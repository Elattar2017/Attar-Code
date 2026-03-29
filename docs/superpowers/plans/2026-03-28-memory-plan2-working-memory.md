# Memory Enhancement Plan 2: Working Memory + Reinforcement (Layer 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add task anchoring, correction tracking, recovery directives, and search repetition detection to prevent model drift — the exact problem where the model loses focus after errors and revisits old topics.

**Architecture:** A new `memory/working-memory.js` module builds a task anchor block that is injected at BOTH start and end of every prompt. It tracks the current task, status updates from tool results, user corrections, and resolved topics. The anchor block acts as guardrails that keep the model on track regardless of model size.

**Tech Stack:** Node.js, Jest. Depends on Plan 1's context-budget.js (already implemented).

**This is Plan 2 of 3.**

---

## File Structure

### Files to Create

| File | Responsibility |
|------|---------------|
| `memory/working-memory.js` | Task anchor builder, correction tracker, recovery directives, search repetition, topic drift |
| `memory/tests/working-memory.test.js` | Tests for all working memory functions |

### Files to Modify

| File | Changes |
|------|---------|
| `attar-code.js` | Inject anchor at prompt start + end, track corrections, recovery directives on tool errors, search repetition in kb_search |

---

## Task 1: Working Memory Module

**Files:**
- Create: `memory/working-memory.js`
- Create: `memory/tests/working-memory.test.js`

- [ ] **Step 1: Create test file**

Create `memory/tests/working-memory.test.js`:

```javascript
'use strict';

const { WorkingMemory } = require('../working-memory');

describe('WorkingMemory', () => {
  let wm;

  beforeEach(() => {
    wm = new WorkingMemory();
  });

  describe('task anchor', () => {
    test('setTask sets the current task', () => {
      wm.setTask('Create JSON schema validator in omar/');
      expect(wm.getAnchorBlock()).toContain('[TASK] Create JSON schema validator in omar/');
    });

    test('updateStatus appends to status trail', () => {
      wm.setTask('Build API');
      wm.updateStatus('Directory created');
      wm.updateStatus('File written');
      const block = wm.getAnchorBlock();
      expect(block).toContain('Directory created');
      expect(block).toContain('File written');
    });

    test('setNextStep sets the step hint', () => {
      wm.setTask('Build API');
      wm.setNextStep('Run tests');
      expect(wm.getAnchorBlock()).toContain('[STEP] Run tests');
    });

    test('anchor block contains all sections', () => {
      wm.setTask('Build API');
      wm.updateStatus('Files created');
      wm.setNextStep('Run build');
      wm.addCorrection('Use async/await not callbacks', 3);
      const block = wm.getAnchorBlock();
      expect(block).toContain('[TASK]');
      expect(block).toContain('[STATUS]');
      expect(block).toContain('[STEP]');
      expect(block).toContain('[CORRECTIONS]');
    });

    test('no task set returns minimal block', () => {
      const block = wm.getAnchorBlock();
      expect(block).toBe('');
    });
  });

  describe('corrections', () => {
    test('addCorrection stores correction with turn number', () => {
      wm.setTask('Build API');
      wm.addCorrection('Use pydantic not jsonschema', 5);
      expect(wm.getAnchorBlock()).toContain('Use pydantic not jsonschema');
    });

    test('max 5 corrections, oldest evicted', () => {
      wm.setTask('test');
      for (let i = 1; i <= 7; i++) {
        wm.addCorrection(`Correction ${i}`, i);
      }
      const block = wm.getAnchorBlock();
      expect(block).not.toContain('Correction 1');
      expect(block).not.toContain('Correction 2');
      expect(block).toContain('Correction 7');
    });

    test('getCorrections returns all corrections', () => {
      wm.addCorrection('fix A', 1);
      wm.addCorrection('fix B', 2);
      expect(wm.getCorrections()).toHaveLength(2);
    });
  });

  describe('DO NOT block', () => {
    test('addDoNot adds resolved topic', () => {
      wm.setTask('Build API');
      wm.addDoNot('Search for observability');
      expect(wm.getAnchorBlock()).toContain('[DO NOT]');
      expect(wm.getAnchorBlock()).toContain('observability');
    });

    test('max 3 entries, oldest evicted (LRU)', () => {
      wm.setTask('test');
      wm.addDoNot('Topic A');
      wm.addDoNot('Topic B');
      wm.addDoNot('Topic C');
      wm.addDoNot('Topic D');
      const block = wm.getAnchorBlock();
      expect(block).not.toContain('Topic A');
      expect(block).toContain('Topic D');
    });

    test('cleared when task changes', () => {
      wm.setTask('Task 1');
      wm.addDoNot('Old topic');
      wm.setTask('Task 2');
      expect(wm.getAnchorBlock()).not.toContain('Old topic');
    });
  });

  describe('recovery directive', () => {
    test('buildRecoveryDirective includes error and current task', () => {
      wm.setTask('Create JSON schema validator');
      const directive = wm.buildRecoveryDirective(
        'BLOCKED: Cannot write to CLI source file',
        'Write to C:\\Users\\Attar\\Desktop\\omar\\ instead'
      );
      expect(directive).toContain('[RECOVERY]');
      expect(directive).toContain('BLOCKED');
      expect(directive).toContain('Create JSON schema validator');
      expect(directive).toContain('CURRENT task');
      expect(directive).toContain('Do NOT change topic');
    });

    test('works without a current task', () => {
      const directive = wm.buildRecoveryDirective('Timeout', 'Try again');
      expect(directive).toContain('[RECOVERY]');
      expect(directive).toContain('Timeout');
    });
  });

  describe('search repetition', () => {
    test('recordSearch tracks queries', () => {
      wm.recordSearch('observability invalid data', 1, 'abc');
      wm.recordSearch('observability data choices', 1, 'abc');
      expect(wm.isSearchRepeating('observability invalid', 'abc')).toBe(false); // only 2, need 3
    });

    test('detects repetition after 3 similar queries with same results', () => {
      wm.recordSearch('observability invalid data', 1, 'hash1');
      wm.recordSearch('observability data choices', 1, 'hash1');
      wm.recordSearch('observability python book', 1, 'hash1');
      expect(wm.isSearchRepeating('observability error', 'hash1')).toBe(true);
    });

    test('does not flag as repeating with different result hashes', () => {
      wm.recordSearch('observability data', 1, 'hash1');
      wm.recordSearch('observability book', 1, 'hash2');
      wm.recordSearch('observability test', 1, 'hash3');
      expect(wm.isSearchRepeating('observability x', 'hash4')).toBe(false);
    });

    test('getSearchRepetitionWarning returns warning when repeating', () => {
      wm.recordSearch('observability invalid data', 5, 'h1');
      wm.recordSearch('observability data choices', 5, 'h1');
      wm.recordSearch('observability python book', 5, 'h1');
      const warning = wm.getSearchRepetitionWarning('observability error', 'h1');
      expect(warning).toContain('similar queries');
      expect(warning).toContain('Move on');
    });

    test('capped at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        wm.recordSearch(`query ${i}`, 1, `hash${i}`);
      }
      expect(wm._searchHistory.length).toBeLessThanOrEqual(20);
    });
  });

  describe('auto-update from tool results', () => {
    test('updateFromToolResult updates status for write_file', () => {
      wm.setTask('Create project');
      wm.updateFromToolResult('write_file', { filepath: 'src/app.js' }, '✓ File written');
      const block = wm.getAnchorBlock();
      expect(block).toContain('app.js');
    });

    test('updateFromToolResult updates status for build_and_test success', () => {
      wm.setTask('Fix build');
      wm.updateFromToolResult('build_and_test', {}, '✓ Build succeeded, 0 errors');
      expect(wm.getAnchorBlock()).toContain('Build succeeded');
    });

    test('updateFromToolResult updates status for build_and_test failure', () => {
      wm.setTask('Fix build');
      wm.updateFromToolResult('build_and_test', {}, '❌ 3 errors found');
      expect(wm.getAnchorBlock()).toContain('error');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/working-memory.test.js --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WorkingMemory**

Create `memory/working-memory.js`:

```javascript
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
    const similarCount = sameResultSearches.filter(s => jaccardSimilarity(s.query, newQuery) > 0.3).length;
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
        if (hasError) {
          const errorMatch = result.match(/(\d+)\s*error/i);
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
```

- [ ] **Step 4: Run tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/working-memory.test.js --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Task 2: Wire Working Memory Into attar-code.js

**Files:**
- Modify: `attar-code.js`

Four integration points:

- [ ] **Step 1: Add require and initialization**

Near the top of attar-code.js, after the existing memory module requires (after the `SessionManager`/`ContextBudget` try/catch block), add:

```javascript
let WorkingMemory;
try {
  ({ WorkingMemory } = require('./memory/working-memory'));
} catch (_) {}
```

After the `sessionManager` initialization line, add:

```javascript
let workingMemory = WorkingMemory ? new WorkingMemory() : null;
```

- [ ] **Step 2: Set task from first user message**

In the chat loop, BEFORE the system prompt building (before line ~6606 `let sysPrompt = CONFIG.systemPrompt`), add task detection:

```javascript
    // Auto-detect task from first user message of a new topic
    if (workingMemory && !workingMemory.getTask() && userMessage && userMessage.length > 10) {
      // First substantial user message becomes the task
      workingMemory.setTask(userMessage.length > 120 ? userMessage.slice(0, 120) + '...' : userMessage);
    }
```

- [ ] **Step 3: Inject anchor block at start of system prompt**

After the system prompt is built (after all the existing sysPrompt += injections, around where skills are injected), add:

```javascript
    // Layer 1: Working Memory — inject task anchor at START of prompt
    if (workingMemory) {
      const anchor = workingMemory.getAnchorBlock();
      if (anchor) {
        sysPrompt += '\n\n## Current Task Context:\n' + anchor;
      }
    }
```

- [ ] **Step 4: Inject anchor block at END of context (reinforcement)**

Find where the messages array is assembled for Ollama (the `reqBody` around line 6802):

```javascript
      const reqBody = {
        model:    CONFIG.model,
        messages: [{ role:"system", content: sysPrompt }, ...compressedMessages],
```

Replace with:

```javascript
      // Layer 1: End-of-context reinforcement — append anchor after last message
      const endReinforcement = workingMemory ? workingMemory.getAnchorBlock() : '';
      const messagesForOllama = [{ role:"system", content: sysPrompt }, ...compressedMessages];
      if (endReinforcement) {
        messagesForOllama.push({ role: "user", content: `[CONTEXT REMINDER]\n${endReinforcement}\n[END REMINDER]` });
      }

      const reqBody = {
        model:    CONFIG.model,
        messages: messagesForOllama,
```

- [ ] **Step 5: Auto-update from tool results**

Find the tool result handling section — after each tool call completes and the result is pushed to SESSION.messages. Look for where `SESSION.toolCount++` is incremented (this happens after tool execution). Add nearby:

```javascript
      // Update working memory with tool result
      if (workingMemory && toolName && toolResult) {
        workingMemory.updateFromToolResult(toolName, toolArgs, typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult));
      }
```

The exact location depends on the tool dispatch structure. The implementer should find where `SESSION.toolCount` is incremented and add the working memory update there.

- [ ] **Step 6: Add recovery directive to tool error responses**

Find the BLOCKED error messages in the tool handler (there are several — search for `BLOCKED` and `❌`). For the write_file BLOCKED case (around the line we modified earlier that says "Cannot write to CLI source file"), modify the return to append a recovery directive:

The current return is:
```javascript
return `❌ BLOCKED: "${path.basename(fp)}" is a protected CLI source file.\nWrite to "${SESSION.cwd}/${path.basename(fp)}" instead, or use a subdirectory like "${SESSION.cwd}/project/".\n\nIMPORTANT: Continue with the CURRENT task. Do NOT revisit previous questions.`;
```

Add recovery directive:
```javascript
          const blockMsg = `❌ BLOCKED: "${path.basename(fp)}" is a protected CLI source file.\nWrite to "${SESSION.cwd}/${path.basename(fp)}" instead.`;
          const recovery = workingMemory
            ? workingMemory.buildRecoveryDirective(blockMsg, `Write to "${SESSION.cwd}/${path.basename(fp)}" instead`)
            : '\n\nIMPORTANT: Continue with the CURRENT task. Do NOT revisit previous questions.';
          return blockMsg + recovery;
```

- [ ] **Step 7: Add search repetition detection to kb_search tool**

Find the `kb_search` tool handler (search for `case "kb_search"` in the tool dispatch). After the search results are received, add:

```javascript
      // Search repetition detection
      if (workingMemory && results && results.length > 0) {
        const topHash = results[0].text ? results[0].text.slice(0, 50) : '';
        workingMemory.recordSearch(args.query, results.length, topHash);
        const warning = workingMemory.getSearchRepetitionWarning(args.query, topHash);
        if (warning) {
          toolResult += warning;
          // Add the search topic to DO NOT list
          const topic = args.query.split(' ').slice(0, 3).join(' ');
          workingMemory.addDoNot(`Search for "${topic}"`);
        }
      }
```

- [ ] **Step 8: Detect user corrections**

In the chat loop, when a new user message is received, check if it looks like a correction:

```javascript
    // Detect user corrections
    if (workingMemory && userMessage) {
      const correctionPatterns = [
        /\b(?:don'?t|do not|stop|no,?\s*not|instead|rather|please use|prefer)\b/i,
        /\b(?:wrong|incorrect|that'?s not|not what I|I said|I meant)\b/i,
      ];
      if (correctionPatterns.some(p => p.test(userMessage)) && sessionManager) {
        workingMemory.addCorrection(
          userMessage.length > 100 ? userMessage.slice(0, 100) + '...' : userMessage,
          sessionManager.getCurrentTurn()
        );
      }
    }
```

- [ ] **Step 9: Handle /clear — reset working memory**

Find the `/clear` slash command handler and add:

```javascript
if (workingMemory) workingMemory.reset();
```

- [ ] **Step 10: Run tests and manual smoke test**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/ --no-coverage`

Manual test:
1. Start CLI, ask "create a hello world python script in test-dir"
2. Verify task anchor shows in debug output
3. Trigger an error (try writing in CLI dir) — verify recovery directive
4. Search KB for same topic 4 times — verify repetition warning
5. `/clear` — verify working memory resets

---

## Summary

| Task | Files | Tests | What it does |
|---|---|---|---|
| 1 | working-memory.js | ~20 | Task anchor, corrections, DO NOT, recovery, search repetition |
| 2 | attar-code.js | existing | Wire into prompt start+end, tool handler, kb_search, corrections |

**What changes for the user after Plan 2:**
- Model stays on task after errors (task anchor + recovery directive)
- Search repetition detected and blocked after 3 similar queries
- User corrections tracked and reinforced every turn
- Resolved topics blocked via DO NOT list
- All of this works with ANY model size (heavy reinforcement always on)

**Next:** Plan 3 — Long-Term Memory + Extraction + Smart-Fix Bridge
