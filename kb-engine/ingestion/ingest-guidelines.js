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
function preScanDocument(content) {
  const headingLines = content.match(/^#{1,6}\s+.+$/gm) || [];
  const headingTexts = headingLines.map(l => l.replace(/^#{1,6}\s+/, "").trim());

  // Count unique
  const unique = new Set(headingTexts);

  // Find suspicious headings
  const suspicious = headingTexts.filter(h => {
    const words = h.split(/\s+/);
    return (
      (words.length === 1 && h.length < 15) ||  // single short word
      /^[a-z]/.test(h) ||                        // starts lowercase
      /@/.test(h) ||                              // has @ symbol
      /^\d+$/.test(h)                             // just a number
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

  // Single-word headings
  const singleWord = [...new Set(headingTexts.filter(h => h.split(/\s+/).length === 1 && h.length < 15))];

  // Determine if guidelines are needed
  const needsGuidelines =
    headingTexts.length > 50 ||                // way too many headings
    suspicious.length > 10 ||                   // many suspicious headings
    Object.keys(repeated).length > 0 ||         // repeated identical headings
    singleWord.length > 5;                      // many single-word headings

  return {
    headingCount: headingTexts.length,
    uniqueHeadings: unique.size,
    suspiciousHeadings: [...new Set(suspicious)].slice(0, 10),
    singleWordHeadings: singleWord.slice(0, 10),
    repeatedHeadings: repeated,
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
