'use strict';

/**
 * plugins/plugin-contract.js — Base class for all language plugins.
 *
 * Every language plugin (python.js, typescript.js, etc.) extends this class
 * and implements the methods relevant to that language. The base class provides
 * default no-op implementations so plugins only need to override what they support.
 *
 * CRITICAL CONTRACT:
 * - get catalog()      → must return the raw JSON object from defaults/plugins/{lang}.json
 * - get errorCatalog() → must return catalog.errorCatalog (exact JSON structure)
 *   These are required for TreeManager and classifyErrors() compatibility.
 */

const fs = require('fs');
const path = require('path');
const { OSAbstraction } = require('./os-abstraction');

class LanguagePlugin {
  /**
   * @param {object} opts
   * @param {string} opts.id           Plugin ID (e.g., 'python', 'typescript')
   * @param {string} opts.displayName  Human name (e.g., 'Python', 'TypeScript')
   * @param {string[]} opts.extensions File extensions (e.g., ['.py', '.pyi'])
   * @param {string[]} opts.configFiles Marker files (e.g., ['pyproject.toml', 'requirements.txt'])
   * @param {string} [opts.proxyUrl]    Search-proxy URL for version resolution / KB
   * @param {string} [opts.ollamaUrl]   Ollama URL for LLM calls
   */
  constructor(opts = {}) {
    this.id          = opts.id || 'unknown';
    this.displayName = opts.displayName || 'Unknown';
    this.extensions  = opts.extensions || [];
    this.configFiles = opts.configFiles || [];
    this._proxyUrl   = opts.proxyUrl || null;
    this._ollamaUrl  = opts.ollamaUrl || 'http://localhost:11434';
    this._catalog    = null; // Raw JSON from defaults/plugins/{id}.json
  }

  /**
   * Load the JSON error catalog from defaults/plugins/{id}.json.
   * Checks user override (~/.attar-code/plugins/{id}.json) first.
   */
  loadCatalog() {
    const userPath = path.join(
      require('os').homedir(), '.attar-code', 'plugins', `${this.id}.json`
    );
    const defaultPath = path.join(
      __dirname, '..', 'defaults', 'plugins', `${this.id}.json`
    );

    const catalogPath = fs.existsSync(userPath) ? userPath : defaultPath;

    try {
      this._catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    } catch {
      this._catalog = { metadata: {}, errorCatalog: { categories: [] }, importSystem: {}, typeTracing: {} };
    }
  }

  /**
   * REQUIRED GETTER: Returns the raw JSON catalog.
   * TreeManager uses this for analyzeFileWithPlugin(content, file, plugin.catalog).
   */
  get catalog() {
    if (!this._catalog) this.loadCatalog();
    return this._catalog;
  }

  /**
   * REQUIRED GETTER: Returns catalog.errorCatalog.
   * classifyErrors() accesses plugin.errorCatalog.categories directly.
   */
  get errorCatalog() {
    return this.catalog.errorCatalog || { categories: [] };
  }

  /**
   * REQUIRED GETTER: Returns catalog.importSystem.
   * analyzeFileWithPlugin() accesses plugin.importSystem.importPatterns.
   */
  get importSystem() {
    return this.catalog.importSystem || { importPatterns: [], exportPatterns: [] };
  }

  /**
   * REQUIRED GETTER: Returns catalog.typeTracing.
   * analyzeFileWithPlugin() accesses plugin.typeTracing.definitionPatterns.
   */
  get typeTracing() {
    return this.catalog.typeTracing || { definitionPatterns: [] };
  }

  // ─── Detection ─────────────────────────────────────────────────────────────

  /**
   * Detect if this language is present in the project.
   * @param {string} projectRoot
   * @returns {boolean}
   */
  detect(projectRoot) {
    return this.configFiles.some(f => fs.existsSync(path.join(projectRoot, f)));
  }

  /**
   * Detect the installed runtime version.
   * @returns {{ version: string, path: string, source: string }|null}
   */
  detectVersion() {
    return null; // Override in subclass
  }

  /**
   * Detect the test framework in use.
   * @param {string} projectRoot
   * @returns {{ name: string, command: string, jsonFlag: string }|null}
   */
  detectTestFramework(projectRoot) {
    return null; // Override in subclass
  }

  // ─── Environment ───────────────────────────────────────────────────────────

  /**
   * Get the preferred strategy order for this language.
   * First available tool wins (e.g., ['uv', 'poetry', 'pipenv', 'venv']).
   * @returns {string[]}
   */
  getStrategyOrder() {
    return [];
  }

  /**
   * Check if the environment is ready for this language.
   * @param {string} projectRoot
   * @returns {object} EnvReport { ready, runtime, packageManager, virtualEnv, missing[], warnings[] }
   */
  checkEnvironment(projectRoot) {
    return {
      ready: false,
      runtime: null,
      packageManager: null,
      virtualEnv: null,
      missing: [{ tool: this.id, installCmd: OSAbstraction.getInstallHint(this.id) }],
      warnings: [],
    };
  }

  /**
   * Set up the environment (install deps, create venv, etc.).
   * @param {string} projectRoot
   * @returns {object} SetupResult { steps[], venvPath?, activateCmd? }
   */
  setupEnvironment(projectRoot) {
    return { steps: [], venvPath: null, activateCmd: null };
  }

  // ─── Scaffolding ───────────────────────────────────────────────────────────

  /**
   * Get latest stable versions for this language's ecosystem.
   * Calls package registries with caching.
   * @returns {Promise<{ runtime: string, frameworks: Object<string, string> }>}
   */
  async getLatestVersions() {
    return { runtime: null, frameworks: {} };
  }

  /**
   * Generate scaffolding data for a new project.
   * @param {string} name   Project name
   * @param {object} opts   Framework, features, etc.
   * @returns {object} { files[], deps{}, devDeps{}, scripts{}, postCreate[] }
   */
  scaffold(name, opts = {}) {
    return { files: [], deps: {}, devDeps: {}, scripts: {}, postCreate: [] };
  }

  // ─── Build & Run ───────────────────────────────────────────────────────────

  /**
   * Get the syntax check command (replaces hard-coded check in build_and_test).
   * @param {string[]} files  Files to check
   * @param {string} projectRoot
   * @returns {string|null}
   */
  getSyntaxCheckCommand(files, projectRoot) {
    return null;
  }

  /**
   * Get the build command for this project.
   * @param {string} projectRoot
   * @returns {string|null}
   */
  getBuildCommand(projectRoot) {
    return null;
  }

  /**
   * Get the run command.
   * @param {string} projectRoot
   * @param {string} [entryFile]
   * @returns {string|null}
   */
  getRunCommand(projectRoot, entryFile) {
    return null;
  }

  /**
   * Get the install command (with venv prefix if applicable).
   * @param {string} projectRoot
   * @returns {string|null}
   */
  getInstallCommand(projectRoot) {
    return null;
  }

  /**
   * Parse raw build/compile output into structured PluginError[].
   * Replaces the hard-coded parseBuildErrors() regex patterns.
   * @param {string} rawOutput   Raw compiler/linter output
   * @param {string} [origin]    'compiler' | 'runtime' | 'test'
   * @returns {Array<object>} PluginError[]
   */
  parseErrors(rawOutput, origin) {
    return [];
  }

  /**
   * Get regex patterns for detecting server crashes in real-time.
   * @returns {RegExp[]}
   */
  getCrashPatterns() {
    return [];
  }

  // ─── Testing ───────────────────────────────────────────────────────────────

  /**
   * Get the test command (OS-aware, with activation prefix).
   * @param {string} projectRoot
   * @param {object} [framework]  Result from detectTestFramework()
   * @returns {string|null}
   */
  getTestCommand(projectRoot, framework) {
    return null;
  }

  /**
   * Parse test output into structured results.
   * @param {string} raw        Raw test output
   * @param {string} framework  Framework name
   * @returns {{ passed: number, failed: number, errors: object[] }}
   */
  parseTestOutput(raw, framework) {
    return { passed: 0, failed: 0, errors: [] };
  }

  /**
   * Analyze a source file using AST.
   * Returns function signatures, classes, imports, exports.
   * @param {string} filePath
   * @returns {object} ModuleMeta { functions[], classes[], imports[], exports[] }
   */
  analyzeSource(filePath) {
    return { functions: [], classes: [], imports: [], exports: [] };
  }

  /**
   * Generate a deterministic test skeleton for a function.
   * Phase 1 of two-phase test generation.
   * @param {object} fn   Function metadata from analyzeSource()
   * @returns {object[]}  TestCase[] with name, type, input, expected
   */
  generateTestSkeleton(fn) {
    return [];
  }

  /**
   * Get edge case values for a parameter type.
   * @param {string} paramType  e.g., 'string', 'number', 'list', 'Optional[T]'
   * @returns {Array<{ label: string, value: any }>}
   */
  getEdgeCases(paramType) {
    return [];
  }

  /**
   * Generate mock definitions for external dependencies.
   * @param {object[]} deps   Import metadata from analyzeSource()
   * @returns {object[]}      MockDef[]
   */
  generateMocks(deps) {
    return [];
  }

  // ─── Unified Diagnostics ───────────────────────────────────────────────────

  /**
   * Parse and diagnose errors from any origin (compiler, runtime, test).
   * Returns unified PluginError[] schema regardless of language.
   * @param {string} raw       Raw error output
   * @param {string} origin    'compiler' | 'runtime' | 'test'
   * @returns {Array<object>}  PluginError[]
   */
  diagnose(raw, origin) {
    // Default: delegate to parseErrors
    return this.parseErrors(raw, origin);
  }

  /**
   * Build a structured fix prompt for Tier 3 LLM fixes.
   * Replaces assembleFixPrompt() from smart-fix/prompt-template.js.
   * @param {object} error     ClassifiedError
   * @param {object} context   { codeSnippet, functionName, stackFrames, similarFixes[], env }
   * @returns {string}         Prompt string
   */
  buildFixPrompt(error, context = {}) {
    const env = context.env || {};
    const lines = [
      `You are fixing an error in a ${this.displayName} project.`,
      '',
      'ERROR:',
      `- Category: ${error.category || 'unknown'}`,
      `- Code: ${error.code || 'unknown'}`,
      `- Message: ${error.message || ''}`,
      `- File: ${error.file || 'unknown'}:${error.line || 0}:${error.column || 0}`,
    ];

    if (context.functionName) {
      lines.push(`- Function: ${context.functionName}`);
    }

    if (context.codeSnippet) {
      lines.push('', 'CODE CONTEXT (20 lines around error):', context.codeSnippet);
    }

    if (context.stackFrames) {
      lines.push('', 'STACK TRACE (user code only):', context.stackFrames);
    }

    if (error.captures) {
      if (error.captures.expectedType && error.captures.actualType) {
        lines.push('', `TYPES: Expected ${error.captures.expectedType}, got ${error.captures.actualType}`);
      }
      if (error.captures.expected && error.captures.actual) {
        lines.push('', `ASSERTION: Expected ${error.captures.expected}, got ${error.captures.actual}, operator: ${error.captures.operator || '==='}`);
      }
    }

    if (context.similarFixes && context.similarFixes.length > 0) {
      lines.push('', 'SIMILAR FIXES:');
      for (const fix of context.similarFixes.slice(0, 3)) {
        lines.push(`- ${fix.fix_description || fix.description || fix.text}`);
      }
    }

    lines.push(
      '',
      `ENVIRONMENT: ${env.os || OSAbstraction.osName}/${process.arch}, ${this.displayName} ${env.version || 'unknown'}, ${env.framework || 'none'}, ${env.packageManager || 'unknown'}`,
      '',
      'Respond as JSON:',
      '{ "rootCause": "explanation", "fixes": [{ "file": "...", "oldCode": "...", "newCode": "..." }], "confidence": 0.0-1.0, "explanation": "what and why" }'
    );

    return lines.join('\n');
  }

  /**
   * Build a search query for KB/web when fixing an error.
   * @param {object} error  PluginError
   * @returns {string}
   */
  buildSearchQuery(error) {
    const parts = [this.displayName];
    if (error.code) parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 80));
    parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helper: Proxy Fetch ───────────────────────────────────────────────────

  /**
   * POST to the search-proxy.
   * @param {string} endpoint  e.g., '/kb/recipe/search'
   * @param {object} body
   * @returns {Promise<object|null>}
   */
  async _proxyPost(endpoint, body) {
    if (!this._proxyUrl) return null;
    try {
      const res = await fetch(`${this._proxyUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return await res.json();
    } catch { /* proxy unavailable */ }
    return null;
  }
}

module.exports = { LanguagePlugin };
