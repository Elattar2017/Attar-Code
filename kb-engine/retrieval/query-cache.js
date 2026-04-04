// kb-engine/retrieval/query-cache.js
// Semantic query cache — returns cached search results when a new query
// embedding is cosine-similar (>threshold) to a previously cached query.
//
// Features:
//   - Brute-force cosine scan (fast enough for ≤500 entries × 1024-dim)
//   - LRU eviction when maxEntries exceeded
//   - TTL-based expiry
//   - Collection-scoped invalidation (only evicts entries that searched affected collections)
//   - Returns the highest-similarity match above threshold (not first)
"use strict";

// ---------------------------------------------------------------------------
// Cosine similarity (assumes unit-normalized vectors from Qwen3-Embedding)
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors of equal length.
 * For unit-normalized vectors, cosine = dot product.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Similarity in [-1, 1]
 */
function cosineSim(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// QueryCache
// ---------------------------------------------------------------------------

class QueryCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=500]   Max cached queries (LRU eviction)
   * @param {number} [opts.ttlMs=1800000]    Time-to-live in ms (default 30 min)
   * @param {number} [opts.threshold=0.88]   Cosine similarity threshold for cache hit
   */
  constructor(opts = {}) {
    this._maxEntries = opts.maxEntries ?? 500;
    this._ttlMs      = opts.ttlMs ?? 30 * 60 * 1000;
    this._threshold   = opts.threshold ?? 0.88;

    /**
     * Cache entries, ordered oldest-first for LRU eviction.
     * @type {Array<{ embedding: number[], results: object, queryText: string, collections: string[], timestamp: number }>}
     */
    this._entries = [];
  }

  /**
   * Look up the cache for a query embedding.
   * Returns the cached result with the HIGHEST cosine similarity above threshold,
   * or null if no match found or entry expired.
   *
   * @param {number[]} embedding - Query embedding vector
   * @returns {object|null} Cached search result, or null
   */
  lookup(embedding) {
    if (!embedding || embedding.length === 0 || this._entries.length === 0) return null;

    const now = Date.now();
    let bestMatch = null;
    let bestSim = -1;

    for (let i = this._entries.length - 1; i >= 0; i--) {
      const entry = this._entries[i];

      // TTL check — evict expired entries
      if (now - entry.timestamp > this._ttlMs) {
        this._entries.splice(i, 1);
        continue;
      }

      const sim = cosineSim(embedding, entry.embedding);
      if (sim >= this._threshold && sim > bestSim) {
        bestSim = sim;
        bestMatch = entry;
      }
    }

    return bestMatch ? bestMatch.results : null;
  }

  /**
   * Store a search result in the cache.
   *
   * @param {number[]} embedding    - Query embedding vector
   * @param {object}   results      - Full search result object
   * @param {string}   queryText    - Original query text (for debugging)
   * @param {string[]} collections  - Collections that were searched (for scoped invalidation)
   */
  store(embedding, results, queryText, collections = []) {
    // LRU eviction: remove oldest if at capacity
    while (this._entries.length >= this._maxEntries) {
      this._entries.shift();
    }

    this._entries.push({
      embedding,
      results,
      queryText,
      collections,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidate cache entries.
   * - No args: clear entire cache
   * - With collection: only evict entries that searched the specified collection
   *
   * @param {string} [collection] - If provided, only invalidate entries involving this collection
   */
  invalidate(collection) {
    if (!collection) {
      this._entries = [];
      return;
    }
    this._entries = this._entries.filter(
      (e) => !e.collections.includes(collection)
    );
  }

  /** @returns {number} Number of cached entries */
  get size() {
    return this._entries.length;
  }
}

module.exports = { QueryCache, cosineSim };
