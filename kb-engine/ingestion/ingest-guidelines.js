// kb-engine/ingestion/ingest-guidelines.js
// Per-document ingestion guidelines — user-provided rules for handling messy documents.
//
// When a document looks unusual during pre-scan (too many headings, OCR artifacts, etc.),
// the CLI can collect guidelines from the user before proceeding with ingestion.
//
// Guidelines are stored as sidecar files at:
//   ~/.attar-code/knowledge/guidelines/{book_id}.guidelines.json
//
// The heading sanitizer reads these during ingestion to apply document-specific rules.
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");

const GUIDELINES_DIR = path.join(config.KB_KNOWLEDGE_DIR || path.join(require("os").homedir(), ".attar-code", "knowledge"), "guidelines");

/**
 * Load ingestion guidelines for a document.
 * @param {string} bookId  12-char hex hash
 * @returns {object|null}
 */
function loadGuidelines(bookId) {
  try {
    const fp = path.join(GUIDELINES_DIR, `${bookId}.guidelines.json`);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (_) {
    return null;
  }
}

/**
 * Save ingestion guidelines for a document.
 * @param {string} bookId
 * @param {object} guidelines
 */
function saveGuidelines(bookId, guidelines) {
  if (!fs.existsSync(GUIDELINES_DIR)) fs.mkdirSync(GUIDELINES_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(GUIDELINES_DIR, `${bookId}.guidelines.json`),
    JSON.stringify(guidelines, null, 2),
    "utf-8"
  );
}

/**
 * Pre-scan a document's markdown content to detect potential issues.
 * Returns a report that helps decide whether to ask the user for guidelines.
 *
 * @param {string} content  Markdown content (after preprocessing, before chunking)
 * @returns {{ headingCount: number, uniqueHeadings: number, suspiciousHeadings: string[], singleWordHeadings: string[], repeatedHeadings: object, needsGuidelines: boolean }}
 */
// Known structural headings that are LEGITIMATE even as single words
const LEGIT_SINGLE_WORDS = new Set([
  'contents', 'introduction', 'preface', 'foreword', 'acknowledgments',
  'acknowledgements', 'abstract', 'summary', 'conclusion', 'conclusions',
  'glossary', 'bibliography', 'references', 'appendix', 'index',
  'overview', 'prerequisites', 'motivation', 'background', 'discussion',
  'methodology', 'results', 'exercises', 'problems', 'solutions',
]);

function preScanDocument(content) {
  // Normalize line endings (Windows \r\n → \n) before processing
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Extract headings with their line numbers (for approximate page reference)
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        text: match[2].trim(),
        level: match[1].length,
        line: i + 1,
        approxPage: Math.max(1, Math.ceil((i + 1) / 45)), // ~45 lines per page estimate
      });
    }
  }

  const headingTexts = headings.map(h => h.text);
  const unique = new Set(headingTexts);

  // Find suspicious headings (exclude known structural words)
  const suspicious = headings.filter(h => {
    const words = h.text.split(/\s+/);
    const lower = h.text.toLowerCase();
    // Skip known legitimate structural headings
    if (words.length === 1 && LEGIT_SINGLE_WORDS.has(lower)) return false;
    return (
      (words.length === 1 && h.text.length < 15 && !LEGIT_SINGLE_WORDS.has(lower)) ||
      /^[a-z]/.test(h.text) ||
      /@/.test(h.text) ||
      /^\d+$/.test(h.text)
    );
  });

  // Find repeated headings (same text appears 3+ times)
  const counts = {};
  for (const h of headingTexts) {
    counts[h] = (counts[h] || 0) + 1;
  }
  const repeated = {};
  for (const [h, c] of Object.entries(counts)) {
    if (c >= 3) repeated[h] = c;
  }

  // Single-word headings (exclude known structural words)
  const singleWord = [...new Set(headings
    .filter(h => {
      const words = h.text.split(/\s+/);
      return words.length === 1 && h.text.length < 15 && !LEGIT_SINGLE_WORDS.has(h.text.toLowerCase());
    })
    .map(h => h.text)
  )];

  // Single-word headings WITH page info (for display)
  const singleWordWithPages = headings
    .filter(h => {
      const words = h.text.split(/\s+/);
      return words.length === 1 && h.text.length < 15 && !LEGIT_SINGLE_WORDS.has(h.text.toLowerCase());
    })
    .map(h => ({ text: h.text, page: h.approxPage }));

  // Suspicious WITH page info
  const suspiciousWithPages = suspicious.map(h => ({ text: h.text, page: h.approxPage }));

  // Repeated WITH first occurrence page
  const repeatedWithPages = {};
  for (const [h, c] of Object.entries(repeated)) {
    const first = headings.find(hh => hh.text === h);
    repeatedWithPages[h] = { count: c, firstPage: first?.approxPage || '?' };
  }

  const needsGuidelines =
    headingTexts.length > 50 ||
    suspicious.length > 10 ||
    Object.keys(repeated).length > 0 ||
    singleWord.length > 3;  // lowered from 5 since we excluded legit words

  return {
    headingCount: headingTexts.length,
    uniqueHeadings: unique.size,
    suspiciousHeadings: [...new Set(suspicious.map(s => s.text))].slice(0, 10),
    suspiciousWithPages: suspiciousWithPages.slice(0, 10),
    singleWordHeadings: singleWord.slice(0, 10),
    singleWordWithPages: singleWordWithPages.slice(0, 10),
    repeatedHeadings: repeated,
    repeatedWithPages,
    needsGuidelines,
  };
}

/**
 * Apply guidelines to the heading classification process.
 * Returns a filter function that the sanitizer can use.
 *
 * @param {object} guidelines
 * @returns {(headingText: string) => { action: 'keep'|'reject'|'default', reason: string }}
 */
function buildHeadingFilter(guidelines) {
  if (!guidelines) return () => ({ action: "default", reason: "no_guidelines" });

  const rejectWords = new Set((guidelines.reject_words || []).map(w => w.toLowerCase()));
  const rejectPatterns = (guidelines.reject_patterns || []).map(p => new RegExp(p, "i"));
  const maxHeadingWords = guidelines.max_heading_words || 12;
  const minHeadingLength = guidelines.min_heading_length || 2;
  const rejectRepeated = guidelines.reject_repeated_headings || false;
  const repeatedHeadings = new Set((guidelines.known_repeated_headings || []).map(h => h.toLowerCase()));

  return (headingText) => {
    const lower = headingText.toLowerCase().trim();
    const words = headingText.trim().split(/\s+/);

    // Check reject words
    if (words.length === 1 && rejectWords.has(lower)) {
      return { action: "reject", reason: "guideline_reject_word" };
    }

    // Check reject patterns
    for (const pat of rejectPatterns) {
      if (pat.test(headingText)) {
        return { action: "reject", reason: "guideline_reject_pattern" };
      }
    }

    // Check max words
    if (words.length > maxHeadingWords) {
      return { action: "reject", reason: "guideline_too_many_words" };
    }

    // Check min length
    if (headingText.trim().length < minHeadingLength) {
      return { action: "reject", reason: "guideline_too_short" };
    }

    // Check repeated headings
    if (rejectRepeated && repeatedHeadings.has(lower)) {
      return { action: "reject", reason: "guideline_repeated_heading" };
    }

    return { action: "default", reason: "no_match" };
  };
}

module.exports = { loadGuidelines, saveGuidelines, preScanDocument, buildHeadingFilter };
