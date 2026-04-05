// kb-engine/store.js — ChunkStore: add, search, hybrid search via Qdrant
// Unified dense embedding (Qwen3-Embedding-0.6B, 1024-dim) + BM25 sparse vectors.
// Hybrid search uses Reciprocal Rank Fusion (RRF) to merge dense + sparse results.
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { QdrantClient } = require("@qdrant/js-client-rest");
const { UnifiedEmbedder } = require("./embedder");
const { SparseVectorizer } = require("./sparse-vectors");
const { CollectionManager } = require("./collections");
const {
  QDRANT_URL,
  EMBED_DIM,
  DEFAULT_SEARCH_LIMIT,
  BATCH_SIZE,
  RRF_K,
  BM25_VOCAB_DIR,
} = require("./config");

// ─── ChunkStore ───────────────────────────────────────────────────────────────

class ChunkStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]  Qdrant base URL override (e.g. for testing)
   */
  constructor(opts = {}) {
    const url = opts.url ?? QDRANT_URL;
    this._client     = new QdrantClient({ url, checkCompatibility: false });
    this._embedder   = new UnifiedEmbedder();
    this._collections = new CollectionManager({ url });

    /**
     * Per-collection SparseVectorizer instances.
     * Map<collectionName, SparseVectorizer>
     * @type {Map<string, SparseVectorizer>}
     */
    this._vectorizers = new Map();

    /**
     * Optional callback invoked after chunks are added to a collection.
     * Used by RetrievalPipeline to invalidate the query cache.
     * @type {((collection: string) => void)|null}
     */
    this.onChunksAdded = null;
  }

  // ─── Collection lifecycle ─────────────────────────────────────────────────

  /**
   * Create the named collection if it does not already exist.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async ensureCollection(name) {
    return this._collections.ensureCollection(name);
  }

  /**
   * Delete a collection. No-op if it does not exist.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async deleteCollection(name) {
    this._vectorizers.delete(name);
    // Remove persisted BM25 vocabulary file
    try {
      const vocabFile = this._vocabPath(name);
      if (fs.existsSync(vocabFile)) fs.unlinkSync(vocabFile);
    } catch (_) {}
    return this._collections.deleteCollection(name);
  }

  // ─── addChunks ────────────────────────────────────────────────────────────

  /**
   * Embed and upsert an array of chunks into the named collection.
   *
   * Each chunk:
   *   { content: string, metadata: { language, framework, doc_type, ... } }
   *
   * Returns an array of UUID strings (one per chunk, same order).
   *
   * @param {string} collection
   * @param {Array<{ content: string, metadata: object }>} chunks
   * @returns {Promise<string[]>}
   */
  async addChunks(collection, chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];

    // ── 1. Build / update BM25 vectorizer for this collection ────────────────
    // Priority: in-memory → disk → fresh. Incremental build preserves term IDs.
    if (!this._vectorizers.has(collection)) {
      const loaded = this._loadVocabulary(collection);
      this._vectorizers.set(collection, loaded || new SparseVectorizer());
    }
    const vectorizer = this._vectorizers.get(collection);

    for (let i = 0; i < chunks.length; i++) {
      vectorizer.addDocument(String(vectorizer._N + i), chunks[i].content);
    }
    vectorizer.build(); // incremental: preserves existing term→ID mappings

    // ── 2. Generate dense embeddings (batched, no prefix — storage mode) ─────
    const texts = chunks.map((c) => c.content);
    const vecs = await this._embedder.embedBatch(texts);

    // ── 3. Generate sparse vectors (BM25 has no token limit) ──────────────────
    const sparseVecs = texts.map((t) => vectorizer.computeSparseVector(t));

    // ── 4. Assemble Qdrant points ─────────────────────────────────────────────
    const ids = chunks.map(() => randomUUID());

    const points = chunks.map((chunk, i) => ({
      id: ids[i],
      vector: {
        dense: vecs[i],
        bm25: sparseVecs[i],
      },
      payload: {
        content: chunk.content,
        ...(chunk.metadata ?? {}),
      },
    }));

    // ── 5. Batch upsert ───────────────────────────────────────────────────────
    for (let offset = 0; offset < points.length; offset += BATCH_SIZE) {
      const batch = points.slice(offset, offset + BATCH_SIZE);
      await this._client.upsert(collection, { points: batch, wait: true });
    }

    // ── 6. Persist BM25 vocabulary to disk (stable term IDs across restarts) ─
    this._persistVocabulary(collection);

    // ── 7. Notify listeners (e.g. cache invalidation) ─────────────────────────
    if (this.onChunksAdded) this.onChunksAdded(collection);

    return ids;
  }

  // ─── scrollByFilter (no vector search — payload filter + pagination) ──────

  /**
   * Scroll through ALL points matching a payload filter.
   * Used for scope queries ("explain chapter 3") where we need ALL chunks
   * in a section, not just top-N by score.
   *
   * @param {string} collection
   * @param {Array<{ key: string, match: object }>} filter  Qdrant filter conditions
   * @param {object} [opts]
   * @param {number} [opts.limit=200]  Max points to return
   * @param {string} [opts.sortBy]     Payload field to sort by (e.g., "chunk_index")
   * @returns {Promise<Array<{ id: string, content: string, metadata: object }>>}
   */
  async scrollByFilter(collection, filter, opts = {}) {
    const maxPoints = opts.limit || 200;
    const results = [];
    let nextOffset = null;

    // Build Qdrant filter
    const qdrantFilter = {
      must: filter.map(f => {
        if (f.match?.text) {
          // Substring match on text field (for section_path CONTAINS)
          return { key: f.key, match: { text: f.match.text } };
        }
        if (f.match?.value) {
          // Exact match (for chunk_type, doc_title)
          return { key: f.key, match: { value: f.match.value } };
        }
        return { key: f.key, match: f.match };
      }),
    };

    do {
      try {
        const batchSize = Math.min(maxPoints - results.length, 50);
        const response = await this._client.scroll(collection, {
          filter: qdrantFilter,
          limit: batchSize,
          offset: nextOffset,
          with_payload: true,
          with_vector: false,
        });

        for (const point of (response.points || [])) {
          results.push({
            id: point.id,
            content: point.payload?.content || '',
            metadata: point.payload || {},
          });
        }

        nextOffset = response.next_page_offset;
      } catch (err) {
        // Collection might not exist or filter is invalid — stop silently
        break;
      }
    } while (nextOffset && results.length < maxPoints);

    // Sort by chunk_index if requested
    if (opts.sortBy) {
      results.sort((a, b) => (a.metadata[opts.sortBy] || 0) - (b.metadata[opts.sortBy] || 0));
    }

    return results;
  }

  // ─── scrollByKeyword ─────────────────────────────────────────────────────

  /**
   * Scroll all chunks matching exact KEYWORD values.
   * Uses match.value (KEYWORD exact match) — immune to text-index tokenization.
   * Used for scope phase 2 retrieval.
   *
   * @param {string} collection
   * @param {Array<{ key: string, value: string }>} conditions  Exact-match conditions
   * @param {object} [opts]
   * @param {number} [opts.limit=200]  Max points to return
   * @param {string} [opts.sortBy]     Payload field to sort by (e.g., "chunk_index")
   * @returns {Promise<Array<{ id: string, content: string, metadata: object }>>}
   */
  async scrollByKeyword(collection, conditions, opts = {}) {
    const maxPoints = opts.limit || 200;
    const results = [];
    let nextOffset = null;

    const qdrantFilter = {
      must: conditions.map(({ key, value }) => ({
        key,
        match: { value },  // KEYWORD exact match — no tokenization
      })),
    };

    do {
      try {
        const batchSize = Math.min(maxPoints - results.length, 50);
        const response = await this._client.scroll(collection, {
          filter: qdrantFilter,
          limit: batchSize,
          offset: nextOffset,
          with_payload: true,
          with_vector: false,
        });

        for (const point of (response.points || [])) {
          results.push({
            id: point.id,
            content: point.payload?.content || '',
            metadata: point.payload || {},
          });
        }

        nextOffset = response.next_page_offset;
      } catch (_) {
        break; // Collection missing or filter invalid
      }
    } while (nextOffset && results.length < maxPoints);

    if (opts.sortBy) {
      results.sort((a, b) => (a.metadata[opts.sortBy] || 0) - (b.metadata[opts.sortBy] || 0));
    }

    return results;
  }

  // ─── search (dense) ───────────────────────────────────────────────────────

  /**
   * Dense vector search against the named collection.
   *
   * @param {string} collection
   * @param {string} query
   * @param {object} [opts]
   * @param {number}  [opts.limit]      Max results (default: DEFAULT_SEARCH_LIMIT)
   * @param {string}  [opts.queryType]  'general' | 'error' | 'code' | 'structural' (default: 'general')
   * @param {Array<{ key: string, value: string }>} [opts.filter]
   *   Payload filter conditions, e.g. [{ key: "language", value: "python" }]
   * @returns {Promise<Array<{ id: string, score: number, content: string, metadata: object }>>}
   */
  async search(collection, query, opts = {}) {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;

    // Embed query with instruction prefix based on queryType
    const queryVec = await this._embedder.embedForQuery(query, opts.queryType || "general");

    // Build optional payload filter
    const filter = this._buildFilter(opts.filter);

    const searchParams = {
      vector:       { name: "dense", vector: queryVec },
      limit,
      with_payload: true,
    };
    if (filter) searchParams.filter = filter;

    const raw = await this._client.search(collection, searchParams);
    return raw.map(this._formatResult);
  }

  // ─── hybridSearch (dense + sparse + RRF) ─────────────────────────────────

  /**
   * Hybrid search: dense vector search + BM25 sparse search merged with RRF.
   *
   * @param {string} collection
   * @param {string} query
   * @param {object} [opts]
   * @param {number}  [opts.limit]      Final result count after merging (default: DEFAULT_SEARCH_LIMIT)
   * @param {string}  [opts.queryType]  'general' | 'error' | 'code' | 'structural' (default: 'general')
   * @param {Array<{ key: string, value: string }>} [opts.filter]
   * @param {boolean} [opts.denseOnly]  Skip BM25 sparse search (used for HyDE verbose text)
   * @returns {Promise<Array<{ id: string, score: number, content: string, metadata: object }>>}
   */
  async hybridSearch(collection, query, opts = {}) {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const queryType = opts.queryType || "general";

    // Retrieve more candidates before RRF to get better coverage
    const candidateLimit = Math.max(limit * 3, 20);

    // ── Parallel: embed for dense search + compute sparse vector ─────────────
    const [denseVec, sparseVec] = await Promise.all([
      this._embedder.embedForQuery(query, queryType),
      opts.denseOnly ? Promise.resolve({ indices: [], values: [] }) : this._getSparseQueryVec(collection, query),
    ]);

    const filter = this._buildFilter(opts.filter);

    // ── Parallel dense + sparse searches ────────────────────────────────────
    const denseParams = {
      vector:       { name: "dense", vector: denseVec },
      limit:        candidateLimit,
      with_payload: true,
      with_vector:  ['dense'], // return vectors for MMR diversity calculation
    };
    if (filter) {
      denseParams.filter = filter;
    }

    // Build sparse search params — skip if denseOnly or vocabulary empty
    const sparsePromise =
      !opts.denseOnly && sparseVec.indices.length > 0
        ? this._client.search(collection, {
            vector:       { name: "bm25", vector: sparseVec },
            limit:        candidateLimit,
            with_payload: true,
            ...(filter ? { filter } : {}),
          }).catch(() => [])
        : Promise.resolve([]);

    const [denseResults, sparseResults] = await Promise.all([
      this._client.search(collection, denseParams).catch(() => []),
      sparsePromise,
    ]);

    // ── Reciprocal Rank Fusion (2 lists: dense + BM25) ───────────────────────
    const merged = this._rrfMerge(
      [denseResults, sparseResults],
      RRF_K
    );

    // Normalize RRF scores to 0-1 range
    // Max possible RRF score = numLists * (1 / (k + 1)) [when item is rank 1 in every list]
    const numLists = [denseResults, sparseResults].filter(l => l?.length > 0).length;
    const maxRRF = numLists > 0 ? numLists * (1 / (RRF_K + 1)) : 1;

    // Return top `limit` results with normalized scores + vectors for MMR
    return merged.slice(0, limit).map((item) => ({
      id:       item.id,
      score:    maxRRF > 0 ? item.rrfScore / maxRRF : 0,
      content:  item.payload?.content ?? "",
      metadata: this._extractMetadata(item.payload),
      _vector:  item._vector || null,
    }));
  }

  // ─── getChunkCount ────────────────────────────────────────────────────────

  /**
   * Return the number of points in the named collection.
   * @param {string} collection
   * @returns {Promise<number>}
   */
  async getChunkCount(collection) {
    const info = await this._client.getCollection(collection);
    return info.points_count ?? 0;
  }

  // ─── getPointsByIds (batch fetch by UUID) ──────────────────────────────────

  /**
   * Fetch multiple points by their UUIDs in one call.
   * Used for chunk linking (fetching prev/next neighbors).
   *
   * @param {string} collection
   * @param {string[]} ids  Array of Qdrant point UUIDs
   * @returns {Promise<Array<{ id: string, content: string, metadata: object }>>}
   */
  async getPointsByIds(collection, ids) {
    if (!ids || ids.length === 0) return [];
    try {
      const points = await this._client.retrieve(collection, { ids, with_payload: true, with_vector: false });
      return (points || []).map((p) => ({
        id:       String(p.id),
        content:  p.payload?.content ?? "",
        metadata: this._extractMetadata(p.payload),
      }));
    } catch (_) {
      return [];
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Format a raw Qdrant search result into the public result shape.
   * @param {{ id: string, score: number, payload: object }} raw
   * @returns {{ id: string, score: number, content: string, metadata: object }}
   */
  _formatResult(raw) {
    const { content, ...rest } = raw.payload ?? {};
    return {
      id:       String(raw.id),
      score:    raw.score,
      content:  content ?? "",
      metadata: rest,
    };
  }

  /**
   * Build a Qdrant payload filter from an array of key/value conditions.
   * Returns null if conditions is empty/falsy.
   *
   * @param {Array<{ key: string, value: string }>|undefined} conditions
   * @returns {object|null}
   */
  _buildFilter(conditions) {
    if (!Array.isArray(conditions) || conditions.length === 0) return null;
    return {
      must: conditions.map(({ key, value }) => ({
        key,
        match: { value },
      })),
    };
  }

  /**
   * Get (or compute) the BM25 sparse vector for a query against a collection.
   * If no vectorizer exists for the collection, returns empty sparse vector.
   *
   * @param {string} collection
   * @param {string} query
   * @returns {{ indices: number[], values: number[] }}
   */
  async _getSparseQueryVec(collection, query) {
    // Cold-start fix: if no vectorizer in memory, rebuild from Qdrant
    if (!this._vectorizers.has(collection)) {
      await this._rebuildVocabulary(collection);
    }
    const vectorizer = this._vectorizers.get(collection);
    if (!vectorizer) return { indices: [], values: [] };
    return vectorizer.computeSparseVector(query);
  }

  /**
   * Restore BM25 vocabulary for a collection on cold start.
   * Priority 1: Load from persisted disk file (stable term-ID mapping).
   * Priority 2: Rebuild from Qdrant scroll (fallback if file missing).
   *             After scroll rebuild, persist so future cold starts use disk.
   */
  async _rebuildVocabulary(collection) {
    // Priority 1: disk-persisted vocabulary (stable term IDs)
    const loaded = this._loadVocabulary(collection);
    if (loaded) {
      this._vectorizers.set(collection, loaded);
      process.stderr.write(`  [BM25] Loaded persisted vocabulary for "${collection}": ${loaded.getVocabularySize()} terms\n`);
      return;
    }

    // Priority 2: rebuild from Qdrant (term IDs may differ from original — one-time migration)
    try {
      const info = await this._collections.getCollectionInfo(collection);
      if (!info || (info.points_count || 0) === 0) return;

      const vectorizer = new SparseVectorizer();
      let offset = null;
      let docCount = 0;

      do {
        const response = await this._client.scroll(collection, {
          limit: 100,
          offset,
          with_payload: ['content'],
          with_vector: false,
        });

        for (const point of (response.points || [])) {
          const content = point.payload?.content || '';
          if (content.length > 10) {
            vectorizer.addDocument(String(docCount++), content);
          }
        }
        offset = response.next_page_offset;
      } while (offset);

      if (docCount > 0) {
        vectorizer.build();
        this._vectorizers.set(collection, vectorizer);
        // Persist so future cold starts use the stable disk vocabulary
        this._persistVocabulary(collection);
        process.stderr.write(`  [BM25] Rebuilt + persisted vocabulary for "${collection}": ${vectorizer.getVocabularySize()} terms from ${docCount} docs\n`);
      }
    } catch (err) {
      process.stderr.write(`  [BM25] Failed to rebuild vocabulary for "${collection}": ${err.message}\n`);
    }
  }

  // ─── BM25 vocabulary persistence ───────────────────────────────────────────

  /** @returns {string} Path to the vocab JSON file for a collection. */
  _vocabPath(collection) {
    return path.join(BM25_VOCAB_DIR, `${collection}.json`);
  }

  /**
   * Persist the in-memory BM25 vocabulary to disk.
   * Called after addChunks() and after scroll-based rebuild.
   */
  _persistVocabulary(collection) {
    const vectorizer = this._vectorizers.get(collection);
    if (!vectorizer) return;
    try {
      if (!fs.existsSync(BM25_VOCAB_DIR)) {
        fs.mkdirSync(BM25_VOCAB_DIR, { recursive: true });
      }
      fs.writeFileSync(this._vocabPath(collection), JSON.stringify(vectorizer.serialize()), 'utf-8');
    } catch (err) {
      process.stderr.write(`  [BM25] Failed to persist vocabulary for "${collection}": ${err.message}\n`);
    }
  }

  /**
   * Load a persisted BM25 vocabulary from disk.
   * Returns null if file missing, corrupted, or schema version mismatch.
   */
  _loadVocabulary(collection) {
    try {
      const filePath = this._vocabPath(collection);
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return SparseVectorizer.deserialize(data);
    } catch (err) {
      process.stderr.write(`  [BM25] Failed to load vocabulary for "${collection}": ${err.message}\n`);
      return null;
    }
  }

  /**
   * Merge multiple ranked result lists using Reciprocal Rank Fusion.
   * RRF score = SUM_over_lists( 1 / (k + rank) )  where rank is 1-based.
   * Preserves dense vector from results (for MMR diversity calculation).
   *
   * @param {Array<Array<{ id: string|number, score: number, payload: object, vector?: object }>>} lists
   * @param {number} k  RRF smoothing constant (typically 60)
   * @returns {Array<{ id: string, rrfScore: number, payload: object, _vector?: number[] }>}
   */
  _rrfMerge(lists, k) {
    const acc = new Map();

    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      list.forEach((item, idx) => {
        const rank = idx + 1;
        const id   = String(item.id);
        const rrf  = 1 / (k + rank);

        if (acc.has(id)) {
          const entry = acc.get(id);
          entry.rrfScore += rrf;
          // Keep vector from whichever list has it (dense list has vectors, sparse doesn't)
          if (!entry._vector && item.vector) {
            entry._vector = item.vector?.dense || item.vector;
          }
        } else {
          acc.set(id, {
            id,
            rrfScore: rrf,
            payload:  item.payload ?? {},
            _vector:  item.vector?.dense || item.vector || null,
          });
        }
      });
    }

    return Array.from(acc.values()).sort((a, b) => b.rrfScore - a.rrfScore);
  }

  /**
   * Extract metadata fields from a Qdrant payload (everything except "content").
   * @param {object} payload
   * @returns {object}
   */
  _extractMetadata(payload) {
    if (!payload || typeof payload !== "object") return {};
    const { content, ...meta } = payload;
    return meta;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { ChunkStore };
