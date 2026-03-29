'use strict';

/**
 * chunker.js — Two-stage Markdown chunking engine.
 *
 * Stage 1: MarkdownHeaderSplitter
 *   Splits content on heading lines (# H1, ## H2, ### H3).
 *   Each section carries its `section_path` (e.g. "Getting Started > Installation").
 *
 * Stage 2: RecursiveCharacterSplitter
 *   Any section exceeding maxTokens is recursively split at preferred boundaries
 *   (\n\n → \n → ". " → " "), respecting code-block and table boundaries.
 *
 * Token estimation: words / 0.75  (no external dependency)
 * Overlap: configurable (default 80 tokens ≈ 60 words worth of text)
 */

// Heading regex: captures level (1–6) and heading text
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

// Fenced code block marker
const FENCE_RE = /^```/;

// Table row marker (a line that starts and ends with |, or has | in it)
const TABLE_ROW_RE = /^\|.+\|?\s*$/;

class Chunker {
  /**
   * @param {object} opts
   * @param {number} [opts.maxTokens=512]     - Max tokens per chunk before splitting
   * @param {number} [opts.overlapTokens=80]  - Overlap tokens between sibling chunks
   */
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens || 512;
    this.overlapTokens = opts.overlapTokens || 80;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Chunk markdown content into structured segments.
   *
   * @param {string} markdownContent
   * @param {string} [docTitle]  - Optional document title prepended to section_path
   * @returns {{ content: string, section_path: string, chunk_index: number, token_estimate: number }[]}
   */
  chunk(markdownContent, docTitle = '') {
    if (!markdownContent || markdownContent.trim() === '') return [];

    // Stage 1: split by headings
    const sections = this._splitByHeaders(markdownContent, docTitle);

    const chunks = [];

    for (const section of sections) {
      const tokenCount = this._estimateTokens(section.content);

      if (tokenCount <= this.maxTokens) {
        // Section fits — emit as-is
        if (section.content.trim() !== '') {
          chunks.push({
            content: section.content.trim(),
            section_path: section.section_path,
            chunk_index: chunks.length,
            token_estimate: tokenCount,
          });
        }
      } else {
        // Stage 2: recursively split oversized section
        const subChunks = this._recursiveSplit(section.content, this.maxTokens);
        const withOverlap = this._applyOverlap(subChunks);

        for (const text of withOverlap) {
          if (text.trim() !== '') {
            chunks.push({
              content: text.trim(),
              section_path: section.section_path,
              chunk_index: chunks.length,
              token_estimate: this._estimateTokens(text),
            });
          }
        }
      }
    }

    // Re-index after all sections are processed
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].chunk_index = i;
    }

    return chunks;
  }

  // ─── Token Estimation ────────────────────────────────────────────────────────

  /**
   * Estimate token count from text.
   * Formula: word_count / 0.75  (1 token ≈ 0.75 words)
   *
   * @param {string} text
   * @returns {number}
   */
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

  // ─── Stage 1: Header Splitting ───────────────────────────────────────────────

  /**
   * Split markdown content on heading lines, tracking heading hierarchy.
   *
   * @param {string} content
   * @param {string} docTitle
   * @returns {{ content: string, section_path: string }[]}
   */
  _splitByHeaders(content, docTitle) {
    const lines = content.split('\n');
    const sections = [];

    // heading stack: index = level-1, value = heading text
    // levels: h1=index 0, h2=index 1, h3=index 2, h4=index 3, h5=index 4, h6=index 5
    const headingStack = ['', '', '', '', '', ''];
    let currentLines = [];
    let currentPath = docTitle || '';
    let inCodeBlock = false;

    const flushSection = () => {
      const text = currentLines.join('\n');
      if (text.trim() !== '') {
        sections.push({ content: text, section_path: currentPath || docTitle || '' });
      }
      currentLines = [];
    };

    for (const line of lines) {
      // Toggle code block state
      if (FENCE_RE.test(line.trim())) {
        inCodeBlock = !inCodeBlock;
        currentLines.push(line);
        continue;
      }

      // Don't split on headings inside code blocks
      if (inCodeBlock) {
        currentLines.push(line);
        continue;
      }

      const headingMatch = line.match(HEADING_RE);
      if (headingMatch) {
        // Flush previous section
        flushSection();

        const level = headingMatch[1].length; // 1, 2, or 3
        const headingText = headingMatch[2].trim();

        // Update heading stack: set current level, clear deeper levels
        headingStack[level - 1] = headingText;
        for (let i = level; i < headingStack.length; i++) {
          headingStack[i] = '';
        }

        // Build section_path from non-empty levels
        const pathParts = [];
        if (docTitle) pathParts.push(docTitle);
        for (let i = 0; i < level; i++) {
          if (headingStack[i]) pathParts.push(headingStack[i]);
        }
        currentPath = pathParts.join(' > ');

        // Include the heading line in the new section's content
        currentLines.push(line);
      } else {
        currentLines.push(line);
      }
    }

    // Flush the last section
    flushSection();

    return sections;
  }

  // ─── Stage 2: Recursive Character Splitting ──────────────────────────────────

  /**
   * Recursively split text that exceeds maxTokens.
   * Separators tried in order: \n\n → \n → ". " → " "
   * Never splits inside a fenced code block or a table.
   *
   * @param {string} text
   * @param {number} maxTokens
   * @returns {string[]}
   */
  _recursiveSplit(text, maxTokens) {
    if (this._estimateTokens(text) <= maxTokens) {
      return [text];
    }

    const separators = ['\n\n', '\n', '. ', ' '];

    for (const sep of separators) {
      const parts = this._splitAt(text, sep);
      if (parts.length <= 1) continue;

      // Merge parts into chunks that fit within maxTokens
      const chunks = this._mergePartsIntoChunks(parts, sep, maxTokens);

      if (chunks.length > 1) {
        // Recursively handle any chunk still too large
        const result = [];
        for (const chunk of chunks) {
          if (this._estimateTokens(chunk) > maxTokens) {
            result.push(...this._recursiveSplit(chunk, maxTokens));
          } else {
            result.push(chunk);
          }
        }
        return result;
      }
    }

    // Last resort: return as single chunk even if over limit
    return [text];
  }

  /**
   * Split text on a separator, but never at a position inside a code block or table.
   *
   * @param {string} text
   * @param {string} sep
   * @returns {string[]}
   */
  _splitAt(text, sep) {
    const parts = [];
    let start = 0;
    let searchFrom = 0;

    while (true) {
      const idx = text.indexOf(sep, searchFrom);
      if (idx === -1) break;

      // Check if this split point is inside a code block or table
      if (this._isInsideCodeBlock(text, idx) || this._isInsideTable(text, idx)) {
        searchFrom = idx + sep.length;
        continue;
      }

      parts.push(text.slice(start, idx + sep.length));
      start = idx + sep.length;
      searchFrom = start;
    }

    // Push remainder
    if (start < text.length) {
      parts.push(text.slice(start));
    }

    return parts.filter(p => p !== '');
  }

  /**
   * Merge split parts back into chunks, each fitting within maxTokens.
   *
   * @param {string[]} parts
   * @param {string} sep
   * @param {number} maxTokens
   * @returns {string[]}
   */
  _mergePartsIntoChunks(parts, sep, maxTokens) {
    const chunks = [];
    let current = '';

    for (const part of parts) {
      const candidate = current + part;
      if (current === '') {
        current = part;
      } else if (this._estimateTokens(candidate) <= maxTokens) {
        current = candidate;
      } else {
        chunks.push(current);
        current = part;
      }
    }

    if (current !== '') {
      chunks.push(current);
    }

    return chunks;
  }

  // ─── Overlap ─────────────────────────────────────────────────────────────────

  /**
   * Apply overlap between consecutive chunks.
   * Appends the last `overlapTokens` worth of words from chunk[i] to the start of chunk[i+1].
   *
   * @param {string[]} chunks
   * @returns {string[]}
   */
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

  // ─── Guard Helpers ───────────────────────────────────────────────────────────

  /**
   * Check whether a character position in the text falls inside a fenced code block.
   * Counts ``` fence markers that appear before `position` on their own line.
   *
   * @param {string} content
   * @param {number} position
   * @returns {boolean}
   */
  _isInsideCodeBlock(content, position) {
    const before = content.slice(0, position);
    const lines = before.split('\n');
    let fenceCount = 0;

    for (const line of lines) {
      if (FENCE_RE.test(line.trim())) {
        fenceCount++;
      }
    }

    // Odd fence count means we're currently inside a code block
    return fenceCount % 2 === 1;
  }

  /**
   * Check whether a character position in the text falls inside a markdown table.
   * A "table region" is a contiguous run of lines matching TABLE_ROW_RE.
   *
   * @param {string} content
   * @param {number} position
   * @returns {boolean}
   */
  _isInsideTable(content, position) {
    const lines = content.split('\n');
    let charOffset = 0;

    for (const line of lines) {
      const lineStart = charOffset;
      const lineEnd = charOffset + line.length + 1; // +1 for the \n

      if (lineStart <= position && position < lineEnd) {
        return TABLE_ROW_RE.test(line);
      }

      charOffset = lineEnd;
    }

    return false;
  }
}

module.exports = { Chunker };
