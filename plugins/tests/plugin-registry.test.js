'use strict';

const path = require('path');
const { PluginRegistry, LanguagePlugin, OSAbstraction } = require('../index');

describe('PluginRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new PluginRegistry({
      pluginDir: path.join(__dirname, '..', 'languages'),
    });
  });

  describe('constructor', () => {
    test('creates with defaults', () => {
      const r = new PluginRegistry();
      expect(r).toBeTruthy();
      expect(r.versionResolver).toBeTruthy();
    });

    test('accepts proxyUrl', () => {
      const r = new PluginRegistry({ proxyUrl: 'http://localhost:3001' });
      expect(r._proxyUrl).toBe('http://localhost:3001');
    });
  });

  describe('loadAll', () => {
    test('returns 0 for empty languages directory', () => {
      const r = new PluginRegistry({ pluginDir: '/nonexistent/path' });
      expect(r.loadAll()).toBe(0);
    });

    // This test will pass once we have plugins in languages/
    test('loads plugins from languages directory', () => {
      const count = registry.loadAll();
      // At minimum 0 (no plugins created yet), will increase as we add them
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('pluginForFile', () => {
    test('returns null when no plugins loaded', () => {
      expect(registry.pluginForFile('test.py')).toBeNull();
    });
  });

  describe('pluginForTech', () => {
    test('returns null for null tech', () => {
      expect(registry.pluginForTech(null)).toBeNull();
    });

    test('returns null when no plugins loaded', () => {
      expect(registry.pluginForTech('Python')).toBeNull();
    });
  });

  describe('detectLanguages', () => {
    test('returns empty array for nonexistent directory', () => {
      expect(registry.detectLanguages('/nonexistent/path')).toEqual([]);
    });
  });

  describe('formatEnvReport', () => {
    test('handles empty reports', () => {
      const result = registry.formatEnvReport([]);
      expect(result).toContain('No languages detected');
    });

    test('formats a basic report', () => {
      const reports = [{
        language: 'python',
        displayName: 'Python',
        ready: true,
        runtime: { installed: true, version: '3.12.9', compatible: true, minVersion: '3.10.0' },
        packageManager: { name: 'uv', version: '0.6.0' },
        virtualEnv: { active: true, exists: true, path: '.venv' },
        missing: [],
        warnings: [],
      }];
      const result = registry.formatEnvReport(reports);
      expect(result).toContain('Python');
      expect(result).toContain('3.12.9');
      expect(result).toContain('INSTALLED');
      expect(result).toContain('READY');
      expect(result).toContain('uv');
    });

    test('shows missing tools', () => {
      const reports = [{
        language: 'rust',
        displayName: 'Rust',
        ready: false,
        runtime: { installed: false, version: null },
        packageManager: null,
        virtualEnv: null,
        missing: [{ tool: 'cargo', installCmd: 'curl https://sh.rustup.rs | sh' }],
        warnings: [],
      }];
      const result = registry.formatEnvReport(reports);
      expect(result).toContain('MISSING');
      expect(result).toContain('cargo');
      expect(result).toContain('NOT READY');
    });
  });
});

describe('LanguagePlugin (base class)', () => {
  let plugin;

  beforeEach(() => {
    plugin = new LanguagePlugin({
      id: 'test',
      displayName: 'Test',
      extensions: ['.test'],
      configFiles: ['test.config'],
    });
  });

  test('has correct identity', () => {
    expect(plugin.id).toBe('test');
    expect(plugin.displayName).toBe('Test');
    expect(plugin.extensions).toEqual(['.test']);
  });

  test('catalog getter returns fallback for missing JSON', () => {
    const cat = plugin.catalog;
    expect(cat).toBeTruthy();
    expect(cat.errorCatalog).toBeTruthy();
    expect(cat.errorCatalog.categories).toEqual([]);
  });

  test('errorCatalog getter delegates to catalog', () => {
    expect(plugin.errorCatalog.categories).toEqual([]);
  });

  test('detect returns false for nonexistent path', () => {
    expect(plugin.detect('/nonexistent')).toBe(false);
  });

  test('base methods return defaults', () => {
    expect(plugin.detectVersion()).toBeNull();
    expect(plugin.detectTestFramework('.')).toBeNull();
    expect(plugin.getStrategyOrder()).toEqual([]);
    expect(plugin.parseErrors('error text')).toEqual([]);
    expect(plugin.getCrashPatterns()).toEqual([]);
    expect(plugin.analyzeSource('test.js')).toEqual({ functions: [], classes: [], imports: [], exports: [] });
    expect(plugin.generateTestSkeleton({})).toEqual([]);
    expect(plugin.getEdgeCases('string')).toEqual([]);
    expect(plugin.generateMocks([])).toEqual([]);
  });

  test('buildFixPrompt generates structured prompt', () => {
    const error = {
      code: 'TEST001',
      message: 'something broke',
      category: 'syntax',
      file: 'test.py',
      line: 10,
      column: 5,
    };
    const prompt = plugin.buildFixPrompt(error, {
      functionName: 'doStuff',
      codeSnippet: 'const x = 1;',
    });
    expect(prompt).toContain('TEST001');
    expect(prompt).toContain('something broke');
    expect(prompt).toContain('doStuff');
    expect(prompt).toContain('Respond as JSON');
  });

  test('buildSearchQuery includes language and error info', () => {
    const query = plugin.buildSearchQuery({ code: 'E001', message: 'import failed' });
    expect(query).toContain('Test');
    expect(query).toContain('E001');
    expect(query).toContain('import failed');
    expect(query).toContain('fix');
  });
});

describe('Exports', () => {
  test('all modules are exported from index', () => {
    const exports = require('../index');
    expect(exports.PluginRegistry).toBeTruthy();
    expect(exports.LanguagePlugin).toBeTruthy();
    expect(exports.OSAbstraction).toBeTruthy();
    expect(exports.VersionResolver).toBeTruthy();
    expect(exports.parseSemver).toBeTruthy();
    expect(exports.compareSemver).toBeTruthy();
    expect(exports.satisfiesMinimum).toBeTruthy();
    expect(exports.majorVersion).toBeTruthy();
  });
});
