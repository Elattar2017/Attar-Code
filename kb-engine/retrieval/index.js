// kb-engine/retrieval/index.js
// RetrievalPipeline — wires query-analyzer, query-expander, reranker, context-assembler.
"use strict";

const { analyzeQuery } = require("./query-analyzer");
const { expandQuery } = require("./query-expander");
const { Reranker } = require("./reranker");
const { assembleContext } = require("./context-assembler");
const { ChunkStore } = require("../store");
const config = require("../config");

// ─── RetrievalPipeline ────────────────────────────────────────────────────────

class RetrievalPipeline {
  /**
   * @param {object} [opts]
   * @param {object} [opts.store]        Pre-built ChunkStore instance (for testing)
   * @param {number} [opts.rerankerPort] Port override for the reranker sidecar
   */
  constructor(opts = {}) {
    this.store = opts.store || new ChunkStore(opts);
    this.reranker = new Reranker(opts.rerankerPort);
    this.config = config;
  }

  // ─── search ───────────────────────────────────────────────────────────────

  /**
   * Full retrieval pipeline:
   *   1. Analyze query   → type, preferVector, collections, tech
   *   2. Hybrid search each collection
   *   3. Sort by score
   *   4. Adaptive query expansion (only if results are weak)
   *   5. Rerank top 20
   *   6. Assemble + return context
   *
   * @param {string} query
   * @param {object} [context]   { detectedTech, model, forceCollections, … }
   * @param {object} [options]   { skipExpansion, maxChunks, minScore }
   * @returns {Promise<{ chunks: object[], formatted: string, count: number }>}
   */
  async search(query, context = {}, options = {}) {
    // 1. Analyze query → type, preferVector, collections, tech
    const analysis = analyzeQuery(query, context);

    // Allow caller to force specific collections (e.g. searchFixRecipes)
    const collections =
      context.forceCollections || analysis.collections;

    // Build payload filter for structural queries
    // Note: hybridSearch runs dense + BM25 in parallel.
    // The structural filter restricts results to structural chunks.
    const structuralFilter = analysis.type === 'structural'
      ? [{ key: 'chunk_type', value: 'structural' }]
      : undefined;

    // 2. Hybrid search each collection
    let allResults = [];
    for (const collection of collections) {
      try {
        const results = await this.store.hybridSearch(collection, query, {
          limit: this.config.DEFAULT_SEARCH_LIMIT,
          queryType: analysis.type,
          filter: structuralFilter,
        });
        allResults.push(...results.map((r) => ({ ...r, collection })));
      } catch (_) {
        // collection may not exist yet — skip silently
      }
    }

    // 3. Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    // 4. Adaptive query expansion (only if results are weak)
    if (
      allResults.filter((r) => r.score > 0.6).length < 3 &&
      !options.skipExpansion
    ) {
      try {
        const expanded = await expandQuery(query, {
          ...context,
          tech: analysis.tech,
        });
        for (const eq of expanded.slice(1)) {
          for (const col of collections) {
            try {
              const more = await this.store.hybridSearch(col, eq, {
                limit: 10,
                queryType: analysis.type,
              });
              allResults.push(...more.map((r) => ({ ...r, collection: col })));
            } catch (_) {}
          }
        }
        // Deduplicate by ID
        const seen = new Set();
        allResults = allResults.filter((r) => {
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        });
        allResults.sort((a, b) => b.score - a.score);
      } catch (_) {}
    }

    // 5. Rerank top 20
    const top = allResults.slice(0, 20);
    if (top.length > 0) {
      const scores = await this.reranker.rerank(
        query,
        top.map((r) => r.content)
      );
      if (scores) {
        top.forEach((r, i) => {
          r.rerankScore = scores[i];
        });
        top.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
      }
    }

    // 6. Assemble context (pass query for term-boosting)
    return assembleContext(top, {
      maxChunks: options.maxChunks || this.config.RERANK_TOP_N,
      minScore: options.minScore !== undefined
        ? options.minScore
        : this.config.MIN_SCORE_THRESHOLD,
      query,
    });
  }

  // ─── searchFixRecipes ─────────────────────────────────────────────────────

  /**
   * Convenience: search the fix_recipes collection for a given error message.
   *
   * @param {string} errorMessage
   * @param {object} [context]
   * @returns {Promise<{ chunks: object[], formatted: string, count: number }>}
   */
  async searchFixRecipes(errorMessage, context = {}) {
    return this.search(
      errorMessage,
      { ...context, forceCollections: ["fix_recipes"] },
      { skipExpansion: true }
    );
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  /** Start the reranker sidecar. */
  async start() {
    return this.reranker.start();
  }

  /** Stop the reranker sidecar. */
  stop() {
    this.reranker.stop();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { RetrievalPipeline };
