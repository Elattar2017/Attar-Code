'use strict';

const { MemoryExtractor } = require('../memory-extractor');

describe('MemoryExtractor', () => {
  describe('quality gate', () => {
    test('rejects extraction with content < 10 chars', () => {
      const ext = new MemoryExtractor();
      expect(ext.passesQualityGate({ type: 'correction', content: 'hi', scope: 'global' })).toBe(false);
    });

    test('accepts extraction with valid content', () => {
      const ext = new MemoryExtractor();
      expect(ext.passesQualityGate({ type: 'correction', content: 'Use pydantic not jsonschema', scope: 'project' })).toBe(true);
    });

    test('rejects extraction with invalid type', () => {
      const ext = new MemoryExtractor();
      expect(ext.passesQualityGate({ type: 'invalid', content: 'Some long content here', scope: 'global' })).toBe(false);
    });

    test('rejects duplicate (Jaccard > 0.6 with existing)', () => {
      const ext = new MemoryExtractor();
      ext._recentExtractions.push({ content: 'User prefers pydantic for validation' });
      expect(ext.passesQualityGate({ type: 'correction', content: 'User prefers pydantic for validation tasks', scope: 'project' })).toBe(false);
    });

    test('accepts non-duplicate', () => {
      const ext = new MemoryExtractor();
      ext._recentExtractions.push({ content: 'User prefers pydantic' });
      expect(ext.passesQualityGate({ type: 'correction', content: 'Project uses Express and SQLite backend', scope: 'project' })).toBe(true);
    });
  });

  describe('parseExtractionResponse', () => {
    test('parses valid JSON array', () => {
      const ext = new MemoryExtractor();
      const result = ext.parseExtractionResponse('[{"type":"correction","content":"Use async/await","scope":"global"}]');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('correction');
    });

    test('returns empty array for invalid JSON', () => {
      const ext = new MemoryExtractor();
      expect(ext.parseExtractionResponse('not json')).toEqual([]);
    });

    test('returns empty array for non-array JSON', () => {
      const ext = new MemoryExtractor();
      expect(ext.parseExtractionResponse('{"type":"correction"}')).toEqual([]);
    });

    test('extracts JSON from markdown code block', () => {
      const ext = new MemoryExtractor();
      const input = '```json\n[{"type":"decision","content":"Use REST not GraphQL","scope":"project"}]\n```';
      const result = ext.parseExtractionResponse(input);
      expect(result).toHaveLength(1);
    });

    test('caps at 3 extractions', () => {
      const ext = new MemoryExtractor();
      const arr = Array.from({ length: 5 }, (_, i) => ({ type: 'project_fact', content: `Fact ${i} with enough length`, scope: 'project' }));
      const result = ext.parseExtractionResponse(JSON.stringify(arr));
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  describe('buildExtractionPrompt', () => {
    test('includes user message and assistant response', () => {
      const ext = new MemoryExtractor();
      const prompt = ext.buildExtractionPrompt('how to fix auth', 'Add middleware to verify JWT', 'edit_file: auth.js');
      expect(prompt).toContain('how to fix auth');
      expect(prompt).toContain('Add middleware');
      expect(prompt).toContain('auth.js');
    });

    test('truncates long messages', () => {
      const ext = new MemoryExtractor();
      const longMsg = 'x'.repeat(2000);
      const prompt = ext.buildExtractionPrompt(longMsg, longMsg, '');
      expect(prompt.length).toBeLessThan(4000);
    });
  });

  describe('serial queue', () => {
    test('enqueue adds to queue', () => {
      const ext = new MemoryExtractor({ extract: false }); // disable actual LLM calls
      ext.enqueue({ userMessage: 'test', assistantResponse: 'response', toolSummary: '' });
      expect(ext._queue).toHaveLength(1);
    });
  });
});
