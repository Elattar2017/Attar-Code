# KB Engine Plan 2: Ingestion Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the document preprocessing and chunking pipeline that converts PDFs, HTML, Markdown, code files, and plain text into enriched, embedded chunks stored in Qdrant via the kb-engine foundation (Plan 1).

**Architecture:** A new `kb-engine/ingestion/` module with format-specific preprocessors, a structure-aware chunker, optional LLM enrichment via Ollama, and metadata extraction. The pipeline feeds into `ChunkStore.addChunks()` from Plan 1.

**Tech Stack:** pymupdf4llm (Python, PDF→Markdown), tree-sitter (npm, code AST), @mozilla/readability + turndown (npm, HTML→Markdown), tiktoken (token counting)

**Depends on:** Plan 1 (kb-engine/store.js, kb-engine/embedder.js)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `kb-engine/ingestion/index.js` | CREATE | Main IngestPipeline class — orchestrates format detect → preprocess → chunk → enrich → store |
| `kb-engine/ingestion/format-detector.js` | CREATE | Detect file type from extension + content sniffing |
| `kb-engine/ingestion/preprocessors/pdf.js` | CREATE | PDF → Markdown via pymupdf4llm Python bridge |
| `kb-engine/ingestion/preprocessors/html.js` | CREATE | HTML → clean Markdown via readability + turndown |
| `kb-engine/ingestion/preprocessors/code.js` | CREATE | Code → AST-based function/class chunks via tree-sitter |
| `kb-engine/ingestion/preprocessors/markdown.js` | CREATE | Markdown pass-through with structure extraction |
| `kb-engine/ingestion/preprocessors/text.js` | CREATE | Plain text paragraph detection |
| `kb-engine/ingestion/chunker.js` | CREATE | Structure-aware chunking: markdown header splitting + recursive char splitting |
| `kb-engine/ingestion/metadata.js` | CREATE | Rule-based metadata extraction (language, framework, doc_type, section_path) |
| `kb-engine/ingestion/enrichment.js` | CREATE | Optional Ollama LLM contextual enrichment per chunk |
| `kb-engine/ingestion/progress.js` | CREATE | Ingestion state tracking + resumability |
| `kb-engine/ingestion/collection-router.js` | CREATE | Auto-detect which collection a document belongs to |
| `kb-engine/tests/ingestion.test.js` | CREATE | Unit tests for format detection, chunking, metadata |
| `kb-engine/tests/preprocessors.test.js` | CREATE | Tests for each preprocessor |
| `kb-engine/tests/ingestion-integration.test.js` | CREATE | End-to-end: file → chunks in Qdrant |
| `package.json` | MODIFY | Add turndown, @mozilla/readability |

---

## Task 1: Format Detector + Collection Router

**Files:**
- Create: `kb-engine/ingestion/format-detector.js`
- Create: `kb-engine/ingestion/collection-router.js`

The format detector identifies file type. The collection router determines which Qdrant collection a document belongs to.

- [ ] **Step 1: Create ingestion directory**

Run: `mkdir -p kb-engine/ingestion/preprocessors`

- [ ] **Step 2: Implement format-detector.js**

Detect by extension: .pdf→pdf, .html/.htm→html, .md→markdown, .txt/.rst→text, code extensions→code. Also detect by content: starts with `<!DOCTYPE` or `<html`→html, starts with `#`→markdown. Returns: `{ format: "pdf"|"html"|"markdown"|"code"|"text", language: "javascript"|"python"|null }`.

- [ ] **Step 3: Implement collection-router.js**

Route documents to collections based on: file path keywords (express, react, django, flask, etc.), detected language, explicit user override. Returns collection name (e.g., "nodejs", "python", "general").

- [ ] **Step 4: Write tests and verify**

Run: `npx jest kb-engine/tests/ingestion.test.js --no-coverage -t "format|router"`

---

## Task 2: Markdown Chunker (Core)

**Files:**
- Create: `kb-engine/ingestion/chunker.js`

The heart of the ingestion pipeline. Splits Markdown-formatted content into chunks respecting document structure.

- [ ] **Step 1: Implement chunker.js with two strategies**

**Strategy 1: MarkdownHeaderSplitter** — split on # headings, preserve section hierarchy as `section_path` metadata. Each heading section becomes a candidate chunk.

**Strategy 2: RecursiveCharacterSplitter** — for sections that exceed MAX_CHUNK_TOKENS. Split at: paragraph breaks (`\n\n`) → sentence breaks (`. `) → word breaks (` `). Never split mid-code-block (``` fences) or mid-table (| rows).

**Combined flow:**
```
Markdown → split by headers → for each section:
  if section <= MAX_CHUNK_TOKENS → one chunk
  else → recursive split within section
→ Each chunk carries section_path from heading hierarchy
```

Token counting: use simple word-count approximation (1 token ≈ 0.75 words) to avoid tiktoken dependency. Can be upgraded later.

- [ ] **Step 2: Write tests**

Tests: splits on H1/H2/H3, preserves section_path, respects code blocks, handles no-heading text, chunk size within bounds, overlap works.

- [ ] **Step 3: Run tests**

Run: `npx jest kb-engine/tests/ingestion.test.js --no-coverage -t "chunker"`

---

## Task 3: Markdown & Text Preprocessors

**Files:**
- Create: `kb-engine/ingestion/preprocessors/markdown.js`
- Create: `kb-engine/ingestion/preprocessors/text.js`

- [ ] **Step 1: Implement markdown.js**

Pass-through preprocessor: reads file, extracts title from first `# heading`, returns `{ content, title, format: "markdown" }`. No transformation needed — Markdown is already the target format.

- [ ] **Step 2: Implement text.js**

Converts plain text to Markdown-like format: detect paragraphs (double newline), detect likely headings (ALL CAPS lines, lines ending with colon), wrap in basic structure. Returns `{ content, title, format: "text" }`.

- [ ] **Step 3: Write tests and verify**

---

## Task 4: HTML Preprocessor

**Files:**
- Create: `kb-engine/ingestion/preprocessors/html.js`

- [ ] **Step 1: Install dependencies**

Run: `npm install @mozilla/readability turndown jsdom`

- [ ] **Step 2: Implement html.js**

Pipeline: HTML string → JSDOM parse → Readability extract main content → Turndown convert to Markdown → clean up (remove empty lines, fix code blocks). Handle: `<pre><code>` → ``` fenced blocks, `<table>` → Markdown tables, `<a>` → [text](url).

- [ ] **Step 3: Write tests**

Test with sample HTML containing navigation, main content, code blocks. Verify nav stripped, code preserved, headings converted.

- [ ] **Step 4: Run tests**

---

## Task 5: PDF Preprocessor

**Files:**
- Create: `kb-engine/ingestion/preprocessors/pdf.js`

- [ ] **Step 1: Implement pdf.js**

Uses Python `pymupdf4llm` bridge: spawn Python process with `pymupdf4llm.to_markdown(filepath)`. Falls back to basic `pdf-parse` npm if Python unavailable.

Python bridge script (inline, written to temp file):
```python
import sys, json
try:
    import pymupdf4llm
    md = pymupdf4llm.to_markdown(sys.argv[1])
    print(json.dumps({"content": md, "format": "pdf"}))
except ImportError:
    # Fallback: basic text extraction
    import fitz
    doc = fitz.open(sys.argv[1])
    text = "\n\n".join(page.get_text() for page in doc)
    print(json.dumps({"content": text, "format": "pdf"}))
```

Graceful degradation: if Python not installed → try `pdf-parse` npm → if that fails → return error with install instructions.

- [ ] **Step 2: Write tests** (skip if Python not available)

- [ ] **Step 3: Run tests**

---

## Task 6: Code Preprocessor (tree-sitter)

**Files:**
- Create: `kb-engine/ingestion/preprocessors/code.js`

- [ ] **Step 1: Implement code.js**

For code files, extract functions/classes as individual chunks rather than splitting by character count.

**With tree-sitter (if installed):** Parse AST → extract function_declaration, class_declaration, method_definition nodes → each becomes a chunk with function name in metadata.

**Without tree-sitter (fallback):** Use regex-based splitting:
- JavaScript/TypeScript: split on `function `, `class `, `const X = (`
- Python: split on `def `, `class `
- Go: split on `func `
- Rust: split on `fn `, `impl `
- Java/C#: split on method signatures
- Generic: split on blank-line-separated blocks

Each code chunk prepended with file-level imports as context header.

- [ ] **Step 2: Write tests with sample code files**

- [ ] **Step 3: Run tests**

---

## Task 7: Metadata Extractor

**Files:**
- Create: `kb-engine/ingestion/metadata.js`

- [ ] **Step 1: Implement metadata.js**

Rule-based extraction (no LLM needed):
```javascript
extractMetadata(content, filePath, options) → {
  language,        // from extension or content detection
  framework,       // from filename/path patterns (express, react, django, etc.)
  doc_type,        // "tutorial"|"api"|"reference"|"guide" from content heuristics
  content_type,    // "code"|"prose"|"mixed" from code block ratio
  has_code_block,  // boolean
  section_path,    // from chunker (passed through)
  keywords,        // top 5-10 terms by TF frequency
}
```

Framework detection patterns: "express" in path → express, "react" → react, "django" → django, etc. 30+ framework patterns.

doc_type heuristics: has `API`, `Reference`, `method`, `returns` → api. Has `tutorial`, `getting started`, `how to` → tutorial. Has `guide`, `overview` → guide.

- [ ] **Step 2: Write tests**

- [ ] **Step 3: Run tests**

---

## Task 8: LLM Enrichment (Optional)

**Files:**
- Create: `kb-engine/ingestion/enrichment.js`

- [ ] **Step 1: Implement enrichment.js**

Optional: generates contextual prefix for each chunk using Ollama.

```javascript
async enrichChunk(chunk, docTitle, sectionPath) {
  const prompt = `<document_title>${docTitle}</document_title>
<section_path>${sectionPath}</section_path>
<chunk>${chunk.content.slice(0, 500)}</chunk>
Give a short context (50-100 words) to situate this chunk. Answer only with the context.`;

  const response = await callOllama(prompt);
  return response.trim() + "\n\n" + chunk.content;
}
```

Batch processing with progress. Configurable: `--deep` flag enables it, default is off (fast mode uses section_path as prefix).

- [ ] **Step 2: Write tests** (mock Ollama for unit tests)

- [ ] **Step 3: Run tests**

---

## Task 9: Ingestion Progress Tracker

**Files:**
- Create: `kb-engine/ingestion/progress.js`

- [ ] **Step 1: Implement progress.js**

Tracks ingestion state for resumability:
```javascript
class IngestionTracker {
  getState(docId)        // → { total_chunks, processed, status, collection }
  updateState(docId, processed)
  markComplete(docId)
  getIncomplete()        // → list of interrupted ingestions
  reset(docId)
}
```

Stores in `~/.attar-code/kb-ingestion-state.json`. On resume: skip already-processed chunks.

- [ ] **Step 2: Write tests**

- [ ] **Step 3: Run tests**

---

## Task 10: Main IngestPipeline Orchestrator

**Files:**
- Create: `kb-engine/ingestion/index.js`

- [ ] **Step 1: Implement IngestPipeline**

Orchestrates the full pipeline:
```javascript
class IngestPipeline {
  async ingestFile(filePath, options) {
    // 1. Detect format
    // 2. Route to collection
    // 3. Preprocess (PDF→MD, HTML→MD, code→chunks, etc.)
    // 4. Chunk (markdown header split + recursive)
    // 5. Extract metadata per chunk
    // 6. Optional: LLM enrichment (if --deep)
    // 7. Store via ChunkStore.addChunks()
    // 8. Track progress
    // Returns: { collection, chunks_stored, duration }
  }

  async ingestDirectory(dirPath, options) {
    // Recursively find all supported files
    // Ingest each, track progress
  }

  async ingestUrl(url, options) {
    // Fetch URL → detect format → ingest
  }
}
```

- [ ] **Step 2: Write integration test**

Test: ingest a sample Markdown file → verify chunks appear in Qdrant with correct metadata.

- [ ] **Step 3: Run ALL tests**

Run: `npx jest kb-engine/tests/ --no-coverage --testTimeout=30000`

---

## Summary

| Task | Component | Files |
|------|----------|-------|
| 1 | Format Detector + Collection Router | 2 |
| 2 | Markdown Chunker | 1 |
| 3 | Markdown & Text Preprocessors | 2 |
| 4 | HTML Preprocessor | 1 |
| 5 | PDF Preprocessor | 1 |
| 6 | Code Preprocessor | 1 |
| 7 | Metadata Extractor | 1 |
| 8 | LLM Enrichment | 1 |
| 9 | Progress Tracker | 1 |
| 10 | IngestPipeline Orchestrator | 1 + tests |

**Total: ~15 new files, 10 tasks**
**Dependencies: turndown, @mozilla/readability, jsdom, pymupdf4llm (Python, optional)**
