'use strict';

/**
 * session-manager.js — Manages the conversation context lifecycle.
 *
 * Responsibilities:
 *   1. Turn tracking — each message tagged with turn number + token estimate
 *   2. Observation masking — replace old tool outputs with summaries
 *   3. Tiered compression — gradual compression at progressive thresholds
 *   4. Rolling summary — maintained across compressions
 *
 * Replaces: enforceContextBudget() + compressContext() in attar-code.js
 */

const { ContextBudget } = require('./context-budget');

// ── Token estimation (mirrored from attar-code.js:1564-1573) ──────────────
function estimateTokens(text) {
  if (!text) return 0;
  const len = text.length;
  const specialChars = (text.match(/[{}\[\]();:=<>\/\\,\n\t"'`|&!@#$%^*~?]/g) || []).length;
  const codeRatio = specialChars / Math.max(len, 1);
  const charsPerToken = codeRatio > 0.08 ? 3.0 : 3.8;
  return Math.ceil(len / charsPerToken);
}

// ── Masking helpers ────────────────────────────────────────────────────────

/**
 * Generate a short summary of a tool result for masking.
 * @param {object} msg  Tool message with content and optional _toolName/_toolArgs
 * @returns {string}
 */
function maskToolResult(msg) {
  const content = msg.content || '';
  const toolName = msg._toolName || 'tool';
  const toolArgs = msg._toolArgs || '';
  const lines = content.split('\n').length;
  const chars = content.length;

  // Extract meaningful summary based on tool type
  if (toolName === 'read_file') {
    const firstLine = content.split('\n')[0].slice(0, 80);
    return `[${toolName}] ${toolArgs} → ✓ ${lines} lines (${firstLine}...)`;
  }
  if (toolName === 'run_bash' || toolName === 'build_and_test') {
    const hasError = /error|fail|stderr/i.test(content);
    const status = hasError ? '✗ errors' : '✓ success';
    return `[${toolName}] → ${status} (${lines} lines output)`;
  }
  if (toolName === 'grep_search' || toolName === 'find_files') {
    const matchCount = (content.match(/\n/g) || []).length;
    return `[${toolName}] ${toolArgs} → ${matchCount} matches`;
  }
  if (toolName === 'write_file' || toolName === 'edit_file') {
    return `[${toolName}] ${toolArgs} → ✓ done`;
  }
  if (toolName === 'kb_search') {
    const chunkMatch = content.match(/Found (\d+)/);
    const count = chunkMatch ? chunkMatch[1] : '?';
    return `[${toolName}] ${toolArgs} → ${count} results`;
  }

  // Generic: first 100 chars
  return `[${toolName}] → ${chars > 100 ? content.slice(0, 100) + '...' : content} (${lines} lines)`;
}

// ── SessionManager ─────────────────────────────────────────────────────────

class SessionManager {
  /**
   * @param {object} opts
   * @param {number} opts.numCtx  Context window size
   */
  constructor(opts = {}) {
    this._messages = [];
    this._currentTurn = 0;
    this._budget = new ContextBudget(opts.numCtx || 40960);
    this._rollingSummary = '';
    this._lastMaskTurn = 0; // last turn where masking was applied
  }

  /**
   * Add a message to the conversation with turn tracking metadata.
   * @param {object} msg  { role, content, tool_calls?, _toolName?, _toolArgs? }
   */
  addMessage(msg) {
    // New turn starts on user messages (except the very first)
    if (msg.role === 'user') {
      this._currentTurn++;
    }

    const enriched = {
      ...msg,
      _turn: this._currentTurn,
      _tokens: estimateTokens(msg.content || '') + 10, // +10 for role/metadata overhead
      _masked: false,
      _addedAt: Date.now(),
    };

    this._messages.push(enriched);
    return enriched;
  }

  /**
   * Get all messages (with metadata).
   * @returns {Array}
   */
  getMessages() {
    return this._messages;
  }

  /**
   * Set messages directly (for loading saved sessions).
   * @param {Array} messages
   */
  setMessages(messages) {
    this._messages = messages.map((msg, i) => ({
      ...msg,
      _turn: msg._turn || 0,
      _tokens: msg._tokens || estimateTokens(msg.content || '') + 10,
      _masked: msg._masked || false,
    }));
    this._currentTurn = Math.max(0, ...this._messages.map(m => m._turn || 0));
  }

  /**
   * Sync internal state from SESSION.messages array.
   * Detects new messages (not yet tagged) and tags them.
   * Detects external resets (/rewind, /load, /clear) by comparing array length/content.
   *
   * @param {Array} sessionMessages  The SESSION.messages array from attar-code.js
   */
  syncFromSession(sessionMessages) {
    // Detect external reset: if session messages shrunk or changed entirely
    if (sessionMessages.length === 0 ||
        sessionMessages.length < this._messages.length - 2 ||
        (sessionMessages.length > 0 && this._messages.length > 0 &&
         sessionMessages[0] !== this._messages[0] && sessionMessages[0]?.content !== this._messages[0]?.content)) {
      this.setMessages(sessionMessages);
      return;
    }

    // Detect new messages appended since last sync
    const knownCount = this._messages.length;
    if (sessionMessages.length > knownCount) {
      const newMessages = sessionMessages.slice(knownCount);
      for (const msg of newMessages) {
        this.addMessage(msg);
      }
    }
  }

  /**
   * Get the current turn number.
   * @returns {number}
   */
  getCurrentTurn() {
    return this._currentTurn;
  }

  /**
   * Get total tokens used by all messages.
   * @returns {number}
   */
  getTotalTokens() {
    return this._messages.reduce((sum, m) => sum + (m._tokens || 0), 0);
  }

  /**
   * Get the context budget instance.
   * @returns {ContextBudget}
   */
  getBudget() {
    return this._budget;
  }

  /**
   * Update budget when model changes.
   * @param {number} numCtx
   */
  updateBudget(numCtx) {
    this._budget = new ContextBudget(numCtx);
  }

  // ── Observation Masking ──────────────────────────────────────────────────

  /**
   * Apply observation masking to old tool results.
   *
   * Rules:
   * - >500 tokens AND model already responded → mask immediately
   * - <500 tokens AND model already responded → mask after 3 turns
   * - Error results → keep full for 5 turns
   * - Current turn → always keep full
   *
   * @returns {number} tokens saved
   */
  applyMasking() {
    const currentTurn = this._currentTurn;
    let tokensSaved = 0;

    for (const msg of this._messages) {
      if (msg._masked) continue;
      if (msg.role !== 'tool') continue;
      if (msg._turn >= currentTurn) continue; // current turn: keep full

      const age = currentTurn - msg._turn;
      const tokens = msg._tokens || 0;
      const isError = /error|fail|stderr|BLOCKED|❌/i.test(msg.content || '');

      // Error results: keep full for 5 turns
      if (isError && age < 5) continue;

      // Large results (>500 chars of content): mask if model already responded
      if ((msg.content || '').length > 500 && age >= 1) {
        const original = msg.content;
        msg.content = maskToolResult(msg);
        msg._tokens = estimateTokens(msg.content) + 10;
        msg._masked = true;
        tokensSaved += estimateTokens(original) - msg._tokens;
        continue;
      }

      // Small results (<=500 chars of content): mask after 3 turns
      if ((msg.content || '').length <= 500 && age >= 3) {
        const original = msg.content;
        msg.content = maskToolResult(msg);
        msg._tokens = estimateTokens(msg.content) + 10;
        msg._masked = true;
        tokensSaved += estimateTokens(original) - msg._tokens;
      }
    }

    return tokensSaved;
  }

  // ── Tiered Compression ───────────────────────────────────────────────────

  /**
   * Check context usage and apply appropriate compression tier.
   *
   * @param {number} sysTokens    Tokens used by system prompt
   * @param {number} toolTokens   Tokens used by tool definitions
   * @param {object} [hooks]      Optional hook engine for PreCompact/PostCompact
   * @returns {{ action: string|null, tokensSaved: number }}
   */
  compress(sysTokens = 0, toolTokens = 0, hooks = null) {
    const msgTokens = this.getTotalTokens();
    const total = sysTokens + toolTokens + msgTokens;
    const action = this._budget.shouldCompress(total);

    if (!action) return { action: null, tokensSaved: 0 };

    let tokensSaved = 0;

    switch (action) {
      case 'mask':
        tokensSaved = this.applyMasking();
        break;

      case 'summarize':
        // First mask, then summarize old turns
        tokensSaved = this.applyMasking();
        tokensSaved += this._summarizeOldTurns(hooks);
        break;

      case 'extract':
        // Mask + summarize + signal that memory extraction should happen
        tokensSaved = this.applyMasking();
        tokensSaved += this._summarizeOldTurns(hooks);
        // The caller (attar-code.js) should trigger memory extraction
        break;

      case 'compact':
        // Full compaction: mask + summarize everything down to last 4 turns
        tokensSaved = this.applyMasking();
        tokensSaved += this._fullCompaction(hooks);
        break;
    }

    return { action, tokensSaved };
  }

  /**
   * Summarize old conversation turns, keeping first message + last 8.
   * @param {object} [hooks]
   * @returns {number} tokens saved
   */
  _summarizeOldTurns(hooks) {
    if (this._messages.length <= 10) return 0;

    // Fire PreCompact hook
    if (hooks) {
      try {
        hooks.fire('PreCompact', {
          trigger: 'tiered',
          message_count: this._messages.length,
          action: 'summarize',
        }).catch(() => {});
      } catch (_) {}
    }

    const first = this._messages[0];
    const recent = this._messages.slice(-8);
    const trimmed = this._messages.slice(1, -8);

    if (trimmed.length === 0) return 0;

    const tokensBefore = trimmed.reduce((s, m) => s + (m._tokens || 0), 0);

    // Build summary from trimmed messages
    const summary = this._buildSummary(trimmed);

    // Update rolling summary
    this._rollingSummary = summary;

    const summaryMsg = {
      role: 'user',
      content: `[SESSION SUMMARY — updated at turn ${this._currentTurn}]\n${summary}\n[END SUMMARY]`,
      _turn: 0,
      _tokens: estimateTokens(summary) + 20,
      _masked: false,
      _isSummary: true,
    };

    this._messages = [first, summaryMsg, ...recent];

    const tokensAfter = summaryMsg._tokens;

    // Fire PostCompact hook
    if (hooks) {
      try {
        hooks.fire('PostCompact', {
          trigger: 'tiered',
          trimmed_count: trimmed.length,
          summary_text: summary,
        }).catch(() => {});
      } catch (_) {}
    }

    return Math.max(0, tokensBefore - tokensAfter);
  }

  /**
   * Full compaction: compress everything to rolling summary + last 4 turns.
   * @param {object} [hooks]
   * @returns {number} tokens saved
   */
  _fullCompaction(hooks) {
    if (this._messages.length <= 6) return 0;

    if (hooks) {
      try {
        hooks.fire('PreCompact', {
          trigger: 'full',
          message_count: this._messages.length,
          action: 'compact',
        }).catch(() => {});
      } catch (_) {}
    }

    const first = this._messages[0];
    const recent = this._messages.slice(-4);
    const trimmed = this._messages.slice(1, -4);

    const tokensBefore = trimmed.reduce((s, m) => s + (m._tokens || 0), 0);

    // Build comprehensive summary
    const newSummary = this._buildSummary(trimmed);

    // Merge with existing rolling summary
    const merged = this._rollingSummary
      ? this._rollingSummary + '\n• ' + newSummary.split('\n').filter(l => !this._rollingSummary.includes(l)).join('\n• ')
      : newSummary;

    this._rollingSummary = merged;

    const summaryMsg = {
      role: 'user',
      content: `[SESSION SUMMARY — updated at turn ${this._currentTurn}]\n${merged}\n[END SUMMARY]`,
      _turn: 0,
      _tokens: estimateTokens(merged) + 20,
      _masked: false,
      _isSummary: true,
    };

    this._messages = [first, summaryMsg, ...recent];

    if (hooks) {
      try {
        hooks.fire('PostCompact', {
          trigger: 'full',
          trimmed_count: trimmed.length,
          summary_text: merged,
        }).catch(() => {});
      } catch (_) {}
    }

    return Math.max(0, tokensBefore - summaryMsg._tokens);
  }

  /**
   * Build a summary string from an array of trimmed messages.
   * @param {Array} trimmed
   * @returns {string}
   */
  _buildSummary(trimmed) {
    const toolActions = [];
    const filesModified = new Set();
    const keyDecisions = [];
    let errorCount = 0;
    let successCount = 0;

    for (const msg of trimmed) {
      const content = msg.content || '';

      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || tc;
          toolActions.push(fn.name);
          try {
            const tArgs = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
            if (tArgs?.filepath) filesModified.add(tArgs.filepath);
            if (tArgs?.file_path) filesModified.add(tArgs.file_path);
          } catch (_) {}
        }
      }

      if (msg.role === 'tool') {
        if (/✓|✅|success/i.test(content)) successCount++;
        if (/❌|STDERR|Error|FAIL/i.test(content)) errorCount++;
      }

      if (msg.role === 'assistant' && content.length > 20 && !msg.tool_calls) {
        const firstSentence = content.split(/[.!?\n]/)[0].trim();
        if (firstSentence.length > 10 && firstSentence.length < 200) {
          keyDecisions.push(firstSentence);
        }
      }
    }

    const uniqueTools = [...new Set(toolActions)];
    const parts = [
      `Previous ${trimmed.length} messages summarized.`,
      uniqueTools.length > 0 ? `Tools used: ${uniqueTools.join(', ')}.` : '',
      filesModified.size > 0 ? `Files: ${[...filesModified].slice(0, 5).join(', ')}${filesModified.size > 5 ? ` (+${filesModified.size - 5} more)` : ''}.` : '',
      `Results: ${successCount} successes, ${errorCount} errors.`,
      keyDecisions.length > 0 ? `Key context: ${keyDecisions.slice(-3).join('; ')}.` : '',
    ].filter(Boolean);

    return parts.join('\n');
  }

  /**
   * Get messages ready for sending to Ollama (strips internal metadata).
   * @returns {Array}
   */
  getMessagesForOllama() {
    return this._messages.map(msg => {
      const { _turn, _tokens, _masked, _addedAt, _toolName, _toolArgs, _isSummary, ...clean } = msg;
      return clean;
    });
  }
}

module.exports = { SessionManager, estimateTokens, maskToolResult };
