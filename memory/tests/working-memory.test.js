'use strict';

const { WorkingMemory } = require('../working-memory');

describe('WorkingMemory', () => {
  let wm;

  beforeEach(() => {
    wm = new WorkingMemory();
  });

  describe('task anchor', () => {
    test('setTask sets the current task', () => {
      wm.setTask('Create JSON schema validator in omar/');
      expect(wm.getAnchorBlock()).toContain('[TASK] Create JSON schema validator in omar/');
    });

    test('updateStatus appends to status trail', () => {
      wm.setTask('Build API');
      wm.updateStatus('Directory created');
      wm.updateStatus('File written');
      const block = wm.getAnchorBlock();
      expect(block).toContain('Directory created');
      expect(block).toContain('File written');
    });

    test('setNextStep sets the step hint', () => {
      wm.setTask('Build API');
      wm.setNextStep('Run tests');
      expect(wm.getAnchorBlock()).toContain('[STEP] Run tests');
    });

    test('anchor block contains all sections', () => {
      wm.setTask('Build API');
      wm.updateStatus('Files created');
      wm.setNextStep('Run build');
      wm.addCorrection('Use async/await not callbacks', 3);
      const block = wm.getAnchorBlock();
      expect(block).toContain('[TASK]');
      expect(block).toContain('[STATUS]');
      expect(block).toContain('[STEP]');
      expect(block).toContain('[CORRECTIONS]');
    });

    test('no task set returns minimal block', () => {
      const block = wm.getAnchorBlock();
      expect(block).toBe('');
    });
  });

  describe('corrections', () => {
    test('addCorrection stores correction with turn number', () => {
      wm.setTask('Build API');
      wm.addCorrection('Use pydantic not jsonschema', 5);
      expect(wm.getAnchorBlock()).toContain('Use pydantic not jsonschema');
    });

    test('max 5 corrections, oldest evicted', () => {
      wm.setTask('test');
      for (let i = 1; i <= 7; i++) {
        wm.addCorrection(`Correction ${i}`, i);
      }
      const block = wm.getAnchorBlock();
      expect(block).not.toContain('Correction 1');
      expect(block).not.toContain('Correction 2');
      expect(block).toContain('Correction 7');
    });

    test('getCorrections returns all corrections', () => {
      wm.addCorrection('fix A', 1);
      wm.addCorrection('fix B', 2);
      expect(wm.getCorrections()).toHaveLength(2);
    });
  });

  describe('DO NOT block', () => {
    test('addDoNot adds resolved topic', () => {
      wm.setTask('Build API');
      wm.addDoNot('Search for observability');
      expect(wm.getAnchorBlock()).toContain('[DO NOT]');
      expect(wm.getAnchorBlock()).toContain('observability');
    });

    test('max 3 entries, oldest evicted (LRU)', () => {
      wm.setTask('test');
      wm.addDoNot('Topic A');
      wm.addDoNot('Topic B');
      wm.addDoNot('Topic C');
      wm.addDoNot('Topic D');
      const block = wm.getAnchorBlock();
      expect(block).not.toContain('Topic A');
      expect(block).toContain('Topic D');
    });

    test('cleared when task changes', () => {
      wm.setTask('Task 1');
      wm.addDoNot('Old topic');
      wm.setTask('Task 2');
      expect(wm.getAnchorBlock()).not.toContain('Old topic');
    });
  });

  describe('recovery directive', () => {
    test('buildRecoveryDirective includes error and current task', () => {
      wm.setTask('Create JSON schema validator');
      const directive = wm.buildRecoveryDirective(
        'BLOCKED: Cannot write to CLI source file',
        'Write to C:\\Users\\Attar\\Desktop\\omar\\ instead'
      );
      expect(directive).toContain('[RECOVERY]');
      expect(directive).toContain('BLOCKED');
      expect(directive).toContain('Create JSON schema validator');
      expect(directive).toContain('CURRENT task');
      expect(directive).toContain('Do NOT change topic');
    });

    test('works without a current task', () => {
      const directive = wm.buildRecoveryDirective('Timeout', 'Try again');
      expect(directive).toContain('[RECOVERY]');
      expect(directive).toContain('Timeout');
    });
  });

  describe('search repetition', () => {
    test('recordSearch tracks queries', () => {
      wm.recordSearch('observability invalid data', 1, 'abc');
      wm.recordSearch('observability data choices', 1, 'abc');
      expect(wm.isSearchRepeating('observability invalid', 'abc')).toBe(false); // only 2, need 3
    });

    test('detects repetition after 3 similar queries with same results', () => {
      wm.recordSearch('observability invalid data', 1, 'hash1');
      wm.recordSearch('observability data choices', 1, 'hash1');
      wm.recordSearch('observability python book', 1, 'hash1');
      expect(wm.isSearchRepeating('observability error', 'hash1')).toBe(true);
    });

    test('does not flag as repeating with different result hashes', () => {
      wm.recordSearch('observability data', 1, 'hash1');
      wm.recordSearch('observability book', 1, 'hash2');
      wm.recordSearch('observability test', 1, 'hash3');
      expect(wm.isSearchRepeating('observability x', 'hash4')).toBe(false);
    });

    test('getSearchRepetitionWarning returns warning when repeating', () => {
      wm.recordSearch('observability invalid data', 5, 'h1');
      wm.recordSearch('observability data choices', 5, 'h1');
      wm.recordSearch('observability python book', 5, 'h1');
      const warning = wm.getSearchRepetitionWarning('observability error', 'h1');
      expect(warning).toContain('similar queries');
      expect(warning).toContain('Move on');
    });

    test('capped at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        wm.recordSearch(`query ${i}`, 1, `hash${i}`);
      }
      expect(wm._searchHistory.length).toBeLessThanOrEqual(20);
    });
  });

  describe('auto-update from tool results', () => {
    test('updateFromToolResult updates status for write_file', () => {
      wm.setTask('Create project');
      wm.updateFromToolResult('write_file', { filepath: 'src/app.js' }, '✓ File written');
      const block = wm.getAnchorBlock();
      expect(block).toContain('app.js');
    });

    test('updateFromToolResult updates status for build_and_test success', () => {
      wm.setTask('Fix build');
      wm.updateFromToolResult('build_and_test', {}, '✓ Build succeeded, 0 errors');
      expect(wm.getAnchorBlock()).toContain('Build succeeded');
    });

    test('updateFromToolResult updates status for build_and_test failure', () => {
      wm.setTask('Fix build');
      wm.updateFromToolResult('build_and_test', {}, '❌ 3 errors found');
      expect(wm.getAnchorBlock()).toContain('error');
    });
  });
});
