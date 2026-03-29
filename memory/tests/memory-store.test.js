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
