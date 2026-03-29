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
