'use strict';

/**
 * plugins/index.js — PluginRegistry: loads, detects, and dispatches to language plugins.
 *
 * Usage:
 *   const { PluginRegistry } = require('./plugins');
 *   const registry = new PluginRegistry({ proxyUrl: 'http://localhost:3001' });
 *   registry.loadAll();
 *   const plugins = registry.detectLanguages('/path/to/project');
 *   const envReport = plugins[0].checkEnvironment('/path/to/project');
 */

const fs = require('fs');
const path = require('path');

// Re-export foundation modules
const { OSAbstraction, INSTALL_HINTS } = require('./os-abstraction');
const { VersionResolver, parseSemver, compareSemver, satisfiesMinimum, majorVersion } = require('./version-resolver');
const { LanguagePlugin } = require('./plugin-contract');

// ─── PluginRegistry ────────────────────────────────────────────────────────────

class PluginRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.proxyUrl]   Search-proxy URL
   * @param {string} [opts.ollamaUrl]  Ollama URL
   * @param {string} [opts.pluginDir]  Override plugin directory (for testing)
   */
  constructor(opts = {}) {
    this._proxyUrl  = opts.proxyUrl || null;
    this._ollamaUrl = opts.ollamaUrl || 'http://localhost:11434';
    this._pluginDir = opts.pluginDir || path.join(__dirname, 'languages');
    this._plugins   = new Map(); // id → LanguagePlugin instance
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  /**
   * Load all plugins from the languages/ directory.
   * Each .js file must export a class extending LanguagePlugin.
   * @returns {number} Number of plugins loaded
   */
  loadAll() {
    if (!fs.existsSync(this._pluginDir)) return 0;

    let count = 0;
    const files = fs.readdirSync(this._pluginDir).filter(f => f.endsWith('.js'));

    for (const file of files) {
      try {
        const PluginClass = require(path.join(this._pluginDir, file));
        // Support both `module.exports = class ...` and `module.exports = { XPlugin }`
        const Cls = typeof PluginClass === 'function'
          ? PluginClass
          : Object.values(PluginClass).find(v => typeof v === 'function' && v.prototype instanceof LanguagePlugin);

        if (Cls) {
          const instance = new Cls({
            proxyUrl: this._proxyUrl,
            ollamaUrl: this._ollamaUrl,
          });
          this._plugins.set(instance.id, instance);
          count++;
        }
      } catch (e) {
        // Skip broken plugins silently in production
        if (process.env.ATTAR_CODE_DEBUG === '1') {
          process.stderr.write(`[plugin] Failed to load ${file}: ${e.message}\n`);
        }
      }
    }

    return count;
  }

  /**
   * Get a plugin by ID.
   * @param {string} id  e.g., 'python', 'typescript'
   * @returns {LanguagePlugin|null}
   */
  get(id) {
    return this._plugins.get(id) || null;
  }

  /**
   * Get all loaded plugins.
   * @returns {LanguagePlugin[]}
   */
  getAll() {
    return [...this._plugins.values()];
  }

  /**
   * Auto-detect which languages are present in the project.
   * Returns ALL matching plugins (not first-match) for polyglot projects.
   * @param {string} projectRoot
   * @returns {LanguagePlugin[]}
   */
  detectLanguages(projectRoot) {
    const detected = [];
    for (const plugin of this._plugins.values()) {
      try {
        if (plugin.detect(projectRoot)) {
          detected.push(plugin);
        }
      } catch { /* skip broken detect */ }
    }
    return detected;
  }

  /**
   * Get the plugin that handles a specific file.
   * @param {string} filePath
   * @returns {LanguagePlugin|null}
   */
  pluginForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // Prefer base language plugins over framework plugins for shared extensions.
    // Framework plugins (nestjs, nextjs, reactnative) share .ts/.tsx/.js/.jsx with
    // the TypeScript plugin — for file-level matching the base plugin should win.
    const BASE_IDS = new Set(['typescript', 'python', 'rust', 'go', 'java', 'cpp', 'php', 'csharp']);
    let fallback = null;
    for (const plugin of this._plugins.values()) {
      if (plugin.extensions.includes(ext)) {
        if (BASE_IDS.has(plugin.id)) return plugin;
        if (!fallback) fallback = plugin;
      }
    }
    return fallback;
  }

  /**
   * Find plugin by technology name (from detect_build_system output).
   * Maps common tech names to plugin IDs.
   * @param {string} tech  e.g., 'Node.js/TypeScript', 'Python', 'Rust'
   * @returns {LanguagePlugin|null}
   */
  pluginForTech(tech) {
    if (!tech) return null;
    const lower = tech.toLowerCase();

    const techMap = {
      'nestjs':             'nestjs',
      'nest.js':            'nestjs',
      'next.js':            'nextjs',
      'nextjs':             'nextjs',
      'react native':       'reactnative',
      'react-native':       'reactnative',
      'expo':               'reactnative',
      'node.js':           'typescript',
      'node.js/typescript': 'typescript',
      'typescript':         'typescript',
      'javascript':         'typescript',
      'python':             'python',
      'rust':               'rust',
      'go':                 'go',
      'java':               'java',
      'java/maven':         'java',
      'java/gradle':        'java',
      'c#':                 'csharp',
      'csharp':             'csharp',
      'asp.net':            'csharp',
      '.net':               'csharp',
      'dotnet':             'csharp',
      'c/c++':              'cpp',
      'c++':                'cpp',
      'c':                  'cpp',
      'php':                'php',
      'laravel':            'php',
      'symfony':            'php',
    };

    for (const [key, id] of Object.entries(techMap)) {
      if (lower.includes(key)) {
        return this._plugins.get(id) || null;
      }
    }
    return null;
  }

  /**
   * Dispatch a method call to the plugin matching a technology.
   * @param {string} tech     Technology name (from SESSION._lastDetectedTech)
   * @param {string} method   Method name on the plugin
   * @param  {...any} args    Arguments to pass
   * @returns {any}           Result from plugin method, or null if no plugin found
   */
  dispatch(tech, method, ...args) {
    const plugin = this.pluginForTech(tech);
    if (!plugin || typeof plugin[method] !== 'function') return null;
    return plugin[method](...args);
  }

  /**
   * Run environment checks for ALL detected languages in a project.
   * @param {string} projectRoot
   * @returns {object[]}  Array of EnvReport objects (one per detected language)
   */
  checkAllEnvironments(projectRoot) {
    const detected = this.detectLanguages(projectRoot);
    return detected.map(plugin => ({
      language: plugin.id,
      displayName: plugin.displayName,
      ...plugin.checkEnvironment(projectRoot),
    }));
  }

  /**
   * Get the version resolver instance (for direct use or /env commands).
   * @returns {VersionResolver}
   */
  get versionResolver() {
    return this._versionResolver;
  }

  /**
   * Get a summary of all latest versions for display.
   * @returns {Promise<string>}  Formatted version block for prompt injection
   */
  async getVersionBlock() {
    const lines = [];
    for (const plugin of this._plugins.values()) {
      try {
        const versions = await plugin.getLatestVersions();
        if (versions && versions.runtime) {
          const fwParts = Object.entries(versions.frameworks || {})
            .map(([name, ver]) => `${name}: ${ver}`)
            .join(' | ');
          lines.push(`- ${plugin.displayName}: ${versions.runtime}${fwParts ? ' | ' + fwParts : ''}`);
        }
      } catch { /* skip */ }
    }
    if (lines.length === 0) return '';
    return 'LATEST STABLE VERSIONS (use these for new projects):\n' + lines.join('\n');
  }

  /**
   * Format a combined environment report for display.
   * @param {object[]} reports  From checkAllEnvironments()
   * @returns {string}
   */
  formatEnvReport(reports) {
    if (!reports || reports.length === 0) {
      return 'No languages detected in this project.';
    }

    const sections = [];
    for (const r of reports) {
      const lines = [`Environment Check: ${r.displayName}`];
      lines.push('─'.repeat(40));

      if (r.runtime) {
        const status = r.runtime.installed ? '✓ INSTALLED' : '✗ MISSING';
        lines.push(`  Runtime: ${status} (${r.runtime.version || 'unknown'})`);
        if (r.runtime.minVersion) {
          const compat = r.runtime.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE (need ' + r.runtime.minVersion + '+)';
          lines.push(`  Required: >= ${r.runtime.minVersion} — ${compat}`);
        }
      }

      if (r.packageManager) {
        lines.push(`  Package Manager: ${r.packageManager.name} ${r.packageManager.version || ''}`);
      }

      if (r.virtualEnv) {
        const vStatus = r.virtualEnv.active ? 'ACTIVE' : r.virtualEnv.exists ? 'EXISTS (not active)' : 'NONE';
        lines.push(`  Virtual Environment: ${vStatus}${r.virtualEnv.path ? ' (' + r.virtualEnv.path + ')' : ''}`);
      }

      if (r.missing && r.missing.length > 0) {
        lines.push('  Missing Tools:');
        for (const m of r.missing) {
          lines.push(`    - ${m.tool}: ${m.installCmd || 'no install hint'}`);
        }
      }

      if (r.warnings && r.warnings.length > 0) {
        for (const w of r.warnings) {
          lines.push(`  Warning: ${w}`);
        }
      }

      lines.push(`  Status: ${r.ready ? '✓ READY' : '✗ NOT READY'}`);
      sections.push(lines.join('\n'));
    }

    return sections.join('\n\n');
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  PluginRegistry,
  LanguagePlugin,
  OSAbstraction,
  INSTALL_HINTS,
  VersionResolver,
  parseSemver,
  compareSemver,
  satisfiesMinimum,
  majorVersion,
};
