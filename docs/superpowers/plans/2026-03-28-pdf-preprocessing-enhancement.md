# PDF Preprocessing & Chunking Enhancement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pymupdf4llm with Marker for ML-powered PDF conversion, add TOC extraction + structural indexing, upgrade the chunker to H1-H6 with better splitting, and enable structural queries ("how many chapters", "what's in chapter 2").

**Architecture:** Marker (Python, GPU-accelerated via Surya OCR) converts PDFs to structured Markdown with proper heading hierarchy. A TOC extractor pulls chapter/section structure from PyMuPDF bookmarks + Marker's metadata. Structural chunks (TOC entries, chapter summaries) are stored in a dedicated index within each collection. The query analyzer detects structural queries and routes them to the structural index. The chunker is upgraded to H1-H6 with sentence-aware overlap.

**Tech Stack:** marker-pdf (Python), pymupdf4llm (fallback), PyMuPDF (fitz), Node.js child_process, Qdrant, Jest

---

## File Structure

### Files to Create

| File | Responsibility |
|------|---------------|
| `kb-engine/ingestion/preprocessors/pdf-marker.js` | Marker-based PDF-to-Markdown bridge (calls Python, parses JSON output with section hierarchy) |
| `kb-engine/ingestion/toc-extractor.js` | Extracts Table of Contents from PyMuPDF bookmarks + Marker metadata |
| `kb-engine/ingestion/structural-indexer.js` | Creates structural chunks (TOC entries, chapter summaries) for Qdrant |
| `kb-engine/tests/pdf-marker.test.js` | Tests for Marker PDF preprocessor |
| `kb-engine/tests/toc-extractor.test.js` | Tests for TOC extraction |
| `kb-engine/tests/structural-indexer.test.js` | Tests for structural indexer |
| `kb-engine/tests/chunker-enhanced.test.js` | Tests for enhanced chunker (H1-H6, overlap, token estimation) |
| `kb-engine/tests/query-structural.test.js` | Tests for structural query detection and routing |

### Files to Modify

| File | Changes |
|------|---------|
| `kb-engine/ingestion/preprocessors/pdf.js` | Wire Marker as primary with pymupdf4llm fallback |
| `kb-engine/ingestion/chunker.js:19` | Upgrade HEADING_RE from H1-H3 to H1-H6, improve token estimation, sentence-aware overlap |
| `kb-engine/ingestion/index.js:298-330` | Enhance `normalizeHeadings()`, integrate TOC extraction + structural indexing |
| `kb-engine/ingestion/enrichment.js:76-79` | No change needed — automatically benefits from richer section_path |
| `kb-engine/retrieval/query-analyzer.js:155-202` | Add `structural` query type detection |
| `kb-engine/retrieval/index.js:42-122` | Route structural queries to structural chunks via payload filter |
| `kb-engine/retrieval/context-assembler.js:182-191` | Format structural results with chapter/section info |
| `kb-engine/config.js` | Add Marker config, structural chunk type constant |
| `kb-engine/collections.js:17-22` | Add payload indexes for `chunk_type`, `chapter`, `heading_level` |

---

## Task 1: Marker PDF Preprocessor

**Files:**
- Create: `kb-engine/ingestion/preprocessors/pdf-marker.js`
- Create: `kb-engine/tests/pdf-marker.test.js`

The Marker library converts PDFs to high-quality Markdown using ML models (Surya OCR + layout detection). It produces proper heading hierarchy, handles tables, equations, and code blocks. We call it via Python child_process, same pattern as the existing pymupdf4llm bridge.

**Prerequisites:** `pip install marker-pdf` (user must install once). Tested with marker-pdf 1.10.x.

- [ ] **Step 1: Write the failing test for Marker bridge**

Create `kb-engine/tests/pdf-marker.test.js`:
```javascript
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
      // Test with a non-existent file — should return error gracefully
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/pdf-marker.test.js --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Marker bridge**

Create `kb-engine/ingestion/preprocessors/pdf-marker.js`:
```javascript
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Check if marker-pdf is installed and available.
 * @returns {Promise<boolean>}
 */
async function isMarkerAvailable() {
  return new Promise((resolve) => {
    execFile('python', ['-c',
      'from marker.converters.pdf import PdfConverter; from marker.models import create_model_dict; print("ok")'
    ], { timeout: 15000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === 'ok');
    });
  });
}

/**
 * Convert a PDF to structured Markdown using Marker.
 *
 * Returns: { content, title, toc, headings, error? }
 *   - content: Full Markdown string with proper # headings
 *   - title: Document title extracted from first heading or filename
 *   - toc: Array of { level, title, page } from Marker's table_of_contents
 *   - headings: Array of { level, text, page } — all headings found in the document
 *   - error: Error message if conversion failed
 *
 * @param {string} filePath  Absolute path to the PDF file
 * @param {object} [opts]
 * @param {boolean} [opts.useLlm=false]   Enable LLM-assisted mode (better tables)
 * @param {string}  [opts.ollamaModel]    Ollama model for LLM mode (e.g. 'qwen2.5:14b')
 * @returns {Promise<{ content: string, title: string, toc: Array, headings: Array, error?: string }>}
 */
async function convertWithMarker(filePath, opts = {}) {
  const fallback = {
    content: '',
    title: path.basename(filePath, '.pdf'),
    toc: [],
    headings: [],
  };

  if (!fs.existsSync(filePath)) {
    return { ...fallback, error: 'File not found: ' + filePath };
  }

  // Python script that uses Marker's Python API to convert PDF → JSON
  // Output: JSON with { markdown, title, toc, headings }
  const useLlm = opts.useLlm || false;
  const ollamaModel = opts.ollamaModel || '';

  const script = `
import sys, json, os, traceback

try:
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered

    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(sys.argv[1])
    text, metadata, images = text_from_rendered(rendered)

    # Extract table of contents from metadata
    toc = []
    if hasattr(rendered, 'metadata') and rendered.metadata:
        toc_data = getattr(rendered.metadata, 'table_of_contents', None)
        if toc_data:
            for entry in toc_data:
                toc.append({
                    "level": getattr(entry, 'heading_level', 1),
                    "title": getattr(entry, 'title', ''),
                    "page": getattr(entry, 'page_id', 0),
                })
    elif isinstance(metadata, dict) and 'table_of_contents' in metadata:
        for entry in metadata['table_of_contents']:
            toc.append({
                "level": entry.get('heading_level', 1),
                "title": entry.get('title', ''),
                "page": entry.get('page_id', 0),
            })

    # Extract all headings from the markdown
    headings = []
    for line in text.split('\\n'):
        stripped = line.strip()
        if stripped.startswith('#'):
            hashes = 0
            for ch in stripped:
                if ch == '#':
                    hashes += 1
                else:
                    break
            heading_text = stripped[hashes:].strip()
            if heading_text:
                headings.append({"level": hashes, "text": heading_text})

    # Extract title from first H1 heading or metadata
    title = ''
    for h in headings:
        if h['level'] == 1:
            title = h['text']
            break
    if not title and toc:
        title = toc[0].get('title', '')
    if not title:
        title = os.path.splitext(os.path.basename(sys.argv[1]))[0]

    result = {
        "ok": True,
        "markdown": text,
        "title": title,
        "toc": toc,
        "headings": headings,
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({
        "ok": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }))
`;

  return new Promise((resolve) => {
    const tmpScript = path.join(os.tmpdir(), 'attar-marker-convert.py');
    try {
      fs.writeFileSync(tmpScript, script);
    } catch (writeErr) {
      return resolve({ ...fallback, error: 'Failed to write temp script: ' + writeErr.message });
    }

    execFile('python', [tmpScript, filePath], {
      encoding: 'utf-8',
      timeout: 600000,  // 10 minutes for large PDFs
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer for large outputs
    }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch (_) {}

      if (err) {
        return resolve({ ...fallback, error: 'Marker execution failed: ' + err.message });
      }

      try {
        // Last line of stdout is the JSON result
        const lines = stdout.trim().split('\n');
        const parsed = JSON.parse(lines[lines.length - 1]);

        if (!parsed.ok) {
          return resolve({ ...fallback, error: parsed.error || 'Unknown Marker error' });
        }

        resolve({
          content: parsed.markdown || '',
          title: parsed.title || fallback.title,
          toc: Array.isArray(parsed.toc) ? parsed.toc : [],
          headings: Array.isArray(parsed.headings) ? parsed.headings : [],
        });
      } catch (parseErr) {
        resolve({ ...fallback, error: 'Failed to parse Marker output: ' + parseErr.message });
      }
    });
  });
}

module.exports = { convertWithMarker, isMarkerAvailable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/pdf-marker.test.js --no-coverage`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add kb-engine/ingestion/preprocessors/pdf-marker.js kb-engine/tests/pdf-marker.test.js
git commit -m "feat(kb): add Marker PDF preprocessor bridge with JSON output"
```

---

## Task 2: TOC Extractor

**Files:**
- Create: `kb-engine/ingestion/toc-extractor.js`
- Create: `kb-engine/tests/toc-extractor.test.js`

Extracts Table of Contents from PDFs using two strategies:
1. **PyMuPDF bookmarks** — `doc.get_toc()` returns `[level, title, page]` arrays
2. **Marker metadata** — `toc` array from Marker's conversion output
3. **Heading-based fallback** — Build TOC from detected `#` headings in Markdown

- [ ] **Step 1: Write the failing test for TOC extraction**

Create `kb-engine/tests/toc-extractor.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/toc-extractor.test.js --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TOC extractor**

Create `kb-engine/ingestion/toc-extractor.js`:
```javascript
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Extract TOC from PDF bookmarks using PyMuPDF.
 * Returns [{ level, title, page }] or empty array on failure.
 *
 * @param {string} filePath  Absolute path to PDF
 * @returns {Promise<Array<{ level: number, title: string, page: number }>>}
 */
async function extractTocFromBookmarks(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const script = `
import sys, json
try:
    import fitz
    doc = fitz.open(sys.argv[1])
    toc = doc.get_toc()
    entries = []
    for entry in toc:
        entries.append({"level": entry[0], "title": entry[1], "page": entry[2]})
    print(json.dumps({"ok": True, "toc": entries}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

  return new Promise((resolve) => {
    const tmpScript = path.join(os.tmpdir(), 'attar-toc-extract.py');
    try {
      fs.writeFileSync(tmpScript, script);
    } catch (_) {
      return resolve([]);
    }

    execFile('python', [tmpScript, filePath], {
      encoding: 'utf-8',
      timeout: 30000,
    }, (err, stdout) => {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
      if (err) return resolve([]);

      try {
        const lines = stdout.trim().split('\n');
        const parsed = JSON.parse(lines[lines.length - 1]);
        if (parsed.ok && Array.isArray(parsed.toc)) {
          return resolve(parsed.toc);
        }
      } catch (_) {}
      resolve([]);
    });
  });
}

/**
 * Extract TOC from markdown headings.
 * Ignores headings inside fenced code blocks.
 *
 * @param {string} markdown
 * @returns {Array<{ level: number, title: string }>}
 */
function extractTocFromHeadings(markdown) {
  if (!markdown) return [];

  const lines = markdown.split('\n');
  const result = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      result.push({
        level: match[1].length,
        title: match[2].trim(),
      });
    }
  }

  return result;
}

/**
 * Merge TOC from bookmarks and headings.
 * Bookmarks are preferred (they have page numbers).
 * Headings fill in sections not in bookmarks.
 *
 * @param {Array} bookmarks  From extractTocFromBookmarks
 * @param {Array} headings   From extractTocFromHeadings
 * @returns {Array<{ level: number, title: string, page?: number }>}
 */
function mergeTocSources(bookmarks, headings) {
  if (bookmarks.length > 0) {
    // Bookmarks are authoritative — enrich with any deeper headings
    // not captured in bookmarks
    const bookmarkTitles = new Set(bookmarks.map(b => b.title.toLowerCase().trim()));
    const extra = headings.filter(h => !bookmarkTitles.has(h.title.toLowerCase().trim()));

    // Return bookmarks + extra headings that bookmarks missed
    return [...bookmarks, ...extra];
  }

  return headings;
}

/**
 * Build a chapter→sections hierarchy from a flat TOC.
 *
 * @param {Array<{ level: number, title: string, page?: number }>} toc
 * @returns {Array<{ title: string, level: number, page?: number, sections: Array }>}
 */
function buildChapterMap(toc) {
  if (!toc || toc.length === 0) return [];

  const chapters = [];
  let current = null;

  for (const entry of toc) {
    if (entry.level === 1) {
      current = {
        title: entry.title,
        level: entry.level,
        page: entry.page,
        sections: [],
      };
      chapters.push(current);
    } else if (current) {
      current.sections.push({
        title: entry.title,
        level: entry.level,
        page: entry.page,
      });
    }
  }

  return chapters;
}

module.exports = {
  extractTocFromBookmarks,
  extractTocFromHeadings,
  mergeTocSources,
  buildChapterMap,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/toc-extractor.test.js --no-coverage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add kb-engine/ingestion/toc-extractor.js kb-engine/tests/toc-extractor.test.js
git commit -m "feat(kb): add TOC extractor with PyMuPDF bookmarks + heading fallback"
```

---

## Task 3: Enhanced Chunker (H1-H6, Better Token Estimation, Sentence-Aware Overlap)

**Files:**
- Modify: `kb-engine/ingestion/chunker.js:19,103-107,124,304-320`
- Create: `kb-engine/tests/chunker-enhanced.test.js`

Three improvements:
1. **H1-H6 support** — Change `HEADING_RE` from `#{1,3}` to `#{1,6}` and expand heading stack from 3 to 6 slots
2. **Better token estimation** — Account for code blocks (higher token density) and punctuation
3. **Sentence-aware overlap** — End overlap at sentence boundaries instead of arbitrary word boundaries

- [ ] **Step 1: Write the failing tests for enhanced chunker**

Create `kb-engine/tests/chunker-enhanced.test.js`:
```javascript
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
      // Code has more tokens due to symbols/punctuation
      const codeTokens = chunker._estimateTokens(code);
      const proseTokens = chunker._estimateTokens(prose);
      // Code should estimate higher (more punctuation = more tokens)
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
        // Overlap text should ideally end at a sentence boundary (period + space)
        const secondChunk = chunks[1].content;
        // The overlap portion at the start should contain complete sentences
        expect(typeof secondChunk).toBe('string');
        expect(secondChunk.length).toBeGreaterThan(0);
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/chunker-enhanced.test.js --no-coverage`
Expected: FAIL — H4+ headings not split, tests fail

- [ ] **Step 3: Implement chunker enhancements**

Modify `kb-engine/ingestion/chunker.js`:

**Change 1 — Line 19:** Expand heading regex from H1-H3 to H1-H6:
```javascript
// OLD: const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
```

**Change 2 — Line 103-107:** Improve token estimation to account for punctuation and code:
```javascript
// OLD:
_estimateTokens(text) {
  if (!text || text.trim() === '') return 0;
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words / 0.75);
}

// NEW:
_estimateTokens(text) {
  if (!text || text.trim() === '') return 0;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).length;
  // Base: 1 token per 0.75 words
  let estimate = Math.ceil(words / 0.75);
  // Boost for punctuation-heavy content (code, URLs, paths)
  const punctuation = (trimmed.match(/[{}()\[\];:=<>.,!?@#$%^&*\/\\|~`"'+-]/g) || []).length;
  if (punctuation > words * 0.3) {
    // Code-heavy: each symbol is ~1 token, add 30% boost
    estimate = Math.ceil(estimate * 1.3);
  }
  return estimate;
}
```

**Change 3 — Line 124:** Expand heading stack from 3 to 6 slots:
```javascript
// OLD: const headingStack = ['', '', ''];
const headingStack = ['', '', '', '', '', ''];
```

**Change 4 — Lines 304-320:** Sentence-aware overlap:
```javascript
// OLD:
_applyOverlap(chunks) {
  if (chunks.length <= 1 || this.overlapTokens <= 0) return chunks;
  const overlapWords = Math.ceil(this.overlapTokens * 0.75);
  const result = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const prevWords = prev.trim().split(/\s+/);
    const tail = prevWords.slice(-overlapWords).join(' ');
    result.push(tail + ' ' + chunks[i]);
  }
  return result;
}

// NEW:
_applyOverlap(chunks) {
  if (chunks.length <= 1 || this.overlapTokens <= 0) return chunks;
  const overlapWords = Math.ceil(this.overlapTokens * 0.75);
  const result = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const prevWords = prev.trim().split(/\s+/);
    const tailWords = prevWords.slice(-overlapWords);
    let tail = tailWords.join(' ');

    // Try to start overlap at a sentence boundary
    const sentenceStart = tail.search(/\.\s+[A-Z]/);
    if (sentenceStart !== -1 && sentenceStart < tail.length * 0.5) {
      tail = tail.slice(sentenceStart + 2); // skip ". " and start at capital
    }

    result.push(tail + '\n' + chunks[i]);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify both new and existing tests pass**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/chunker-enhanced.test.js kb-engine/tests/ingestion.test.js --no-coverage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add kb-engine/ingestion/chunker.js kb-engine/tests/chunker-enhanced.test.js
git commit -m "feat(kb): upgrade chunker to H1-H6, better token estimation, sentence-aware overlap"
```

---

## Task 4: Structural Indexer

**Depends on:** Task 2 (TOC extractor must exist — `structural-indexer.js` imports `buildChapterMap` from `toc-extractor.js`)

**Files:**
- Create: `kb-engine/ingestion/structural-indexer.js`
- Create: `kb-engine/tests/structural-indexer.test.js`
- Modify: `kb-engine/config.js`
- Modify: `kb-engine/collections.js:17-22`

Creates special "structural" chunks for TOC entries and chapter summaries. These are stored alongside regular content chunks but with `chunk_type: "structural"` payload field, enabling filtered search for structural queries.

- [ ] **Step 1: Update config with structural constants**

Add to `kb-engine/config.js` before `module.exports`:
```javascript
  // Structural indexing
  STRUCTURAL_CHUNK_TYPE: 'structural',
  CONTENT_CHUNK_TYPE: 'content',
```

- [ ] **Step 2: Add payload indexes for structural fields**

Modify `kb-engine/collections.js:17-22` — add to `PAYLOAD_INDEXES`:
```javascript
const PAYLOAD_INDEXES = [
  { field_name: "language", field_schema: "keyword" },
  { field_name: "framework", field_schema: "keyword" },
  { field_name: "doc_type",  field_schema: "keyword" },
  { field_name: "source",    field_schema: "keyword" },
  { field_name: "chunk_type", field_schema: "keyword" },    // "structural" | "content"
  { field_name: "chapter",    field_schema: "keyword" },    // chapter title for filtering
  { field_name: "heading_level", field_schema: { type: "integer" } }, // 1-6
];
```

- [ ] **Step 3: Write the failing test for structural indexer**

Create `kb-engine/tests/structural-indexer.test.js`:
```javascript
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
    expect(overview.content).toContain('2 chapters'); // or "2 top-level sections"
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/structural-indexer.test.js --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 5: Implement structural indexer**

Create `kb-engine/ingestion/structural-indexer.js`:
```javascript
'use strict';

const { buildChapterMap } = require('./toc-extractor');

/**
 * Build structural chunks from a Table of Contents.
 * Creates:
 *   1. A document overview chunk (lists all chapters)
 *   2. One chunk per chapter (lists sections within that chapter)
 *
 * All chunks have chunk_type: "structural" in metadata for filtered search.
 *
 * @param {Array<{ level: number, title: string, page?: number }>} toc
 * @param {string} docTitle
 * @returns {Array<{ content: string, metadata: object }>}
 */
function buildStructuralChunks(toc, docTitle) {
  if (!toc || toc.length === 0) return [];

  const chapters = buildChapterMap(toc);
  const chunks = [];
  const topLevel = toc.filter(e => e.level === 1);

  // 1. Document overview chunk
  const chapterCount = topLevel.length;
  const overviewLines = [
    `Document: ${docTitle}`,
    `This document contains ${chapterCount} ${chapterCount === 1 ? 'chapter' : 'chapters'}:`,
    '',
  ];

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const pageInfo = ch.page ? ` (page ${ch.page})` : '';
    const sectionCount = ch.sections.length;
    const sectionInfo = sectionCount > 0
      ? ` — ${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}`
      : '';
    overviewLines.push(`${i + 1}. ${ch.title}${pageInfo}${sectionInfo}`);
  }

  chunks.push({
    content: overviewLines.join('\n'),
    metadata: {
      chunk_type: 'structural',
      structural_type: 'overview',
      doc_title: docTitle,
      heading_level: 0,
      chapter: '',
    },
  });

  // 2. One chunk per chapter with its sections
  for (const ch of chapters) {
    const lines = [
      `Chapter: ${ch.title}`,
    ];

    if (ch.page) {
      lines.push(`Starts at page ${ch.page}`);
    }

    if (ch.sections.length > 0) {
      lines.push('');
      lines.push('Sections:');
      for (const sec of ch.sections) {
        const pageInfo = sec.page ? ` (page ${sec.page})` : '';
        const indent = '  '.repeat(sec.level - 2);
        lines.push(`${indent}- ${sec.title}${pageInfo}`);
      }
    }

    chunks.push({
      content: lines.join('\n'),
      metadata: {
        chunk_type: 'structural',
        structural_type: 'chapter',
        doc_title: docTitle,
        chapter: ch.title,
        heading_level: 1,
        page: ch.page || null,
        section_count: ch.sections.length,
      },
    });
  }

  return chunks;
}

module.exports = { buildStructuralChunks };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/structural-indexer.test.js --no-coverage`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add kb-engine/ingestion/structural-indexer.js kb-engine/tests/structural-indexer.test.js kb-engine/config.js kb-engine/collections.js
git commit -m "feat(kb): add structural indexer for TOC/chapter chunks + config/collection updates"
```

---

## Task 5: Query Analyzer — Structural Query Detection

**Files:**
- Modify: `kb-engine/retrieval/query-analyzer.js:155-202`
- Create: `kb-engine/tests/query-structural.test.js`

Add `structural` query type that detects questions about document structure ("how many chapters", "what topics does chapter 3 cover", "table of contents", "what's in this book").

- [ ] **Step 1: Write the failing test for structural query detection**

Create `kb-engine/tests/query-structural.test.js`:
```javascript
'use strict';

const { analyzeQuery } = require('../retrieval/query-analyzer');

describe('query-analyzer — structural queries', () => {
  test('detects "how many chapters" as structural', () => {
    const result = analyzeQuery('how many chapters does this book have');
    expect(result.type).toBe('structural');
  });

  test('detects "what is in chapter 2" as structural', () => {
    const result = analyzeQuery('what is covered in chapter 2');
    expect(result.type).toBe('structural');
  });

  test('detects "table of contents" as structural', () => {
    const result = analyzeQuery('show me the table of contents');
    expect(result.type).toBe('structural');
  });

  test('detects "what topics" as structural', () => {
    const result = analyzeQuery('what topics does this document cover');
    expect(result.type).toBe('structural');
  });

  test('detects "list all sections" as structural', () => {
    const result = analyzeQuery('list all sections in the python book');
    expect(result.type).toBe('structural');
  });

  test('detects "chapter 5 subject" as structural', () => {
    const result = analyzeQuery('what is the subject of chapter 5');
    expect(result.type).toBe('structural');
  });

  test('structural queries prefer text_vector', () => {
    const result = analyzeQuery('how many chapters are there');
    expect(result.preferVector).toBe('text_vector');
  });

  test('non-structural query remains unchanged', () => {
    const result = analyzeQuery('how to use async/await in python');
    expect(result.type).not.toBe('structural');
  });

  test('error query still detected as error (higher priority)', () => {
    const result = analyzeQuery('TypeError in chapter 3');
    expect(result.type).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/query-structural.test.js --no-coverage`
Expected: FAIL — `structural` type not returned

- [ ] **Step 3: Implement structural query detection**

Modify `kb-engine/retrieval/query-analyzer.js`:

**Add after line 110 (after API_PATTERNS):**
```javascript
const STRUCTURAL_PATTERNS = [
  /\bhow\s+many\s+chapters?\b/i,
  /\btable\s+of\s+contents\b/i,
  /\bwhat.*chapter\s+\d/i,
  /\bchapter\s+\d+\s+(?:subject|topic|cover|about|content)/i,
  /\bsubject\s+of\s+chapter/i,
  /\bwhat\s+(?:topics?|sections?)\s+(?:does|do|are|is)/i,
  /\blist\s+(?:all\s+)?(?:chapters?|sections?|topics?)/i,
  /\bwhat(?:'s| is)\s+(?:in|covered|included)\s+(?:in\s+)?(?:this\s+)?(?:book|document|pdf)/i,
  /\boverview\s+of\s+(?:the\s+)?(?:book|document)/i,
  /\bstructure\s+of\b/i,
  /\boutline\b/i,
];
```

**Modify the type detection block (lines 168-177) — add structural check BEFORE conceptual:**
```javascript
  // Determine query type (checked in order of specificity)
  let type = 'general';

  if (ERROR_PATTERNS.some((p) => p.test(query))) {
    type = 'error';
  } else if (STRUCTURAL_PATTERNS.some((p) => p.test(query))) {
    type = 'structural';
  } else if (CONCEPTUAL_PATTERNS.some((p) => p.test(query))) {
    type = 'conceptual';
  } else if (API_PATTERNS.some((p) => p.test(query))) {
    type = 'api';
  }
```

**Modify the preferVector line (line 182):**
```javascript
  // Choose preferred vector
  const preferVector =
    type === 'error' || type === 'api' ? 'code_vector' : 'text_vector';
```

(No change needed — structural already falls through to `text_vector`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/query-structural.test.js kb-engine/tests/retrieval.test.js --no-coverage`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add kb-engine/retrieval/query-analyzer.js kb-engine/tests/query-structural.test.js
git commit -m "feat(kb): add structural query type detection for chapter/TOC questions"
```

---

## Task 6: Retrieval Pipeline — Structural Query Routing

**Files:**
- Modify: `kb-engine/retrieval/index.js:42-122`
- Modify: `kb-engine/retrieval/context-assembler.js:182-191`

When the query analyzer detects a `structural` query type, the retrieval pipeline adds a payload filter `chunk_type: "structural"` to only search structural chunks. This means "how many chapters" only hits TOC/overview chunks, not content chunks.

- [ ] **Step 1: Modify retrieval pipeline to filter by chunk_type for structural queries**

Modify `kb-engine/retrieval/index.js` — in the `search` method, after line 48 (after collections are determined), add structural filter logic:

```javascript
  async search(query, context = {}, options = {}) {
    // 1. Analyze query → type, preferVector, collections, tech
    const analysis = analyzeQuery(query, context);

    // Allow caller to force specific collections (e.g. searchFixRecipes)
    const collections =
      context.forceCollections || analysis.collections;

    // Build payload filter for structural queries
    // Note: hybridSearch always runs BOTH code_vector and text_vector in parallel
    // (vectorName is only used by the simpler store.search method).
    // The structural filter is what matters here — it restricts results to structural chunks.
    const structuralFilter = analysis.type === 'structural'
      ? [{ key: 'chunk_type', value: 'structural' }]
      : undefined;

    // 2. Hybrid search each collection
    let allResults = [];
    for (const collection of collections) {
      try {
        const results = await this.store.hybridSearch(collection, query, {
          limit: this.config.DEFAULT_SEARCH_LIMIT,
          vectorName: analysis.preferVector,
          filter: structuralFilter,
        });
        allResults.push(...results.map((r) => ({ ...r, collection })));
      } catch (_) {
        // collection may not exist yet — skip silently
      }
    }

    // ... rest of the method stays the same
```

- [ ] **Step 2: Modify context assembler to format structural results**

Modify `kb-engine/retrieval/context-assembler.js` — update the formatting section (lines 182-191) to show chapter info for structural chunks:

```javascript
  // Step 4 — format each chunk
  const parts = topChunks.map((chunk) => {
    const meta = chunk.metadata || {};
    // Preserve backward compat: try both doc_title and title (existing tests use title)
    const title = meta.title || meta.doc_title || 'Unknown';
    const section = meta.section || meta.section_path || meta.chapter || '';
    const source = section ? `${title} > ${section}` : title;
    const scoreStr = (chunk.score || 0).toFixed(2);
    const content = (chunk.content || '').trim();

    // For structural chunks, add a label
    const typeLabel = meta.chunk_type === 'structural' ? ' [Structure]' : '';
    return `[Source: ${source}]${typeLabel} [Score: ${scoreStr}]\n\n${content}`;
  });
```

- [ ] **Step 3: Run existing retrieval tests to verify no regression**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/retrieval.test.js --no-coverage`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add kb-engine/retrieval/index.js kb-engine/retrieval/context-assembler.js
git commit -m "feat(kb): route structural queries to structural chunks via payload filter"
```

---

## Task 7: Pipeline Integration — Wire Marker + TOC + Structural Indexing

**Files:**
- Modify: `kb-engine/ingestion/preprocessors/pdf.js`
- Modify: `kb-engine/ingestion/index.js:90-237,298-330`
- Modify: `kb-engine/ingestion/enrichment.js:76-79`

Wire everything together:
1. `pdf.js` tries Marker first, falls back to pymupdf4llm
2. `index.js` extracts TOC, builds structural chunks, stores them alongside content chunks
3. Enhanced `normalizeHeadings()` covers more patterns
4. Enrichment includes full heading path with chapter info

- [ ] **Step 1: Rewrite pdf.js to use Marker with fallback + update existing tests**

**IMPORTANT:** This changes `preprocessPdf` from sync to async. The existing tests at `kb-engine/tests/preprocessors.test.js` must be updated in the same step to use `await`.

Replace the content of `kb-engine/ingestion/preprocessors/pdf.js`:

```javascript
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { convertWithMarker, isMarkerAvailable } = require('./pdf-marker');

// Cache Marker availability check
let _markerAvailable = null;

/**
 * Preprocess a PDF file for ingestion.
 *
 * Strategy 1: Marker (ML-powered, GPU-accelerated, proper headings)
 * Strategy 2: pymupdf4llm (rule-based, fast, good for digital PDFs)
 * Strategy 3: PyMuPDF fitz (plain text extraction, last resort)
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {boolean} [opts.forceMarker]   Skip pymupdf4llm, only use Marker
 * @param {boolean} [opts.forceLegacy]   Skip Marker, only use pymupdf4llm
 * @param {boolean} [opts.useLlm]       Enable Marker's LLM mode for tables
 * @param {string}  [opts.ollamaModel]  Ollama model for LLM mode
 * @returns {Promise<{ content: string, title: string, format: string, toc?: Array, headings?: Array, error?: string }>}
 */
async function preprocessPdf(filePath, opts = {}) {
  const fallback = {
    content: '',
    title: path.basename(filePath, '.pdf'),
    format: 'pdf',
  };

  if (!fs.existsSync(filePath)) {
    return { ...fallback, error: 'File not found: ' + filePath };
  }

  // Strategy 1: Marker (if available and not forced legacy)
  if (!opts.forceLegacy) {
    if (_markerAvailable === null) {
      _markerAvailable = await isMarkerAvailable();
    }

    if (_markerAvailable) {
      const result = await convertWithMarker(filePath, {
        useLlm: opts.useLlm,
        ollamaModel: opts.ollamaModel,
      });

      if (!result.error && result.content.length > 0) {
        return {
          content: result.content,
          title: result.title || fallback.title,
          format: 'pdf',
          toc: result.toc,
          headings: result.headings,
          converter: 'marker',
        };
      }
      // Marker failed — fall through to pymupdf4llm
    }
  }

  if (opts.forceMarker) {
    return { ...fallback, error: 'Marker not available. Install: pip install marker-pdf' };
  }

  // Strategy 2: pymupdf4llm → Strategy 3: fitz plain text
  try {
    const script = `
import sys, json
try:
    import pymupdf4llm
    md = pymupdf4llm.to_markdown(sys.argv[1])
    print(json.dumps({"content": md, "ok": True}))
except ImportError:
    import fitz
    doc = fitz.open(sys.argv[1])
    text = "\\n\\n".join(page.get_text() for page in doc)
    print(json.dumps({"content": text, "ok": True}))
`;
    const tmpScript = path.join(os.tmpdir(), 'attar-pdf-extract.py');
    fs.writeFileSync(tmpScript, script);
    const result = execFileSync('python', [tmpScript, filePath], {
      encoding: 'utf-8',
      timeout: 120000,
    });
    try { fs.unlinkSync(tmpScript); } catch (_) {}

    const parsed = JSON.parse(result.trim().split('\n').pop());
    return {
      content: parsed.content,
      title: fallback.title,
      format: 'pdf',
      converter: 'pymupdf4llm',
    };
  } catch (pyErr) {
    return {
      ...fallback,
      error: `PDF extraction failed. Install: pip install marker-pdf (recommended) or pip install pymupdf4llm\nError: ${pyErr.message}`,
    };
  }
}

module.exports = { preprocessPdf };
```

- [ ] **Step 2: Enhance normalizeHeadings in index.js**

Replace the `normalizeHeadings()` function in `kb-engine/ingestion/index.js` (lines 298-330):

```javascript
function normalizeHeadings(content) {
  let result = content;

  // Pattern: "Chapter N: Title" or "Chapter N. Title" (with or without bold)
  result = result.replace(/^(\*\*)?Chapter\s+(\d+)[:.]\s*(.+?)(\*\*)?$/gm, (m, b1, num, title, b2) => {
    return `# Chapter ${num}: ${title.replace(/\*\*/g, '').trim()}`;
  });

  // Pattern: "**N.N Title**" or "**N.N.N Title**" → ## or ###
  result = result.replace(/^\*\*(\d+\.\d+(?:\.\d+)?)\s+(.+?)\*\*$/gm, (m, num, title) => {
    const depth = num.split('.').length;
    const prefix = depth <= 2 ? '##' : '###';
    return `${prefix} ${num} ${title.trim()}`;
  });

  // Pattern: "Part N: Title" (with or without bold)
  result = result.replace(/^(\*\*)?Part\s+(\d+|[IVX]+)[:.]\s*(.+?)(\*\*)?$/gm, (m, b1, num, title, b2) => {
    return `# Part ${num}: ${title.replace(/\*\*/g, '').trim()}`;
  });

  // Pattern: "Appendix A: Title" or "Appendix N: Title"
  result = result.replace(/^(\*\*)?Appendix\s+([A-Z]|\d+)[:.]\s*(.+?)(\*\*)?$/gm, (m, b1, id, title, b2) => {
    return `# Appendix ${id}: ${title.replace(/\*\*/g, '').trim()}`;
  });

  // Pattern: ALL CAPS line (2-8 words, <80 chars) — likely a heading
  // Only match lines that are clearly headings (not code, not data, not long prose)
  result = result.replace(/^([A-Z][A-Z\s]{5,78})$/gm, (m, text) => {
    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).length;
    // Must have 2-8 words and not be a common code/data pattern
    if (wordCount >= 2 && wordCount <= 8 && !/[{}()\[\]=<>;]/.test(trimmed)) {
      return `## ${trimmed}`;
    }
    return m;
  });

  // Pattern: "N. Title" standalone (short line, starts with capital)
  result = result.replace(/^(\d{1,2})\.\s+([A-Z][^\n]{5,75})$/gm, (m, num, title) => {
    return `## ${num}. ${title.trim()}`;
  });

  // Pattern: "N.N Title" without bold
  result = result.replace(/^(\d{1,2}\.\d{1,2})\s+([A-Z][^\n]{5,75})$/gm, (m, num, title) => {
    return `## ${num} ${title.trim()}`;
  });

  // Pattern: "**Bold Heading Text**" on its own line (likely a heading if short)
  result = result.replace(/^\*\*([^*\n]{5,80})\*\*$/gm, (m, text) => {
    const trimmed = text.trim();
    // Only convert if it looks like a heading (capitalized, no code patterns)
    if (/^[A-Z]/.test(trimmed) && !/[{}()\[\]=;]/.test(trimmed)) {
      return `## ${trimmed}`;
    }
    return m;
  });

  return result;
}
```

- [ ] **Step 3: Integrate TOC extraction + structural indexing into ingestFile**

Modify `kb-engine/ingestion/index.js` — add imports at the top (after existing requires):

```javascript
const { extractTocFromBookmarks, extractTocFromHeadings, mergeTocSources } = require('./toc-extractor');
const { buildStructuralChunks } = require('./structural-indexer');
```

Modify the `ingestFile` method — in the PDF case (around line 105-109), change to:

```javascript
      case 'pdf': {
        const { preprocessPdf } = require('./preprocessors/pdf');
        processed = await preprocessPdf(absPath, options);
        break;
      }
```

After the heading normalization and before chunking (after line 168, before line 170), add TOC extraction and structural indexing:

```javascript
    // 2.6 Extract TOC and build structural chunks
    let structuralChunks = [];
    if (detected.format === 'pdf') {
      // Get TOC from preprocessor output (Marker) or from PyMuPDF bookmarks
      const markerToc = processed.toc || [];
      const bookmarkToc = await extractTocFromBookmarks(absPath).catch(() => []);
      const headingToc = extractTocFromHeadings(processed.content);

      const mergedToc = mergeTocSources(
        markerToc.length > 0 ? markerToc : bookmarkToc,
        headingToc
      );

      if (mergedToc.length > 0) {
        structuralChunks = buildStructuralChunks(mergedToc, processed.title);
      }
    }
```

After storing the main content chunks (after line 226, after `const ids = await this.store.addChunks(collection, enrichedChunks);`), add structural chunk storage:

```javascript
    // 7.5 Store structural chunks (if any)
    let structuralIds = [];
    if (structuralChunks.length > 0) {
      structuralIds = await this.store.addChunks(collection, structuralChunks);
    }
```

Update the return value to include structural count:

```javascript
    return {
      collection,
      chunks_stored: ids.length,
      structural_chunks: structuralIds.length,
      format: detected.format,
      title: processed.title,
    };
```

- [ ] **Step 4: Verify enrichment works with new section_path depth**

**No code change needed.** The existing `enrichChunkFast` in `kb-engine/ingestion/enrichment.js` already prepends `[docTitle > sectionPath]`. Since the chunker now provides richer section_path (H4-H6), enrichment automatically includes deeper hierarchy. Verify by reading the function and confirming it handles multi-level paths correctly.

- [ ] **Step 5: Run all ingestion tests**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/preprocessors.test.js kb-engine/tests/ingestion.test.js --no-coverage`
Expected: PASS

**Note:** The `preprocessPdf` test will need updating since it's now async. Modify `kb-engine/tests/preprocessors.test.js` — change all `preprocessPdf` calls to use `await`:

```javascript
describe('preprocessPdf', () => {
  test('returns format: pdf', async () => {
    const result = await preprocessPdf('/nonexistent/fake.pdf');
    expect(result.format).toBe('pdf');
  });

  test('returns error message when extraction fails (graceful degradation)', async () => {
    const result = await preprocessPdf('/nonexistent/fake.pdf');
    expect(typeof result.content).toBe('string');
    if (!result.content) {
      expect(result.error).toBeDefined();
    }
  });

  test('uses filename as title', async () => {
    const result = await preprocessPdf('/some/path/my-document.pdf');
    expect(result.title).toBe('my-document');
  });

  test('never rejects — always resolves with object containing format and title', async () => {
    await expect(preprocessPdf('/totally/bogus/path.pdf')).resolves.toHaveProperty('format', 'pdf');
    const result = await preprocessPdf('/totally/bogus/path.pdf');
    expect(result).toHaveProperty('title');
  });
});
```

Also update `kb-engine/ingestion/index.js` line 107 — the existing call `processed = await preprocessPdf(absPath);` is already `await`'d, so this is fine.

- [ ] **Step 6: Run full test suite**

Run: `cd C:\Users\Attar\Desktop\Cli\Attar-Code && npx jest kb-engine/tests/ --no-coverage`
Expected: PASS (all test files)

- [ ] **Step 7: Commit**

```bash
git add kb-engine/ingestion/preprocessors/pdf.js kb-engine/ingestion/index.js kb-engine/ingestion/enrichment.js kb-engine/tests/preprocessors.test.js
git commit -m "feat(kb): integrate Marker + TOC + structural indexing into ingestion pipeline"
```

---

## Task 8: End-to-End Verification with Real PDF

**Files:**
- No new files — this task verifies everything works together

Test with the actual Python book: `C:\Users\Attar\Downloads\Packt.Python.Real-World.Projects.pdf`

- [ ] **Step 1: Ensure Marker is installed**

Run: `pip install marker-pdf`
Expected: Installation succeeds (downloads ~1-2GB of Surya models on first run)

- [ ] **Step 2: Clear old Python collection and re-ingest**

In the CLI or via search-proxy:
```bash
# Start search-proxy
cd C:\Users\Attar\Desktop\Cli\Attar-Code && node search-proxy.js

# In another terminal, use curl or the CLI:
# Delete old collection
curl -X DELETE http://localhost:3001/kb/collections/python

# Re-ingest
curl -X POST http://localhost:3001/kb/ingest \
  -H "Content-Type: application/json" \
  -d '{"filePath": "C:\\Users\\Attar\\Downloads\\Packt.Python.Real-World.Projects.pdf"}'
```

Expected: Ingestion completes with:
- `converter: "marker"` (using Marker, not pymupdf4llm)
- `structural_chunks > 0` (TOC chunks were created)
- `chunks_stored > 0` (content chunks stored)

- [ ] **Step 3: Test structural queries**

```bash
# How many chapters?
curl -X POST http://localhost:3001/kb/search \
  -H "Content-Type: application/json" \
  -d '{"query": "how many chapters does this book have"}'

# What's in chapter 2?
curl -X POST http://localhost:3001/kb/search \
  -H "Content-Type: application/json" \
  -d '{"query": "what is the subject of chapter 2"}'
```

Expected:
- "How many chapters" returns the overview structural chunk listing all chapters
- "Chapter 2 subject" returns the Chapter 2 structural chunk with sections

- [ ] **Step 4: Test content queries**

```bash
# Technical content query
curl -X POST http://localhost:3001/kb/search \
  -H "Content-Type: application/json" \
  -d '{"query": "how to read a CSV file in Python"}'
```

Expected: Returns relevant content chunks with proper section paths (not just flat text)

- [ ] **Step 5: Verify in CLI**

```bash
cd C:\Users\Attar\Desktop\Cli\Attar-Code
node attar-code.js
# Then type:
# /kb search how many chapters in the python book
# /kb search what is chapter 2 about
```

Expected: CLI shows structured results with chapter/section info

- [ ] **Step 6: Commit verification notes**

No code to commit — this is a verification step. If issues are found, fix them and commit the fixes.

---

## Summary of Changes

| Component | Before | After |
|-----------|--------|-------|
| PDF converter | pymupdf4llm only (rule-based) | Marker primary (ML-powered) + pymupdf4llm fallback |
| Heading detection | Regex-only, brittle | ML-detected by Marker + enhanced regex fallback |
| TOC extraction | None | PyMuPDF bookmarks + Marker metadata + heading-based |
| Structural index | None | Overview + per-chapter chunks with `chunk_type: "structural"` |
| Chunker headings | H1-H3 only | H1-H6 |
| Token estimation | `words / 0.75` | + punctuation density boost for code |
| Chunk overlap | Word boundary | Sentence boundary when possible |
| Query types | error, conceptual, api, general | + structural |
| Structural routing | None | Payload filter `chunk_type: "structural"` for structural queries |
| Heading normalization | 5 regex patterns | 8 patterns + ALL CAPS + bold text detection |

**Test count:** ~40+ new tests across 5 new test files, plus updates to existing tests.

**Dependencies:** `marker-pdf` (Python, pip install) — optional, system degrades gracefully to pymupdf4llm if not installed.
