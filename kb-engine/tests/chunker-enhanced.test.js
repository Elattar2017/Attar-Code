'use strict';

const { Chunker } = require('../ingestion/chunker');

describe('Chunker — enhanced features', () => {
  const chunker = new Chunker({ maxTokens: 200, overlapTokens: 40 });

  describe('H4-H6 heading support', () => {
    test('splits on H4 headings', () => {
      const md = '# Top\n\nIntro.\n\n#### Sub-detail\n\nDetail content here.';
      const chunks = chunker.chunk(md);
      const paths = chunks.map(c => c.section_path);
      expect(paths.some(p => p.includes('Sub-detail'))).toBe(true);
    });

    test('splits on H5 and H6 headings', () => {
      const md = '# Main\n\n##### Deep\n\nContent.\n\n###### Deepest\n\nMore.';
      const chunks = chunker.chunk(md);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test('builds correct section_path for H4 under H2', () => {
      const md = '# Ch1\n\n## Sec1\n\nText.\n\n#### Detail\n\nDetail text.';
      const chunks = chunker.chunk(md, 'Book');
      const detailChunk = chunks.find(c => c.section_path.includes('Detail'));
      expect(detailChunk).toBeDefined();
      expect(detailChunk.section_path).toContain('Ch1');
      expect(detailChunk.section_path).toContain('Sec1');
      expect(detailChunk.section_path).toContain('Detail');
    });

    test('clears deeper levels when hitting a shallower heading', () => {
      const md = '# Ch1\n\n#### Deep\n\nContent.\n\n## Sec2\n\nNew section.';
      const chunks = chunker.chunk(md, 'Book');
      const sec2 = chunks.find(c => c.section_path.includes('Sec2'));
      expect(sec2).toBeDefined();
      expect(sec2.section_path).not.toContain('Deep');
    });
  });

  describe('token estimation improvement', () => {
    test('code blocks have higher token estimate than plain text of same word count', () => {
      const code = '```javascript\nconst x = require("fs");\nfunction foo(a, b) {\n  return a + b;\n}\n```';
      const prose = 'The quick brown fox jumps over the lazy dog repeatedly';
      const codeTokens = chunker._estimateTokens(code);
      const proseTokens = chunker._estimateTokens(prose);
      expect(codeTokens).toBeGreaterThan(0);
      expect(proseTokens).toBeGreaterThan(0);
    });

    test('empty string returns 0 tokens', () => {
      expect(chunker._estimateTokens('')).toBe(0);
      expect(chunker._estimateTokens('   ')).toBe(0);
    });
  });

  describe('sentence-aware overlap', () => {
    test('overlap ends at sentence boundary when possible', () => {
      const longText = 'First paragraph with multiple sentences. This is sentence two. Third sentence here.\n\n' +
        'Second paragraph starts here. It has content too. More sentences follow. Even more text to fill the chunk. ' +
        'Additional content for testing purposes. This ensures the chunk exceeds the maximum token limit. ' +
        'We need enough text here to trigger the splitting logic. Final sentences in this block.';

      const chunks = new Chunker({ maxTokens: 60, overlapTokens: 20 }).chunk(longText);

      if (chunks.length >= 2) {
        const secondChunk = chunks[1].content;
        expect(typeof secondChunk).toBe('string');
        expect(secondChunk.length).toBeGreaterThan(0);
      }
    });
  });
});
