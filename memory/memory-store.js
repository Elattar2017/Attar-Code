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

  // ── Qdrant Sync ─────────────────────────────────────────────────────────

  /**
   * Flush current session's extractions to Qdrant via search-proxy.
   * Called at session end. Non-blocking — failure is logged, not thrown.
   *
   * @param {string} [proxyUrl='http://localhost:3001']
   * @returns {Promise<{ synced: number }|{ error: string }>}
   */
  async syncToQdrant(proxyUrl = 'http://localhost:3001') {
    const extractions = this.getExtractions();
    if (extractions.length === 0) return { synced: 0 };

    try {
      const res = await fetch(`${proxyUrl}/memory/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extractions,
          sessionId: this._sessionId,
          projectRoot: this._projectDir,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return { error: `Sync failed: ${res.status}` };
      }

      const data = await res.json();
      return { synced: data.synced || 0 };
    } catch (err) {
      // Non-fatal — working.json stays on disk for retry next session
      return { error: err.message };
    }
  }

  /**
   * Search Qdrant memory archive via search-proxy.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.num=5]
   * @param {string} [opts.scope]     Filter by 'global' or 'project'
   * @param {string} [opts.proxyUrl='http://localhost:3001']
   * @returns {Promise<Array<{ content, type, scope, score }>>}
   */
  async searchMemories(query, opts = {}) {
    const proxyUrl = opts.proxyUrl || 'http://localhost:3001';
    try {
      const res = await fetch(`${proxyUrl}/memory/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          num: opts.num || 5,
          scope: opts.scope,
          project: this._projectDir,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return [];
      const data = await res.json();
      return data.results || [];
    } catch (_) {
      return []; // Qdrant unavailable — degrade gracefully
    }
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
        // Filter garbage (< 10 chars or starts with greetings)
        if (!entry.content || entry.content.length < 10) continue;
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
