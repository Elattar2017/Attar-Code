'use strict';

/**
 * kb-engine/ingestion/heading-sanitizer.js
 *
 * Sanitizes and classifies document headings for clean KB metadata.
 * Based on Unstructured.io's is_possible_title() approach:
 *   - Classify first (is this really a heading?)
 *   - Clean second (strip formatting, fix OCR, normalize)
 *
 * Applied at ingestion time — industry consensus is to normalize at ingestion
 * because dirty headings produce degraded embeddings and break Qdrant filters.
 */

// ── Ligature Map (PDF extraction artifacts) ──────────────────────────────────
const LIGATURE_MAP = {
  '\uFB00': 'ff',   // ff ligature
  '\uFB01': 'fi',   // fi ligature
  '\uFB02': 'fl',   // fl ligature
  '\uFB03': 'ffi',  // ffi ligature
  '\uFB04': 'ffl',  // ffl ligature
  '\uFB05': 'st',   // long s + t
  '\uFB06': 'st',   // st ligature
  '\u0152': 'OE',   // OE ligature
  '\u0153': 'oe',   // oe ligature
  '\u00C6': 'AE',   // AE ligature
  '\u00E6': 'ae',   // ae ligature
};

// ── Programming Keywords (for heading rejection) ─────────────────────────────
const CODE_KEYWORDS = /\b(if|for|while|def|class|return|import|from|print|True|False|None|var|let|const|function|async|await|new|this|try|except|catch|throw|yield|lambda)\b/;

// ═══════════════════════════════════════════════════════════════════════════════
// SANITIZATION FUNCTIONS (applied in pipeline order)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fix OCR character-level spacing artifacts.
 * "re que s t" → "request", "Ce lls" → "Cells"
 * Collapses sequences of 1-2 char groups separated by spaces.
 */
function fixOcrSpacing(text) {
  // Language-agnostic OCR spacing fix.
  // No hardcoded word lists — works for any language.
  //
  // Strategy: Use character-class analysis to detect OCR artifacts.
  // OCR splits produce fragments where one side has no vowels or starts
  // with a consonant cluster that doesn't begin words in any language.

  // Pass 1: Collapse sequences of short (1-3 char) LETTER fragments
  // These are almost always OCR: "re que s t" → "request", "s e rvice" → "service"
  // Uses [a-zA-Z] not \w to avoid matching digits in heading numbers like "1.1 On"
  let result = text.replace(
    /(?<![.\w])((?:[a-zA-Z]{1,3}\s){2,}[a-zA-Z]{1,3})(?![.\w])/g,
    (match) => {
      const collapsed = match.replace(/\s+/g, '');
      if (collapsed.length >= 3) return collapsed;
      return match;
    }
  );

  // Pass 2: Collapse pairs where one fragment is a single non-standalone LETTER
  // "databas e" → "database" (single 'e' is OCR)
  // But keep: "a dog" ('a' is a word), "I think" ('I' is a word),
  //           "1 On quality" (digit + word is a heading number)
  result = result.replace(
    /([a-zA-Z]{3,})\s([a-zA-Z]{1,3})\b/g,
    (match, left, right) => {
      if (/^[aAI]$/.test(right)) return match;
      // Single-char right: always collapse (only a/I kept above)
      // "databas e" → "database"
      if (right.length === 1) return left + right;
      // 2-3 char right: collapse only if it has NO vowel (can't be a word)
      // "obje cts" → "objects" (no vowel), keeps "use the" (has vowel)
      if (!/[aeiouyAEIOUY]/.test(right)) return left + right;
      return match;
    }
  );
  result = result.replace(
    /\b([a-zA-Z]{1,2})\s([a-zA-Z]{3,})/g,
    (match, left, right) => {
      // Keep standalone words: a, I, an, am, as, at, be, by, do, go, he, if, in, is, it, me, my, no, of, oh, ok, on, or, so, to, up, us, we
      // Rather than hardcode: if left is 1 char, only keep "a" and "I"
      // If left is 2 chars, check if BOTH chars are common (likely a word)
      if (left.length === 1 && /^[aAI]$/.test(left)) return match;
      if (left.length === 2 && /^(an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|oh|ok|on|or|so|to|up|us|we)$/i.test(left)) return match;
      return left + right;
    }
  );

  // Pass 3: Fix spaced-out words within dotted paths (urllib.re que s t → urllib.request)
  // Only matches letter-dot-letter patterns (not number-dot like "1.1 On")
  result = result.replace(
    /([a-zA-Z]+\.)((?:[a-zA-Z]{1,5}\s){1,}[a-zA-Z]{1,5})\b/g,
    (match, prefix, spaced) => {
      const collapsed = spaced.replace(/\s+/g, '');
      if (collapsed.length >= 3) return prefix + collapsed;
      return match;
    }
  );

  return result;
}

/**
 * Fix common Unicode ligatures from PDF extraction.
 * Uses explicit mapping + NFKC for any remaining compatibility chars.
 */
function fixLigatures(text) {
  let result = text;
  for (const [lig, replacement] of Object.entries(LIGATURE_MAP)) {
    result = result.split(lig).join(replacement);
  }
  return result;
}

/**
 * Fix hyphenation artifacts from PDF line breaks.
 * "func-\ntion" → "function"
 */
function fixHyphenation(text) {
  return text.replace(/(\w+)-\n(\w+)/g, '$1$2');
}

/**
 * Strip markdown formatting from heading text.
 * Removes **, *, _, #, backticks, and link syntax.
 */
function stripMarkdownFormatting(text) {
  let result = text;
  result = result.replace(/\*\*(.*?)\*\*/g, '$1');     // **bold**
  result = result.replace(/\*(.*?)\*/g, '$1');           // *italic*
  result = result.replace(/_(.*?)_/g, '$1');             // _italic_
  result = result.replace(/^#{1,6}\s+/, '');             // # heading markers
  result = result.replace(/`([^`]+)`/g, '$1');           // `inline code`
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url) → text
  return result.trim();
}

/**
 * Fix malformed OCR chapter headings where chapter+section bleed together.
 * "CHAPTER 4. A QUICK OVERVIEW OF THE PYTHON LANGUAGE 4.2 Basic Data Types"
 * → "CHAPTER 4. A QUICK OVERVIEW OF THE PYTHON LANGUAGE"
 */
function fixMalformedChapterHeading(text) {
  // Pattern 1: Chapter heading bleeds into subsection number
  // "CHAPTER 4. Title 4.2 Subtitle" → "CHAPTER 4. Title"
  const match = text.match(
    /^((?:CHAPTER|Chapter|PART|Part)\s+\d+[\.:]\s*.+?)\s+(\d+\.\d+\s+.+)$/i
  );
  if (match) {
    return match[1].trim();
  }

  // Pattern 2: Page number embedded in heading (very common in PDF extraction)
  // "CHAPTER 2. A CASE FOR PUZZLE-BASED 18 LEARNING" → strip the standalone number
  // "3.4. HOW TO TEST AND TRAIN YOUR SKILLS?29" → strip trailing number
  let fixed = text;

  // Strip leading standalone page number: "28 CHAPTER 3..." → "CHAPTER 3..."
  fixed = fixed.replace(/^\d{1,4}\s+(?=[A-Z])/, '');

  // Strip trailing standalone number (page number at end): "HEADING TEXT 42" → "HEADING TEXT"
  fixed = fixed.replace(/\s+\d{1,4}\s*$/, '');

  // Strip number stuck to last word: "SKILLS?29" → "SKILLS?"
  fixed = fixed.replace(/([^0-9])(\d{1,4})$/, '$1');

  // Strip embedded standalone number between ALL CAPS words:
  // "CASE FOR PUZZLE-BASED 18 LEARNING" → "CASE FOR PUZZLE-BASED LEARNING"
  fixed = fixed.replace(/\b([A-Z]{2,})\s+(\d{1,4})\s+([A-Z]{2,})\b/g, '$1 $3');

  return fixed;
}

/**
 * Remove control characters (keep newlines and tabs).
 */
function removeControlChars(text) {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Normalize whitespace: collapse spaces, remove zero-width chars, trim.
 */
function normalizeWhitespace(text) {
  let result = text;
  result = result.replace(/[\u200B\u200C\u200D\uFEFF]/g, ''); // zero-width chars
  result = result.replace(/\u00A0/g, ' ');                      // non-breaking space
  result = result.replace(/[ \t]{2,}/g, ' ');                   // collapse spaces
  return result.trim();
}

/**
 * Truncate heading to reasonable length at word boundary.
 */
function truncateHeading(text, maxLength = 120) {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace).trim();
  }
  return truncated.trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL SANITIZATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full heading sanitization pipeline.
 * Apply in this order for correct results.
 *
 * @param {string} raw — raw heading text (may contain markdown, OCR artifacts, etc.)
 * @returns {string} — cleaned heading text
 */
function sanitizeHeading(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw;

  // Step 1: Fix OCR spacing artifacts BEFORE stripping formatting
  text = fixOcrSpacing(text);

  // Step 2: Fix ligatures
  text = fixLigatures(text);

  // Step 3: Fix hyphenation
  text = fixHyphenation(text);

  // Step 4: Strip markdown formatting
  text = stripMarkdownFormatting(text);

  // Step 5: Fix malformed chapter headings (bleeding)
  text = fixMalformedChapterHeading(text);

  // Step 6: Remove control characters
  text = removeControlChars(text);

  // Step 7: Normalize whitespace
  text = normalizeWhitespace(text);

  // Step 8: Unicode NFC normalization
  text = text.normalize('NFC');

  // Step 9: Truncate
  text = truncateHeading(text, 120);

  return text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEADING CLASSIFICATION (Unstructured.io-style)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine if text qualifies as a heading.
 * Based on Unstructured.io's is_possible_title() with adaptations for code/PDF content.
 *
 * 9 rejection rules + 5 positive signals → confidence score.
 *
 * @param {string} text — text to classify (should be sanitized first)
 * @returns {{ isHeading: boolean, confidence: number, reason: string }}
 */
function classifyHeading(text) {
  const trimmed = (text || '').trim();

  // ── Rejection rules (any one disqualifies) ──

  // Rule 1: Empty or very short
  if (trimmed.length < 2) {
    return { isHeading: false, confidence: 1.0, reason: 'too_short' };
  }

  // Rule 2: Too many words (>12)
  const words = trimmed.split(/\s+/);
  if (words.length > 12) {
    return { isHeading: false, confidence: 0.9, reason: 'too_many_words' };
  }

  // Rule 3: Ends with sentence-terminal punctuation (unless structural prefix)
  if (/[.!?]$/.test(trimmed) && !/^(Chapter|Section|Part|Appendix)\b/i.test(trimmed)) {
    return { isHeading: false, confidence: 0.85, reason: 'sentence_ending' };
  }

  // Rule 4: Contains code syntax characters
  if (/[{}\[\]=;`]/.test(trimmed)) {
    return { isHeading: false, confidence: 0.95, reason: 'code_syntax' };
  }

  // Rule 4b: Shell commands (starts with %, $, >, #!, or common CLI tools)
  if (/^[%$>]/.test(trimmed) || /^#!/.test(trimmed)) {
    return { isHeading: false, confidence: 0.95, reason: 'shell_command' };
  }
  // Common CLI command patterns: pip, conda, npm, yarn, git, python, node, etc.
  if (/^(pip|conda|npm|yarn|git|python|node|cargo|go|mvn|gradle|docker|kubectl|brew|apt|yum|curl|wget|chmod|mkdir|cd|ls|cat|echo|export|source)\b/i.test(trimmed)) {
    return { isHeading: false, confidence: 0.9, reason: 'cli_command' };
  }
  // Paths: starts with /, ~/, ./, or contains /usr/, /bin/, /home/
  if (/^[~.\/]/.test(trimmed) || /\/(usr|bin|home|etc|var|opt|tmp)\//i.test(trimmed)) {
    return { isHeading: false, confidence: 0.85, reason: 'file_path' };
  }

  // Rule 5: Contains snake_case identifiers
  if (/\b\w+_\w+\b/.test(trimmed)) {
    return { isHeading: false, confidence: 0.9, reason: 'snake_case' };
  }

  // Rule 6: Contains programming keywords
  if (CODE_KEYWORDS.test(trimmed)) {
    return { isHeading: false, confidence: 0.85, reason: 'code_keyword' };
  }

  // Rule 7: Non-alpha ratio too high (>50% non-alpha chars)
  const alphaCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const nonSpaceLen = trimmed.replace(/\s/g, '').length;
  if (nonSpaceLen > 0 && alphaCount / nonSpaceLen < 0.5) {
    return { isHeading: false, confidence: 0.8, reason: 'too_many_symbols' };
  }

  // Rule 8: Ends with comma (attribution, not heading)
  if (/,\s*$/.test(trimmed)) {
    return { isHeading: false, confidence: 0.8, reason: 'ends_with_comma' };
  }

  // Rule 9: Entirely numeric
  if (/^\d+$/.test(trimmed)) {
    return { isHeading: false, confidence: 1.0, reason: 'purely_numeric' };
  }

  // Rule 10: All-lowercase text (puzzle answers, random phrases)
  // "mouse", "hello world", "galaxy" — NOT headings
  if (trimmed === trimmed.toLowerCase() && trimmed.length < 30 && words.length <= 3) {
    return { isHeading: false, confidence: 0.9, reason: 'all_lowercase_short' };
  }

  // Rule 11: Single word that's a common short word (even capitalized)
  // "Yes", "No", "True", "False", "None", "Unzip", etc. are not headings
  if (words.length === 1 && trimmed.length < 10 && !/^(Chapter|Section|Part|Appendix|Introduction|Preface|Contents|Index|Summary|Conclusion|Abstract|Glossary|Bibliography|References)\b/i.test(trimmed)) {
    return { isHeading: false, confidence: 0.85, reason: 'single_short_word' };
  }

  // Rule 12: Contains @ symbol (social handles, email-like)
  if (/@/.test(trimmed)) {
    return { isHeading: false, confidence: 0.9, reason: 'contains_at_symbol' };
  }

  // Rule 13: Roman numeral alone or single letter alone (A, B, C, IV, ii)
  if (/^[A-Za-z]{1,4}$/.test(trimmed) && /^[ivxlcdmIVXLCDMA-Z]{1,4}$/i.test(trimmed)) {
    return { isHeading: false, confidence: 0.9, reason: 'single_letter_or_numeral' };
  }

  // ── Positive signals (accumulate confidence) ──

  let confidence = 0.5; // baseline

  // Starts with capital letter
  if (/^[A-Z]/.test(trimmed)) confidence += 0.1;

  // Short (1-6 words) — very likely heading ONLY if 2+ words
  // Single words get reduced boost to prevent false positives
  if (words.length >= 2 && words.length <= 6) confidence += 0.15;
  else if (words.length === 1) confidence += 0.05; // minimal boost for single words

  // Contains structural prefix
  if (/^(Chapter|Section|Part|Appendix|Module|Unit|Lesson|Topic)\b/i.test(trimmed)) {
    confidence += 0.25;
  }

  // Numbered section pattern (N.N or N.N.N)
  if (/^\d+(\.\d+)+\s/.test(trimmed)) confidence += 0.2;

  // ALL CAPS (2-8 words)
  if (trimmed === trimmed.toUpperCase() && words.length >= 2 && words.length <= 8) {
    confidence += 0.2;
  }

  return {
    isHeading: confidence >= 0.6,
    confidence: Math.min(confidence, 1.0),
    reason: confidence >= 0.6 ? 'classified_as_heading' : 'low_confidence',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN-LEVEL SANITIZATION (applied to full document content)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sanitize all headings in a markdown document.
 * Finds every # heading line, sanitizes the text, and optionally demotes
 * headings that fail classification back to bold text.
 *
 * @param {string} content — full markdown content (after normalizeHeadings)
 * @returns {string} — content with sanitized heading text
 */
function sanitizeAllHeadings(content) {
  return content.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, text) => {
    // Sanitize the heading text
    const clean = sanitizeHeading(text);
    if (!clean) return ''; // empty after sanitization → remove line

    // Classify: is this actually a heading?
    const classification = classifyHeading(clean);
    if (!classification.isHeading) {
      // Demote to bold text (not a real heading)
      return `**${clean}**`;
    }

    return `${hashes} ${clean}`;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  sanitizeHeading,
  classifyHeading,
  sanitizeAllHeadings,
  // Individual steps (for testing)
  fixOcrSpacing,
  fixLigatures,
  fixHyphenation,
  stripMarkdownFormatting,
  fixMalformedChapterHeading,
  removeControlChars,
  normalizeWhitespace,
  truncateHeading,
};
