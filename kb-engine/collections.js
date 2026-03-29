// kb-engine/collections.js — Collection Manager for the Attar-Code KB engine
// Manages Qdrant collections: create, check, list, info, delete, stats.
// Each collection has a single dense vector (Qwen3-Embedding-4B, 2560-dim),
// sparse BM25 vectors, scalar quantization, and payload indexes.
"use strict";

const { QdrantClient } = require("@qdrant/js-client-rest");
const {
  QDRANT_URL,
  EMBED_DIM,
  COLLECTIONS,
} = require("./config");

// ─── Payload indexes to create on every collection ────────────────────────────

const PAYLOAD_INDEXES = [
  { field_name: "language", field_schema: "keyword" },
  { field_name: "framework", field_schema: "keyword" },
  { field_name: "doc_type",  field_schema: "keyword" },
  { field_name: "source",    field_schema: "keyword" },
  { field_name: "chunk_type", field_schema: "keyword" },
  { field_name: "chapter",    field_schema: "keyword" },
  { field_name: "heading_level", field_schema: { type: "integer" } },
];

// ─── CollectionManager ────────────────────────────────────────────────────────

class CollectionManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]  Qdrant base URL override (e.g. for testing)
   */
  constructor(opts = {}) {
    this._url    = opts.url ?? QDRANT_URL;
    this._client = new QdrantClient({ url: this._url, checkCompatibility: false });
  }

  // ─── ensureCollection ───────────────────────────────────────────────────────

  /**
   * Create a collection if it does not already exist.
   * Uses a single dense vector + sparse BM25 + scalar quantization (int8).
   *
   * @param {string} name  Collection name
   * @returns {Promise<void>}
   */
  async ensureCollection(name) {
    // Skip creation if the collection is already there
    const exists = await this.collectionExists(name);
    if (exists) return;

    // ── Create collection ─────────────────────────────────────────────────────
    await this._client.createCollection(name, {
      vectors: {
        dense: {
          size:     EMBED_DIM,   // 2560
          distance: "Cosine",
        },
      },
      sparse_vectors: {
        bm25: {},   // empty config — Qdrant handles BM25 indexing
      },
      quantization_config: {
        scalar: {
          type:       "int8",
          quantile:   0.99,
          always_ram: true,
        },
      },
    });

    // ── Create payload indexes ────────────────────────────────────────────────
    for (const { field_name, field_schema } of PAYLOAD_INDEXES) {
      await this._client.createPayloadIndex(name, {
        field_name,
        field_schema,
        wait: true,
      });
    }
  }

  // ─── ensureAllCollections ───────────────────────────────────────────────────

  /**
   * Create all 15 default collections (from config.COLLECTIONS) if missing.
   * @returns {Promise<void>}
   */
  async ensureAllCollections() {
    for (const name of COLLECTIONS) {
      await this.ensureCollection(name);
    }
  }

  // ─── collectionExists ───────────────────────────────────────────────────────

  /**
   * Check whether a collection exists.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async collectionExists(name) {
    try {
      const result = await this._client.collectionExists(name);
      // result is { exists: boolean }
      return result.exists === true;
    } catch (_) {
      return false;
    }
  }

  // ─── listCollections ────────────────────────────────────────────────────────

  /**
   * List all collection names.
   * @returns {Promise<string[]>}
   */
  async listCollections() {
    const result = await this._client.getCollections();
    // result is { collections: Array<{ name: string, ... }> }
    return (result.collections ?? []).map((c) => c.name);
  }

  // ─── getCollectionInfo ──────────────────────────────────────────────────────

  /**
   * Get summary info for a single collection.
   * @param {string} name
   * @returns {Promise<{ name: string, vectors_count: number, points_count: number, status: string }>}
   */
  async getCollectionInfo(name) {
    const detail = await this._client.getCollection(name);
    return {
      name,
      vectors_count: detail.vectors_count  ?? 0,
      points_count:  detail.points_count   ?? 0,
      status:        detail.status         ?? "unknown",
    };
  }

  // ─── deleteCollection ───────────────────────────────────────────────────────

  /**
   * Delete a collection if it exists. No-op if it does not exist.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async deleteCollection(name) {
    try {
      await this._client.deleteCollection(name);
    } catch (_) {
      // Ignore errors (e.g. collection not found)
    }
  }

  // ─── getAllStats ─────────────────────────────────────────────────────────────

  /**
   * Return info objects for every collection currently in Qdrant.
   * @returns {Promise<Array<{ name: string, vectors_count: number, points_count: number, status: string }>>}
   */
  async getAllStats() {
    const names = await this.listCollections();
    const stats = [];
    for (const name of names) {
      const info = await this.getCollectionInfo(name);
      stats.push(info);
    }
    return stats;
  }
}

module.exports = { CollectionManager };
