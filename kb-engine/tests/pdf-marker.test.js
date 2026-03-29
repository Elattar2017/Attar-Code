'use strict';

const path = require('path');
const { convertWithMarker, isMarkerAvailable } = require('../ingestion/preprocessors/pdf-marker');

describe('pdf-marker', () => {
  describe('isMarkerAvailable', () => {
    test('returns a boolean', async () => {
      const result = await isMarkerAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('convertWithMarker', () => {
    test('returns object with content, title, toc, and headings fields', async () => {
      const result = await convertWithMarker('/nonexistent/fake.pdf');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('toc');
      expect(result).toHaveProperty('headings');
      expect(typeof result.content).toBe('string');
      expect(Array.isArray(result.toc)).toBe(true);
      expect(Array.isArray(result.headings)).toBe(true);
    });

    test('returns error field on failure without throwing', async () => {
      const result = await convertWithMarker('/nonexistent/fake.pdf');
      expect(result.error).toBeDefined();
      expect(result.content).toBe('');
    });

    test('title falls back to filename when extraction fails', async () => {
      const result = await convertWithMarker('/some/path/my-book.pdf');
      expect(result.title).toBe('my-book');
    });
  });
});
