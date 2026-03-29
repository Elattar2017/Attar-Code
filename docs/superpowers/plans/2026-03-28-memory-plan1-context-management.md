# Memory Enhancement Plan 1: Context Management (Layer 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current single-cliff context compression with adaptive observation masking, tiered compression, rolling summaries, and turn tracking — saving ~10K tokens per session while preserving important context.

**Architecture:** A new `memory/session-manager.js` module manages the context lifecycle. It tracks turns with metadata, masks old tool outputs adaptively, compresses at progressive thresholds (40%/60%/80%/95%), and maintains a rolling summary that survives compaction. A new `memory/context-budget.js` handles adaptive budget allocation based on model size. Both modules replace `enforceContextBudget()` (lines 1575-1618) and `compressContext()` (lines 1623-1704) in attar-code.js.

**Spec deviation note:** The spec says Tier 2 uses "LLM summarizes old turns." This plan uses deterministic summarization instead (tool actions + files + key decisions). Reason: LLM summarization adds 3-5s latency during compression and requires Ollama availability. Deterministic summaries are instant, predictable, and sufficient for context management. LLM-quality summaries can be added in Plan 3 (memory extraction) if needed.

**Deferred to Plan 2:** The `_topic` field on message metadata (used by topic drift detection in working-memory.js). Not needed for Plan 1's masking/compression logic.

**Tech Stack:** Node.js, Jest, existing `estimateTokens()` function, existing hook system

**This is Plan 1 of 3.** Plan 2 covers Layer 1 (Working Memory + Reinforcement). Plan 3 covers Layer 3 (Long-Term Memory + Extraction + Smart-Fix Bridge).

---

## File Structure

### Files to Create

| File | Responsibility |
|------|---------------|
| `memory/context-budget.js` | Model tier detection, adaptive budget allocation, compression thresholds |
| `memory/session-manager.js` | Turn tracking, observation masking, tiered compression, rolling summaries |
| `memory/tests/context-budget.test.js` | Tests for budget allocation |
| `memory/tests/session-manager.test.js` | Tests for masking + compression |

### Files to Modify

| File | Changes |
|------|---------|
| `attar-code.js:1562-1618` | Replace `getMaxInputTokens()` + `enforceContextBudget()` with context-budget.js |
| `attar-code.js:1623-1704` | Replace `compressContext()` with session-manager.js |
| `attar-code.js:6767-6776` | Wire new modules into the chat loop |
| `package.json` | Add test script for memory tests |

---

## Task 1: Context Budget Module

**Files:**
- Create: `memory/context-budget.js`
- Create: `memory/tests/context-budget.test.js`

This module determines how much context budget each component gets, based on the active model's context window size.

- [ ] **Step 1: Create test file**

Create `memory/tests/context-budget.test.js`:

```javascript
'use strict';

const { ContextBudget } = require('../context-budget');

describe('ContextBudget', () => {
  describe('tier detection', () => {
    test('classifies 8192 as small', () => {
      const b = new ContextBudget(8192);
      expect(b.tier).toBe('small');
    });

    test('classifies 16384 as small (boundary)', () => {
      const b = new ContextBudget(16384);
      expect(b.tier).toBe('small');
    });

    test('classifies 32768 as medium', () => {
      const b = new ContextBudget(32768);
      expect(b.tier).toBe('medium');
    });

    test('classifies 65536 as medium (boundary)', () => {
      const b = new ContextBudget(65536);
      expect(b.tier).toBe('medium');
    });

    test('classifies 131072 as large', () => {
      const b = new ContextBudget(131072);
      expect(b.tier).toBe('large');
    });
  });

  describe('budget allocation', () => {
    test('response reserve is 25% of total', () => {
      const b = new ContextBudget(40000);
      expect(b.responseReserve).toBe(10000);
    });

    test('available input is 75% of total', () => {
      const b = new ContextBudget(40000);
      expect(b.availableInput).toBe(30000);
    });

    test('small model: system prompt budget is ~400', () => {
      const b = new ContextBudget(8192);
      expect(b.systemPromptBudget).toBeGreaterThanOrEqual(300);
      expect(b.systemPromptBudget).toBeLessThanOrEqual(500);
    });

    test('large model: system prompt budget is ~600', () => {
      const b = new ContextBudget(131072);
      expect(b.systemPromptBudget).toBeGreaterThanOrEqual(500);
      expect(b.systemPromptBudget).toBeLessThanOrEqual(700);
    });

    test('conversation budget is the remainder after fixed allocations', () => {
      const b = new ContextBudget(40000);
      const fixed = b.systemPromptBudget + b.anchorBudget + b.reinforcementBudget + b.memoryBudget;
      expect(b.conversationBudget).toBe(b.availableInput - fixed);
    });
  });

  describe('compression thresholds', () => {
    test('small model masks earlier (35%)', () => {
      const b = new ContextBudget(8192);
      expect(b.thresholds.mask).toBe(0.35);
    });

    test('medium model masks at 40%', () => {
      const b = new ContextBudget(32768);
      expect(b.thresholds.mask).toBe(0.40);
    });

    test('large model masks at 50%', () => {
      const b = new ContextBudget(131072);
      expect(b.thresholds.mask).toBe(0.50);
    });

    test('all tiers have 4 thresholds in ascending order', () => {
      const b = new ContextBudget(32768);
      const t = b.thresholds;
      expect(t.mask).toBeLessThan(t.summarize);
      expect(t.summarize).toBeLessThan(t.extract);
      expect(t.extract).toBeLessThan(t.compact);
    });
  });

  describe('shouldCompress', () => {
    test('returns null when under mask threshold', () => {
      const b = new ContextBudget(40000);
      expect(b.shouldCompress(5000)).toBeNull();
    });

    test('returns "mask" when between mask and summarize thresholds', () => {
      const b = new ContextBudget(40000);
      // 40% of 30000 (available) = 12000
      expect(b.shouldCompress(13000)).toBe('mask');
    });

    test('returns "compact" when above compact threshold', () => {
      const b = new ContextBudget(40000);
      // 95% of 30000 = 28500
      expect(b.shouldCompress(29000)).toBe('compact');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/context-budget.test.js --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Create directory and implement**

Run: `mkdir -p memory/tests`

Create `memory/context-budget.js`:

```javascript
'use strict';

/**
 * context-budget.js — Adaptive context budget allocation based on model size.
 *
 * Determines how much of the context window each component gets:
 * - System prompt
 * - Layer 1: Task anchor + instructions (Plan 2)
 * - Layer 1: End-of-context reinforcement (Plan 2)
 * - Retrieved memories (Plan 3)
 * - Conversation history (remainder)
 *
 * Also provides tiered compression thresholds that trigger
 * observation masking, summarization, and compaction.
 */

const TIER_CONFIG = {
  small: {
    // <= 16384 context tokens
    systemPrompt:   400,
    anchor:         300,
    reinforcement:  200,
    memory:         500,
    thresholds: { mask: 0.35, summarize: 0.50, extract: 0.70, compact: 0.90 },
  },
  medium: {
    // 16385 - 65536
    systemPrompt:   500,
    anchor:         500,
    reinforcement:  300,
    memory:         1000,
    thresholds: { mask: 0.40, summarize: 0.60, extract: 0.80, compact: 0.95 },
  },
  large: {
    // > 65536
    systemPrompt:   600,
    anchor:         800,
    reinforcement:  400,
    memory:         1500,
    thresholds: { mask: 0.50, summarize: 0.70, extract: 0.85, compact: 0.95 },
  },
};

class ContextBudget {
  /**
   * @param {number} numCtx  Total context window size in tokens
   */
  constructor(numCtx) {
    this.numCtx = numCtx;
    this.tier = numCtx <= 16384 ? 'small' : numCtx <= 65536 ? 'medium' : 'large';

    const config = TIER_CONFIG[this.tier];

    // Reserve 25% for model response
    this.responseReserve = Math.floor(numCtx * 0.25);
    this.availableInput  = numCtx - this.responseReserve;

    // Fixed allocations
    this.systemPromptBudget   = config.systemPrompt;
    this.anchorBudget         = config.anchor;
    this.reinforcementBudget  = config.reinforcement;
    this.memoryBudget         = config.memory;

    // Conversation gets the remainder
    const fixed = this.systemPromptBudget + this.anchorBudget + this.reinforcementBudget + this.memoryBudget;
    this.conversationBudget = this.availableInput - fixed;

    // Compression thresholds (fraction of availableInput)
    this.thresholds = { ...config.thresholds };
  }

  /**
   * Determine what compression action is needed based on current token usage.
   *
   * @param {number} currentTokens  Current total tokens used (sys + messages + tools)
   * @returns {string|null}  'mask' | 'summarize' | 'extract' | 'compact' | null
   */
  shouldCompress(currentTokens) {
    const usage = currentTokens / this.availableInput;

    if (usage >= this.thresholds.compact)   return 'compact';
    if (usage >= this.thresholds.extract)   return 'extract';
    if (usage >= this.thresholds.summarize) return 'summarize';
    if (usage >= this.thresholds.mask)      return 'mask';
    return null;
  }

  /**
   * Get a plain object summary of the budget (for debugging/logging).
   * @returns {object}
   */
  toJSON() {
    return {
      tier: this.tier,
      numCtx: this.numCtx,
      availableInput: this.availableInput,
      systemPromptBudget: this.systemPromptBudget,
      anchorBudget: this.anchorBudget,
      reinforcementBudget: this.reinforcementBudget,
      memoryBudget: this.memoryBudget,
      conversationBudget: this.conversationBudget,
      thresholds: this.thresholds,
    };
  }
}

module.exports = { ContextBudget, TIER_CONFIG };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/context-budget.test.js --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add memory/context-budget.js memory/tests/context-budget.test.js
git commit -m "feat(memory): add adaptive context budget module with model-tier detection"
```

---

## Task 2: Session Manager — Turn Tracking

**Files:**
- Create: `memory/session-manager.js`
- Create: `memory/tests/session-manager.test.js`

Start with the core turn tracking and token estimation. Masking and compression come in Tasks 3-4.

- [ ] **Step 1: Create test file for turn tracking**

Create `memory/tests/session-manager.test.js`:

```javascript
'use strict';

const { SessionManager } = require('../session-manager');

describe('SessionManager — turn tracking', () => {
  let sm;

  beforeEach(() => {
    sm = new SessionManager({ numCtx: 40960 });
  });

  describe('addMessage', () => {
    test('assigns incrementing turn numbers', () => {
      sm.addMessage({ role: 'user', content: 'hello' });
      sm.addMessage({ role: 'assistant', content: 'hi' });
      const msgs = sm.getMessages();
      expect(msgs[0]._turn).toBe(1);
      expect(msgs[1]._turn).toBe(1); // same turn (user+assistant pair)
    });

    test('new user message starts a new turn', () => {
      sm.addMessage({ role: 'user', content: 'hello' });
      sm.addMessage({ role: 'assistant', content: 'hi' });
      sm.addMessage({ role: 'user', content: 'next question' });
      const msgs = sm.getMessages();
      expect(msgs[2]._turn).toBe(2);
    });

    test('tool messages belong to the current turn', () => {
      sm.addMessage({ role: 'user', content: 'read file' });
      sm.addMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] });
      sm.addMessage({ role: 'tool', content: 'file content here...' });
      const msgs = sm.getMessages();
      expect(msgs[2]._turn).toBe(1);
    });

    test('estimates tokens for each message', () => {
      sm.addMessage({ role: 'user', content: 'hello world' });
      const msgs = sm.getMessages();
      expect(msgs[0]._tokens).toBeGreaterThan(0);
    });
  });

  describe('getTotalTokens', () => {
    test('returns sum of all message tokens', () => {
      sm.addMessage({ role: 'user', content: 'hello world' });
      sm.addMessage({ role: 'assistant', content: 'hi there friend' });
      expect(sm.getTotalTokens()).toBeGreaterThan(0);
    });

    test('returns 0 for empty messages', () => {
      expect(sm.getTotalTokens()).toBe(0);
    });
  });

  describe('getCurrentTurn', () => {
    test('returns 0 with no messages', () => {
      expect(sm.getCurrentTurn()).toBe(0);
    });

    test('returns current turn number', () => {
      sm.addMessage({ role: 'user', content: 'q1' });
      sm.addMessage({ role: 'assistant', content: 'a1' });
      sm.addMessage({ role: 'user', content: 'q2' });
      expect(sm.getCurrentTurn()).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/session-manager.test.js --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionManager with turn tracking**

Create `memory/session-manager.js`:

```javascript
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

      // Large results (>500 tokens): mask if model already responded
      if (tokens > 500 && age >= 1) {
        const original = msg.content;
        msg.content = maskToolResult(msg);
        msg._tokens = estimateTokens(msg.content) + 10;
        msg._masked = true;
        tokensSaved += estimateTokens(original) - msg._tokens;
        continue;
      }

      // Small results (<500 tokens): mask after 3 turns
      if (tokens <= 500 && age >= 3) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/session-manager.test.js --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add memory/session-manager.js memory/tests/session-manager.test.js
git commit -m "feat(memory): add session manager with turn tracking"
```

---

## Task 3: Session Manager — Observation Masking Tests

**Files:**
- Modify: `memory/tests/session-manager.test.js`

Add masking-specific tests.

- [ ] **Step 1: Add masking tests to the test file**

Append to `memory/tests/session-manager.test.js`:

```javascript
describe('SessionManager — observation masking', () => {
  let sm;

  beforeEach(() => {
    sm = new SessionManager({ numCtx: 40960 });
  });

  test('does not mask tool results from current turn', () => {
    sm.addMessage({ role: 'user', content: 'read the file' });
    sm.addMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] });
    sm.addMessage({ role: 'tool', content: 'A'.repeat(1000), _toolName: 'read_file', _toolArgs: 'big.js' });
    const saved = sm.applyMasking();
    expect(saved).toBe(0); // same turn, don't mask
  });

  test('masks large tool results (>500 tokens) after model responds', () => {
    // Turn 1: large tool result
    sm.addMessage({ role: 'user', content: 'read the file' });
    sm.addMessage({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] });
    sm.addMessage({ role: 'tool', content: 'x\n'.repeat(500), _toolName: 'read_file', _toolArgs: 'big.js' });
    sm.addMessage({ role: 'assistant', content: 'I read the file, here is what I found...' });

    // Turn 2: new user message (advances turn)
    sm.addMessage({ role: 'user', content: 'now do something else' });

    const saved = sm.applyMasking();
    expect(saved).toBeGreaterThan(0);

    const toolMsg = sm.getMessages().find(m => m.role === 'tool');
    expect(toolMsg._masked).toBe(true);
    expect(toolMsg.content).toContain('[read_file]');
    expect(toolMsg.content.length).toBeLessThan(200);
  });

  test('keeps small tool results for 3 turns before masking', () => {
    // Turn 1: small tool result
    sm.addMessage({ role: 'user', content: 'check something' });
    sm.addMessage({ role: 'tool', content: 'ok done', _toolName: 'edit_file', _toolArgs: 'a.js' });
    sm.addMessage({ role: 'assistant', content: 'done' });

    // Turn 2
    sm.addMessage({ role: 'user', content: 'q2' });
    sm.addMessage({ role: 'assistant', content: 'a2' });

    // Turn 3 — still within 3-turn window
    sm.addMessage({ role: 'user', content: 'q3' });
    sm.applyMasking();
    const msgs2 = sm.getMessages();
    const toolMsg2 = msgs2.find(m => m.role === 'tool');
    expect(toolMsg2._masked).toBe(false); // age=2, keep

    // Turn 4 — now past 3-turn window
    sm.addMessage({ role: 'assistant', content: 'a3' });
    sm.addMessage({ role: 'user', content: 'q4' });
    sm.applyMasking();
    const msgs3 = sm.getMessages();
    const toolMsg3 = msgs3.find(m => m.role === 'tool');
    expect(toolMsg3._masked).toBe(true); // age=3, mask
  });

  test('keeps error results full for 5 turns', () => {
    sm.addMessage({ role: 'user', content: 'run build' });
    sm.addMessage({ role: 'tool', content: 'Error: module not found\nSTDERR: compilation failed', _toolName: 'build_and_test' });
    sm.addMessage({ role: 'assistant', content: 'build failed' });

    // Advance 4 turns
    for (let i = 0; i < 4; i++) {
      sm.addMessage({ role: 'user', content: `q${i + 2}` });
      sm.addMessage({ role: 'assistant', content: `a${i + 2}` });
    }

    sm.applyMasking();
    const toolMsg = sm.getMessages().find(m => m.role === 'tool');
    expect(toolMsg._masked).toBe(false); // age=4, error keeps for 5
  });

  test('maskToolResult generates correct summary for read_file', () => {
    const { maskToolResult } = require('../session-manager');
    const result = maskToolResult({
      content: 'const x = 1;\nconst y = 2;\nconst z = 3;',
      _toolName: 'read_file',
      _toolArgs: 'src/index.js',
    });
    expect(result).toContain('[read_file]');
    expect(result).toContain('src/index.js');
    expect(result).toContain('3 lines');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/session-manager.test.js --no-coverage`
Expected: PASS (all turn tracking + masking tests)

- [ ] **Step 3: Commit**

```bash
git add memory/tests/session-manager.test.js
git commit -m "test(memory): add observation masking tests"
```

---

## Task 4: Session Manager — Compression Tests

**Files:**
- Modify: `memory/tests/session-manager.test.js`

Add compression-specific tests.

- [ ] **Step 1: Add compression tests**

Append to `memory/tests/session-manager.test.js`:

```javascript
describe('SessionManager — tiered compression', () => {
  test('compress returns null when context is under threshold', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'hello' });
    const result = sm.compress(500, 200);
    expect(result.action).toBeNull();
    expect(result.tokensSaved).toBe(0);
  });

  test('summarizeOldTurns keeps first + last 8 messages', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    // Add 15 messages
    for (let i = 0; i < 15; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}: ${'x'.repeat(100)}` });
    }

    const saved = sm._summarizeOldTurns();
    const msgs = sm.getMessages();
    // Should be: first + summary + last 8 = 10
    expect(msgs.length).toBe(10);
    expect(msgs[1].content).toContain('[SESSION SUMMARY');
  });

  test('fullCompaction keeps first + summary + last 4', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    for (let i = 0; i < 20; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}: ${'x'.repeat(100)}` });
    }

    const saved = sm._fullCompaction();
    const msgs = sm.getMessages();
    // Should be: first + summary + last 4 = 6
    expect(msgs.length).toBe(6);
    expect(msgs[1].content).toContain('[SESSION SUMMARY');
  });

  test('rolling summary merges across compressions', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    // Fill with messages
    for (let i = 0; i < 15; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Batch1 msg ${i}: ${'y'.repeat(100)}` });
    }
    sm._summarizeOldTurns();
    const firstSummary = sm._rollingSummary;
    expect(firstSummary).toBeTruthy();

    // Add more messages
    for (let i = 0; i < 10; i++) {
      sm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Batch2 msg ${i}: ${'z'.repeat(100)}` });
    }
    sm._fullCompaction();

    // Rolling summary should contain info from both batches
    expect(sm._rollingSummary.length).toBeGreaterThan(firstSummary.length);
  });

  test('getMessagesForOllama strips internal metadata', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'hello' });
    sm.addMessage({ role: 'assistant', content: 'hi' });

    const clean = sm.getMessagesForOllama();
    for (const msg of clean) {
      expect(msg).not.toHaveProperty('_turn');
      expect(msg).not.toHaveProperty('_tokens');
      expect(msg).not.toHaveProperty('_masked');
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  test('_buildSummary extracts tool actions and files', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    const trimmed = [
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"filepath":"src/a.js"}' } }] },
      { role: 'tool', content: '✓ file read' },
      { role: 'assistant', content: 'I found the issue in the authentication logic' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: '{"filepath":"src/a.js"}' } }] },
      { role: 'tool', content: '✓ edit applied' },
    ];
    const summary = sm._buildSummary(trimmed);
    expect(summary).toContain('read_file');
    expect(summary).toContain('edit_file');
    expect(summary).toContain('src/a.js');
    expect(summary).toContain('2 successes');
  });
});
```

- [ ] **Step 2: Run all session-manager tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/session-manager.test.js --no-coverage`
Expected: PASS (all tests — turn tracking + masking + compression)

- [ ] **Step 3: Commit**

```bash
git add memory/tests/session-manager.test.js
git commit -m "test(memory): add tiered compression tests"
```

---

## Task 5: Wire Into attar-code.js

**Files:**
- Modify: `attar-code.js:1575-1618` — Replace `enforceContextBudget()`
- Modify: `attar-code.js:1623-1704` — Replace `compressContext()`
- Modify: `attar-code.js:6767-6776` — Wire new modules into chat loop

This is the integration task. The new modules replace the old functions while maintaining all existing behavior.

- [ ] **Step 1: Add require at top of attar-code.js**

Find the requires section near the top of `attar-code.js` (after other requires) and add:

```javascript
// Memory system modules
let SessionManager, ContextBudget;
try {
  ({ SessionManager } = require('./memory/session-manager'));
  ({ ContextBudget } = require('./memory/context-budget'));
} catch (_) { /* graceful degradation — old system still works */ }
```

- [ ] **Step 2: Initialize SessionManager in SESSION**

After the SESSION object initialization (around line 492), add:

```javascript
// Initialize session manager (if memory modules available)
let sessionManager = SessionManager ? new SessionManager({ numCtx: CONFIG.numCtx }) : null;
```

- [ ] **Step 3: Replace the chat loop wiring — sync-from-SESSION approach**

**Key design decision:** Instead of modifying 30+ individual `SESSION.messages.push()` sites throughout the tool handler, the sessionManager **syncs from `SESSION.messages` at the start of each chat loop iteration**. This is ONE sync point that handles all message sources (tools, user, assistant, /rewind, /load, /clear).

Find the chat loop section (around line 6767):

```javascript
// OLD (two lines):
const compressedMessages = compressContext(SESSION.messages);
enforceContextBudget(sysPrompt, compressedMessages, selectedTools);
```

Replace with:

```javascript
      // Context management: sync SESSION.messages → sessionManager → compress → output
      let compressedMessages;
      if (sessionManager) {
        // ALWAYS sync from SESSION.messages (handles /rewind, /load, /clear, and all tool pushes)
        sessionManager.syncFromSession(SESSION.messages);

        // Apply tiered compression
        const sysTokens = estimateTokens(sysPrompt);
        const toolTokens = estimateTokens(JSON.stringify(selectedTools));
        const { action, tokensSaved } = sessionManager.compress(sysTokens, toolTokens, hookEngine);
        if (action) {
          debugLog(`Context ${action}: saved ${tokensSaved} tokens`);
        }

        compressedMessages = sessionManager.getMessagesForOllama();
        // Write back compressed state to SESSION.messages
        SESSION.messages = sessionManager.getMessages();
      } else {
        // Fallback to old system
        compressedMessages = compressContext(SESSION.messages);
        enforceContextBudget(sysPrompt, compressedMessages, selectedTools);
      }
```

This approach means:
- **No changes needed at 30+ tool push sites** — they push to SESSION.messages as before
- **`/rewind`, `/load`, `/clear` automatically handled** — they modify SESSION.messages, sessionManager picks up the new state on next sync
- **One sync point** — at the top of each chat loop iteration

- [ ] **Step 4: Add `syncFromSession()` method to SessionManager**

Add this method to `memory/session-manager.js` in the SessionManager class (after `setMessages`):

```javascript
  /**
   * Sync internal state from SESSION.messages array.
   * Detects new messages (not yet tagged) and tags them.
   * Detects external resets (/rewind, /load, /clear) by comparing array identity/length.
   *
   * @param {Array} sessionMessages  The SESSION.messages array from attar-code.js
   */
  syncFromSession(sessionMessages) {
    // Detect external reset: if session messages shrunk or changed entirely
    if (sessionMessages.length < this._messages.length - 2 || // shrunk significantly (allow 1-2 message fluctuation)
        (sessionMessages.length > 0 && this._messages.length > 0 &&
         sessionMessages[0] !== this._messages[0] && sessionMessages[0]?.content !== this._messages[0]?.content)) {
      // External reset detected (/rewind, /load, /clear) — re-sync entirely
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
```

- [ ] **Step 5: Add test for syncFromSession**

Add to `memory/tests/session-manager.test.js`:

```javascript
describe('SessionManager — syncFromSession', () => {
  test('picks up new messages appended to session array', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    const sessionMsgs = [
      { role: 'user', content: 'hello' },
    ];
    sm.syncFromSession(sessionMsgs);
    expect(sm.getMessages()).toHaveLength(1);
    expect(sm.getCurrentTurn()).toBe(1);

    // Simulate tool handler pushing to session array
    sessionMsgs.push({ role: 'assistant', content: 'hi' });
    sessionMsgs.push({ role: 'user', content: 'next' });
    sm.syncFromSession(sessionMsgs);
    expect(sm.getMessages()).toHaveLength(3);
    expect(sm.getCurrentTurn()).toBe(2);
  });

  test('detects /clear (empty array) and resets', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'hello' });
    sm.addMessage({ role: 'assistant', content: 'hi' });
    expect(sm.getMessages()).toHaveLength(2);

    // Simulate /clear
    sm.syncFromSession([]);
    expect(sm.getMessages()).toHaveLength(0);
    expect(sm.getCurrentTurn()).toBe(0);
  });

  test('detects /rewind (messages shrunk) and re-syncs', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    const fullSession = [];
    for (let i = 0; i < 10; i++) {
      const msg = { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` };
      fullSession.push(msg);
      sm.addMessage(msg);
    }
    expect(sm.getMessages()).toHaveLength(10);

    // Simulate /rewind — session restored to 4 messages
    const rewound = fullSession.slice(0, 4);
    sm.syncFromSession(rewound);
    expect(sm.getMessages()).toHaveLength(4);
  });

  test('detects /load (different first message) and re-syncs', () => {
    const sm = new SessionManager({ numCtx: 40960 });
    sm.addMessage({ role: 'user', content: 'original session' });

    // Simulate /load — completely different messages
    const loaded = [
      { role: 'user', content: 'loaded session' },
      { role: 'assistant', content: 'response from loaded session' },
    ];
    sm.syncFromSession(loaded);
    expect(sm.getMessages()).toHaveLength(2);
    expect(sm.getMessages()[0].content).toBe('loaded session');
  });
});
```

- [ ] **Step 6: Handle /model change**

Find the `/model` slash command handler. After CONFIG.numCtx is updated, add:

```javascript
if (sessionManager) sessionManager.updateBudget(CONFIG.numCtx);
```

- [ ] **Step 7: Run all tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/ --no-coverage && npx jest --no-coverage 2>&1 | tail -5`
Expected: All memory tests pass + all existing tests pass

- [ ] **Step 8: Manual smoke test**

Start the CLI and verify:
1. Basic conversation works
2. Tool calls work (read_file, run_bash)
3. After 10+ tool calls, check debug output shows masking
4. `/model` command updates the budget
5. `/clear` then new conversation — no stale state
6. `/rewind` — masking state resets correctly

- [ ] **Step 9: Commit**

```bash
git add attar-code.js memory/session-manager.js memory/tests/session-manager.test.js
git commit -m "feat(memory): wire session manager into chat loop with sync-from-SESSION approach"
```

---

## Summary

| Task | Files | Tests | What it does |
|---|---|---|---|
| 1 | context-budget.js | ~15 | Model tier detection, adaptive thresholds |
| 2 | session-manager.js | ~8 | Turn tracking, message metadata |
| 3 | session-manager.test.js | ~5 | Observation masking behavior |
| 4 | session-manager.test.js | ~6 | Tiered compression behavior |
| 5 | attar-code.js | existing | Wire modules into chat loop |

**Total: ~34 new tests, 2 new files, 1 modified file.**

**What changes for the user after Plan 1:**
- Old tool outputs get masked automatically → ~10K tokens saved per session
- Compression happens gradually (not all at once at 20 messages)
- Budget adapts when switching models via `/model`
- Rolling summaries preserve important context across compressions
- All existing behavior preserved as fallback

**Next plans:**
- Plan 2: Layer 1 — Working Memory + Reinforcement (task anchor, corrections, recovery directives)
- Plan 3: Layer 3 — Long-Term Memory + Extraction + Smart-Fix Bridge (Qdrant archive, model-driven extraction, error trending)
