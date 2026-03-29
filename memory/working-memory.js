'use strict';

/**
 * working-memory.js — Layer 1: Always-in-context task anchoring and reinforcement.
 *
 * Builds a task anchor block injected at BOTH start and end of every prompt.
 * Tracks: current task, status updates, corrections, resolved topics, search repetition.
 * Prevents: model drift, topic revisiting, search loops.
 */

const path = require('path');

// ── Jaccard word similarity for search repetition detection ───────────────
function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}

class WorkingMemory {
  constructor() {
    this._task = '';
    this._statusTrail = [];      // Last 5 status updates
    this._nextStep = '';
    this._corrections = [];      // { text, turn } — max 5
    this._doNotList = [];        // Resolved topics — max 3
    this._searchHistory = [];    // { query, resultCount, topResultHash, turn } — max 20
  }

  // ── Task Management ──────────────────────────────────────────────────────

  /**
   * Set the current task. Clears DO NOT list (new topic = clean slate).
   * @param {string} task
   */
  setTask(task) {
    this._task = task || '';
    this._statusTrail = [];
    this._nextStep = '';
    this._doNotList = []; // new task = clear old resolved topics
  }

  /**
   * Get the current task.
   * @returns {string}
   */
  getTask() {
    return this._task;
  }

  /**
   * Append a status update to the trail. Max 5 entries.
   * @param {string} status
   */
  updateStatus(status) {
    this._statusTrail.push(status);
    if (this._statusTrail.length > 5) this._statusTrail.shift();
  }

  /**
   * Set the next step hint.
   * @param {string} step
   */
  setNextStep(step) {
    this._nextStep = step || '';
  }

  // ── Corrections ──────────────────────────────────────────────────────────

  /**
   * Add a user correction. Max 5, oldest evicted.
   * @param {string} text  The correction (e.g., "use pydantic not jsonschema")
   * @param {number} turn  The turn number when correction was given
   */
  addCorrection(text, turn) {
    this._corrections.push({ text, turn });
    if (this._corrections.length > 5) this._corrections.shift();
  }

  /**
   * Get all corrections.
   * @returns {Array<{ text: string, turn: number }>}
   */
  getCorrections() {
    return this._corrections;
  }

  // ── DO NOT Block ─────────────────────────────────────────────────────────

  /**
   * Add a resolved topic to the DO NOT list. Max 3, LRU eviction.
   * @param {string} topic
   */
  addDoNot(topic) {
    // Remove if already exists (move to end = most recent)
    this._doNotList = this._doNotList.filter(t => t !== topic);
    this._doNotList.push(topic);
    if (this._doNotList.length > 3) this._doNotList.shift();
  }

  // ── Anchor Block Builder ─────────────────────────────────────────────────

  /**
   * Build the task anchor block for injection into the prompt.
   * Returns empty string if no task is set.
   * @returns {string}
   */
  getAnchorBlock() {
    if (!this._task) return '';

    const lines = [];
    lines.push(`[TASK] ${this._task}`);

    if (this._statusTrail.length > 0) {
      lines.push(`[STATUS] ${this._statusTrail.map(s => `✓ ${s}`).join(' → ')}`);
    }

    if (this._nextStep) {
      lines.push(`[STEP] ${this._nextStep}`);
    }

    if (this._corrections.length > 0) {
      const corrLines = this._corrections.map(c => `  User (turn ${c.turn}): "${c.text}"`);
      lines.push(`[CORRECTIONS]\n${corrLines.join('\n')}`);
    }

    if (this._doNotList.length > 0) {
      lines.push(`[DO NOT] ${this._doNotList.join('. ')}.`);
    }

    return lines.join('\n');
  }

  // ── Recovery Directive ───────────────────────────────────────────────────

  /**
   * Build a recovery directive to append to tool error messages.
   * Keeps the model focused on the current task after an error.
   *
   * @param {string} error       What went wrong
   * @param {string} alternative Suggested alternative action
   * @returns {string}
   */
  buildRecoveryDirective(error, alternative) {
    const taskLine = this._task
      ? `Continue with the CURRENT task: ${this._task}.`
      : 'Continue with your CURRENT task.';

    return [
      `\n[RECOVERY] ${error}`,
      alternative ? `Alternative: ${alternative}` : '',
      taskLine,
      'Do NOT change topic or search for unrelated content.',
    ].filter(Boolean).join('\n');
  }

  // ── Search Repetition Detection ──────────────────────────────────────────

  /**
   * Record a KB search query for repetition detection.
   * @param {string} query
   * @param {number} resultCount
   * @param {string} topResultHash  Hash of the top result (to detect same results)
   */
  recordSearch(query, resultCount, topResultHash) {
    this._searchHistory.push({ query, resultCount, topResultHash, time: Date.now() });
    if (this._searchHistory.length > 20) this._searchHistory.shift();
  }

  /**
   * Check if a new search query is repeating (similar to 3+ previous queries
   * that returned the same top result).
   *
   * @param {string} newQuery
   * @param {string} newTopHash
   * @returns {boolean}
   */
  isSearchRepeating(newQuery, newTopHash) {
    // Find recent searches with the same top result hash
    const sameResultSearches = this._searchHistory.filter(s => s.topResultHash === newTopHash);
    if (sameResultSearches.length < 3) return false;

    // Check if the queries are similar (Jaccard > 0.3 — they share key terms)
    const similarCount = sameResultSearches.filter(s => jaccardSimilarity(s.query, newQuery) > 0.2).length;
    return similarCount >= 3;
  }

  /**
   * Get a warning message if search is repeating, or null if not.
   * @param {string} query
   * @param {string} topResultHash
   * @returns {string|null}
   */
  getSearchRepetitionWarning(query, topResultHash) {
    if (!this.isSearchRepeating(query, topResultHash)) return null;

    const count = this._searchHistory.filter(s => s.topResultHash === topResultHash).length;
    return `\n⚠ You have searched ${count} similar queries with the same results. The answer is in the results above. Move on to the next step. Do NOT search for this topic again.`;
  }

  // ── Auto-Update from Tool Results ────────────────────────────────────────

  /**
   * Automatically update status based on a tool call result.
   * Called after each tool execution.
   *
   * @param {string} toolName
   * @param {object} toolArgs
   * @param {string} result
   */
  updateFromToolResult(toolName, toolArgs, result) {
    if (!this._task) return; // no task = no tracking

    const resultLower = (result || '').toLowerCase();
    const hasError = /error|fail|❌|blocked/i.test(result);
    const hasSuccess = /✓|✅|success|written|created|applied/i.test(result);

    switch (toolName) {
      case 'write_file': {
        const name = path.basename(toolArgs?.filepath || toolArgs?.file_path || '');
        this.updateStatus(hasError ? `Failed to write ${name}` : `${name} written`);
        break;
      }
      case 'edit_file': {
        const name = path.basename(toolArgs?.filepath || toolArgs?.file_path || '');
        this.updateStatus(hasError ? `Failed to edit ${name}` : `${name} edited`);
        break;
      }
      case 'run_bash': {
        if (hasError) this.updateStatus('Command failed');
        else if (hasSuccess) this.updateStatus('Command succeeded');
        break;
      }
      case 'build_and_test': {
        const errorMatch = result.match(/(\d+)\s*error/i);
        const nonZeroErrors = errorMatch && parseInt(errorMatch[1], 10) > 0;
        if (nonZeroErrors || /fail|❌|blocked/i.test(result)) {
          this.updateStatus(errorMatch ? `Build: ${errorMatch[1]} errors` : 'Build failed');
          this.setNextStep('Fix the build errors');
        } else {
          this.updateStatus('Build succeeded');
          this.setNextStep('Verify the changes work correctly');
        }
        break;
      }
      case 'start_server': {
        this.updateStatus(hasError ? 'Server failed to start' : 'Server started');
        break;
      }
      case 'test_endpoint': {
        this.updateStatus(hasError ? 'Endpoint test failed' : 'Endpoint test passed');
        break;
      }
      // read_file, grep_search, find_files — don't update status (informational only)
    }
  }

  /**
   * Reset all state (for /clear).
   */
  reset() {
    this._task = '';
    this._statusTrail = [];
    this._nextStep = '';
    this._corrections = [];
    this._doNotList = [];
    this._searchHistory = [];
  }
}

module.exports = { WorkingMemory, jaccardSimilarity };
