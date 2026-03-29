'use strict';

/**
 * plugins/test-generator.js — Two-phase test generation.
 *
 * Phase 1 (deterministic): AST analysis → test skeleton with guaranteed coverage.
 * Phase 2 (LLM): Send skeleton + source to Ollama → LLM fills expected values.
 *
 * The skeleton guarantees comprehensive coverage (every function, every type edge case,
 * every error path). The LLM makes it runnable with real expected values.
 * The LLM never decides WHAT to test — only fills in values.
 */

const fs = require('fs');
const path = require('path');

// ─── TestGenerator ─────────────────────────────────────────────────────────────

class TestGenerator {
  /**
   * @param {object} opts
   * @param {string} [opts.ollamaUrl]  Ollama API URL
   * @param {string} [opts.model]      Model name for Phase 2
   */
  constructor(opts = {}) {
    this._ollamaUrl = opts.ollamaUrl || 'http://localhost:11434';
    this._model = opts.model || null; // Will use SESSION model if not set
  }

  // ─── Phase 1: Generate Skeleton (deterministic) ────────────────────────────

  /**
   * Generate a deterministic test skeleton from source analysis.
   * Covers: happy path, edge cases per type, error/invalid, null, async rejection.
   *
   * @param {object} plugin      LanguagePlugin instance
   * @param {string} filePath    Source file to generate tests for
   * @param {string} projectRoot Project root directory
   * @returns {object} { cases[], mocks[], framework, sourceCode, meta }
   */
  generateSkeleton(plugin, filePath, projectRoot) {
    // 1. Analyze source using plugin's AST
    const meta = plugin.analyzeSource(filePath);
    if (!meta || (!meta.functions?.length && !meta.classes?.length)) {
      return { cases: [], mocks: [], framework: null, sourceCode: '', meta, error: 'No functions or classes found' };
    }

    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const framework = plugin.detectTestFramework(projectRoot);
    const cases = [];

    // 2. Generate test cases for each function
    for (const fn of (meta.functions || [])) {
      // Skip private/internal functions (start with _ in Python, # in JS)
      if (fn.name.startsWith('_') && fn.name !== '__init__') continue;

      // Happy path
      cases.push({
        name: `${fn.name} returns expected output`,
        type: 'happy',
        function: fn.name,
        params: fn.params || [],
        isAsync: fn.isAsync || false,
        expected: null, // Phase 2 fills this
      });

      // Edge cases from parameter types
      for (const param of (fn.params || [])) {
        if (param.name === 'self' || param.name === 'cls') continue; // Skip Python self/cls
        const edges = plugin.getEdgeCases(param.type || 'unknown');
        for (const edge of edges) {
          cases.push({
            name: `${fn.name} handles ${param.name}=${edge.label}`,
            type: 'edge',
            function: fn.name,
            param: param.name,
            paramType: param.type,
            edgeValue: edge.value,
            expected: null,
          });
        }
      }

      // Error/invalid input
      cases.push({
        name: `${fn.name} handles invalid input`,
        type: 'error',
        function: fn.name,
        expected: null, // Should throw/raise or return error
      });

      // Null/undefined/None for each param
      for (const param of (fn.params || [])) {
        if (param.name === 'self' || param.name === 'cls') continue;
        cases.push({
          name: `${fn.name} handles ${param.name}=null`,
          type: 'null',
          function: fn.name,
          param: param.name,
          expected: null,
        });
      }

      // Async rejection (if async)
      if (fn.isAsync) {
        cases.push({
          name: `${fn.name} handles async rejection`,
          type: 'async_error',
          function: fn.name,
          expected: null,
        });
      }
    }

    // 3. Generate test cases for each class
    for (const cls of (meta.classes || [])) {
      // Constructor test
      cases.push({
        name: `${cls.name} can be instantiated`,
        type: 'happy',
        function: `${cls.name} constructor`,
        className: cls.name,
        expected: null,
      });

      // Method tests (from class methods list)
      for (const method of (cls.methods || [])) {
        if (method.startsWith('_') && method !== '__init__') continue;
        cases.push({
          name: `${cls.name}.${method} works correctly`,
          type: 'happy',
          function: `${cls.name}.${method}`,
          className: cls.name,
          method,
          expected: null,
        });
      }
    }

    // 4. Generate mock requirements
    const externalDeps = (meta.imports || []).filter(i => i.isExternal !== false);
    const mocks = plugin.generateMocks(externalDeps);

    return {
      cases,
      mocks,
      framework,
      sourceCode,
      meta,
      filePath,
      language: plugin.id,
    };
  }

  // ─── Phase 2: LLM Completion ──────────────────────────────────────────────

  /**
   * Send skeleton + source to LLM to fill in expected values.
   * Returns a complete, runnable test file.
   *
   * @param {object} skeleton  From generateSkeleton()
   * @param {object} opts
   * @param {string} [opts.model]  Override model name
   * @returns {Promise<string>}    Complete test file content
   */
  async completeSkeleton(skeleton, opts = {}) {
    const model = opts.model || this._model;
    if (!model) return this._buildSkeletonOnly(skeleton);

    const prompt = this._buildCompletionPrompt(skeleton);

    try {
      const response = await fetch(`${this._ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.2, num_predict: 4096 },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) return this._buildSkeletonOnly(skeleton);

      const data = await response.json();
      const content = data.response || '';

      // Extract code block from LLM response
      const codeMatch = content.match(/```(?:\w+)?\n([\s\S]+?)```/);
      return codeMatch ? codeMatch[1].trim() : content.trim();
    } catch {
      // LLM unavailable — return skeleton with TODO comments
      return this._buildSkeletonOnly(skeleton);
    }
  }

  // ─── Prompt Builder ────────────────────────────────────────────────────────

  _buildCompletionPrompt(skeleton) {
    const { cases, mocks, sourceCode, language, framework } = skeleton;

    const mockSection = mocks.length > 0
      ? `\nMOCK REQUIREMENTS:\n${mocks.map(m => `- Mock ${m.name} (${m.type}): return ${m.returnValue}`).join('\n')}`
      : '';

    const casesSection = cases.map((c, i) => {
      let desc = `${i + 1}. [${c.type}] ${c.name}`;
      if (c.edgeValue) desc += ` (input: ${c.edgeValue})`;
      if (c.type === 'error') desc += ' → should throw/raise or return error';
      if (c.type === 'null') desc += ` → handle ${c.param} being null/None`;
      if (c.type === 'async_error') desc += ' → should reject or raise';
      return desc;
    }).join('\n');

    const fwName = framework?.name || 'standard';

    return `You are writing tests for a ${language} file using ${fwName}.

SOURCE CODE:
\`\`\`
${sourceCode.slice(0, 3000)}
\`\`\`
${mockSection}

TEST CASES TO IMPLEMENT (fill in expected values and assertions):
${casesSection}

RULES:
- Write a COMPLETE, RUNNABLE test file
- Use ${fwName} framework syntax
- Import the source file correctly
- Set up mocks for external dependencies
- Fill in realistic expected values based on the source code
- Each test case must have at least one assertion
- Do NOT add extra test cases beyond what's listed
- Do NOT modify the source code

Respond with ONLY the test file code inside a code block.`;
  }

  // ─── Skeleton-Only Fallback ────────────────────────────────────────────────

  _buildSkeletonOnly(skeleton) {
    const { cases, mocks, language, framework, filePath } = skeleton;
    const fwName = framework?.name || 'unknown';
    const relPath = filePath ? path.basename(filePath, path.extname(filePath)) : 'module';

    if (language === 'python') {
      return this._buildPythonSkeleton(cases, mocks, relPath, fwName);
    }
    if (language === 'typescript') {
      return this._buildJSSkeleton(cases, mocks, relPath, fwName);
    }
    // Generic skeleton
    return this._buildGenericSkeleton(cases, language);
  }

  _buildPythonSkeleton(cases, mocks, moduleName, framework) {
    const lines = [];
    if (framework === 'pytest') {
      lines.push(`import pytest`);
    } else {
      lines.push(`import unittest`);
    }
    lines.push(`from ${moduleName} import *  # TODO: import specific functions`);
    if (mocks.length > 0) {
      lines.push(`from unittest.mock import Mock, patch`);
    }
    lines.push('', '');

    if (framework === 'pytest') {
      for (const c of cases) {
        lines.push(`def test_${c.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}():`);
        if (c.type === 'happy') {
          lines.push(`    # TODO: Fill in expected value`);
          lines.push(`    result = ${c.function}()  # TODO: add arguments`);
          lines.push(`    assert result is not None  # TODO: replace with actual assertion`);
        } else if (c.type === 'edge') {
          lines.push(`    # Edge case: ${c.param} = ${c.edgeValue}`);
          lines.push(`    result = ${c.function}(${c.param}=${c.edgeValue})`);
          lines.push(`    assert result is not None  # TODO: replace with actual assertion`);
        } else if (c.type === 'error') {
          lines.push(`    with pytest.raises(Exception):  # TODO: specify exception type`);
          lines.push(`        ${c.function}(None)  # TODO: use invalid input`);
        } else if (c.type === 'null') {
          lines.push(`    # Handle ${c.param} = None`);
          lines.push(`    result = ${c.function}(${c.param}=None)`);
          lines.push(`    assert result is not None or True  # TODO: define expected behavior`);
        } else if (c.type === 'async_error') {
          lines.push(`    # Async rejection test`);
          lines.push(`    with pytest.raises(Exception):`);
          lines.push(`        await ${c.function}()  # TODO: trigger rejection`);
        }
        lines.push('', '');
      }
    } else {
      lines.push(`class Test${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}(unittest.TestCase):`);
      for (const c of cases) {
        lines.push(`    def test_${c.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}(self):`);
        lines.push(`        # TODO: implement test`);
        lines.push(`        pass`);
        lines.push('');
      }
      lines.push('', "if __name__ == '__main__':", '    unittest.main()');
    }

    return lines.join('\n');
  }

  _buildJSSkeleton(cases, mocks, moduleName, framework) {
    const lines = [];
    const isVitest = framework === 'vitest';
    const importStyle = isVitest ? 'import' : 'const';

    if (isVitest) {
      lines.push(`import { describe, test, expect, vi } from 'vitest';`);
      lines.push(`import { /* TODO: functions */ } from './${moduleName}';`);
    } else {
      lines.push(`const { /* TODO: functions */ } = require('./${moduleName}');`);
    }

    if (mocks.length > 0) {
      lines.push('');
      for (const m of mocks) {
        if (isVitest) {
          lines.push(`vi.mock('${m.name}', () => ({ default: ${m.returnValue} }));`);
        } else {
          lines.push(`jest.mock('${m.name}', () => (${m.returnValue}));`);
        }
      }
    }

    lines.push('', `describe('${moduleName}', () => {`);

    for (const c of cases) {
      const testFn = c.isAsync ? 'async ' : '';
      lines.push(`  test('${c.name}', ${testFn}() => {`);

      if (c.type === 'happy') {
        lines.push(`    // TODO: Fill in expected value`);
        lines.push(`    const result = ${c.isAsync ? 'await ' : ''}${c.function}(); // TODO: add arguments`);
        lines.push(`    expect(result).toBeDefined(); // TODO: replace with actual assertion`);
      } else if (c.type === 'edge') {
        lines.push(`    // Edge case: ${c.param} = ${c.edgeValue}`);
        lines.push(`    const result = ${c.function}(${c.edgeValue});`);
        lines.push(`    expect(result).toBeDefined(); // TODO: replace with actual assertion`);
      } else if (c.type === 'error') {
        lines.push(`    expect(() => ${c.function}(null)).toThrow(); // TODO: specify error`);
      } else if (c.type === 'null') {
        lines.push(`    // Handle ${c.param} = null`);
        lines.push(`    const result = ${c.function}(null);`);
        lines.push(`    expect(result).toBeDefined(); // TODO: define expected behavior`);
      } else if (c.type === 'async_error') {
        lines.push(`    await expect(${c.function}()).rejects.toThrow(); // TODO: trigger rejection`);
      }

      lines.push(`  });`);
      lines.push('');
    }

    lines.push('});');
    return lines.join('\n');
  }

  _buildGenericSkeleton(cases, language) {
    const lines = [`// Test skeleton for ${language}`, '// Generated by Attar-Code test generator', ''];
    for (const c of cases) {
      lines.push(`// Test: ${c.name} [${c.type}]`);
      lines.push(`// Function: ${c.function}`);
      if (c.edgeValue) lines.push(`// Input: ${c.edgeValue}`);
      lines.push('// TODO: implement test', '');
    }
    return lines.join('\n');
  }

  // ─── Utility: Format for Display ───────────────────────────────────────────

  /**
   * Format a skeleton summary for CLI display.
   * @param {object} skeleton
   * @returns {string}
   */
  formatSkeletonSummary(skeleton) {
    if (!skeleton || !skeleton.cases?.length) {
      return 'No test cases generated (no functions or classes found in source).';
    }

    const lines = [
      `Test Skeleton: ${skeleton.cases.length} test cases`,
      `Language: ${skeleton.language}`,
      `Framework: ${skeleton.framework?.name || 'unknown'}`,
      '',
      'Coverage:',
    ];

    const byType = {};
    for (const c of skeleton.cases) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      lines.push(`  ${type}: ${count} cases`);
    }

    if (skeleton.mocks.length > 0) {
      lines.push('', `Mocks needed: ${skeleton.mocks.length}`);
      for (const m of skeleton.mocks) {
        lines.push(`  - ${m.name} (${m.type})`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = { TestGenerator };
