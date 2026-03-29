# Memory Enhancement Plan 3: Long-Term Memory + Extraction + Smart-Fix Bridge (Layer 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent flat-file memory (project.json/user.json/working.json), model-driven memory extraction after every exchange, smart-fix bridge with error trending, and migration from old memory.json.

**Architecture:** `memory-store.js` manages three flat files (user.json global, project.json per-project, working.json per-session) and syncs to Qdrant at session boundaries. `memory-extractor.js` runs an async LLM call after each exchange to extract worth-remembering facts. `smartfix-bridge.js` tracks error frequency across sessions and provides project context to smart-fix prompts.

**Tech Stack:** Node.js, Jest, Ollama (for extraction), Qdrant (optional archive), existing smart-fix pipeline.

**This is Plan 3 of 3.** Depends on Plans 1+2 (already implemented).

---

## File Structure

### Files to Create

| File | Responsibility |
|------|---------------|
| `memory/memory-store.js` | Flat file management (user.json, project.json, working.json) + Qdrant sync |
| `memory/memory-extractor.js` | Async LLM extraction after each exchange, quality gate, serial queue |
| `memory/smartfix-bridge.js` | Error trending, strategy escalation, project context for fix prompts |
| `memory/tests/memory-store.test.js` | Tests for flat file store |
| `memory/tests/memory-extractor.test.js` | Tests for extraction logic |
| `memory/tests/smartfix-bridge.test.js` | Tests for error trending |

### Files to Modify

| File | Changes |
|------|---------|
| `attar-code.js` | Wire memory-store (replace old MemoryStore), extractor (after each exchange), bridge (in build error handler) |

---

## Task 1: Memory Store (Flat Files)

**Files:**
- Create: `memory/memory-store.js`
- Create: `memory/tests/memory-store.test.js`

The memory store manages three JSON files with different lifecycles.

- [ ] **Step 1: Create test file**

Create `memory/tests/memory-store.test.js`:

```javascript
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { MemoryFileStore } = require('../memory-store');

// Use temp directory for tests
const TEST_DIR = path.join(os.tmpdir(), `memory-store-test-${Date.now()}`);

describe('MemoryFileStore', () => {
  let store;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    store = new MemoryFileStore({
      globalDir: TEST_DIR,
      projectRoot: path.join(TEST_DIR, 'myproject'),
      sessionId: 'test-session',
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('user.json (global preferences)', () => {
    test('saves and loads user preferences', () => {
      store.setUser('fixStyle', 'minimal fixes');
      const loaded = new MemoryFileStore({
        globalDir: TEST_DIR,
        projectRoot: path.join(TEST_DIR, 'myproject'),
        sessionId: 'new-session',
      });
      expect(loaded.getUser('fixStyle')).toBe('minimal fixes');
    });

    test('persists across instances', () => {
      store.setUser('codeStyle', 'no semicolons');
      store.setUser('preference', 'async/await');

      const store2 = new MemoryFileStore({
        globalDir: TEST_DIR,
        projectRoot: path.join(TEST_DIR, 'myproject'),
        sessionId: 's2',
      });
      expect(store2.getUser('codeStyle')).toBe('no semicolons');
      expect(store2.getUser('preference')).toBe('async/await');
    });

    test('getAllUser returns all entries', () => {
      store.setUser('a', '1');
      store.setUser('b', '2');
      const all = store.getAllUser();
      expect(all.a).toBe('1');
      expect(all.b).toBe('2');
    });
  });

  describe('project.json (per-project facts)', () => {
    test('saves and loads project facts', () => {
      store.setProject('tech', 'Express + SQLite');
      store.setProject('buildCommand', 'npm run build');
      expect(store.getProject('tech')).toBe('Express + SQLite');
    });

    test('different projects have separate files', () => {
      const store2 = new MemoryFileStore({
        globalDir: TEST_DIR,
        projectRoot: path.join(TEST_DIR, 'other-project'),
        sessionId: 's2',
      });
      store.setProject('name', 'project-A');
      store2.setProject('name', 'project-B');
      expect(store.getProject('name')).toBe('project-A');
      expect(store2.getProject('name')).toBe('project-B');
    });

    test('error_trends stores and retrieves', () => {
      store.setProject('error_trends', {
        MODULE_NOT_FOUND: { total: 2, last_seen: '2026-03-28' }
      });
      const trends = store.getProject('error_trends');
      expect(trends.MODULE_NOT_FOUND.total).toBe(2);
    });
  });

  describe('working.json (session-scoped)', () => {
    test('saves and loads session data', () => {
      store.setWorking('currentTask', 'Build API');
      store.setWorking('corrections', ['use async/await']);
      expect(store.getWorking('currentTask')).toBe('Build API');
    });

    test('clearWorking removes all session data', () => {
      store.setWorking('task', 'something');
      store.clearWorking();
      expect(store.getWorking('task')).toBeUndefined();
    });

    test('addExtractedMemory appends to extractions list', () => {
      store.addExtractedMemory({ type: 'correction', content: 'Use pydantic', scope: 'project' });
      store.addExtractedMemory({ type: 'user_pref', content: 'No semicolons', scope: 'global' });
      const extractions = store.getWorking('extractions') || [];
      expect(extractions).toHaveLength(2);
      expect(extractions[0].content).toBe('Use pydantic');
    });
  });

  describe('migration', () => {
    test('migrates old memory.json entries', () => {
      const oldMemory = {
        version: 1,
        entries: [
          { id: 'm1', type: 'user_pref', content: 'prefers dark mode', scope: 'global' },
          { id: 'm2', type: 'project_fact', content: 'uses Express', scope: 'global' },
          { id: 'm3', type: 'error_solution', content: 'fixed by adding middleware', scope: 'global' },
          { id: 'm4', type: 'user_pref', content: 'hi', scope: 'global' }, // garbage — too short
        ],
      };
      const oldPath = path.join(TEST_DIR, 'memory.json');
      fs.writeFileSync(oldPath, JSON.stringify(oldMemory));

      const migrated = new MemoryFileStore({
        globalDir: TEST_DIR,
        projectRoot: path.join(TEST_DIR, 'myproject'),
        sessionId: 'migrate-test',
        legacyMemoryPath: oldPath,
      });

      expect(migrated.getUser('user_pref_0')).toBeDefined();
      // Garbage entry (content 'hi', <20 chars) should be filtered out
      expect(fs.existsSync(oldPath + '.bak')).toBe(true);
    });
  });

  describe('getInstructionsBlock', () => {
    test('builds instructions from user + project data', () => {
      store.setUser('fixStyle', 'minimal fixes');
      store.setProject('tech', 'Express + SQLite');
      store.setProject('buildCommand', 'npm run build');

      const block = store.getInstructionsBlock();
      expect(block).toContain('Express + SQLite');
      expect(block).toContain('npm run build');
      expect(block).toContain('minimal fixes');
    });

    test('returns empty string when no data', () => {
      expect(store.getInstructionsBlock()).toBe('');
    });
  });
});
```

- [ ] **Step 2: Implement MemoryFileStore**

Create `memory/memory-store.js`:

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * memory-store.js — Flat file memory management.
 *
 * Three files with different lifecycles:
 * - user.json (global, persistent) — user preferences across all projects
 * - project.json (per-project, persistent) — project facts, build commands, error trends
 * - working.json (per-session, archived) — current session extractions, reset each session
 */

class MemoryFileStore {
  /**
   * @param {object} opts
   * @param {string} opts.globalDir      Path to ~/.attar-code/
   * @param {string} opts.projectRoot    Absolute path to current project
   * @param {string} opts.sessionId      Current session ID
   * @param {string} [opts.legacyMemoryPath]  Path to old memory.json for migration
   */
  constructor(opts = {}) {
    this._globalDir = opts.globalDir || path.join(require('os').homedir(), '.attar-code');
    this._sessionId = opts.sessionId || 'unknown';

    // Project directory: ~/.attar-code/projects/{hash}/
    const projectRoot = opts.projectRoot || process.cwd();
    const projectHash = crypto.createHash('md5').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
    this._projectDir = path.join(this._globalDir, 'projects', projectHash);

    // Ensure directories exist
    fs.mkdirSync(this._globalDir, { recursive: true });
    fs.mkdirSync(this._projectDir, { recursive: true });

    // File paths
    this._userPath = path.join(this._globalDir, 'user.json');
    this._projectPath = path.join(this._projectDir, 'project.json');
    this._workingPath = path.join(this._projectDir, 'working.json');

    // Load from disk
    this._user = this._loadJson(this._userPath) || {};
    this._project = this._loadJson(this._projectPath) || {};
    this._working = {};  // Always start fresh

    // Migration from old memory.json
    if (opts.legacyMemoryPath && !this._user.migrated) {
      this._migrateOldMemory(opts.legacyMemoryPath);
    }
  }

  // ── User (global, persistent) ──────────────────────────────────────────

  setUser(key, value) {
    this._user[key] = value;
    this._saveJson(this._userPath, this._user);
  }

  getUser(key) {
    return this._user[key];
  }

  getAllUser() {
    return { ...this._user };
  }

  // ── Project (per-project, persistent) ──────────────────────────────────

  setProject(key, value) {
    this._project[key] = value;
    this._saveJson(this._projectPath, this._project);
  }

  getProject(key) {
    return this._project[key];
  }

  getAllProject() {
    return { ...this._project };
  }

  // ── Working (per-session, archived at end) ─────────────────────────────

  setWorking(key, value) {
    this._working[key] = value;
    this._saveJson(this._workingPath, this._working);
  }

  getWorking(key) {
    return this._working[key];
  }

  clearWorking() {
    this._working = {};
    try { fs.unlinkSync(this._workingPath); } catch (_) {}
  }

  /**
   * Add an extracted memory to the working session's extractions list.
   * @param {{ type: string, content: string, scope: string }} extraction
   */
  addExtractedMemory(extraction) {
    if (!this._working.extractions) this._working.extractions = [];
    this._working.extractions.push({
      ...extraction,
      sessionId: this._sessionId,
      timestamp: new Date().toISOString(),
    });
    this._saveJson(this._workingPath, this._working);
  }

  /**
   * Get all extracted memories from the current session.
   * @returns {Array}
   */
  getExtractions() {
    return this._working.extractions || [];
  }

  // ── Instructions Block Builder ─────────────────────────────────────────

  /**
   * Build an instructions block from user + project data for prompt injection.
   * @returns {string}
   */
  getInstructionsBlock() {
    const lines = [];

    // Project context
    const tech = this._project.tech;
    if (tech) lines.push(`[PROJECT] ${tech}`);

    const buildCmd = this._project.buildCommand;
    if (buildCmd) lines.push(`[BUILD] ${buildCmd}`);

    const testCmd = this._project.testCommand;
    if (testCmd) lines.push(`[TEST] ${testCmd}`);

    const style = this._project.codeStyle;
    if (style) lines.push(`[STYLE] ${style}`);

    // User preferences
    const fixStyle = this._user.fixStyle;
    if (fixStyle) lines.push(`[USER] ${fixStyle}`);

    const codeStyle = this._user.codeStyle;
    if (codeStyle) lines.push(`[USER STYLE] ${codeStyle}`);

    return lines.length > 0 ? lines.join('\n') : '';
  }

  // ── Migration ──────────────────────────────────────────────────────────

  _migrateOldMemory(legacyPath) {
    try {
      if (!fs.existsSync(legacyPath)) return;
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      const entries = raw.entries || [];

      let userIdx = 0;
      for (const entry of entries) {
        // Filter garbage (< 20 chars or starts with greetings)
        if (!entry.content || entry.content.length < 20) continue;
        if (/^(you |hello|hi |ok |yes|no )/i.test(entry.content)) continue;

        if (entry.type === 'user_pref') {
          this.setUser(`user_pref_${userIdx++}`, entry.content);
        } else if (entry.type === 'project_fact') {
          this.setProject(`fact_${userIdx++}`, entry.content);
        }
        // error_solution entries → queued for Qdrant (handled by extractor later)
      }

      // Mark as migrated
      this.setUser('migrated', true);

      // Backup old file
      fs.copyFileSync(legacyPath, legacyPath + '.bak');
    } catch (err) {
      // Migration failure is non-fatal
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  _loadJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
      return null;
    }
  }

  _saveJson(filePath, data) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (_) {}
  }
}

module.exports = { MemoryFileStore };
```

- [ ] **Step 3: Run tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/memory-store.test.js --no-coverage`
Expected: PASS

---

## Task 2: Memory Extractor

**Files:**
- Create: `memory/memory-extractor.js`
- Create: `memory/tests/memory-extractor.test.js`

- [ ] **Step 1: Create test file**

Create `memory/tests/memory-extractor.test.js`:

```javascript
'use strict';

const { MemoryExtractor } = require('../memory-extractor');

describe('MemoryExtractor', () => {
  describe('quality gate', () => {
    test('rejects extraction with content < 10 chars', () => {
      const ext = new MemoryExtractor();
      expect(ext.passesQualityGate({ type: 'correction', content: 'hi', scope: 'global' })).toBe(false);
    });

    test('accepts extraction with valid content', () => {
      const ext = new MemoryExtractor();
      expect(ext.passesQualityGate({ type: 'correction', content: 'Use pydantic not jsonschema', scope: 'project' })).toBe(true);
    });

    test('rejects extraction with invalid type', () => {
      const ext = new MemoryExtractor();
      expect(ext.passesQualityGate({ type: 'invalid', content: 'Some long content here', scope: 'global' })).toBe(false);
    });

    test('rejects duplicate (Jaccard > 0.6 with existing)', () => {
      const ext = new MemoryExtractor();
      ext._recentExtractions.push({ content: 'User prefers pydantic for validation' });
      expect(ext.passesQualityGate({ type: 'correction', content: 'User prefers pydantic for validation tasks', scope: 'project' })).toBe(false);
    });

    test('accepts non-duplicate', () => {
      const ext = new MemoryExtractor();
      ext._recentExtractions.push({ content: 'User prefers pydantic' });
      expect(ext.passesQualityGate({ type: 'correction', content: 'Project uses Express and SQLite backend', scope: 'project' })).toBe(true);
    });
  });

  describe('parseExtractionResponse', () => {
    test('parses valid JSON array', () => {
      const ext = new MemoryExtractor();
      const result = ext.parseExtractionResponse('[{"type":"correction","content":"Use async/await","scope":"global"}]');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('correction');
    });

    test('returns empty array for invalid JSON', () => {
      const ext = new MemoryExtractor();
      expect(ext.parseExtractionResponse('not json')).toEqual([]);
    });

    test('returns empty array for non-array JSON', () => {
      const ext = new MemoryExtractor();
      expect(ext.parseExtractionResponse('{"type":"correction"}')).toEqual([]);
    });

    test('extracts JSON from markdown code block', () => {
      const ext = new MemoryExtractor();
      const input = '```json\n[{"type":"decision","content":"Use REST not GraphQL","scope":"project"}]\n```';
      const result = ext.parseExtractionResponse(input);
      expect(result).toHaveLength(1);
    });

    test('caps at 3 extractions', () => {
      const ext = new MemoryExtractor();
      const arr = Array.from({ length: 5 }, (_, i) => ({ type: 'project_fact', content: `Fact ${i} with enough length`, scope: 'project' }));
      const result = ext.parseExtractionResponse(JSON.stringify(arr));
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  describe('buildExtractionPrompt', () => {
    test('includes user message and assistant response', () => {
      const ext = new MemoryExtractor();
      const prompt = ext.buildExtractionPrompt('how to fix auth', 'Add middleware to verify JWT', 'edit_file: auth.js');
      expect(prompt).toContain('how to fix auth');
      expect(prompt).toContain('Add middleware');
      expect(prompt).toContain('auth.js');
    });

    test('truncates long messages', () => {
      const ext = new MemoryExtractor();
      const longMsg = 'x'.repeat(2000);
      const prompt = ext.buildExtractionPrompt(longMsg, longMsg, '');
      expect(prompt.length).toBeLessThan(4000);
    });
  });

  describe('serial queue', () => {
    test('enqueue adds to queue', () => {
      const ext = new MemoryExtractor({ extract: false }); // disable actual LLM calls
      ext.enqueue({ userMessage: 'test', assistantResponse: 'response', toolSummary: '' });
      expect(ext._queue).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Implement MemoryExtractor**

Create `memory/memory-extractor.js`:

```javascript
'use strict';

/**
 * memory-extractor.js — Model-driven memory extraction.
 *
 * After each user-model exchange, an async LLM call extracts facts worth
 * remembering. Uses a serial queue to prevent concurrent writes.
 */

const VALID_TYPES = new Set(['correction', 'decision', 'project_fact', 'error_pattern', 'user_pref']);

// Jaccard word similarity
function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) { if (setB.has(w)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

class MemoryExtractor {
  /**
   * @param {object} [opts]
   * @param {string} [opts.ollamaUrl]   Ollama base URL
   * @param {string} [opts.model]       Model for extraction (fast model preferred)
   * @param {boolean} [opts.extract]    Whether to actually run LLM calls (default true)
   * @param {Function} [opts.onExtraction]  Callback when extractions are ready: (extractions) => void
   */
  constructor(opts = {}) {
    this._ollamaUrl = opts.ollamaUrl || 'http://127.0.0.1:11434';
    this._model = opts.model || null; // null = auto-detect
    this._extract = opts.extract !== false;
    this._onExtraction = opts.onExtraction || null;
    this._queue = [];
    this._running = false;
    this._recentExtractions = []; // last 20 for dedup
    this._consecutiveFailures = 0;
  }

  // ── Extraction Prompt ──────────────────────────────────────────────────

  /**
   * Build the extraction prompt.
   * @param {string} userMessage
   * @param {string} assistantResponse
   * @param {string} toolSummary
   * @returns {string}
   */
  buildExtractionPrompt(userMessage, assistantResponse, toolSummary) {
    const user = (userMessage || '').slice(0, 500);
    const asst = (assistantResponse || '').slice(0, 800);
    const tools = (toolSummary || '').slice(0, 300);

    return `You are a memory extractor for a coding assistant. Given this exchange, extract ONLY facts worth remembering in future sessions. Output a JSON array or empty array [].

Categories:
- correction: User corrected the assistant's approach
- decision: A design/architecture decision was made
- project_fact: Learned something about the project (build command, framework, structure)
- error_pattern: An error was fixed — what was the root cause and fix
- user_pref: User expressed a preference for how to work

Rules:
- ONLY extract facts useful in FUTURE sessions (not greetings, not "ok", not "yes")
- Be specific: "User wants pydantic not jsonschema" NOT "User has preferences"
- Skip: greetings, acknowledgments, questions without answers, tool outputs
- Max 3 extractions per exchange
- Each extraction must have: type, content, scope ("global" or "project")

Exchange:
User: ${user}
Assistant: ${asst}
${tools ? `Tools used: ${tools}` : ''}

Output ONLY a JSON array:`;
  }

  // ── Quality Gate ───────────────────────────────────────────────────────

  /**
   * Check if an extraction passes quality criteria.
   * @param {{ type: string, content: string, scope: string }} extraction
   * @returns {boolean}
   */
  passesQualityGate(extraction) {
    if (!extraction || !extraction.content || !extraction.type) return false;
    if (extraction.content.length < 10) return false;
    if (!VALID_TYPES.has(extraction.type)) return false;

    // Dedup against recent extractions (Jaccard > 0.6)
    for (const recent of this._recentExtractions) {
      if (jaccard(extraction.content, recent.content) > 0.6) return false;
    }

    return true;
  }

  // ── Parse LLM Response ─────────────────────────────────────────────────

  /**
   * Parse the LLM's extraction response into validated extractions.
   * @param {string} response  Raw LLM response (should be JSON array)
   * @returns {Array<{ type: string, content: string, scope: string }>}
   */
  parseExtractionResponse(response) {
    if (!response) return [];

    let text = response.trim();
    // Handle markdown code blocks
    const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) text = codeBlock[1].trim();

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      // Cap at 3 and validate each
      return parsed.slice(0, 3).filter(e =>
        e && typeof e.type === 'string' && typeof e.content === 'string'
      ).map(e => ({
        type: e.type,
        content: e.content,
        scope: e.scope || 'project',
      }));
    } catch (_) {
      return [];
    }
  }

  // ── Serial Queue ───────────────────────────────────────────────────────

  /**
   * Enqueue an exchange for extraction (async, non-blocking).
   * @param {{ userMessage: string, assistantResponse: string, toolSummary: string }} exchange
   */
  enqueue(exchange) {
    if (!this._extract) {
      this._queue.push(exchange);
      return;
    }
    if (this._consecutiveFailures >= 3) return; // disabled until next session

    this._queue.push(exchange);
    if (!this._running) this._drain();
  }

  async _drain() {
    this._running = true;
    while (this._queue.length > 0) {
      const exchange = this._queue.shift();
      await this._extractOne(exchange);
    }
    this._running = false;
  }

  async _extractOne(exchange) {
    const prompt = this.buildExtractionPrompt(
      exchange.userMessage,
      exchange.assistantResponse,
      exchange.toolSummary
    );

    try {
      const model = this._model || 'glm-4.7-flash:latest';
      const res = await fetch(`${this._ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 200 },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        this._consecutiveFailures++;
        return;
      }

      const data = await res.json();
      const extractions = this.parseExtractionResponse(data.response || '');

      // Apply quality gate
      const valid = extractions.filter(e => this.passesQualityGate(e));

      if (valid.length > 0) {
        // Track for dedup
        for (const v of valid) {
          this._recentExtractions.push(v);
          if (this._recentExtractions.length > 20) this._recentExtractions.shift();
        }

        // Notify callback
        if (this._onExtraction) this._onExtraction(valid);
      }

      this._consecutiveFailures = 0;
    } catch (_) {
      this._consecutiveFailures++;
    }
  }

  /**
   * Find the best available model for extraction.
   * Called once at session start.
   * @returns {Promise<string|null>}
   */
  async detectModel() {
    const candidates = ['glm-4.7-flash:latest', 'qwen2.5:7b'];
    for (const model of candidates) {
      try {
        const res = await fetch(`${this._ollamaUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          this._model = model;
          return model;
        }
      } catch (_) {}
    }
    return null; // will use CONFIG.model as fallback
  }
}

module.exports = { MemoryExtractor };
```

- [ ] **Step 3: Run tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/memory-extractor.test.js --no-coverage`
Expected: PASS

---

## Task 3: Smart-Fix Bridge

**Files:**
- Create: `memory/smartfix-bridge.js`
- Create: `memory/tests/smartfix-bridge.test.js`

- [ ] **Step 1: Create test file**

Create `memory/tests/smartfix-bridge.test.js`:

```javascript
'use strict';

const { SmartFixBridge } = require('../smartfix-bridge');

describe('SmartFixBridge', () => {
  describe('error trending', () => {
    test('recordError tracks occurrences', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('MODULE_NOT_FOUND', 'session1', true, 'create_file');
      bridge.recordError('MODULE_NOT_FOUND', 'session2', false, 'llm_edit');

      const trend = bridge.getErrorTrend('MODULE_NOT_FOUND');
      expect(trend.total).toBe(2);
      expect(trend.success_rate).toBe(0.5);
    });

    test('isSystemic returns true after 3+ sessions with same error', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('IMPORT_ERROR', 'session1', true, 'fix_import');
      bridge.recordError('IMPORT_ERROR', 'session2', true, 'fix_import');
      bridge.recordError('IMPORT_ERROR', 'session3', false, 'llm_edit');
      expect(bridge.isSystemic('IMPORT_ERROR')).toBe(true);
    });

    test('isSystemic returns false for < 3 sessions', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('SYNTAX_ERROR', 'session1', true, 'auto_fix');
      expect(bridge.isSystemic('SYNTAX_ERROR')).toBe(false);
    });
  });

  describe('strategy escalation', () => {
    test('shouldEscalate returns true after 2 failed attempts with same strategy', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('TYPE_ERROR', 's1', false, 'llm_edit');
      bridge.recordError('TYPE_ERROR', 's1', false, 'llm_edit');
      expect(bridge.shouldEscalate('TYPE_ERROR', 'llm_edit')).toBe(true);
    });

    test('shouldEscalate returns false after 1 failure', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('TYPE_ERROR', 's1', false, 'llm_edit');
      expect(bridge.shouldEscalate('TYPE_ERROR', 'llm_edit')).toBe(false);
    });
  });

  describe('getContextForFix', () => {
    test('returns error trending info', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('NULL_REF', 's1', true, 'null_check');
      bridge.recordError('NULL_REF', 's2', false, 'llm_edit');

      const ctx = bridge.getContextForFix('NULL_REF');
      expect(ctx.errorTrending.total).toBe(2);
      expect(ctx.errorTrending.success_rate).toBe(0.5);
      expect(ctx.errorTrending.previousStrategies).toContain('null_check');
    });

    test('returns empty context for unknown error', () => {
      const bridge = new SmartFixBridge();
      const ctx = bridge.getContextForFix('UNKNOWN');
      expect(ctx.errorTrending).toBeNull();
    });

    test('includes systemic flag', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('CRASH', 's1', false, 'restart');
      bridge.recordError('CRASH', 's2', false, 'restart');
      bridge.recordError('CRASH', 's3', false, 'restart');

      const ctx = bridge.getContextForFix('CRASH');
      expect(ctx.errorTrending.systemic).toBe(true);
    });
  });

  describe('getSystemicWarning', () => {
    test('returns warning for systemic errors', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('LOOP', 's1', false, 'strategy_a');
      bridge.recordError('LOOP', 's2', false, 'strategy_b');
      bridge.recordError('LOOP', 's3', false, 'strategy_c');

      const warning = bridge.getSystemicWarning('LOOP');
      expect(warning).toContain('SYSTEMIC');
      expect(warning).toContain('3 sessions');
    });

    test('returns null for non-systemic errors', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('TYPO', 's1', true, 'auto');
      expect(bridge.getSystemicWarning('TYPO')).toBeNull();
    });
  });

  describe('persistence', () => {
    test('loadTrends and saveTrends work with object', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('ERR1', 's1', true, 'fix');

      const data = bridge.exportTrends();
      const bridge2 = new SmartFixBridge();
      bridge2.importTrends(data);
      expect(bridge2.getErrorTrend('ERR1').total).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Implement SmartFixBridge**

Create `memory/smartfix-bridge.js`:

```javascript
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
```

- [ ] **Step 3: Run tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/smartfix-bridge.test.js --no-coverage`
Expected: PASS

---

## Task 4: Wire All Plan 3 Modules Into attar-code.js

**Files:**
- Modify: `attar-code.js`

Integration points:

- [ ] **Step 1: Add requires**

After existing memory module requires, add:

```javascript
let MemoryFileStore, MemoryExtractor, SmartFixBridge;
try {
  ({ MemoryFileStore } = require('./memory/memory-store'));
  ({ MemoryExtractor } = require('./memory/memory-extractor'));
  ({ SmartFixBridge } = require('./memory/smartfix-bridge'));
} catch (_) {}
```

- [ ] **Step 2: Initialize after SESSION**

After the existing `workingMemory` init, add:

```javascript
let memoryFileStore = MemoryFileStore ? new MemoryFileStore({
  projectRoot: SESSION.cwd,
  sessionId: SESSION.id,
  legacyMemoryPath: path.join(os.homedir(), '.attar-code', 'memory.json'),
}) : null;

let memoryExtractor = MemoryExtractor ? new MemoryExtractor({
  onExtraction: (extractions) => {
    if (memoryFileStore) {
      for (const e of extractions) {
        memoryFileStore.addExtractedMemory(e);
        // Route to appropriate persistent store
        if (e.scope === 'global' && e.type === 'user_pref') {
          memoryFileStore.setUser(`pref_${Date.now()}`, e.content);
        } else if (e.scope === 'project') {
          memoryFileStore.setProject(`fact_${Date.now()}`, e.content);
        }
      }
    }
  },
}) : null;

let smartFixBridge = SmartFixBridge ? new SmartFixBridge() : null;
// Load persisted error trends from project.json
if (smartFixBridge && memoryFileStore) {
  const savedTrends = memoryFileStore.getProject('error_trends');
  if (savedTrends) smartFixBridge.importTrends(savedTrends);
}
```

- [ ] **Step 3: Inject instructions block into system prompt**

In the system prompt building section, after the working memory anchor injection, add:

```javascript
    // Layer 3: Memory Store — inject persistent instructions
    if (memoryFileStore) {
      const instructions = memoryFileStore.getInstructionsBlock();
      if (instructions) {
        sysPrompt += '\n\n## Persistent Memory:\n' + instructions;
      }
    }
```

- [ ] **Step 4: Trigger extraction after each model response**

After the model response is fully assembled and pushed to SESSION.messages, add:

```javascript
      // Layer 3: Async memory extraction
      if (memoryExtractor && fullResponseText && userMessage) {
        const toolSummary = SESSION.messages.slice(-10)
          .filter(m => m.role === 'tool')
          .map(m => (m._toolName || 'tool') + ': ' + (m.content || '').slice(0, 50))
          .join('; ');
        memoryExtractor.enqueue({ userMessage, assistantResponse: fullResponseText, toolSummary });
      }
```

The exact location is after the streaming response is complete and the assistant message is assembled. Look for where `fullResponseText` or the equivalent accumulated response text is finalized.

- [ ] **Step 5: Bridge smart-fix errors**

In the build error handling section (around where `SESSION._buildState` is updated after a build failure), add:

```javascript
        // Bridge: record error for trending
        if (smartFixBridge && errorCode) {
          smartFixBridge.recordError(errorCode, SESSION.id, false, 'pending');
          // Check for systemic warning
          const warning = smartFixBridge.getSystemicWarning(errorCode);
          if (warning) {
            SESSION.messages.push({ role: 'user', content: warning });
          }
          // Persist trends
          if (memoryFileStore) {
            memoryFileStore.setProject('error_trends', smartFixBridge.exportTrends());
          }
        }
```

After a build succeeds (where fix outcomes are recorded), update the bridge:

```javascript
        if (smartFixBridge && errorCode) {
          smartFixBridge.recordError(errorCode, SESSION.id, true, strategy || 'llm_edit');
          if (memoryFileStore) {
            memoryFileStore.setProject('error_trends', smartFixBridge.exportTrends());
          }
        }
```

- [ ] **Step 6: Persist working memory on /exit**

Find the exit handler (search for `/exit` or the process exit handler). Add:

```javascript
    // Persist corrections to project/user.json on exit
    if (workingMemory && memoryFileStore) {
      const corrections = workingMemory.getCorrections();
      if (corrections.length > 0) {
        memoryFileStore.setProject('lastCorrections', corrections.map(c => c.text));
      }
    }
    if (memoryFileStore) {
      memoryFileStore.clearWorking(); // Archive complete, clear session file
    }
```

- [ ] **Step 7: Handle /clear**

In the `/clear` handler (where workingMemory.reset() was added), also add:

```javascript
        if (memoryFileStore) memoryFileStore.clearWorking();
```

- [ ] **Step 8: Run all tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest memory/tests/ --no-coverage && node -c attar-code.js`
Expected: All memory tests pass + no syntax errors

---

## Summary

| Task | Files | Tests | What it does |
|---|---|---|---|
| 1 | memory-store.js | ~12 | Flat file management (user/project/working.json) + migration |
| 2 | memory-extractor.js | ~11 | Async LLM extraction, quality gate, serial queue |
| 3 | smartfix-bridge.js | ~10 | Error trending, strategy escalation, systemic detection |
| 4 | attar-code.js | existing | Wire all modules, extraction trigger, bridge, persistence |

**What changes for the user after Plan 3:**
- Memory persists across sessions (project facts, user preferences)
- Model-driven extraction captures corrections and decisions automatically
- Error patterns tracked across sessions, systemic issues flagged
- Old memory.json migrated to new flat file system
- Smart-fix gets project context for better fix prompts
