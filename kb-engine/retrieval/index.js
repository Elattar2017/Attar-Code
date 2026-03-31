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

    // ── SCOPE query: scroll by section_path filter, return ALL chunks in order ──
    if (analysis.type === 'scope' && analysis.scopeId) {
      let allScopeResults = [];
      const filter = [{ key: 'section_path', match: { text: analysis.scopeId } }];
      // If user specified a book: add doc_title filter
      if (analysis.scopeBook) {
        filter.push({ key: 'doc_title', match: { text: analysis.scopeBook } });
      }

      for (const collection of collections) {
        try {
          const results = await this.store.scrollByFilter(collection, filter, {
            limit: 200, sortBy: 'chunk_index',
          });
          allScopeResults.push(...results.map(r => ({ ...r, collection })));
        } catch (_) {}
      }

      if (allScopeResults.length > 0) {
        // Group by doc_title for multi-book disambiguation
        const byBook = {};
        for (const r of allScopeResults) {
          const book = r.metadata?.doc_title || 'Unknown';
          if (!byBook[book]) byBook[book] = [];
          byBook[book].push(r);
        }

        const bookNames = Object.keys(byBook);
        let chosen;
        if (bookNames.length === 1) {
          // Single book — return all its chunks
          chosen = byBook[bookNames[0]];
        } else {
          // Multiple books — pick the one with most chunks (most detailed)
          const sorted = bookNames.sort((a, b) => byBook[b].length - byBook[a].length);
          chosen = byBook[sorted[0]];
          // Note other books
          const others = sorted.slice(1).map(b => `${b} (${byBook[b].length} chunks)`);
          if (chosen.length > 0) {
            chosen[chosen.length - 1]._otherBooks = others;
          }
        }

        // Sort by chunk_index within chosen book
        chosen.sort((a, b) => (a.metadata?.chunk_index || 0) - (b.metadata?.chunk_index || 0));

        // Detail + Summary hybrid: if >25 detail chunks, use summaries for the rest
        const details = chosen.filter(r => r.metadata?.chunk_type !== 'summary');
        const summaries = chosen.filter(r => r.metadata?.chunk_type === 'summary');

        let finalResults;
        if (details.length <= 25) {
          finalResults = details; // All detail chunks fit
        } else {
          // First 25 detail + summaries for remaining sections
          const first25 = details.slice(0, 25);
          const coveredSections = new Set(first25.map(r => r.metadata?.section_path));
          const remainingSummaries = summaries.filter(r =>
            !coveredSections.has(r.metadata?.section_path)
          );
          finalResults = [...first25, ...remainingSummaries];
        }

        return {
          chunks: finalResults.map((r, i) => ({
            id: r.id, content: r.content, metadata: r.metadata,
            score: 1.0 - (i * 0.001), // Preserve order as score
            collection: r.collection,
          })),
          formatted: finalResults.map(r => r.content).join('\n\n---\n\n'),
          count: finalResults.length,
          type: 'scope',
          scopeId: analysis.scopeId,
          totalInScope: allScopeResults.length,
        };
      }
      // Scope query but no results → fall through to regular search
    }

    // ── CODE_EXAMPLES query: vector search + filter has_code_block=true ──
    if (analysis.type === 'code_examples') {
      let allCodeResults = [];
      for (const collection of collections) {
        try {
          const results = await this.store.hybridSearch(collection, query, {
            limit: 30, // Wider search for code examples
            queryType: 'code',
            filter: [{ key: 'has_code_block', value: true }],
          });
          allCodeResults.push(...results.map(r => ({ ...r, collection })));
        } catch (_) {}
      }

      // Group by doc_title
      const byBook = {};
      for (const r of allCodeResults) {
        const book = r.metadata?.doc_title || r.metadata?.source || 'Unknown';
        if (!byBook[book]) byBook[book] = [];
        byBook[book].push(r);
      }

      // Sort within each book by chunk_index
      for (const book of Object.keys(byBook)) {
        byBook[book].sort((a, b) => (a.metadata?.chunk_index || 0) - (b.metadata?.chunk_index || 0));
      }

      // Flatten with book headers
      const formatted = [];
      for (const [book, chunks] of Object.entries(byBook)) {
        formatted.push(`\n── From "${book}" ──`);
        for (const c of chunks) {
          const section = c.metadata?.section_path ? ` (${c.metadata.section_path.split(' > ').pop()})` : '';
          formatted.push(`${section}\n${c.content}`);
        }
      }

      return {
        chunks: allCodeResults.map(r => ({
          id: r.id, content: r.content, metadata: r.metadata,
          score: r.score, collection: r.collection,
        })),
        formatted: formatted.join('\n\n'),
        count: allCodeResults.length,
        type: 'code_examples',
      };
    }

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
