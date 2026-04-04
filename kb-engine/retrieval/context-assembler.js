'use strict';

/**
 * kb-engine/retrieval/context-assembler.js
 *
 * Processes raw search result chunks into LLM-ready context strings.
 * Supports both Jaccard deduplication and MMR (Maximal Marginal Relevance)
 * for diversity-aware selection.
 */

const config = require('../config');

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
// cosineSim(a, b) → number in [-1, 1]
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 * @param {number[]|null} a
 * @param {number[]|null} b
 * @returns {number}
 */
function cosineSim(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// mmrSelect(chunks, maxChunks, lambda) → selected chunks
// ---------------------------------------------------------------------------

/**
 * Maximal Marginal Relevance selection.
 * Balances relevance (rerankScore or score) against diversity (cosine dissimilarity
 * in embedding space, with Jaccard fallback when vectors are unavailable).
 *
 * MMR(c) = λ × relevance(c) - (1-λ) × max(similarity(c, s) for s in selected)
 *
 * @param {Array<object>} chunks   Candidate chunks (must have score/rerankScore, optionally _vector)
 * @param {number} maxChunks       How many to select
 * @param {number} [lambda=0.7]    Relevance vs diversity tradeoff (1.0 = pure relevance, 0.0 = pure diversity)
 * @returns {Array<object>}
 */
function mmrSelect(chunks, maxChunks, lambda = 0.7) {
  if (!chunks || chunks.length === 0) return [];
  if (chunks.length <= maxChunks) return [...chunks];

  // Sort by relevance first to pick the best initial chunk
  const sorted = [...chunks].sort((a, b) => {
    const aR = a.rerankScore !== undefined ? a.rerankScore : (a.score || 0);
    const bR = b.rerankScore !== undefined ? b.rerankScore : (b.score || 0);
    return bR - aR;
  });

  const selected = [sorted[0]];
  const candidates = sorted.slice(1);

  while (selected.length < maxChunks && candidates.length > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const relevance = c.rerankScore !== undefined ? c.rerankScore : (c.score || 0);

      // Max similarity to any already-selected chunk
      let maxSim = 0;
      for (const s of selected) {
        if (c._vector && s._vector) {
          maxSim = Math.max(maxSim, cosineSim(c._vector, s._vector));
        } else {
          // Jaccard fallback when vectors unavailable
          maxSim = Math.max(maxSim, computeOverlap(c.content || '', s.content || ''));
        }
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      selected.push(candidates.splice(bestIdx, 1)[0]);
    } else {
      break;
    }
  }

  return selected;
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

  // Step 2+3 — select top chunks: MMR (diversity-aware) or Jaccard dedup (legacy)
  let topChunks;
  if (config.MMR_ENABLED) {
    // MMR uses rerankScore for relevance + cosine similarity for diversity
    topChunks = mmrSelect(filtered, maxChunks, config.MMR_LAMBDA || 0.7);
  } else {
    // Legacy path: Jaccard dedup + relevance sort
    filtered = deduplicateChunks(filtered);
    filtered.sort((a, b) => {
      const aScore = a.rerankScore !== undefined ? a.rerankScore : (a.score || 0);
      const bScore = b.rerankScore !== undefined ? b.rerankScore : (b.score || 0);
      return bScore - aScore;
    });
    topChunks = filtered.slice(0, maxChunks);
  }

  if (topChunks.length === 0) {
    return {
      chunks: [],
      formatted: 'No relevant documentation found.',
      count: 0,
    };
  }

  // Step 3.5 — DNA multiplicative score boosts (authority, freshness, trust)
  // Applied after selection so DNA doesn't affect which chunks enter the pool,
  // only their final ranking for display order.
  for (const c of topChunks) {
    const meta = c.metadata || {};
    let multiplier = 1.0;

    // Authority boost
    if (meta.dna_authority && config.DNA_AUTHORITY_MULT) {
      multiplier *= (config.DNA_AUTHORITY_MULT[meta.dna_authority] ?? 1.0);
    }

    // Freshness boost
    if (meta.dna_freshness && config.DNA_FRESHNESS_MULT) {
      multiplier *= (config.DNA_FRESHNESS_MULT[meta.dna_freshness] ?? 1.0);
    }

    // Trust boost (per-point deviation from trust=3 baseline)
    if (meta.dna_trust !== undefined && config.DNA_TRUST_WEIGHT) {
      multiplier *= (1.0 + (meta.dna_trust - 3) * config.DNA_TRUST_WEIGHT);
    }

    // Quality feedback boost (chunks with usage history get boosted/penalized)
    // quality_score: 0-1 (cited/retrieved ratio). Neutral = 0.5.
    if (meta.quality_score !== undefined) {
      multiplier *= (0.7 + 0.3 * (meta.quality_score ?? 0.5));
    }

    // Apply multiplicative boost to the display score
    if (multiplier !== 1.0) {
      c.score = (c.score || 0) * multiplier;
      if (c.rerankScore !== undefined) c.rerankScore *= multiplier;
    }
  }

  // Re-sort after DNA boosts
  topChunks.sort((a, b) => {
    const aScore = a.rerankScore !== undefined ? a.rerankScore : (a.score || 0);
    const bScore = b.rerankScore !== undefined ? b.rerankScore : (b.score || 0);
    return bScore - aScore;
  });

  // Step 4 — format: group by data source if results span multiple sources
  const bySource = {};
  for (const chunk of topChunks) {
    const src = chunk.metadata?.doc_title || chunk.metadata?.title || 'Unknown';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(chunk);
  }

  // Helper: build DNA authority label like "(★★★★ known-author, current)"
  function dnaLabel(meta) {
    if (!meta.dna_authority) return '';
    const stars = { canonical: '★★★★★', 'industry-standard': '★★★★', 'known-author': '★★★', community: '★★', personal: '★' };
    const s = stars[meta.dna_authority] || '';
    const f = meta.dna_freshness ? `, ${meta.dna_freshness}` : '';
    return ` (${s} ${meta.dna_authority}${f})`;
  }

  let formatted;
  if (Object.keys(bySource).length > 1) {
    // Multiple sources — group with source headers
    const parts = [];
    for (const [source, chunks] of Object.entries(bySource)) {
      const firstMeta = chunks[0]?.metadata || {};
      parts.push(`\n── From "${source}"${dnaLabel(firstMeta)} ──`);
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
      const dna = dnaLabel(meta);
      return `[Source: ${source}${dna}]${typeLabel} [Score: ${scoreStr}]\n\n${content}`;
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
module.exports = { assembleContext, deduplicateChunks, computeOverlap, mmrSelect, cosineSim };
