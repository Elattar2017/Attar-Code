'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const PythonPlugin = require('../languages/python');
const { LanguagePlugin } = require('../plugin-contract');

describe('PythonPlugin', () => {
  let plugin;

  beforeEach(() => {
    plugin = new PythonPlugin();
  });

  // ─── Identity ─────────────────────────────────────────────────────────────

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('python');
      expect(plugin.displayName).toBe('Python');
    });

    test('has Python extensions', () => {
      expect(plugin.extensions).toContain('.py');
      expect(plugin.extensions).toContain('.pyi');
    });

    test('has Python config files', () => {
      expect(plugin.configFiles).toContain('pyproject.toml');
      expect(plugin.configFiles).toContain('requirements.txt');
    });

    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  // ─── Catalog ──────────────────────────────────────────────────────────────

  describe('catalog', () => {
    test('loads python.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('Python');
    });

    test('errorCatalog has categories', () => {
      const ec = plugin.errorCatalog;
      expect(ec.categories).toBeTruthy();
      expect(ec.categories.length).toBeGreaterThan(0);
    });

    test('importSystem is available', () => {
      expect(plugin.importSystem).toBeTruthy();
    });

    test('typeTracing is available', () => {
      expect(plugin.typeTracing).toBeTruthy();
    });

    test('catalog has toolchains', () => {
      expect(plugin.catalog.metadata.toolchains).toBeTruthy();
      expect(plugin.catalog.metadata.toolchains.length).toBeGreaterThan(0);
      const names = plugin.catalog.metadata.toolchains.map(t => t.name);
      expect(names).toContain('python');
      expect(names).toContain('mypy');
    });
  });

  // ─── Detection ────────────────────────────────────────────────────────────

  describe('detect', () => {
    test('detects project with requirements.txt', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask>=3.0\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .py files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.writeFileSync(path.join(tmpDir, 'main.py'), 'print("hello")\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-Python project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('detectVersion', () => {
    test('detects Python version', () => {
      const ver = plugin.detectVersion();
      // May be null if Python not installed (CI), but if installed should have version
      if (ver) {
        expect(ver.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(ver.source).toBeTruthy();
      }
    });
  });

  describe('detectTestFramework', () => {
    test('detects pytest from tests/ directory', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.mkdirSync(path.join(tmpDir, 'tests'));
      const fw = plugin.detectTestFramework(tmpDir);
      expect(fw.name).toBe('pytest');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('returns unittest as fallback', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      const fw = plugin.detectTestFramework(tmpDir);
      expect(fw.name).toBe('unittest');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Environment ──────────────────────────────────────────────────────────

  describe('environment', () => {
    test('getStrategyOrder returns correct order', () => {
      const order = plugin.getStrategyOrder();
      expect(order).toEqual(['uv', 'poetry', 'pipenv', 'venv']);
    });

    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('packageManager');
      expect(report).toHaveProperty('virtualEnv');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      // If Python is installed
      if (report.runtime?.installed) {
        expect(report.runtime.version).toMatch(/^\d+\.\d+/);
        expect(report.strategy).toBeTruthy();
        expect(report.ready).toBe(true);
      }
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Scaffolding ──────────────────────────────────────────────────────────

  describe('scaffold', () => {
    test('scaffolds Flask project', () => {
      const result = plugin.scaffold('myapp', { framework: 'flask' });
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.deps).toHaveProperty('flask');
      expect(result.scripts).toHaveProperty('start');
      expect(result.scripts).toHaveProperty('test');
    });

    test('scaffolds Django project', () => {
      const result = plugin.scaffold('myapp', { framework: 'django' });
      expect(result.deps).toHaveProperty('django');
      expect(result.postCreate.length).toBeGreaterThan(0);
    });

    test('scaffolds FastAPI project', () => {
      const result = plugin.scaffold('myapp', { framework: 'fastapi' });
      expect(result.deps).toHaveProperty('fastapi');
      expect(result.deps).toHaveProperty('uvicorn');
      expect(result.files.length).toBeGreaterThan(0);
    });
  });

  // ─── Build & Run ──────────────────────────────────────────────────────────

  describe('build commands', () => {
    test('getSyntaxCheckCommand generates valid command', () => {
      const cmd = plugin.getSyntaxCheckCommand(['app.py', 'utils.py']);
      expect(cmd).toContain('py_compile');
      expect(cmd).toContain('app.py');
    });

    test('getSyntaxCheckCommand returns null for empty files', () => {
      expect(plugin.getSyntaxCheckCommand([])).toBeNull();
    });

    test('getRunCommand detects entry point', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.writeFileSync(path.join(tmpDir, 'app.py'), 'print("hi")');
      const cmd = plugin.getRunCommand(tmpDir);
      expect(cmd).toContain('app.py');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getInstallCommand returns strategy-appropriate command', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-test-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
      const cmd = plugin.getInstallCommand(tmpDir);
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/pip|uv|poetry|pipenv/);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Error Parsing ────────────────────────────────────────────────────────

  describe('parseErrors', () => {
    test('parses Python traceback', () => {
      const raw = `Traceback (most recent call last):
  File "app.py", line 15, in main
    result = process(data)
  File "app.py", line 8, in process
    return data["key"]
KeyError: 'key'`;
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toContain('app.py');
      expect(errors[0].message).toMatch(/KeyError|key/);
      expect(errors[0].language).toBe('python');
      expect(errors[0].origin).toBe('runtime');
    });

    test('parses mypy errors', () => {
      const raw = `app.py:10: error: Name "foo" is not defined [name-defined]
app.py:15:5: error: Incompatible types in assignment [assignment]`;
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toBe('app.py');
      expect(errors[0].origin).toBe('compiler');
    });

    test('parses ruff errors', () => {
      const raw = 'app.py:10:5: F401 os imported but unused\napp.py:15:1: E302 expected 2 blank lines, got 1';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });

    test('enriches errors from catalog', () => {
      const raw = `  File "app.py", line 5
    if x == 5
         ^
SyntaxError: invalid syntax`;
      const errors = plugin.parseErrors(raw, 'compiler');
      if (errors.length > 0) {
        const e = errors[0];
        // Should be enriched with catalog data (rootCause, prescription)
        expect(e.language).toBe('python');
      }
    });
  });

  // ─── Crash Patterns ───────────────────────────────────────────────────────

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });

    test('matches traceback', () => {
      const patterns = plugin.getCrashPatterns();
      const matches = patterns.some(p => p.test('Traceback (most recent call last):'));
      expect(matches).toBe(true);
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────────

  describe('getEdgeCases', () => {
    test('returns string edge cases', () => {
      const cases = plugin.getEdgeCases('str');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.label === 'empty string')).toBe(true);
    });

    test('returns int edge cases', () => {
      const cases = plugin.getEdgeCases('int');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.label === 'zero')).toBe(true);
    });

    test('returns list edge cases', () => {
      const cases = plugin.getEdgeCases('list');
      expect(cases.length).toBeGreaterThan(0);
    });

    test('returns None for Optional', () => {
      const cases = plugin.getEdgeCases('Optional');
      expect(cases.some(c => c.value === 'None')).toBe(true);
    });

    test('returns default for unknown type', () => {
      const cases = plugin.getEdgeCases('SomeCustomType');
      expect(cases.length).toBeGreaterThan(0);
    });
  });

  // ─── Mocks ────────────────────────────────────────────────────────────────

  describe('generateMocks', () => {
    test('generates DB mock', () => {
      const mocks = plugin.generateMocks([{ module: 'sqlalchemy' }]);
      expect(mocks[0].type).toBe('database');
    });

    test('generates HTTP mock', () => {
      const mocks = plugin.generateMocks([{ module: 'requests' }]);
      expect(mocks[0].type).toBe('http');
    });

    test('generates generic mock', () => {
      const mocks = plugin.generateMocks([{ module: 'unknown_lib' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  describe('diagnostics', () => {
    test('buildSearchQuery includes Python and error type', () => {
      const query = plugin.buildSearchQuery({ code: 'PY_IMPORT_ERROR', message: 'ModuleNotFoundError: No module named flask' });
      expect(query).toContain('Python');
      expect(query).toContain('ModuleNotFoundError');
      expect(query).toContain('fix');
    });

    test('buildFixPrompt generates structured prompt', () => {
      const prompt = plugin.buildFixPrompt(
        { code: 'PY_IMPORT_ERROR', message: 'ImportError: cannot import name Foo', category: 'import', file: 'app.py', line: 5, column: 0 },
        { functionName: 'main', codeSnippet: 'from utils import Foo' }
      );
      expect(prompt).toContain('Python');
      expect(prompt).toContain('ImportError');
      expect(prompt).toContain('app.py');
      expect(prompt).toContain('Respond as JSON');
    });
  });

  // ─── Registry Integration ─────────────────────────────────────────────────

  describe('registry integration', () => {
    test('can be loaded by PluginRegistry', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      const count = registry.loadAll();
      expect(count).toBeGreaterThanOrEqual(1);
      const py = registry.get('python');
      expect(py).toBeTruthy();
      expect(py.id).toBe('python');
    });

    test('pluginForTech finds Python', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('Python')).toBeTruthy();
      expect(registry.pluginForTech('Python')?.id).toBe('python');
    });

    test('pluginForFile finds .py', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForFile('app.py')?.id).toBe('python');
    });
  });
});
