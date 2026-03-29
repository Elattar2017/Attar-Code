'use strict';

const {
  extractTocFromBookmarks,
  extractTocFromHeadings,
  mergeTocSources,
  buildChapterMap,
} = require('../ingestion/toc-extractor');

describe('toc-extractor', () => {
  describe('extractTocFromBookmarks', () => {
    test('returns empty array for non-existent file', async () => {
      const result = await extractTocFromBookmarks('/nonexistent/file.pdf');
      expect(result).toEqual([]);
    });

    test('returns empty array for file that does not exist (fallback path)', async () => {
      const result = await extractTocFromBookmarks('/fake.pdf');
      expect(result).toEqual([]);
    });
  });

  describe('extractTocFromHeadings', () => {
    test('extracts headings from markdown', () => {
      const md = `# Introduction\n\nSome text.\n\n## Getting Started\n\nMore text.\n\n### Prerequisites\n\nDetails.\n\n# Chapter 2\n\nContent.`;
      const result = extractTocFromHeadings(md);

      expect(result).toEqual([
        { level: 1, title: 'Introduction' },
        { level: 2, title: 'Getting Started' },
        { level: 3, title: 'Prerequisites' },
        { level: 1, title: 'Chapter 2' },
      ]);
    });

    test('returns empty array for markdown with no headings', () => {
      const result = extractTocFromHeadings('Just plain text without headings.');
      expect(result).toEqual([]);
    });

    test('ignores headings inside code blocks', () => {
      const md = "# Real Heading\n\n```\n# Not a heading\n```\n\n## Another Real";
      const result = extractTocFromHeadings(md);

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Real Heading');
      expect(result[1].title).toBe('Another Real');
    });

    test('handles H1 through H6', () => {
      const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
      const result = extractTocFromHeadings(md);
      expect(result).toHaveLength(6);
      expect(result[5].level).toBe(6);
    });
  });

  describe('mergeTocSources', () => {
    test('prefers bookmark TOC when available', () => {
      const bookmarks = [
        { level: 1, title: 'Chapter 1', page: 5 },
        { level: 1, title: 'Chapter 2', page: 20 },
      ];
      const headings = [
        { level: 1, title: 'Chapter 1' },
        { level: 2, title: 'Section 1.1' },
      ];
      const result = mergeTocSources(bookmarks, headings);
      expect(result[0].page).toBe(5); // has page info from bookmarks
    });

    test('falls back to headings when bookmarks empty', () => {
      const result = mergeTocSources([], [{ level: 1, title: 'Intro' }]);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Intro');
    });

    test('returns empty array when both sources empty', () => {
      expect(mergeTocSources([], [])).toEqual([]);
    });
  });

  describe('buildChapterMap', () => {
    test('builds chapter-to-section hierarchy', () => {
      const toc = [
        { level: 1, title: 'Chapter 1: Introduction' },
        { level: 2, title: 'What is Python' },
        { level: 2, title: 'Installation' },
        { level: 1, title: 'Chapter 2: Basics' },
        { level: 2, title: 'Variables' },
      ];
      const map = buildChapterMap(toc);

      expect(map).toHaveLength(2);
      expect(map[0].title).toBe('Chapter 1: Introduction');
      expect(map[0].sections).toHaveLength(2);
      expect(map[1].title).toBe('Chapter 2: Basics');
      expect(map[1].sections).toHaveLength(1);
    });

    test('handles flat TOC (all same level)', () => {
      const toc = [
        { level: 1, title: 'Part A' },
        { level: 1, title: 'Part B' },
      ];
      const map = buildChapterMap(toc);
      expect(map).toHaveLength(2);
      expect(map[0].sections).toHaveLength(0);
    });

    test('returns empty for empty TOC', () => {
      expect(buildChapterMap([])).toEqual([]);
    });
  });
});
