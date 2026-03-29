'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { TestGenerator } = require('../test-generator');
const PythonPlugin = require('../languages/python');
const TypeScriptPlugin = require('../languages/typescript');

describe('TestGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = new TestGenerator();
  });

  describe('constructor', () => {
    test('creates with defaults', () => {
      expect(generator._ollamaUrl).toBe('http://localhost:11434');
    });

    test('accepts custom model', () => {
      const g = new TestGenerator({ model: 'qwen2.5:14b' });
      expect(g._model).toBe('qwen2.5:14b');
    });
  });

  describe('generateSkeleton', () => {
    test('returns empty for file with no functions', () => {
      const plugin = new PythonPlugin();
      // Mock analyzeSource to return empty
      plugin.analyzeSource = () => ({ functions: [], classes: [], imports: [], exports: [] });
      const result = generator.generateSkeleton(plugin, 'empty.py', '/tmp');
      expect(result.cases).toEqual([]);
      expect(result.error).toContain('No functions');
    });

    test('generates cases for functions', () => {
      const plugin = new PythonPlugin();
      plugin.analyzeSource = () => ({
        functions: [
          { name: 'add', params: [{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }], isAsync: false },
          { name: 'fetch_data', params: [{ name: 'url', type: 'str' }], isAsync: true },
        ],
        classes: [],
        imports: [{ module: 'requests', isExternal: true }],
        exports: [],
      });

      const tmpFile = path.join(os.tmpdir(), 'test_source.py');
      fs.writeFileSync(tmpFile, 'def add(a, b): return a + b\n');

      const result = generator.generateSkeleton(plugin, tmpFile, os.tmpdir());

      // Should have: happy + edges per param + error + null per param for each function
      expect(result.cases.length).toBeGreaterThan(5);
      expect(result.language).toBe('python');

      // Check case types exist
      const types = new Set(result.cases.map(c => c.type));
      expect(types.has('happy')).toBe(true);
      expect(types.has('edge')).toBe(true);
      expect(types.has('error')).toBe(true);
      expect(types.has('null')).toBe(true);
      expect(types.has('async_error')).toBe(true); // fetch_data is async

      // Check mocks generated for requests
      expect(result.mocks.length).toBeGreaterThan(0);
      expect(result.mocks[0].type).toBe('http');

      fs.unlinkSync(tmpFile);
    });

    test('generates cases for classes', () => {
      const plugin = new TypeScriptPlugin();
      plugin.analyzeSource = () => ({
        functions: [],
        classes: [{ name: 'UserService', methods: ['getUser', 'createUser'], bases: [], line: 1 }],
        imports: [{ module: 'prisma', rawSource: '@prisma/client', isExternal: true }],
        exports: [],
      });

      const tmpFile = path.join(os.tmpdir(), 'test_source.ts');
      fs.writeFileSync(tmpFile, 'class UserService { getUser() {} createUser() {} }');

      const result = generator.generateSkeleton(plugin, tmpFile, os.tmpdir());

      // Constructor + 2 methods = 3 happy cases minimum
      expect(result.cases.some(c => c.name.includes('UserService'))).toBe(true);
      expect(result.cases.some(c => c.name.includes('getUser'))).toBe(true);

      // DB mock for prisma
      expect(result.mocks.some(m => m.type === 'database')).toBe(true);

      fs.unlinkSync(tmpFile);
    });

    test('skips private functions (underscore)', () => {
      const plugin = new PythonPlugin();
      plugin.analyzeSource = () => ({
        functions: [
          { name: 'public_fn', params: [], isAsync: false },
          { name: '_private_fn', params: [], isAsync: false },
          { name: '__init__', params: [{ name: 'self' }], isAsync: false },
        ],
        classes: [], imports: [], exports: [],
      });

      const tmpFile = path.join(os.tmpdir(), 'test_source.py');
      fs.writeFileSync(tmpFile, 'def public_fn(): pass\n');

      const result = generator.generateSkeleton(plugin, tmpFile, os.tmpdir());

      // Should have cases for public_fn but NOT _private_fn (but __init__ is allowed)
      expect(result.cases.some(c => c.function === 'public_fn')).toBe(true);
      expect(result.cases.some(c => c.function === '_private_fn')).toBe(false);

      fs.unlinkSync(tmpFile);
    });

    test('skips self/cls params in edge cases', () => {
      const plugin = new PythonPlugin();
      plugin.analyzeSource = () => ({
        functions: [
          { name: 'method', params: [{ name: 'self' }, { name: 'data', type: 'str' }], isAsync: false },
        ],
        classes: [], imports: [], exports: [],
      });

      const tmpFile = path.join(os.tmpdir(), 'test_source.py');
      fs.writeFileSync(tmpFile, 'def method(self, data): pass\n');

      const result = generator.generateSkeleton(plugin, tmpFile, os.tmpdir());

      // Should NOT have edge cases for 'self'
      expect(result.cases.some(c => c.param === 'self')).toBe(false);
      // Should have edge cases for 'data'
      expect(result.cases.some(c => c.param === 'data')).toBe(true);

      fs.unlinkSync(tmpFile);
    });
  });

  describe('skeleton-only fallback', () => {
    test('builds Python pytest skeleton', () => {
      const skeleton = {
        cases: [
          { name: 'add returns expected output', type: 'happy', function: 'add', params: [], isAsync: false },
          { name: 'add handles a=zero', type: 'edge', function: 'add', param: 'a', edgeValue: '0' },
          { name: 'add handles invalid input', type: 'error', function: 'add' },
        ],
        mocks: [{ name: 'requests', returnValue: 'Mock(status_code=200)', type: 'http' }],
        framework: { name: 'pytest' },
        sourceCode: 'def add(a, b): return a + b',
        language: 'python',
        filePath: '/tmp/calc.py',
        meta: {},
      };

      const result = generator._buildSkeletonOnly(skeleton);
      expect(result).toContain('import pytest');
      expect(result).toContain('def test_');
      expect(result).toContain('assert');
    });

    test('builds JS jest skeleton', () => {
      const skeleton = {
        cases: [
          { name: 'add returns expected output', type: 'happy', function: 'add', isAsync: false },
          { name: 'add handles invalid input', type: 'error', function: 'add' },
        ],
        mocks: [],
        framework: { name: 'jest' },
        sourceCode: 'function add(a, b) { return a + b; }',
        language: 'typescript',
        filePath: '/tmp/calc.js',
        meta: {},
      };

      const result = generator._buildSkeletonOnly(skeleton);
      expect(result).toContain('describe');
      expect(result).toContain('test(');
      expect(result).toContain('expect');
    });

    test('builds vitest skeleton', () => {
      const skeleton = {
        cases: [{ name: 'fn works', type: 'happy', function: 'fn', isAsync: false }],
        mocks: [{ name: 'axios', returnValue: '{ data: {} }', type: 'http' }],
        framework: { name: 'vitest' },
        sourceCode: '',
        language: 'typescript',
        filePath: '/tmp/api.ts',
        meta: {},
      };

      const result = generator._buildSkeletonOnly(skeleton);
      expect(result).toContain('import');
      expect(result).toContain('vitest');
      expect(result).toContain('vi.mock');
    });

    test('builds generic skeleton for unknown language', () => {
      const skeleton = {
        cases: [{ name: 'test case', type: 'happy', function: 'fn' }],
        mocks: [],
        language: 'rust',
        filePath: '/tmp/lib.rs',
        meta: {},
      };

      const result = generator._buildSkeletonOnly(skeleton);
      expect(result).toContain('Test: test case');
      expect(result).toContain('TODO');
    });
  });

  describe('completeSkeleton (offline fallback)', () => {
    test('returns skeleton when no model set', async () => {
      const skeleton = {
        cases: [{ name: 'test', type: 'happy', function: 'fn', isAsync: false }],
        mocks: [],
        framework: { name: 'pytest' },
        sourceCode: 'def fn(): pass',
        language: 'python',
        filePath: '/tmp/test.py',
        meta: {},
      };

      const result = await generator.completeSkeleton(skeleton);
      expect(result).toContain('def test_');
    });

    test('returns skeleton when Ollama unavailable', async () => {
      const g = new TestGenerator({ model: 'nonexistent-model', ollamaUrl: 'http://localhost:99999' });
      const skeleton = {
        cases: [{ name: 'test', type: 'happy', function: 'fn', isAsync: false }],
        mocks: [],
        framework: { name: 'jest' },
        sourceCode: 'function fn() {}',
        language: 'typescript',
        filePath: '/tmp/test.js',
        meta: {},
      };

      const result = await g.completeSkeleton(skeleton);
      expect(result).toContain('test(');
    });
  });

  describe('formatSkeletonSummary', () => {
    test('formats empty skeleton', () => {
      const result = generator.formatSkeletonSummary({ cases: [] });
      expect(result).toContain('No test cases');
    });

    test('formats populated skeleton', () => {
      const skeleton = {
        cases: [
          { type: 'happy' }, { type: 'happy' },
          { type: 'edge' }, { type: 'edge' }, { type: 'edge' },
          { type: 'error' },
          { type: 'null' },
        ],
        mocks: [{ name: 'db', type: 'database' }],
        language: 'python',
        framework: { name: 'pytest' },
      };

      const result = generator.formatSkeletonSummary(skeleton);
      expect(result).toContain('7 test cases');
      expect(result).toContain('happy: 2');
      expect(result).toContain('edge: 3');
      expect(result).toContain('error: 1');
      expect(result).toContain('null: 1');
      expect(result).toContain('Mocks needed: 1');
      expect(result).toContain('db (database)');
    });
  });

  describe('prompt builder', () => {
    test('builds completion prompt with all sections', () => {
      const skeleton = {
        cases: [
          { name: 'add works', type: 'happy', function: 'add' },
          { name: 'add edge zero', type: 'edge', function: 'add', param: 'a', edgeValue: '0' },
          { name: 'add error', type: 'error', function: 'add' },
        ],
        mocks: [{ name: 'db', type: 'database', returnValue: '[]' }],
        sourceCode: 'def add(a, b): return a + b',
        language: 'python',
        framework: { name: 'pytest' },
      };

      const prompt = generator._buildCompletionPrompt(skeleton);
      expect(prompt).toContain('python');
      expect(prompt).toContain('pytest');
      expect(prompt).toContain('SOURCE CODE');
      expect(prompt).toContain('def add');
      expect(prompt).toContain('MOCK REQUIREMENTS');
      expect(prompt).toContain('db (database)');
      expect(prompt).toContain('[happy]');
      expect(prompt).toContain('[edge]');
      expect(prompt).toContain('[error]');
      expect(prompt).toContain('COMPLETE, RUNNABLE');
    });
  });
});
