'use strict';

const { SmartFixBridge } = require('../smartfix-bridge');

describe('SmartFixBridge', () => {
  describe('error trending', () => {
    test('recordError tracks occurrences', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('MODULE_NOT_FOUND', 'session1', true, 'create_file');
      bridge.recordError('MODULE_NOT_FOUND', 'session2', false, 'llm_edit');

      const trend = bridge.getErrorTrend('MODULE_NOT_FOUND');
      expect(trend.total).toBe(2);
      expect(trend.success_rate).toBe(0.5);
    });

    test('isSystemic returns true after 3+ sessions with same error', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('IMPORT_ERROR', 'session1', true, 'fix_import');
      bridge.recordError('IMPORT_ERROR', 'session2', true, 'fix_import');
      bridge.recordError('IMPORT_ERROR', 'session3', false, 'llm_edit');
      expect(bridge.isSystemic('IMPORT_ERROR')).toBe(true);
    });

    test('isSystemic returns false for < 3 sessions', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('SYNTAX_ERROR', 'session1', true, 'auto_fix');
      expect(bridge.isSystemic('SYNTAX_ERROR')).toBe(false);
    });
  });

  describe('strategy escalation', () => {
    test('shouldEscalate returns true after 2 failed attempts with same strategy', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('TYPE_ERROR', 's1', false, 'llm_edit');
      bridge.recordError('TYPE_ERROR', 's1', false, 'llm_edit');
      expect(bridge.shouldEscalate('TYPE_ERROR', 'llm_edit')).toBe(true);
    });

    test('shouldEscalate returns false after 1 failure', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('TYPE_ERROR', 's1', false, 'llm_edit');
      expect(bridge.shouldEscalate('TYPE_ERROR', 'llm_edit')).toBe(false);
    });
  });

  describe('getContextForFix', () => {
    test('returns error trending info', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('NULL_REF', 's1', true, 'null_check');
      bridge.recordError('NULL_REF', 's2', false, 'llm_edit');

      const ctx = bridge.getContextForFix('NULL_REF');
      expect(ctx.errorTrending.total).toBe(2);
      expect(ctx.errorTrending.success_rate).toBe(0.5);
      expect(ctx.errorTrending.previousStrategies).toContain('null_check');
    });

    test('returns empty context for unknown error', () => {
      const bridge = new SmartFixBridge();
      const ctx = bridge.getContextForFix('UNKNOWN');
      expect(ctx.errorTrending).toBeNull();
    });

    test('includes systemic flag', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('CRASH', 's1', false, 'restart');
      bridge.recordError('CRASH', 's2', false, 'restart');
      bridge.recordError('CRASH', 's3', false, 'restart');

      const ctx = bridge.getContextForFix('CRASH');
      expect(ctx.errorTrending.systemic).toBe(true);
    });
  });

  describe('getSystemicWarning', () => {
    test('returns warning for systemic errors', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('LOOP', 's1', false, 'strategy_a');
      bridge.recordError('LOOP', 's2', false, 'strategy_b');
      bridge.recordError('LOOP', 's3', false, 'strategy_c');

      const warning = bridge.getSystemicWarning('LOOP');
      expect(warning).toContain('SYSTEMIC');
      expect(warning).toContain('3 sessions');
    });

    test('returns null for non-systemic errors', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('TYPO', 's1', true, 'auto');
      expect(bridge.getSystemicWarning('TYPO')).toBeNull();
    });
  });

  describe('persistence', () => {
    test('loadTrends and saveTrends work with object', () => {
      const bridge = new SmartFixBridge();
      bridge.recordError('ERR1', 's1', true, 'fix');

      const data = bridge.exportTrends();
      const bridge2 = new SmartFixBridge();
      bridge2.importTrends(data);
      expect(bridge2.getErrorTrend('ERR1').total).toBe(1);
    });
  });
});
