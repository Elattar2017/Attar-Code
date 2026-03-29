'use strict';

/**
 * smartfix-bridge.js — Bridge between memory system and smart-fix pipeline.
 *
 * Tracks error frequency across sessions, provides project context for fix prompts,
 * and detects systemic issues that need fundamentally different approaches.
 */

class SmartFixBridge {
  constructor() {
    this._trends = {};  // errorCode → { occurrences: [], total, success_rate, last_seen }
  }

  /**
   * Record an error occurrence for trending.
   * @param {string} errorCode
   * @param {string} sessionId
   * @param {boolean} fixed
   * @param {string} strategy
   */
  recordError(errorCode, sessionId, fixed, strategy) {
    if (!this._trends[errorCode]) {
      this._trends[errorCode] = { occurrences: [], total: 0, success_rate: 0, last_seen: '' };
    }

    const trend = this._trends[errorCode];
    trend.occurrences.push({
      session: sessionId,
      date: new Date().toISOString().split('T')[0],
      fixed,
      strategy,
    });

    // Keep last 20 occurrences
    if (trend.occurrences.length > 20) trend.occurrences.shift();

    trend.total = trend.occurrences.length;
    trend.success_rate = trend.occurrences.filter(o => o.fixed).length / trend.total;
    trend.last_seen = new Date().toISOString().split('T')[0];
  }

  /**
   * Get the error trend for a specific error code.
   * @param {string} errorCode
   * @returns {{ total: number, success_rate: number, last_seen: string, occurrences: Array }|null}
   */
  getErrorTrend(errorCode) {
    return this._trends[errorCode] || null;
  }

  /**
   * Check if an error is systemic (3+ unique sessions with same error).
   * @param {string} errorCode
   * @returns {boolean}
   */
  isSystemic(errorCode) {
    const trend = this._trends[errorCode];
    if (!trend) return false;
    const uniqueSessions = new Set(trend.occurrences.map(o => o.session));
    return uniqueSessions.size >= 3;
  }

  /**
   * Check if a strategy should be escalated (2+ consecutive failures with same strategy).
   * @param {string} errorCode
   * @param {string} strategy
   * @returns {boolean}
   */
  shouldEscalate(errorCode, strategy) {
    const trend = this._trends[errorCode];
    if (!trend) return false;

    const failures = trend.occurrences.filter(o => !o.fixed && o.strategy === strategy);
    return failures.length >= 2;
  }

  /**
   * Get context for a fix prompt (bridges memory → smart-fix).
   * @param {string} errorCode
   * @returns {{ errorTrending: object|null, projectContext: object, userPrefs: object }}
   */
  getContextForFix(errorCode) {
    const trend = this._trends[errorCode];

    return {
      errorTrending: trend ? {
        total: trend.total,
        success_rate: trend.success_rate,
        last_seen: trend.last_seen,
        systemic: this.isSystemic(errorCode),
        previousStrategies: [...new Set(trend.occurrences.map(o => o.strategy))],
      } : null,
    };
  }

  /**
   * Get a systemic warning for injection into prompts.
   * @param {string} errorCode
   * @returns {string|null}
   */
  getSystemicWarning(errorCode) {
    if (!this.isSystemic(errorCode)) return null;

    const trend = this._trends[errorCode];
    const uniqueSessions = new Set(trend.occurrences.map(o => o.session));
    const strategies = [...new Set(trend.occurrences.map(o => o.strategy))];

    return `\n⚠ SYSTEMIC: Error "${errorCode}" has recurred across ${uniqueSessions.size} sessions. Previous strategies tried: ${strategies.join(', ')}. Try a fundamentally different approach.`;
  }

  /**
   * Export trends data for persistence (to project.json).
   * @returns {object}
   */
  exportTrends() {
    return { ...this._trends };
  }

  /**
   * Import trends from persisted data.
   * @param {object} data
   */
  importTrends(data) {
    if (data && typeof data === 'object') {
      this._trends = { ...data };
    }
  }
}

module.exports = { SmartFixBridge };
