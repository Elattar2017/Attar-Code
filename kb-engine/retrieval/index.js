// kb-engine/retrieval/index.js
// RetrievalPipeline — wires query-analyzer, query-expander, reranker, context-assembler.
"use strict";

const { analyzeQuery } = require("./query-analyzer");
const { expandQuery } = require("./query-expander");
const { rewriteQuery, decomposeQuery, REWRITE_TYPES } = require("./query-rewriter");
const { generateHypothetical, HYDE_TYPES } = require("./hyde");
const { QueryCache } = require("./query-cache");
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

    // Semantic query cache (invalidated when new chunks are ingested)
    this._cache = config.QUERY_CACHE_ENABLED
      ? new QueryCache({
          maxEntries: config.QUERY_CACHE_MAX,
          ttlMs:      config.QUERY_CACHE_TTL,
          threshold:  config.QUERY_CACHE_THRESHOLD,
        })
      : null;

    // Wire cache invalidation to store's addChunks
    if (this._cache) {
      this.store.onChunksAdded = (collection) => {
        this._cache.invalidate(collection);
      };
    }
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

    // ── Cache check (skip for scope/code_examples which have specialized paths) ──
    let _cacheEmbedding = null;
    if (this._cache && analysis.type !== 'scope' && analysis.type !== 'code_examples' && analysis.type !== 'cross_structural') {
      try {
        _cacheEmbedding = await this.store._embedder.embedForQuery(
          query, analysis.type || 'general'
        );
        const cached = this._cache.lookup(_cacheEmbedding);
        if (cached) return cached;
      } catch (_) {
        // Embedding failed — skip cache, proceed with normal search
      }
    }

    // ── SCOPE query: two-phase vector-discovery + keyword-filter retrieval ──
    if (analysis.type === 'scope' && analysis.scopeHint) {
      const discovered = await this._discoverScopeMetadata(
        query, analysis.scopeBook, collections
      );
      if (discovered) {
        const allScopeResults = await this._retrieveFullScope(discovered, collections);
        if (allScopeResults.length > 0) {
          return this._formatScopeResult(allScopeResults, discovered);
        }
      }
      // Discovery or retrieval found nothing → fall through to regular search
    }

    // ── CROSS_STRUCTURAL query: "which chapters mention X across all docs" ──
    if (analysis.type === 'cross_structural') {
      return this._crossStructuralSearch(analysis.crossTopic || '', collections, query);
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
    const structuralFilter = analysis.type === 'structural'
      ? [{ key: 'chunk_type', value: 'structural' }]
      : undefined;

    // 1.5. Pre-search query understanding: rewrite + decompose
    let searchQuery = query;
    let subQueries = null;

    if (this.config.QUERY_REWRITE_ENABLED && REWRITE_TYPES.has(analysis.type)) {
      // Rewrite vague queries into optimized search queries
      searchQuery = await rewriteQuery(query, undefined, context.model, { tech: analysis.tech, type: analysis.type });

      // Decompose complex queries (comparisons, multi-topic) into sub-queries
      subQueries = await decomposeQuery(searchQuery, undefined, context.model);
      if (subQueries.length === 1 && subQueries[0] === searchQuery) {
        subQueries = null; // no decomposition needed
      }
    }

    // 2. Hybrid search each collection
    let allResults = [];
    const queriesToSearch = subQueries || [searchQuery];

    for (const sq of queriesToSearch) {
      for (const collection of collections) {
        try {
          const results = await this.store.hybridSearch(collection, sq, {
            limit: this.config.DEFAULT_SEARCH_LIMIT,
            queryType: analysis.type,
            filter: structuralFilter,
          });
          allResults.push(...results.map((r) => ({ ...r, collection })));
        } catch (_) {
          // collection may not exist yet — skip silently
        }
      }
    }

    // Deduplicate if multiple sub-queries produced overlapping results
    if (subQueries) {
      const seen = new Set();
      allResults = allResults.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
    }

    // 3. Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    // 3.5. Anti-tag hard filter: remove results whose dna_anti_tags overlap with query keywords
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length > 0) {
      allResults = allResults.filter((r) => {
        const antiTags = r.metadata?.dna_anti_tags;
        if (!Array.isArray(antiTags) || antiTags.length === 0) return true;
        // Check if ANY anti-tag appears as substring in the query
        const queryLower = query.toLowerCase();
        return !antiTags.some(tag => queryLower.includes(tag.toLowerCase()));
      });
    }

    // 4. Adaptive augmentation: HyDE + query expansion (only if results are weak)
    const isWeak = allResults.filter((r) => r.score > 0.6).length < 3;
    if (isWeak && !options.skipExpansion) {
      // 4a. HyDE: generate hypothetical answer, embed it, search with it (dense-only)
      if (this.config.HYDE_ENABLED && HYDE_TYPES.has(analysis.type)) {
        try {
          const hypothetical = await generateHypothetical(
            query, undefined, context.model
          );
          if (hypothetical) {
            for (const col of collections) {
              try {
                const hydeResults = await this.store.hybridSearch(col, hypothetical, {
                  limit: this.config.DEFAULT_SEARCH_LIMIT,
                  queryType: analysis.type,
                  filter: structuralFilter,
                  denseOnly: true, // skip BM25 for verbose hypothetical text
                });
                allResults.push(...hydeResults.map((r) => ({ ...r, collection: col })));
              } catch (_) {}
            }
          }
        } catch (_) {
          // HyDE failure — continue with expansion fallback
        }
      }

      // 4b. Query expansion: reformulate query via LLM
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
      } catch (_) {}

      // Deduplicate by ID (HyDE + expansion may overlap with original results)
      const seen = new Set();
      allResults = allResults.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      allResults.sort((a, b) => b.score - a.score);
    }

    // 5. Rerank top candidates (configurable — default 40, was hardcoded 20)
    const top = allResults.slice(0, this.config.RERANK_CANDIDATES || 40);
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

    // 5.5. Chunk linking: expand top results with prev/next neighbors
    if (this.config.CHUNK_LINK_EXPAND && top.length > 0) {
      const neighborIds = new Set();
      const idToChunk = new Map();

      for (const chunk of top) {
        const prev = chunk.metadata?.prev_chunk_id;
        const next = chunk.metadata?.next_chunk_id;
        if (prev && !top.some(t => t.id === prev)) neighborIds.add(prev);
        if (next && !top.some(t => t.id === next)) neighborIds.add(next);
        idToChunk.set(chunk.id, chunk);
      }

      if (neighborIds.size > 0) {
        // Fetch all neighbors in one batch per collection
        const collectionSet = new Set(top.map(t => t.collection).filter(Boolean));
        const neighborMap = new Map();

        for (const col of collectionSet) {
          const colNeighborIds = [...neighborIds]; // same IDs searched in each collection
          const fetched = await this.store.getPointsByIds(col, colNeighborIds);
          for (const f of fetched) neighborMap.set(f.id, f);
        }

        // Expand each chunk with its neighbors' content
        for (const chunk of top) {
          const prev = chunk.metadata?.prev_chunk_id;
          const next = chunk.metadata?.next_chunk_id;
          const prevChunk = prev ? neighborMap.get(prev) : null;
          const nextChunk = next ? neighborMap.get(next) : null;

          if (prevChunk || nextChunk) {
            const parts = [];
            if (prevChunk) parts.push('[...preceding context]\n' + prevChunk.content.slice(-500));
            parts.push(chunk.content);
            if (nextChunk) parts.push(nextChunk.content.slice(0, 500) + '\n[continues...]');
            chunk.content = parts.join('\n\n---\n\n');
            chunk._expanded = true;
          }
        }
      }
    }

    // 6. Assemble context (pass query for term-boosting)
    const result = assembleContext(top, {
      maxChunks: options.maxChunks || this.config.RERANK_TOP_N,
      minScore: options.minScore !== undefined
        ? options.minScore
        : this.config.MIN_SCORE_THRESHOLD,
      query,
    });

    // 7. Store in cache for future similar queries
    if (this._cache && _cacheEmbedding) {
      this._cache.store(_cacheEmbedding, result, query, collections);
    }

    return result;
  }

  // ─── Scope: Phase 1 — Discovery ───────────────────────────────────────────

  /**
   * Use vector search to discover the actual stored chapter/section metadata.
   * Returns the best-matching chapter heading and book_id, or null.
   *
   * @param {string} query       The user's query (used for vector search)
   * @param {string|null} scopeBook  Book hint from query ("from Python Programming")
   * @param {string[]} collections   Collections to search
   * @returns {Promise<{ chapter: string, book_id: string, doc_title: string, scopeLevel: string } | null>}
   */
  async _discoverScopeMetadata(query, scopeBook, collections) {
    const allDiscovery = [];

    for (const collection of collections) {
      try {
        const results = await this.store.hybridSearch(collection, query, {
          limit: 5,
          queryType: 'structural',
        });
        allDiscovery.push(...results.map(r => ({ ...r, collection })));
      } catch (_) {}
    }

    if (allDiscovery.length === 0) return null;

    // Score chapter values: sum scores for each (chapter, book_id) pair
    const chapterScores = {};  // key: "chapter|||book_id" → { chapter, book_id, doc_title, totalScore }
    for (const r of allDiscovery) {
      const chapter = r.metadata?.chapter || '';
      const bookId = r.metadata?.book_id || '';
      const docTitle = r.metadata?.doc_title || '';
      if (!chapter) continue;  // skip chunks with empty chapter

      const key = `${chapter}|||${bookId}`;
      if (!chapterScores[key]) {
        chapterScores[key] = { chapter, book_id: bookId, doc_title: docTitle, totalScore: 0 };
      }
      // If scopeBook hint: boost matching books
      const bookBoost = scopeBook && docTitle.toLowerCase().includes(scopeBook.toLowerCase()) ? 2.0 : 1.0;
      chapterScores[key].totalScore += (r.score || 0) * bookBoost;
    }

    // Pick the best chapter
    const candidates = Object.values(chapterScores);
    if (candidates.length === 0) {
      // No chapter found — try section level
      const sectionScores = {};
      for (const r of allDiscovery) {
        const section = r.metadata?.section || '';
        const bookId = r.metadata?.book_id || '';
        const docTitle = r.metadata?.doc_title || '';
        if (!section) continue;

        const key = `${section}|||${bookId}`;
        if (!sectionScores[key]) {
          sectionScores[key] = { section, book_id: bookId, doc_title: docTitle, totalScore: 0 };
        }
        const bookBoost = scopeBook && docTitle.toLowerCase().includes(scopeBook.toLowerCase()) ? 2.0 : 1.0;
        sectionScores[key].totalScore += (r.score || 0) * bookBoost;
      }

      const secCandidates = Object.values(sectionScores);
      if (secCandidates.length === 0) return null;

      secCandidates.sort((a, b) => b.totalScore - a.totalScore);
      const best = secCandidates[0];
      return { section: best.section, book_id: best.book_id, doc_title: best.doc_title, scopeLevel: 'section' };
    }

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    const best = candidates[0];
    return { chapter: best.chapter, book_id: best.book_id, doc_title: best.doc_title, scopeLevel: 'chapter' };
  }

  // ─── Scope: Phase 2 — Complete Retrieval ─────────────────────────────────

  /**
   * Use KEYWORD exact match to retrieve ALL chunks from a discovered chapter/section.
   *
   * @param {{ chapter?: string, section?: string, book_id: string, scopeLevel: string }} discovered
   * @param {string[]} collections
   * @returns {Promise<Array<{ id, content, metadata, collection }>>}
   */
  async _retrieveFullScope(discovered, collections) {
    const conditions = [];

    if (discovered.scopeLevel === 'chapter' && discovered.chapter) {
      conditions.push({ key: 'chapter', value: discovered.chapter });
    } else if (discovered.scopeLevel === 'section' && discovered.section) {
      conditions.push({ key: 'section', value: discovered.section });
    } else {
      return [];
    }

    // Narrow to specific book if known
    if (discovered.book_id) {
      conditions.push({ key: 'book_id', value: discovered.book_id });
    }

    const allResults = [];
    for (const collection of collections) {
      try {
        const results = await this.store.scrollByKeyword(collection, conditions, {
          limit: 200,
          sortBy: 'chunk_index',
        });
        allResults.push(...results.map(r => ({ ...r, collection })));
      } catch (_) {}
    }

    return allResults;
  }

  // ─── Scope: Format Result ────────────────────────────────────────────────

  /**
   * Format scope results with multi-book disambiguation and detail+summary hybrid.
   */
  _formatScopeResult(allResults, discovered) {
    // Group by doc_title for multi-book disambiguation
    const byBook = {};
    for (const r of allResults) {
      const book = r.metadata?.doc_title || 'Unknown';
      if (!byBook[book]) byBook[book] = [];
      byBook[book].push(r);
    }

    const bookNames = Object.keys(byBook);
    let chosen;
    let otherBooks = [];

    if (bookNames.length === 1) {
      chosen = byBook[bookNames[0]];
    } else {
      // Multiple books — pick the one with most chunks
      const sorted = bookNames.sort((a, b) => byBook[b].length - byBook[a].length);
      chosen = byBook[sorted[0]];
      otherBooks = sorted.slice(1).map(b => `${b} (${byBook[b].length} chunks)`);
    }

    // Sort by chunk_index
    chosen.sort((a, b) => (a.metadata?.chunk_index || 0) - (b.metadata?.chunk_index || 0));

    // Detail + Summary hybrid: if >25 detail chunks, use summaries for the rest
    const details = chosen.filter(r => r.metadata?.chunk_type !== 'summary');
    const summaries = chosen.filter(r => r.metadata?.chunk_type === 'summary');

    let finalResults;
    if (details.length <= 25) {
      finalResults = details;
    } else {
      const first25 = details.slice(0, 25);
      const coveredSections = new Set(first25.map(r => r.metadata?.section_path));
      const remainingSummaries = summaries.filter(r =>
        !coveredSections.has(r.metadata?.section_path)
      );
      finalResults = [...first25, ...remainingSummaries];
    }

    const scopeHeading = discovered.chapter || discovered.section || 'Unknown';
    const formattedParts = finalResults.map(r => r.content);
    if (otherBooks.length > 0) {
      formattedParts.push(`\n[Also found in: ${otherBooks.join(', ')}]`);
    }

    return {
      chunks: finalResults.map((r, i) => ({
        id: r.id, content: r.content, metadata: r.metadata,
        score: 1.0 - (i * 0.001),  // Preserve reading order as score
        collection: r.collection,
      })),
      formatted: formattedParts.join('\n\n---\n\n'),
      count: finalResults.length,
      type: 'scope',
      scopeId: scopeHeading,
      doc_title: discovered.doc_title,
      totalInScope: allResults.length,
    };
  }

  // ─── Cross-structural search ──────────────────────────────────────────────

  /**
   * Search for a topic across ALL documents and group results by chapter.
   * Returns a cross-document map showing which chapters mention the topic.
   *
   * @param {string}   topic        The topic to search for (extracted from query)
   * @param {string[]} collections  Collections to search
   * @param {string}   originalQuery The full original query (for count-only detection)
   * @returns {Promise<{ chunks: object[], formatted: string, count: number, type: string }>}
   */
  async _crossStructuralSearch(topic, collections, originalQuery) {
    const limit = this.config.CROSS_STRUCTURAL_LIMIT || 50;
    const minChunks = this.config.CROSS_STRUCTURAL_MIN_CHUNKS || 2;

    // 0. Pure listing: no topic — scroll all structural overview chunks
    if (!topic) {
      const structuralChunks = [];
      for (const collection of collections) {
        try {
          const results = await this.store.scrollByKeyword(collection,
            [{ key: 'chunk_type', value: 'structural' }],
            { limit: 100 }
          );
          structuralChunks.push(...results.map((r) => ({ ...r, collection })));
        } catch (_) {}
      }

      if (structuralChunks.length === 0) {
        return { chunks: [], formatted: 'No structural data found across the knowledge base.', count: 0, type: 'cross_structural' };
      }

      // Group by document
      const byDoc = {};
      for (const c of structuralChunks) {
        const doc = c.metadata?.doc_title || 'Unknown';
        if (!byDoc[doc]) byDoc[doc] = [];
        byDoc[doc].push(c);
      }

      const parts = [`Knowledge base contains ${structuralChunks.length} structural chunks across ${Object.keys(byDoc).length} document(s):\n`];
      for (const [doc, chunks] of Object.entries(byDoc)) {
        const overviews = chunks.filter(c => c.metadata?.structural_type === 'overview');
        const chapters = chunks.filter(c => c.metadata?.structural_type === 'chapter');
        parts.push(`── "${doc}" ── (${chapters.length} chapters)`);
        for (const ch of chapters) {
          parts.push(`  - ${ch.metadata?.chapter || ch.content?.split('\n')[0] || '?'}`);
        }
      }

      return { chunks: structuralChunks, formatted: parts.join('\n'), count: structuralChunks.length, type: 'cross_structural' };
    }

    // 1. Semantic search for the topic across all collections
    let allResults = [];
    for (const collection of collections) {
      try {
        const results = await this.store.hybridSearch(collection, topic, {
          limit,
          queryType: 'conceptual',
        });
        allResults.push(...results.map((r) => ({ ...r, collection })));
      } catch (_) {}
    }

    if (allResults.length === 0) {
      return {
        chunks: [],
        formatted: `No content found mentioning "${topic}" across the knowledge base.`,
        count: 0,
        type: 'cross_structural',
      };
    }

    // Filter by minimum score
    allResults = allResults.filter((r) => (r.score || 0) >= (this.config.MIN_SCORE_THRESHOLD || 0.2));

    // 2. Group by (doc_title, chapter)
    const chapterMap = {};
    for (const r of allResults) {
      const docTitle = r.metadata?.doc_title || 'Unknown';
      const chapter  = r.metadata?.chapter || r.metadata?.section || 'Uncategorized';
      const key = `${docTitle}|||${chapter}`;

      if (!chapterMap[key]) {
        chapterMap[key] = {
          doc_title: docTitle,
          chapter,
          book_id: r.metadata?.book_id || '',
          chunks: [],
          totalScore: 0,
          bestScore: 0,
        };
      }
      chapterMap[key].chunks.push(r);
      chapterMap[key].totalScore += (r.score || 0);
      chapterMap[key].bestScore = Math.max(chapterMap[key].bestScore, r.score || 0);
    }

    // 3. Filter: minimum chunk count per chapter
    const chapters = Object.values(chapterMap).filter((ch) => ch.chunks.length >= minChunks);

    if (chapters.length === 0) {
      return {
        chunks: allResults.slice(0, 5),
        formatted: `Found mentions of "${topic}" but no chapter has ${minChunks}+ matching chunks. Showing top results instead.\n\n` +
          allResults.slice(0, 5).map((r) => `[${r.metadata?.doc_title} > ${r.metadata?.chapter || ''}] ${r.content.slice(0, 200)}...`).join('\n\n---\n\n'),
        count: allResults.length,
        type: 'cross_structural',
      };
    }

    // 4. Score and rank chapters
    for (const ch of chapters) {
      ch.avgScore = ch.totalScore / ch.chunks.length;
      ch.rank = ch.chunks.length * 0.4 + ch.avgScore * 0.3 + ch.bestScore * 0.3;
    }
    chapters.sort((a, b) => b.rank - a.rank);

    // 5. Fetch chapter summaries (if available)
    for (const ch of chapters) {
      if (!ch.book_id) continue;
      try {
        const summaries = await this.store.scrollByKeyword(
          ch.chunks[0]?.collection || collections[0],
          [
            { key: 'book_id', value: ch.book_id },
            { key: 'chunk_type', value: 'summary' },
          ],
          { limit: 5 }
        );
        // Find a summary matching this chapter
        const chapterSummary = summaries.find((s) =>
          (s.metadata?.chapter || '') === ch.chapter && s.metadata?.summary_level === 'chapter'
        );
        if (chapterSummary) ch.summary = chapterSummary.content;
      } catch (_) {}
    }

    // 6. Detect count-only vs full listing
    const isCountOnly = /\bhow\s+many\b/i.test(originalQuery);

    // 7. Format output
    const totalChapters = chapters.length;
    const docSet = new Set(chapters.map((ch) => ch.doc_title));
    const totalDocs = docSet.size;

    if (isCountOnly) {
      return {
        chunks: chapters.flatMap((ch) => ch.chunks.slice(0, 1)),
        formatted: `Found "${topic}" discussed across ${totalChapters} chapter${totalChapters !== 1 ? 's' : ''} in ${totalDocs} document${totalDocs !== 1 ? 's' : ''}:\n\n` +
          chapters.map((ch, i) => `${i + 1}. ${ch.doc_title} > ${ch.chapter} (${ch.chunks.length} mentions)`).join('\n'),
        count: totalChapters,
        type: 'cross_structural',
      };
    }

    // Full listing grouped by document
    const byDoc = {};
    for (const ch of chapters) {
      if (!byDoc[ch.doc_title]) byDoc[ch.doc_title] = [];
      byDoc[ch.doc_title].push(ch);
    }

    const parts = [];
    parts.push(`Found "${topic}" mentioned across ${totalChapters} chapter${totalChapters !== 1 ? 's' : ''} in ${totalDocs} document${totalDocs !== 1 ? 's' : ''}:\n`);

    let rank = 1;
    for (const [docTitle, docChapters] of Object.entries(byDoc)) {
      parts.push(`\n── "${docTitle}" ──`);
      for (const ch of docChapters) {
        const scoreStr = ch.avgScore.toFixed(2);
        parts.push(`${rank}. ${ch.chapter} (${ch.chunks.length} mentions, avg score: ${scoreStr})`);
        if (ch.summary) {
          // Truncate summary to first 200 chars for display
          const summaryPreview = ch.summary.length > 200 ? ch.summary.slice(0, 200) + '...' : ch.summary;
          parts.push(`   Summary: ${summaryPreview}`);
        }
        rank++;
      }
    }

    return {
      chunks: chapters.flatMap((ch) => ch.chunks),
      formatted: parts.join('\n'),
      count: totalChapters,
      type: 'cross_structural',
    };
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
    return this.reranker.start(this.config.RERANKER_MODEL);
  }

  /** Stop the reranker sidecar. */
  stop() {
    this.reranker.stop();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { RetrievalPipeline };
