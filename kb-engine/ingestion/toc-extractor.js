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
    const tmpScript = path.join(os.tmpdir(), `attar-toc-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
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
    const bookmarkTitles = new Set(bookmarks.map(b => b.title.toLowerCase().trim()));
    const extra = headings.filter(h => !bookmarkTitles.has(h.title.toLowerCase().trim()));
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
