'use strict';

/**
 * kb-engine/retrieval/context-assembler.js
 *
 * Processes raw search result chunks into LLM-ready context strings.
 */

// ---------------------------------------------------------------------------
// computeOverlap(a, b) → 0-1  (Jaccard word similarity)
// ---------------------------------------------------------------------------

/**
 * Tokenise a string into a Set of lowercase words (letters/digits only).
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  const words = String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return new Set(words || []);
}

/**
 * computeOverlap(a, b) → number in [0, 1]
 *
 * Returns the Jaccard similarity between the word-sets of two strings.
 * Identical text → 1.0, completely disjoint vocabulary → 0.0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function computeOverlap(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// deduplicateChunks(chunks) → filtered array
// ---------------------------------------------------------------------------

/**
 * deduplicateChunks(chunks) → chunk[]
 *
 * Removes near-duplicate chunks (>80 % Jaccard overlap), keeping the one
 * with the higher score.  Works in O(n²) which is fine for small result sets.
 *
 * Each chunk is expected to have: { content: string, score: number, ... }
 *
 * @param {Array<object>} chunks
 * @returns {Array<object>}
 */
function deduplicateChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const OVERLAP_THRESHOLD = 0.8;

  // Work with a copy so we don't mutate the caller's array
  const remaining = [...chunks];
  const kept = [];

  while (remaining.length > 0) {
    // Take the first unprocessed chunk
    const candidate = remaining.shift();
    let dominated = false;

    // Compare against already-kept chunks
    for (let i = 0; i < kept.length; i++) {
      const overlap = computeOverlap(
        candidate.content || '',
        kept[i].content || ''
      );

      if (overlap > OVERLAP_THRESHOLD) {
        // Near-duplicate found — keep whichever has the higher score
        if ((candidate.score || 0) > (kept[i].score || 0)) {
          // Replace the lower-scored kept chunk with the candidate
          kept[i] = candidate;
        }
        // Either way, the candidate is now represented — stop comparing
        dominated = true;
        break;
      }
    }

    if (!dominated) {
      kept.push(candidate);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// assembleContext(chunks, options) → { chunks, formatted, count }
// ---------------------------------------------------------------------------

/**
 * assembleContext(chunks, options) → { chunks, formatted, count }
 *
 * Pipeline:
 *  1. Filter chunks whose score is below minScore (default 0.5)
 *  2. Deduplicate chunks with >80 % Jaccard overlap (keep higher score)
 *  3. Take the top maxChunks (default 5) by score (descending)
 *  4. Format each chunk as:
 *       [Source: <title> > <section>] [Score: <score>]
 *
 *       <content>
 *  5. Join with "\n\n---\n\n"
 *  6. If nothing survives, formatted = "No relevant documentation found."
 *
 * Expected chunk shape:
 *  {
 *    content : string,
 *    score   : number,          // 0-1 relevance score
 *    metadata: {
 *      title  ?: string,
 *      section?: string,
 *    }
 *  }
 *
 * @param {Array<object>} chunks
 * @param {{ minScore?: number, maxChunks?: number }} [options]
 * @returns {{ chunks: Array<object>, formatted: string, count: number }}
 */
function assembleContext(chunks, options = {}) {
  const minScore = options.minScore !== undefined ? options.minScore : 0.5;
  const maxChunks = options.maxChunks !== undefined ? options.maxChunks : 5;

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return {
      chunks: [],
      formatted: 'No relevant documentation found.',
      count: 0,
    };
  }

  // Step 0 — boost scores for chunks where query terms appear in content or section_path
  const queryTerms = (options.query || "").toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (queryTerms.length > 0) {
    for (const c of chunks) {
      const text = ((c.content || "") + " " + (c.metadata?.section_path || "")).toLowerCase();
      const matchCount = queryTerms.filter(t => text.includes(t)).length;
      if (matchCount > 0) {
        c.score = (c.score || 0) + (matchCount / queryTerms.length) * 0.3; // boost up to 0.3
      }
    }
  }

  // Step 1 — filter by score (lower threshold for hybrid search which has normalized RRF scores)
  let filtered = chunks.filter((c) => (c.score || 0) >= minScore);

  // Step 2 — deduplicate
  filtered = deduplicateChunks(filtered);

  // Step 3 — sort descending: prefer rerankScore (cross-encoder) when present,
  // fall back to score (RRF + term-boost). This preserves the reranker's ordering
  // instead of discarding it via the term-boost re-sort.
  filtered.sort((a, b) => {
    const aScore = a.rerankScore !== undefined ? a.rerankScore : (a.score || 0);
    const bScore = b.rerankScore !== undefined ? b.rerankScore : (b.score || 0);
    return bScore - aScore;
  });
  const topChunks = filtered.slice(0, maxChunks);

  if (topChunks.length === 0) {
    return {
      chunks: [],
      formatted: 'No relevant documentation found.',
      count: 0,
    };
  }

  // Step 4 — format: group by data source if results span multiple sources
  const bySource = {};
  for (const chunk of topChunks) {
    const src = chunk.metadata?.doc_title || chunk.metadata?.title || 'Unknown';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(chunk);
  }

  let formatted;
  if (Object.keys(bySource).length > 1) {
    // Multiple sources — group with source headers
    const parts = [];
    for (const [source, chunks] of Object.entries(bySource)) {
      parts.push(`\n── From "${source}" ──`);
      for (const chunk of chunks) {
        const meta = chunk.metadata || {};
        const section = meta.section || meta.section_path || meta.chapter || '';
        const scoreStr = (chunk.score || 0).toFixed(2);
        const content = (chunk.content || '').trim();
        const typeLabel = meta.chunk_type === 'structural' ? ' [Structure]' : '';
        const sectionLabel = section ? ` > ${section}` : '';
        parts.push(`[${source}${sectionLabel}]${typeLabel} [Score: ${scoreStr}]\n\n${content}`);
      }
    }
    formatted = parts.join('\n\n---\n\n');
  } else {
    // Single source — original flat format
    const parts = topChunks.map((chunk) => {
      const meta = chunk.metadata || {};
      const title = meta.title || meta.doc_title || 'Unknown';
      const section = meta.section || meta.section_path || meta.chapter || '';
      const source = section ? `${title} > ${section}` : title;
      const scoreStr = (chunk.score || 0).toFixed(2);
      const content = (chunk.content || '').trim();
      const typeLabel = meta.chunk_type === 'structural' ? ' [Structure]' : '';
      return `[Source: ${source}]${typeLabel} [Score: ${scoreStr}]\n\n${content}`;
    });
    formatted = parts.join('\n\n---\n\n');
  }

  return {
    chunks: topChunks,
    formatted,
    count: topChunks.length,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { assembleContext, deduplicateChunks, computeOverlap };
