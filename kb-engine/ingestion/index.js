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

const fs     = require('fs');
const path   = require('path');
const config = require('../config');

const { detectFormat }      = require('./format-detector');
const { routeToCollection } = require('./collection-router');
const { Chunker }           = require('./chunker');
const { extractMetadata }   = require('./metadata');
const { enrichChunkFast, generateSummary }   = require('./enrichment');
const { IngestionTracker }  = require('./progress');
const { ChunkStore }        = require('../store');
const { extractTocFromBookmarks, extractTocFromHeadings, mergeTocSources } = require('./toc-extractor');
const { buildStructuralChunks } = require('./structural-indexer');
const { sanitizeHeading, sanitizeAllHeadings, classifyHeading } = require('./heading-sanitizer');
const { normalizeHeadings } = require('./heading-normalizer');
const { loadDNA, flattenDNA } = require('./dna-loader');
const { loadGuidelines, preScanDocument, buildHeadingFilter } = require('./ingest-guidelines');

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
    this.chunker = new Chunker({
      maxTokens: opts.maxTokens || config.MAX_CHUNK_TOKENS,
      overlapTokens: opts.overlapTokens || config.CHUNK_OVERLAP_TOKENS,
    });
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
        const crypto   = require('crypto');
        const result   = preprocessCode(absPath);
        const language = options.language || detected.language;
        const collection = routeToCollection(absPath, { language }, options);
        const bookId   = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 12);
        const dirName  = path.basename(path.dirname(absPath));
        const dnaFields = flattenDNA(loadDNA(bookId));

        await this.store.ensureCollection(collection);

        const chunks = result.chunks.map((c, i) => {
          const sectionName  = c.name || 'module';
          const sectionPath  = `${result.title} > ${dirName} > ${sectionName}`;
          const enriched     = enrichChunkFast(c.content, result.title, sectionPath);
          return {
            content:  enriched,
            metadata: {
              ...extractMetadata(c.content, absPath, { language }),
              ...dnaFields,
              source:       absPath,
              filename:     path.basename(absPath),
              doc_title:    result.title,
              section_path: sectionPath,
              chunk_index:  i,
              total_chunks: result.chunks.length,
              chunk_type:   'content',
              book_id:      bookId,
              chapter:      dirName,
              section:      sectionName,
              ...(result.importHeader ? { import_header: result.importHeader } : {}),
            },
          };
        });

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
    processed.content = normalizeHeadings(processed.content);

    // 2.55 Pre-scan: detect messy documents + load ingestion guidelines
    const crypto2 = require('crypto');
    const scanBookId = crypto2.createHash('sha256').update(absPath).digest('hex').slice(0, 12);
    const guidelines = loadGuidelines(scanBookId);
    const scan = preScanDocument(processed.content);

    if (scan.needsGuidelines && !guidelines) {
      process.stderr.write(`  [Ingest] ⚠ Document has ${scan.headingCount} headings (${scan.uniqueHeadings} unique)`);
      if (scan.singleWordHeadings.length > 0) process.stderr.write(` — ${scan.singleWordHeadings.length} single-word headings`);
      if (Object.keys(scan.repeatedHeadings).length > 0) process.stderr.write(` — ${Object.keys(scan.repeatedHeadings).length} repeated headings`);
      process.stderr.write(`\n  [Ingest] Run /kb guidelines ${path.basename(absPath)} to set ingestion rules\n`);
    }

    // 2.56 Apply guidelines-based heading filter (if guidelines exist)
    if (guidelines) {
      const filter = buildHeadingFilter(guidelines);
      processed.content = processed.content.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, text) => {
        const result = filter(text.trim());
        if (result.action === 'reject') return `**${text.trim()}**`; // demote to bold
        return match; // keep as heading
      });
      process.stderr.write(`  [Ingest] Applied ingestion guidelines for "${path.basename(absPath)}"\n`);
    }

    // 2.57 Sanitize headings — clean OCR artifacts, strip markdown, classify, demote non-headings
    processed.content = sanitizeAllHeadings(processed.content);

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

      // Neighbor context for Anthropic-style contextual enrichment
      const prevContent = i > 0 ? rawChunks[i - 1].content : '';
      const nextContent = i < rawChunks.length - 1 ? rawChunks[i + 1].content : '';

      if (useDeep) {
        const { enrichChunk } = require('./enrichment');
        enrichedContent = await enrichChunk(
          c.content,
          processed.title,
          c.section_path,
          this.ollamaUrl,
          prevContent,
          nextContent
        );
        // Progress logging for deep enrichment
        if (i % 50 === 0 || i === rawChunks.length - 1) {
          process.stderr.write(`  Deep enrichment: ${i + 1}/${rawChunks.length} chunks\r`);
        }
      } else {
        enrichedContent = enrichChunkFast(c.content, processed.title, c.section_path, prevContent);
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

    // 6.5 Add chunk_type: "detail", book_id, and DNA metadata to all enriched chunks
    const crypto = require('crypto');
    const bookId = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 12);
    const dnaFields = flattenDNA(loadDNA(bookId));
    for (const c of enrichedChunks) {
      c.metadata.chunk_type = 'detail';
      c.metadata.book_id = bookId;
      // Extract chapter and section from section_path
      const pathParts = (c.metadata.section_path || '').split(' > ');
      c.metadata.chapter = sanitizeHeading(pathParts[1] || '');
      c.metadata.section = sanitizeHeading(pathParts[2] || '');
      // Merge Document DNA metadata (if sidecar file exists)
      Object.assign(c.metadata, dnaFields);
    }

    // 6.6 Generate section AND chapter summaries ────────────────────────────────
    // Two levels of summaries as planned:
    //   - Section summary: group by first 3 levels (Book > Chapter > Section), threshold 3+
    //   - Chapter summary: group by first 2 levels (Book > Chapter), threshold 5+
    //
    // No VRAM management needed — embedding model (0.6B, ~2GB) fits alongside
    // chat/summary model (gemma4:e4b, ~12GB) in 24GB VRAM simultaneously.
    const _ollamaUrl = this.ollamaUrl || config.OLLAMA_URL;
    const summaryChunks = [];

    // Helper: generate and store a summary chunk
    const _addSummary = async (groupKey, chunks, level) => {
      const name = groupKey.split(' > ').pop() || groupKey;
      const combined = chunks.map(c => c.content).join('\n\n').slice(0, 8000);
      let summary = await generateSummary(combined, name, this.ollamaUrl);
      // Fallback: if LLM summary fails, create an extractive summary (first 200 words)
      if (!summary && combined.length > 50) {
        const words = combined.split(/\s+/).slice(0, 200);
        summary = words.join(' ') + (words.length >= 200 ? '...' : '');
        process.stderr.write(`  [summary fallback] extractive summary for "${name}" (LLM unavailable)\n`);
      }
      if (summary) {
        summaryChunks.push({
          content: `[${level === 'chapter' ? 'Chapter Summary' : 'Section Summary'}: ${name}]\n\n${summary}`,
          metadata: {
            chunk_type: 'summary',
            summary_level: level,
            book_id: bookId,
            doc_title: processed.title,
            section_path: groupKey,
            chapter: level === 'chapter' ? name : (groupKey.split(' > ')[1] || ''),
            section: level === 'section' ? name : '',
            source: absPath,
            filename: path.basename(absPath),
            detail_chunk_count: chunks.length,
            ...dnaFields,
          },
        });
        process.stderr.write(`  ${level} summary: ${name} (${chunks.length} chunks)\n`);
      }
    };

    // Pass 1: Section summaries (group by first 3 path levels, threshold 3+)
    const sectionGroups = {};
    for (const c of enrichedChunks) {
      const parts = (c.metadata.section_path || '').split(' > ');
      const groupKey = parts.slice(0, 3).join(' > ') || 'default';
      if (!sectionGroups[groupKey]) sectionGroups[groupKey] = [];
      sectionGroups[groupKey].push(c);
    }
    for (const [groupKey, chunks] of Object.entries(sectionGroups)) {
      // Relaxed: depth >= 2 (was >= 3) so chapters with only H1-level headings get summaries
      if (chunks.length >= 3 && groupKey.split(' > ').length >= 2) {
        await _addSummary(groupKey, chunks, 'section');
      }
    }

    // Pass 2: Chapter summaries (group by first 2 path levels, threshold 5+)
    const chapterGroups = {};
    for (const c of enrichedChunks) {
      const parts = (c.metadata.section_path || '').split(' > ');
      const groupKey = parts.length >= 2 ? `${parts[0]} > ${parts[1]}` : parts[0] || 'default';
      if (!chapterGroups[groupKey]) chapterGroups[groupKey] = [];
      chapterGroups[groupKey].push(c);
    }
    for (const [groupKey, chunks] of Object.entries(chapterGroups)) {
      if (chunks.length >= 5) {
        await _addSummary(groupKey, chunks, 'chapter');
      }
    }

    // 7. Store ─────────────────────────────────────────────────────────────────
    const ids = await this.store.addChunks(collection, enrichedChunks);

    // 7.1 Chunk linking: write prev/next IDs for continuous context expansion.
    //     Only link within same chapter (section_path first 2 parts match).
    if (ids.length > 1) {
      const linkPayloads = [];
      for (let i = 0; i < ids.length; i++) {
        const currChapter = (enrichedChunks[i]?.metadata?.chapter || '');
        const prevChapter = i > 0 ? (enrichedChunks[i - 1]?.metadata?.chapter || '') : '';
        const nextChapter = i < ids.length - 1 ? (enrichedChunks[i + 1]?.metadata?.chapter || '') : '';

        const payload = {};
        if (i > 0 && currChapter === prevChapter)            payload.prev_chunk_id = ids[i - 1];
        if (i < ids.length - 1 && currChapter === nextChapter) payload.next_chunk_id = ids[i + 1];

        if (Object.keys(payload).length > 0) {
          linkPayloads.push({ id: ids[i], payload });
        }
      }
      // Batch setPayload for all linked chunks
      for (const { id, payload } of linkPayloads) {
        try {
          await this.store._client.setPayload(collection, { payload, points: [id] });
        } catch (_) {}
      }
    }

    // 7.5 Store structural chunks (if any)
    let structuralIds = [];
    if (structuralChunks.length > 0) {
      // Add book_id + DNA to structural chunks too
      for (const sc of structuralChunks) {
        sc.metadata.book_id = bookId;
        Object.assign(sc.metadata, dnaFields);
      }
      structuralIds = await this.store.addChunks(collection, structuralChunks);
    }

    // 7.6 Store summary chunks (if any)
    let summaryIds = [];
    if (summaryChunks.length > 0) {
      summaryIds = await this.store.addChunks(collection, summaryChunks);
    }

    this.tracker.updateProgress(docId, ids.length);
    this.tracker.markComplete(docId);

    return {
      collection,
      chunks_stored: ids.length,
      structural_chunks: structuralIds.length,
      summary_chunks: summaryIds.length,
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
module.exports = { IngestPipeline, normalizeHeadings };
