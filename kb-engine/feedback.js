// kb-engine/feedback.js
// Multi-signal quality scoring for KB chunks.
//
// Three signals (no extra LLM calls for signals 1 and 3):
//
//   1. SATISFACTION (0.4 weight) — Did the user move on to a new topic after
//      the search, or did they search the same topic again?
//      Move on = satisfied (boost). Search again = unsatisfied (penalize).
//      Zero cost: uses query embedding similarity to detect topic continuity.
//
//   2. SEMANTIC CITATION (0.3 weight) — Did the LLM's response use content
//      from the chunk? Measured via embedding cosine similarity (>0.5).
//      One embedding batch call per response (done server-side in proxy).
//
//   3. RETRIEVAL STABILITY (0.3 weight) — Does this chunk consistently
//      appear in top results for its topic, or does it bounce in/out?
//      Chunks that reliably surface = stable = trustworthy.
//      Zero cost: computed from retrieval event history.
//
// Combined: quality_score = 0.4×satisfaction + 0.3×citation + 0.3×stability
"use strict";

const fs = require("fs");
const path = require("path");

class FeedbackTracker {
  /**
   * @param {string} feedbackFile  Path to the JSONL feedback log
   */
  constructor(feedbackFile) {
    this._file = feedbackFile;
    this._searchCount = 0;
    this._lastSearchQuery = null;
    this._lastSearchChunkIds = null;
  }

  // ── Event Logging ───────────────────────────────────────────────────────

  /**
   * Log a search event. Also detects satisfaction signal from previous search:
   * if this query is on a DIFFERENT topic than the last search → previous search
   * was satisfactory (user moved on). If SAME topic → user is re-searching
   * (previous search was unsatisfactory).
   *
   * @param {string[]} chunkIds  Retrieved chunk IDs
   * @param {string}   query     Search query text
   */
  logSearch(chunkIds, query) {
    // Satisfaction signal: compare this query to the previous one
    if (this._lastSearchQuery && this._lastSearchChunkIds?.length > 0) {
      const similarity = this._queryTopicSimilarity(this._lastSearchQuery, query);
      const satisfied = similarity < 0.6; // different topic = satisfied with previous

      this._append({
        type: "satisfaction",
        chunk_ids: this._lastSearchChunkIds,
        satisfied,
        similarity: Math.round(similarity * 100) / 100,
        prev_query: this._lastSearchQuery,
        next_query: query,
        timestamp: new Date().toISOString(),
      });
    }

    this._append({
      type: "search",
      chunk_ids: chunkIds,
      query,
      timestamp: new Date().toISOString(),
    });

    this._lastSearchQuery = query;
    this._lastSearchChunkIds = chunkIds;
    this._searchCount++;
  }

  /**
   * Log a citation event (from semantic embedding comparison).
   * @param {string[]} chunkIds  Cited chunk IDs
   */
  logCitation(chunkIds) {
    this._append({
      type: "cited",
      chunk_ids: chunkIds,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log that the user ended the search session (e.g., moved to a different
   * task, typed a non-KB message). Marks the last search as satisfactory.
   */
  logSessionEnd() {
    if (this._lastSearchChunkIds?.length > 0) {
      this._append({
        type: "satisfaction",
        chunk_ids: this._lastSearchChunkIds,
        satisfied: true,
        similarity: 0,
        prev_query: this._lastSearchQuery,
        next_query: "(session end)",
        timestamp: new Date().toISOString(),
      });
      this._lastSearchQuery = null;
      this._lastSearchChunkIds = null;
    }
  }

  // ── Aggregation ─────────────────────────────────────────────────────────

  /**
   * Multi-signal aggregation:
   *   quality = 0.4 × satisfaction + 0.3 × citation + 0.3 × stability
   *
   * @returns {Map<string, number>} chunk ID → quality score (0 to 1)
   */
  aggregate() {
    const retrieved = new Map();     // id → count
    const cited = new Map();         // id → count
    const satisfied = new Map();     // id → { yes, total }

    const lines = this._readLines();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (!Array.isArray(event.chunk_ids)) continue;

        if (event.type === "search") {
          for (const id of event.chunk_ids) {
            retrieved.set(id, (retrieved.get(id) || 0) + 1);
          }
        } else if (event.type === "cited") {
          for (const id of event.chunk_ids) {
            cited.set(id, (cited.get(id) || 0) + 1);
          }
        } else if (event.type === "satisfaction") {
          for (const id of event.chunk_ids) {
            const s = satisfied.get(id) || { yes: 0, total: 0 };
            s.total++;
            if (event.satisfied) s.yes++;
            satisfied.set(id, s);
          }
        }
      } catch (_) {}
    }

    const scores = new Map();

    for (const [id, retrievedCount] of retrieved) {
      // Signal 1: Satisfaction (0.4 weight)
      const sat = satisfied.get(id);
      const satisfactionScore = sat && sat.total > 0 ? sat.yes / sat.total : 0.5; // neutral default

      // Signal 2: Citation (0.3 weight)
      const citedCount = cited.get(id) || 0;
      const citationScore = retrievedCount > 0 ? citedCount / retrievedCount : 0;

      // Signal 3: Retrieval stability (0.3 weight)
      // Chunks retrieved many times are stable/reliable for their topic
      // Normalize: 1 retrieval = 0.3, 5+ = 1.0
      const stabilityScore = Math.min(retrievedCount / 5, 1.0);

      // Combined score
      const quality = 0.4 * satisfactionScore + 0.3 * citationScore + 0.3 * stabilityScore;

      scores.set(id, Math.round(quality * 1000) / 1000);
    }

    return scores;
  }

  /**
   * Decay all scores by a multiplicative factor.
   */
  decay(scores, factor = 0.95) {
    const decayed = new Map();
    for (const [id, score] of scores) {
      decayed.set(id, score * factor);
    }
    return decayed;
  }

  /**
   * Write quality_score to Qdrant payload for each scored chunk.
   */
  async applyScores(collection, scores, qdrantClient) {
    if (!qdrantClient || scores.size === 0) return;
    let applied = 0;
    for (const [chunkId, score] of scores) {
      try {
        await qdrantClient.setPayload(collection, {
          payload: { quality_score: score },
          points: [chunkId],
        });
        applied++;
      } catch (_) {}
    }
    return applied;
  }

  /** @returns {number} Number of search events logged since construction */
  get searchCount() {
    return this._searchCount;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Fast topic similarity between two queries using token overlap.
   * NOT embedding-based — zero cost, runs on every search.
   * Returns 0-1 where 1 = identical topic, 0 = completely different.
   */
  _queryTopicSimilarity(q1, q2) {
    const tokenize = (q) => {
      const stops = new Set(['the','a','an','in','for','of','to','at','on','by','with','is','are','and','or','i','my','how','what','do','does']);
      return q.toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2 && !stops.has(t)) || [];
    };
    const set1 = new Set(tokenize(q1));
    const set2 = new Set(tokenize(q2));
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersection = 0;
    for (const t of set1) { if (set2.has(t)) intersection++; }
    return intersection / Math.max(set1.size, set2.size);
  }

  _append(event) {
    try {
      const dir = path.dirname(this._file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this._file, JSON.stringify(event) + "\n", "utf-8");
    } catch (err) {
      process.stderr.write(`[Feedback] Failed to log event: ${err.message}\n`);
    }
  }

  _readLines() {
    try {
      if (!fs.existsSync(this._file)) return [];
      return fs.readFileSync(this._file, "utf-8").split("\n").filter(Boolean);
    } catch (_) {
      return [];
    }
  }
}

module.exports = { FeedbackTracker };
