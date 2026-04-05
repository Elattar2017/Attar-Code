'use strict';

/**
 * heading-normalizer.js — Converts bold/numbered/caps patterns to proper # headings.
 *
 * PDF→Markdown output often has bold text (**Chapter N: Title**) instead of
 * proper # headings. This module normalizes those patterns.
 *
 * Called after preprocessing, before heading-sanitizer.
 */

/**
 * Normalize common heading patterns in markdown content.
 * Converts bold chapters, numbered sections, ALL CAPS headings, etc. to # headings.
 *
 * @param {string} content  Raw markdown content
 * @returns {string}        Content with normalized headings
 */
function normalizeHeadings(content) {
  let result = content;

  // Pattern: "Chapter N: Title" or "Chapter N. Title" (with or without bold)
  result = result.replace(/^(\*\*)?Chapter\s+(\d+)[:.]\s*(.+?)(\*\*)?$/gm, (m, b1, num, title, b2) => {
    return `# Chapter ${num}: ${title.replace(/\*\*/g, '').trim()}`;
  });

  // Pattern: "**N.N Title**" or "**N.N.N Title**" → ## or ###
  result = result.replace(/^\s*\*\*(\d+\.\d+(?:\.\d+)?)\s+(.+?)\*\*\s*$/gm, (m, num, title) => {
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
  result = result.replace(/^([A-Z][A-Z\s]{5,78})$/gm, (m, text) => {
    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount >= 2 && wordCount <= 8
      && !/[{}()\[\]=<>;_`]/.test(trimmed)
      && !/\?$/.test(trimmed)
      && !/\.\s*$/.test(trimmed)
    ) {
      return `## ${trimmed}`;
    }
    return m;
  });

  // Pattern: "N. Title" standalone
  result = result.replace(/^(\d{1,2})\.\s+([A-Z][^\n]{5,75})$/gm, (m, num, title) => {
    const t = title.trim();
    if (!/[{}()\[\]=;`]/.test(t)
      && !/\?$/.test(t)
      && !/\.\s*$/.test(t)
      && !/\b\w+_\w+\b/.test(t)
      && t.split(/\s+/).length <= 10
    ) {
      return `## ${num}. ${t}`;
    }
    return m;
  });

  // Pattern: "N.N Title" without bold
  result = result.replace(/^(\d{1,2}\.\d{1,2})\s+([A-Z][^\n]{5,75})$/gm, (m, num, title) => {
    const t = title.trim();
    if (!/[{}()\[\]=;`]/.test(t)
      && !/\?$/.test(t)
      && !/\.\s*$/.test(t)
      && !/\b\w+_\w+\b/.test(t)
      && t.split(/\s+/).length <= 10
    ) {
      return `## ${num} ${t}`;
    }
    return m;
  });

  // Pattern: "**Bold Heading Text**" on its own line
  result = result.replace(/^\s*\*\*([^*\n]{5,80})\*\*\s*$/gm, (m, text) => {
    const trimmed = text.trim();
    if (/^[A-Z]/.test(trimmed)
      && !/[{}()\[\]=;`]/.test(trimmed)
      && !/\?$/.test(trimmed)
      && !/\.\s*$/.test(trimmed)
      && !/\b\w+_\w+\b/.test(trimmed)
      && !/\b(if|for|while|def|class|return|import|from|print|True|False|None)\b/.test(trimmed)
      && !/\b(var|let|const|function|async|await|new|this)\b/.test(trimmed)
      && trimmed.split(/\s+/).length <= 10
    ) {
      return `## ${trimmed}`;
    }
    return m;
  });

  return result;
}

module.exports = { normalizeHeadings };
