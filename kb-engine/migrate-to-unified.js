#!/usr/bin/env node
// kb-engine/migrate-to-unified.js
//
// Migration script: Dual-model (code_vector + text_vector) → Unified single-model (dense 1024-dim + bm25 sparse)
//
// This script:
//   1. Connects to Qdrant at http://127.0.0.1:6333
//   2. Lists all collections
//   3. For each collection that has points:
//      a. Scrolls all points (batch 100), extracts content + metadata
//      b. Deletes the collection
//      c. Re-creates it with the new single-vector schema (dense 1024-dim + bm25 sparse)
//      d. Re-embeds all content with UnifiedEmbedder.embedBatch()
//      e. Re-computes BM25 sparse vectors
//      f. Upserts all points with original metadata preserved
//      g. Verifies point count matches
//
// Usage:
//   node kb-engine/migrate-to-unified.js
//
// Requirements:
//   - Qdrant running at http://127.0.0.1:6333
//   - Ollama running with Qwen3-Embedding-4B model pulled

"use strict";

const { QdrantClient } = require("@qdrant/js-client-rest");
const { UnifiedEmbedder } = require("./embedder");
const { SparseVectorizer } = require("./sparse-vectors");
const { CollectionManager } = require("./collections");
const config = require("./config");

// ─── Constants ──────────────────────────────────────────────────────────────────

const QDRANT_URL = config.QDRANT_URL || "http://127.0.0.1:6333";
const SCROLL_BATCH = 100;
const UPSERT_BATCH = config.BATCH_SIZE || 100;

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Scroll all points from a collection (paginated).
 * Returns array of { id, payload } objects.
 */
async function scrollAllPoints(client, collectionName) {
  const allPoints = [];
  let offset = null;
  let hasMore = true;

  while (hasMore) {
    const scrollParams = {
      limit: SCROLL_BATCH,
      with_payload: true,
      with_vector: false, // We don't need old vectors — we'll re-embed
    };
    if (offset !== null) {
      scrollParams.offset = offset;
    }

    const result = await client.scroll(collectionName, scrollParams);
    const points = result.points || [];

    for (const point of points) {
      allPoints.push({
        id: point.id,
        payload: point.payload || {},
      });
    }

    // Qdrant scroll returns next_page_offset; if null, we've read everything
    offset = result.next_page_offset ?? null;
    hasMore = offset !== null && points.length > 0;
  }

  return allPoints;
}

/**
 * Print a timestamped log message.
 */
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Main migration ─────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  KB Engine Migration: Dual-Model → Unified (Qwen3-Embed)   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // 1. Connect to Qdrant
  log(`Connecting to Qdrant at ${QDRANT_URL}...`);
  const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });

  try {
    const health = await client.api("cluster").clusterStatus();
    log("Qdrant is reachable.");
  } catch (err) {
    // Try a simpler health check
    try {
      await client.getCollections();
      log("Qdrant is reachable.");
    } catch (err2) {
      console.error(`ERROR: Cannot reach Qdrant at ${QDRANT_URL}`);
      console.error(`  ${err2.message}`);
      console.error("Make sure Qdrant is running: qdrant.exe or docker run qdrant/qdrant");
      process.exit(1);
    }
  }

  // 2. Probe embedding model
  log("Probing embedding model availability...");
  const embedder = new UnifiedEmbedder();
  const models = await embedder.getAvailableModels();
  if (!models.model) {
    console.error(`ERROR: Embedding model not available.`);
    console.error(`  Install it with: ollama pull ${config.EMBED_MODEL}`);
    console.error("  Then ensure Ollama is running: ollama serve");
    process.exit(1);
  }
  log(`Embedding model OK: ${config.EMBED_MODEL} (${config.EMBED_DIM}-dim)`);

  // 3. List all collections
  const collectionsResult = await client.getCollections();
  const collections = (collectionsResult.collections || []).map((c) => c.name);
  log(`Found ${collections.length} collection(s): ${collections.join(", ") || "(none)"}`);
  console.log();

  if (collections.length === 0) {
    log("Nothing to migrate. Done.");
    return;
  }

  // 4. Collection manager for re-creation
  const collectionMgr = new CollectionManager({ url: QDRANT_URL });

  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const name of collections) {
    console.log(`─── Collection: ${name} ───`);

    try {
      // 4a. Get current point count
      const info = await client.getCollection(name);
      const originalCount = info.points_count ?? 0;

      if (originalCount === 0) {
        log(`  Skipping (0 points)`);
        skippedCount++;
        console.log();
        continue;
      }

      log(`  Found ${originalCount} point(s). Scrolling all content...`);

      // 4b. Scroll all points — extract content + metadata
      const allPoints = await scrollAllPoints(client, name);
      log(`  Scrolled ${allPoints.length} point(s).`);

      // Extract content and metadata from payloads
      const documents = allPoints.map((p) => {
        const { content, ...metadata } = p.payload;
        return {
          content: content || "",
          metadata,
        };
      });

      // 4c. Delete the old collection
      log(`  Deleting old collection...`);
      await client.deleteCollection(name);

      // 4d. Re-create with new unified schema (dense 1024-dim + bm25 sparse)
      log(`  Re-creating with unified schema (dense ${config.EMBED_DIM}-dim + bm25 sparse)...`);
      await collectionMgr.ensureCollection(name);

      // 4e. Re-embed all content with UnifiedEmbedder
      const texts = documents.map((d) => d.content);
      const total = texts.length;

      // Process in batches
      const allVectors = [];
      for (let i = 0; i < total; i += UPSERT_BATCH) {
        const batchTexts = texts.slice(i, i + UPSERT_BATCH);
        const batchEnd = Math.min(i + UPSERT_BATCH, total);
        log(`  Migrating ${name}: ${batchEnd}/${total} chunks...`);

        const vecs = await embedder.embedBatch(batchTexts);
        allVectors.push(...vecs);
      }

      // 4f. Re-compute BM25 sparse vectors
      log(`  Computing BM25 sparse vectors...`);
      const vectorizer = new SparseVectorizer();
      for (let i = 0; i < documents.length; i++) {
        vectorizer.addDocument(String(i), documents[i].content);
      }
      vectorizer.build();
      const sparseVecs = texts.map((t) => vectorizer.computeSparseVector(t));

      // 4g. Upsert all points with original metadata preserved
      log(`  Upserting ${total} point(s)...`);
      const { randomUUID } = require("crypto");

      for (let offset = 0; offset < total; offset += UPSERT_BATCH) {
        const batchEnd = Math.min(offset + UPSERT_BATCH, total);
        const points = [];

        for (let i = offset; i < batchEnd; i++) {
          points.push({
            id: randomUUID(),
            vector: {
              dense: allVectors[i],
              bm25: sparseVecs[i],
            },
            payload: {
              content: documents[i].content,
              ...documents[i].metadata,
            },
          });
        }

        await client.upsert(name, { points, wait: true });
      }

      // 4h. Verify point count matches
      const newInfo = await client.getCollection(name);
      const newCount = newInfo.points_count ?? 0;

      if (newCount === originalCount) {
        log(`  Verified: ${newCount}/${originalCount} points. OK`);
        migratedCount++;
      } else {
        log(`  WARNING: Point count mismatch! Expected ${originalCount}, got ${newCount}.`);
        migratedCount++;
      }
    } catch (err) {
      console.error(`  ERROR migrating "${name}": ${err.message}`);
      errorCount++;
    }

    console.log();
  }

  // 5. Summary
  console.log("═══════════════════════════════════════════════════════════════");
  log(`Migration complete.`);
  log(`  Migrated: ${migratedCount}`);
  log(`  Skipped (empty): ${skippedCount}`);
  log(`  Errors: ${errorCount}`);

  if (errorCount > 0) {
    process.exit(1);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error during migration:", err);
  process.exit(1);
});
