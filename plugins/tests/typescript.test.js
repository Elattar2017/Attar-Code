'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const TypeScriptPlugin = require('../languages/typescript');
const { LanguagePlugin } = require('../plugin-contract');

describe('TypeScriptPlugin', () => {
  let plugin;

  beforeEach(() => { plugin = new TypeScriptPlugin(); });

  describe('identity', () => {
    test('has correct id', () => { expect(plugin.id).toBe('typescript'); });
    test('has TS extensions', () => { expect(plugin.extensions).toContain('.ts'); expect(plugin.extensions).toContain('.js'); });
    test('extends LanguagePlugin', () => { expect(plugin).toBeInstanceOf(LanguagePlugin); });
  });

  describe('catalog', () => {
    test('loads typescript.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('TypeScript');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with package.json', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with tsconfig.json', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect Python-only project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('detectVersion', () => {
    test('detects Node.js version', () => {
      const ver = plugin.detectVersion();
      expect(ver).not.toBeNull();
      expect(ver.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(ver.source).toBe('node');
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns correct order', () => {
      expect(plugin.getStrategyOrder()).toEqual(['pnpm', 'bun', 'yarn', 'npm']);
    });

    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report.ready).toBe(true);
      expect(report.runtime.installed).toBe(true);
      expect(report.runtime.version).toMatch(/^\d+\.\d+/);
      expect(report.strategy).toBeTruthy();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('scaffold', () => {
    test('scaffolds Express TS project', () => {
      const result = plugin.scaffold('myapp', { framework: 'express' });
      expect(result.deps).toHaveProperty('express');
      expect(result.devDeps).toHaveProperty('typescript');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.scripts.build).toBe('tsc');
    });

    test('scaffolds Express JS project', () => {
      const result = plugin.scaffold('myapp', { framework: 'express', typescript: false });
      expect(result.deps).toHaveProperty('express');
      expect(result.devDeps).not.toHaveProperty('typescript');
    });

    test('scaffolds Next.js project', () => {
      const result = plugin.scaffold('myapp', { framework: 'nextjs' });
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('create-next-app');
    });
  });

  describe('parseErrors', () => {
    test('parses TypeScript errors', () => {
      const raw = 'src/app.ts(12,5): error TS2339: Property \'foo\' does not exist on type \'Bar\'';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBe(1);
      expect(errors[0].file).toBe('src/app.ts');
      expect(errors[0].line).toBe(12);
      expect(errors[0].code).toBe('TS2339');
      expect(errors[0].language).toBe('typescript');
    });

    test('parses Node.js runtime errors', () => {
      const raw = '/path/to/app.js:15\n    throw new Error("fail")\nTypeError: Cannot read properties of null';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].origin).toBe('runtime');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null)).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('matches TypeError', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('TypeError: Cannot read properties'))).toBe(true);
    });
    test('matches ECONNREFUSED', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Error: connect ECONNREFUSED'))).toBe(true);
    });
  });

  describe('edge cases and mocks', () => {
    test('getEdgeCases for string', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });

    test('getEdgeCases for number', () => {
      const cases = plugin.getEdgeCases('number');
      expect(cases.some(c => c.label === 'NaN')).toBe(true);
    });

    test('generateMocks for database', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'prisma' }]);
      expect(mocks[0].type).toBe('database');
    });

    test('generateMocks for http', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'axios' }]);
      expect(mocks[0].type).toBe('http');
    });
  });

  describe('diagnostics', () => {
    test('buildSearchQuery', () => {
      const q = plugin.buildSearchQuery({ code: 'TS2339', message: 'Property foo does not exist' });
      expect(q).toContain('TypeScript');
      expect(q).toContain('TS2339');
    });
  });

  describe('registry integration', () => {
    test('loaded by PluginRegistry', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.get('typescript')).toBeTruthy();
    });

    test('pluginForTech finds TypeScript', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('Node.js/TypeScript')?.id).toBe('typescript');
      expect(registry.pluginForTech('Node.js')?.id).toBe('typescript');
    });

    test('pluginForFile finds .ts', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForFile('src/app.ts')?.id).toBe('typescript');
    });
  });
});
