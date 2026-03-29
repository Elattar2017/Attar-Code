'use strict';

const { buildStructuralChunks } = require('../ingestion/structural-indexer');

describe('structural-indexer', () => {
  test('creates a document overview chunk', () => {
    const toc = [
      { level: 1, title: 'Chapter 1: Introduction', page: 1 },
      { level: 2, title: 'Getting Started', page: 3 },
      { level: 1, title: 'Chapter 2: Basics', page: 10 },
    ];
    const chunks = buildStructuralChunks(toc, 'Python Book');

    const overview = chunks.find(c => c.metadata.structural_type === 'overview');
    expect(overview).toBeDefined();
    expect(overview.content).toContain('Python Book');
    expect(overview.content).toContain('2 chapters');
    expect(overview.content).toContain('Chapter 1');
    expect(overview.content).toContain('Chapter 2');
  });

  test('creates a chunk per chapter with sections listed', () => {
    const toc = [
      { level: 1, title: 'Chapter 1: Introduction', page: 1 },
      { level: 2, title: 'What is Python', page: 3 },
      { level: 2, title: 'Installation', page: 5 },
      { level: 1, title: 'Chapter 2: Variables', page: 10 },
      { level: 2, title: 'Data Types', page: 12 },
    ];
    const chunks = buildStructuralChunks(toc, 'Python Book');

    const ch1 = chunks.find(c =>
      c.metadata.structural_type === 'chapter' &&
      c.metadata.chapter === 'Chapter 1: Introduction'
    );
    expect(ch1).toBeDefined();
    expect(ch1.content).toContain('What is Python');
    expect(ch1.content).toContain('Installation');
    expect(ch1.metadata.heading_level).toBe(1);
    expect(ch1.metadata.chunk_type).toBe('structural');
  });

  test('returns empty array for empty TOC', () => {
    expect(buildStructuralChunks([], 'Book')).toEqual([]);
  });

  test('all chunks have chunk_type: structural', () => {
    const toc = [
      { level: 1, title: 'Intro' },
      { level: 2, title: 'Details' },
    ];
    const chunks = buildStructuralChunks(toc, 'Test Doc');
    for (const c of chunks) {
      expect(c.metadata.chunk_type).toBe('structural');
    }
  });

  test('handles single chapter', () => {
    const toc = [{ level: 1, title: 'Only Chapter' }];
    const chunks = buildStructuralChunks(toc, 'Short Doc');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
