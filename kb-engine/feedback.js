// kb-engine/feedback.js
// Quality feedback tracker — tracks which chunks get retrieved and which get cited.
// Computes per-chunk quality_score for retrieval boosting.
//
// Events are appended to a JSONL file. Aggregation computes:
//   quality_score = cited_count / retrieved_count
//
// Disabled by default (FEEDBACK_ENABLED: false) until the system has enough usage data.
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
  }

  /**
   * Log a search event: which chunk IDs were retrieved for a query.
   * @param {string[]} chunkIds  Array of Qdrant point IDs
   * @param {string}   query     The search query
   */
  logSearch(chunkIds, query) {
    this._append({
      type: "search",
      chunk_ids: chunkIds,
      query,
      timestamp: new Date().toISOString(),
    });
    this._searchCount++;
  }

  /**
   * Log a citation event: which chunk IDs the LLM actually cited in its response.
   * @param {string[]} chunkIds  Array of cited Qdrant point IDs
   */
  logCitation(chunkIds) {
    this._append({
      type: "cited",
      chunk_ids: chunkIds,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Aggregate all events into per-chunk quality scores.
   * quality_score = cited_count / retrieved_count (0 to 1)
   *
   * @returns {Map<string, number>} Map of chunk ID → quality score
   */
  aggregate() {
    const retrieved = new Map(); // chunkId → count
    const cited = new Map();     // chunkId → count

    const lines = this._readLines();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "search" && Array.isArray(event.chunk_ids)) {
          for (const id of event.chunk_ids) {
            retrieved.set(id, (retrieved.get(id) || 0) + 1);
          }
        } else if (event.type === "cited" && Array.isArray(event.chunk_ids)) {
          for (const id of event.chunk_ids) {
            cited.set(id, (cited.get(id) || 0) + 1);
          }
        }
      } catch (_) {
        // Skip malformed lines
      }
    }

    const scores = new Map();
    for (const [id, retrievedCount] of retrieved) {
      const citedCount = cited.get(id) || 0;
      scores.set(id, citedCount / retrievedCount);
    }
    // Chunks that were only cited (never tracked as retrieved) get score 1.0
    for (const [id] of cited) {
      if (!scores.has(id)) {
        scores.set(id, 1.0);
      }
    }

    return scores;
  }

  /**
   * Decay all quality scores by a multiplicative factor.
   * Used to prevent stale scores from dominating.
   *
   * @param {Map<string, number>} scores  Output from aggregate()
   * @param {number} [factor=0.95]        Decay multiplier
   * @returns {Map<string, number>} New scores after decay
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
   * Uses setPayload with point ID filter — no re-ingestion needed.
   *
   * @param {string} collection  Qdrant collection name
   * @param {Map<string, number>} scores  chunk ID → quality_score (from aggregate)
   * @param {object} qdrantClient  QdrantClient instance
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
      } catch (_) {
        // Point may no longer exist — skip silently
      }
    }
    return applied;
  }

  /** @returns {number} Number of search events logged since construction */
  get searchCount() {
    return this._searchCount;
  }

  // ── Private ──────────────────────────────────────────────────────────────

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
