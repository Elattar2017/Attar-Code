'use strict';

/**
 * ingestion/index.js — IngestPipeline: orchestrates the full ingestion flow.
 *
 * Flow for each file:
 *   1. Detect format  (format-detector)
 *   2. Preprocess     (format-specific preprocessor)
 *   3. Chunk          (chunker)
 *   4. Route          (collection-router)
 *   5. Track          (progress tracker)
 *   6. Enrich         (enrichment — fast or LLM mode)
 *   7. Extract metadata (metadata extractor)
 *   8. Store          (ChunkStore → Qdrant)
 */

const fs   = require('fs');
const path = require('path');

const { detectFormat }      = require('./format-detector');
const { routeToCollection } = require('./collection-router');
const { Chunker }           = require('./chunker');
const { extractMetadata }   = require('./metadata');
const { enrichChunkFast }   = require('./enrichment');
const { IngestionTracker }  = require('./progress');
const { ChunkStore }        = require('../store');
const { extractTocFromBookmarks, extractTocFromHeadings, mergeTocSources } = require('./toc-extractor');
const { buildStructuralChunks } = require('./structural-indexer');

// Supported file extensions for directory ingestion
const SUPPORTED_EXTS = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.html', '.htm',
  '.pdf',
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java', '.kt',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.cpp', '.cc', '.cxx', '.c', '.h',
  '.css', '.scss', '.sass',
  '.sh', '.bash',
]);

// Directory names to skip during recursive walk
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', 'vendor',
  '.next', '.nuxt', 'coverage', '.cache',
]);

class IngestPipeline {
  /**
   * @param {object} [opts]
   * @param {ChunkStore}        [opts.store]      - Custom ChunkStore instance (useful for testing).
   * @param {string}            [opts.stateFile]  - Override path for ingestion state JSON.
   * @param {boolean}           [opts.deep]       - Enable LLM enrichment mode (slower).
   * @param {string}            [opts.ollamaUrl]  - Ollama URL for LLM enrichment.
   * @param {number}            [opts.maxTokens]  - Max tokens per chunk.
   * @param {number}            [opts.overlapTokens] - Overlap tokens between chunks.
   */
  constructor(opts = {}) {
    this.store   = opts.store || new ChunkStore(opts);
    this.chunker = new Chunker({ maxTokens: opts.maxTokens, overlapTokens: opts.overlapTokens });
    this.tracker = new IngestionTracker(opts.stateFile);
    this.deep    = opts.deep || false;
    this.ollamaUrl = opts.ollamaUrl;
  }

  // ─── ingestFile ─────────────────────────────────────────────────────────────

  /**
   * Ingest a single file into Qdrant.
   *
   * @param {string} filePath   - Absolute or relative path to the file.
   * @param {object} [options]
   * @param {string} [options.collection] - Override the target collection.
   * @param {string} [options.language]   - Override detected language.
   * @returns {Promise<{
   *   collection: string,
   *   chunks_stored: number,
   *   format: string,
   *   title?: string,
   *   error?: string
   * }>}
   */
  async ingestFile(filePath, options = {}) {
    const absPath = path.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      throw new Error('File not found: ' + absPath);
    }

    // 1. Read & detect format ─────────────────────────────────────────────────
    const content  = fs.readFileSync(absPath, 'utf-8');
    const detected = detectFormat(absPath, content);

    // 2. Preprocess (format-specific) ─────────────────────────────────────────
    let processed;

    switch (detected.format) {
      case 'pdf': {
        const { preprocessPdf } = require('./preprocessors/pdf');
        processed = await preprocessPdf(absPath, options);
        break;
      }

      case 'html': {
        const { preprocessHtml } = require('./preprocessors/html');
        processed = preprocessHtml(content);
        break;
      }

      case 'code': {
        // Code preprocessor returns pre-split function/class chunks — handle separately
        const { preprocessCode } = require('./preprocessors/code');
        const result     = preprocessCode(absPath);
        const language   = options.language || detected.language;
        const collection = routeToCollection(absPath, { language }, options);

        await this.store.ensureCollection(collection);

        const chunks = result.chunks.map((c, i) => ({
          content:  c.content,
          metadata: {
            ...extractMetadata(c.content, absPath, { language }),
            source:      absPath,
            filename:    path.basename(absPath),
            doc_title:   result.title,
            section_path: c.name || '',
            chunk_index:  i,
            total_chunks: result.chunks.length,
          },
        }));

        const ids = await this.store.addChunks(collection, chunks);
        return {
          collection,
          chunks_stored: ids.length,
          format:        detected.format,
          title:         result.title,
        };
      }

      case 'markdown': {
        const { preprocessMarkdown } = require('./preprocessors/markdown');
        processed = preprocessMarkdown(absPath);
        break;
      }

      default: {
        const { preprocessText } = require('./preprocessors/text');
        processed = preprocessText(absPath);
        break;
      }
    }

    // Preprocessor error check (e.g. PDF parse failure)
    if (processed && processed.error) {
      return { error: processed.error, collection: null, chunks_stored: 0, format: detected.format };
    }

    // 2.5 Normalize headings — convert common chapter/section patterns to Markdown headings
    //     (especially important for PDFs where headings are bold text or numbered)
    processed.content = normalizeHeadings(processed.content);

    // 2.6 Extract TOC and build structural chunks
    let structuralChunks = [];
    if (detected.format === 'pdf') {
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

    // 3. Chunk ─────────────────────────────────────────────────────────────────
    const rawChunks = this.chunker.chunk(processed.content, processed.title);

    // Empty file edge case
    if (rawChunks.length === 0) {
      return {
        collection:    routeToCollection(absPath, { language: detected.language }, options),
        chunks_stored: 0,
        format:        detected.format,
        title:         processed.title,
      };
    }

    // 4. Route to collection ───────────────────────────────────────────────────
    const language   = options.language || detected.language;
    const collection = routeToCollection(absPath, { language }, options);
    await this.store.ensureCollection(collection);

    // 5. Track progress ────────────────────────────────────────────────────────
    const docId = path.basename(absPath);
    this.tracker.startIngestion(docId, rawChunks.length, collection);

    // 6. Enrich + extract metadata ────────────────────────────────────────────
    // Deep enrichment must be sequential — Ollama processes one request at a time.
    // Parallel calls cause timeouts and 500 errors.
    const useDeep = this.deep || options.deep;
    const enrichedChunks = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const c = rawChunks[i];
      let enrichedContent;

      if (useDeep) {
        const { enrichChunk } = require('./enrichment');
        enrichedContent = await enrichChunk(
          c.content,
          processed.title,
          c.section_path,
          this.ollamaUrl
        );
        // Progress logging for deep enrichment
        if (i % 50 === 0 || i === rawChunks.length - 1) {
          process.stderr.write(`  Deep enrichment: ${i + 1}/${rawChunks.length} chunks\r`);
        }
      } else {
        enrichedContent = enrichChunkFast(c.content, processed.title, c.section_path);
      }

      enrichedChunks.push({
          content:  enrichedContent,
          metadata: {
            ...extractMetadata(c.content, absPath, { language }),
            source:       absPath,
            filename:     path.basename(absPath),
            doc_title:    processed.title,
            section_path: c.section_path || '',
            chunk_index:  i,
            total_chunks: rawChunks.length,
          },
        });
    }
    if (useDeep) process.stderr.write('\n'); // clear progress line

    // 7. Store ─────────────────────────────────────────────────────────────────
    const ids = await this.store.addChunks(collection, enrichedChunks);

    // 7.5 Store structural chunks (if any)
    let structuralIds = [];
    if (structuralChunks.length > 0) {
      structuralIds = await this.store.addChunks(collection, structuralChunks);
    }

    this.tracker.updateProgress(docId, ids.length);
    this.tracker.markComplete(docId);

    return {
      collection,
      chunks_stored: ids.length,
      structural_chunks: structuralIds.length,
      format:        detected.format,
      title:         processed.title,
    };
  }

  // ─── ingestDirectory ────────────────────────────────────────────────────────

  /**
   * Recursively ingest all supported files in a directory.
   *
   * @param {string} dirPath   - Directory path.
   * @param {object} [options] - Same options as ingestFile (applied to every file).
   * @returns {Promise<Array<{ file: string, collection?: string, chunks_stored?: number, format?: string, error?: string }>>}
   */
  async ingestDirectory(dirPath, options = {}) {
    const absDir = path.resolve(dirPath);
    const files  = [];

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        return; // unreadable directory — skip
      }

      for (const entry of entries) {
        // Skip hidden files/dirs and known noise directories
        if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;

        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else if (SUPPORTED_EXTS.has(path.extname(full).toLowerCase())) {
            files.push(full);
          }
        } catch (_) {
          // stat failure (e.g. broken symlink) — skip
        }
      }
    };

    walk(absDir);

    const results = [];
    for (const file of files) {
      try {
        const result = await this.ingestFile(file, options);
        results.push({ file, ...result });
      } catch (err) {
        results.push({ file, error: err.message });
      }
    }

    return results;
  }
}

// ─── Heading Normalizer ─────────────────────────────────────────────────────
// Converts common chapter/section patterns to Markdown headings.
// PDF→Markdown output often has bold text instead of proper # headings.

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
  result = result.replace(/^([A-Z][A-Z\s]{5,78})$/gm, (m, text) => {
    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).length;
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
    if (/^[A-Z]/.test(trimmed) && !/[{}()\[\]=;]/.test(trimmed)) {
      return `## ${trimmed}`;
    }
    return m;
  });

  return result;
}

module.exports = { IngestPipeline, normalizeHeadings };
