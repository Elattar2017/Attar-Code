'use strict';

const { ContextBudget } = require('../context-budget');

describe('ContextBudget', () => {
  describe('tier detection', () => {
    test('classifies 8192 as small', () => {
      const b = new ContextBudget(8192);
      expect(b.tier).toBe('small');
    });

    test('classifies 16384 as small (boundary)', () => {
      const b = new ContextBudget(16384);
      expect(b.tier).toBe('small');
    });

    test('classifies 32768 as medium', () => {
      const b = new ContextBudget(32768);
      expect(b.tier).toBe('medium');
    });

    test('classifies 65536 as medium (boundary)', () => {
      const b = new ContextBudget(65536);
      expect(b.tier).toBe('medium');
    });

    test('classifies 131072 as large', () => {
      const b = new ContextBudget(131072);
      expect(b.tier).toBe('large');
    });
  });

  describe('budget allocation', () => {
    test('response reserve is 25% of total', () => {
      const b = new ContextBudget(40000);
      expect(b.responseReserve).toBe(10000);
    });

    test('available input is 75% of total', () => {
      const b = new ContextBudget(40000);
      expect(b.availableInput).toBe(30000);
    });

    test('small model: system prompt budget is ~400', () => {
      const b = new ContextBudget(8192);
      expect(b.systemPromptBudget).toBeGreaterThanOrEqual(300);
      expect(b.systemPromptBudget).toBeLessThanOrEqual(500);
    });

    test('large model: system prompt budget is ~600', () => {
      const b = new ContextBudget(131072);
      expect(b.systemPromptBudget).toBeGreaterThanOrEqual(500);
      expect(b.systemPromptBudget).toBeLessThanOrEqual(700);
    });

    test('conversation budget is the remainder after fixed allocations', () => {
      const b = new ContextBudget(40000);
      const fixed = b.systemPromptBudget + b.anchorBudget + b.reinforcementBudget + b.memoryBudget;
      expect(b.conversationBudget).toBe(b.availableInput - fixed);
    });
  });

  describe('compression thresholds', () => {
    test('small model masks earlier (35%)', () => {
      const b = new ContextBudget(8192);
      expect(b.thresholds.mask).toBe(0.35);
    });

    test('medium model masks at 40%', () => {
      const b = new ContextBudget(32768);
      expect(b.thresholds.mask).toBe(0.40);
    });

    test('large model masks at 50%', () => {
      const b = new ContextBudget(131072);
      expect(b.thresholds.mask).toBe(0.50);
    });

    test('all tiers have 4 thresholds in ascending order', () => {
      const b = new ContextBudget(32768);
      const t = b.thresholds;
      expect(t.mask).toBeLessThan(t.summarize);
      expect(t.summarize).toBeLessThan(t.extract);
      expect(t.extract).toBeLessThan(t.compact);
    });
  });

  describe('shouldCompress', () => {
    test('returns null when under mask threshold', () => {
      const b = new ContextBudget(40000);
      expect(b.shouldCompress(5000)).toBeNull();
    });

    test('returns "mask" when between mask and summarize thresholds', () => {
      const b = new ContextBudget(40000);
      // medium tier: mask at 40% of 30000 (available) = 12000
      expect(b.shouldCompress(13000)).toBe('mask');
    });

    test('returns "compact" when above compact threshold', () => {
      const b = new ContextBudget(40000);
      // medium tier: compact at 95% of 30000 = 28500
      expect(b.shouldCompress(29000)).toBe('compact');
    });
  });
});
