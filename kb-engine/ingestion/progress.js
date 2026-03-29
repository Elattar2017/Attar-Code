'use strict';

/**
 * progress.js — Ingestion state tracker for resumable document processing.
 *
 * Persists state to a JSON file (default: ~/.attar-code/kb-ingestion-state.json).
 * All writes are best-effort: errors are silently swallowed to avoid breaking the pipeline.
 */

const fs   = require('fs');
const path = require('path');
const config = require('../config');

class IngestionTracker {
  /**
   * @param {string} [stateFile] - Path to the state JSON file.
   *   Defaults to config.INGESTION_STATE_FILE (~/.attar-code/kb-ingestion-state.json).
   */
  constructor(stateFile) {
    this.stateFile = stateFile || config.INGESTION_STATE_FILE;
    this.state     = this._load();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Load state from disk. Returns {} if the file is missing or unreadable.
   * @returns {object}
   */
  _load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      }
    } catch (_) {
      // Corrupt or missing file — start fresh
    }
    return {};
  }

  /**
   * Persist current state to disk. Silently no-ops on write failure.
   */
  _save() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (_) {
      // Best-effort write — ignore errors
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get the current ingestion state for a document.
   *
   * @param {string} docId
   * @returns {{ total_chunks: number, processed: number, status: string, collection: string, started_at: string, completed_at?: string }|null}
   */
  getState(docId) {
    return this.state[docId] || null;
  }

  /**
   * Record the start of ingestion for a document.
   *
   * @param {string} docId
   * @param {number} totalChunks  - Total number of chunks to process.
   * @param {string} collection   - Target Qdrant collection name.
   */
  startIngestion(docId, totalChunks, collection) {
    this.state[docId] = {
      total_chunks: totalChunks,
      processed:    0,
      status:       'in_progress',
      collection,
      started_at:   new Date().toISOString(),
    };
    this._save();
  }

  /**
   * Update the processed chunk count for a document.
   *
   * @param {string} docId
   * @param {number} processed - Number of chunks processed so far.
   */
  updateProgress(docId, processed) {
    if (this.state[docId]) {
      this.state[docId].processed = processed;
      this._save();
    }
  }

  /**
   * Mark a document's ingestion as complete.
   *
   * @param {string} docId
   */
  markComplete(docId) {
    if (this.state[docId]) {
      this.state[docId].status       = 'complete';
      this.state[docId].completed_at = new Date().toISOString();
      this._save();
    }
  }

  /**
   * Return all documents that are currently in_progress (i.e. unfinished).
   * Useful for resuming interrupted ingestion.
   *
   * @returns {Array<{ docId: string, total_chunks: number, processed: number, collection: string, started_at: string }>}
   */
  getIncomplete() {
    return Object.entries(this.state)
      .filter(([, v]) => v.status === 'in_progress')
      .map(([k, v]) => ({ docId: k, ...v }));
  }

  /**
   * Remove a document's state entry entirely.
   *
   * @param {string} docId
   */
  reset(docId) {
    delete this.state[docId];
    this._save();
  }

  /**
   * Remove all state entries.
   */
  resetAll() {
    this.state = {};
    this._save();
  }
}

module.exports = { IngestionTracker };
