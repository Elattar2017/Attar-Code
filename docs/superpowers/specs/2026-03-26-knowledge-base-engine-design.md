# Knowledge Base Engine — Design Specification (v2 — Reviewed & Fixed)

**Date:** 2026-03-27
**Goal:** Build a production-grade local knowledge base that dramatically improves the CLI's error-fixing and coding performance by giving the 30B model access to comprehensive, searchable technical documentation, books, and fix recipes.
**Hardware:** RTX 5090 (24GB VRAM) + 64GB RAM. Chat model uses ~16-20GB VRAM → ~4-8GB available for embedding models.

---

## 1. Problem Statement

The current KB system has:
- Word-based chunking (splits mid-sentence, mid-code-block)
- Generic embedding model (`all-MiniLM-L6-v2`, 384-dim, not code-aware)
- No preprocessing (raw text dumped into ChromaDB)
- Vector-only search (no keyword/BM25, no reranking)
- No metadata enrichment
- Single collection for everything
- No feedback loop integration

Result: The model can't find relevant documentation when it needs it. Fix rate stays at 35-45% because the model invents answers instead of looking them up.

**Target:** 60-70% reduction in retrieval failures (per Anthropic's Contextual Retrieval research), directly translating to higher fix rates.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    INGESTION PIPELINE                    │
│                                                         │
│  Input → Format Detect → Preprocess → Chunk → Enrich   │
│          → Dual Embed → Store in Qdrant                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   QDRANT STORAGE                        │
│                                                         │
│  fix_recipes │ nodejs │ python │ go │ rust │ java │ ... │
│                                                         │
│  Each chunk has:                                        │
│    code_vector (mxbai-embed-large 335M)                 │
│    text_vector (nomic-embed-text 137M)                  │
│    Sparse vector (BM25 weights, computed at ingestion)  │
│    Payload metadata (lang, framework, section, type)    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  RETRIEVAL PIPELINE                      │
│                                                         │
│  Query → Analyze → Route → Hybrid Search → Rerank      │
│       → Threshold Filter → Context Assembly → LLM      │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   FEEDBACK LOOP                         │
│                                                         │
│  Fix succeeds → Generate recipe summary (Ollama)        │
│       → Dual embed → Store in fix_recipes collection    │
│       → Next similar error → recipe found first         │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Ingestion Pipeline

### 3.1 Format Detection & Preprocessing

| Input Format | Preprocessor | Output | Key Library |
|-------------|-------------|--------|-------------|
| PDF (books, papers) | PyMuPDF → `pymupdf4llm` | Structured Markdown | `pymupdf4llm` Python |
| HTML (web docs) | Readability → Turndown | Clean Markdown | `@mozilla/readability` + `turndown` npm |
| Code files | tree-sitter AST | Function/class chunks | `tree-sitter` npm |
| Markdown | Pass-through | Already structured | — |
| Plain text | Paragraph detection | Grouped paragraphs | Regex |
| URL | Fetch → detect → route | Depends on content | `node-fetch` |

### 3.2 Chunking Strategy

| Content Type | Chunker | Size | Overlap |
|-------------|---------|------|---------|
| Markdown/books | MarkdownHeaderSplitter → RecursiveCharacterSplitter | 400-512 tokens | 10-20% |
| Code files | tree-sitter AST (function/class boundaries) | Natural (1 function = 1 chunk) | Import header shared |
| API references | Endpoint-level splitting | Variable | None |
| Plain text | Sentence-aware paragraph grouping | 400-512 tokens | 10% |

**Token counting:** Use `tiktoken` cl100k_base tokenizer for consistent chunk sizing across all content types (not character-based).

**Rules:**
1. Never split mid-sentence
2. Never split mid-code-block
3. Never split mid-table
4. Preserve heading hierarchy as `section_path` metadata
5. Code: never split mid-function

### 3.3 Contextual Enrichment (Ollama LLM)

**Two modes:**

**Fast mode (default for bulk ingestion):**
- Use rule-based context: prepend `section_path` as prefix
- Example: "Express.js Guide > Chapter 3 > Middleware > Error Handling: {chunk}"
- No LLM call — instant, free

**Deep mode (for high-value documents, user-triggered with `/kb add --deep`):**
- Call Ollama with full document context + chunk
- Generate 50-100 token situational context
- Prepend to chunk before embedding
- ~1-2s per chunk (chat model must be loaded, uses same GPU)

**GPU scheduling for deep mode:** Ollama handles model switching — when embedding calls come in, the chat model is temporarily unloaded. This means deep enrichment should happen as a BATCH JOB (not during active coding), triggered explicitly by the user.

### 3.4 Metadata Extraction

**Rule-based (always, no LLM needed):**
```json
{
  "source": "/path/to/file",
  "filename": "express-guide.pdf",
  "doc_title": "Express.js Guide",
  "section_path": "Chapter 3 > Middleware > Error Handling",
  "chunk_index": 42,
  "total_chunks": 285,
  "language": "javascript",
  "framework": "express",
  "content_type": "prose|code|mixed",
  "has_code_block": true,
  "indexed_at": "2026-03-27T00:00:00Z"
}
```

- `language` → from file extension or collection name
- `framework` → from filename/path pattern matching
- `has_code_block` → regex for ``` in content
- `content_type` → ratio of code vs prose

**LLM-based (deep mode only, batched):**
- `doc_type` → tutorial / api_reference / guide / cookbook
- `difficulty` → beginner / intermediate / advanced
- `keywords` → 5-10 relevant terms
- `framework_version` → extracted from doc content

### 3.5 Dual Embedding

**VRAM constraint: 24GB total, chat model uses 16-20GB. Embedding models must be <4GB.**

| Vector Name | Model | Params | Dimensions | Runs On | VRAM |
|-------------|-------|--------|-----------|---------|------|
| `code_vector` | `mxbai-embed-large` | 335M | 1024 | Ollama (GPU when available, CPU fallback) | ~700MB |
| `text_vector` | `nomic-embed-text` | 137M | 768 | Ollama (GPU when available, CPU fallback) | ~300MB |

**Why these models:**
- Both fit comfortably alongside the 30B chat model (total ~1GB vs 4-8GB available)
- `mxbai-embed-large`: top-5 on MTEB, strong on code + technical text, 1024-dim for high precision
- `nomic-embed-text`: optimized for long-form prose, 768-dim, extremely fast on CPU
- Both available via `ollama pull`

**Ollama embedding API (current version):**
```
POST http://localhost:11434/api/embed
{ "model": "mxbai-embed-large", "input": "chunk text here" }
→ { "embeddings": [[0.123, -0.456, ...]] }
```

**Batch embedding:** Send up to 10 chunks per request using `input` as array.

**Performance:** ~20-50ms per chunk on GPU, ~100-200ms on CPU. Both models fast enough for interactive queries.

### 3.6 Sparse Vector Generation (BM25 replacement)

Since Qdrant does NOT have native BM25 scoring, we compute BM25-equivalent sparse vectors at ingestion time:

```
For each chunk:
  1. Tokenize content (whitespace + punctuation split)
  2. Compute TF-IDF weights per token (corpus = all chunks in collection)
  3. Store as Qdrant sparse vector: { indices: [token_ids], values: [weights] }
```

**Library:** `wink-bm25-text-search` (npm) for BM25 weight computation, then store weights as Qdrant sparse vectors.

**At query time:** Same tokenization on query → sparse vector → Qdrant sparse vector search → returns ranked results with BM25-equivalent scoring.

### 3.7 Deduplication

During ingestion, before storing:
```
1. Compute content hash (SHA-256 of chunk text, ignoring whitespace)
2. Check if hash exists in collection
3. If >90% similar (cosine similarity of embeddings): skip chunk, log duplicate
4. If same source file re-ingested: delete old chunks first, then re-ingest
```

---

## 4. Storage (Qdrant)

### 4.1 Instance Management

```
Qdrant lifecycle managed by search-proxy:
  1. On search-proxy start: check if Qdrant is running (GET localhost:6333/healthz)
  2. If not running: spawn Qdrant binary as child process
     - Binary location: ~/.attar-code/bin/qdrant (auto-downloaded on first use)
     - Data storage: ~/.attar-code/qdrant_storage/
     - Port: 6333
     - Started with: detached=false (dies with search-proxy)
  3. Health check every 30s
  4. On search-proxy stop: Qdrant child process killed

Auto-download on first use:
  - Detect OS (Windows/macOS/Linux) + architecture (x86_64/arm64)
  - Download from Qdrant GitHub releases
  - Extract to ~/.attar-code/bin/
  - Mark executable (chmod +x on Unix)
```

### 4.2 Collections

| Collection | Content | Expected Chunks |
|-----------|---------|----------------|
| `fix_recipes` | Fix recipes from feedback loop | 100-10,000 |
| `nodejs` | Express, React, Next.js, Node core | 50,000-200,000 |
| `python` | Django, Flask, FastAPI, stdlib | 50,000-200,000 |
| `go` | Go stdlib, Gin, Echo | 20,000-50,000 |
| `rust` | Rust book, std, Tokio, Actix | 20,000-50,000 |
| `java` | Spring, Kotlin, JVM | 20,000-50,000 |
| `csharp` | ASP.NET, .NET Core | 20,000-50,000 |
| `php` | Laravel, PHP core | 10,000-30,000 |
| `ruby` | Rails, Ruby stdlib | 10,000-30,000 |
| `swift` | SwiftUI, iOS | 10,000-30,000 |
| `css_html` | Tailwind, CSS, HTML | 10,000-30,000 |
| `devops` | Docker, K8s, Git, CI/CD | 10,000-30,000 |
| `databases` | SQL, MongoDB, Redis | 10,000-30,000 |
| `general` | Patterns, algorithms, architecture | 20,000-50,000 |
| `personal` | User notes, project docs | Variable |

### 4.3 Collection Schema

```
Named Vectors:
  code_vector: size=1024, distance=Cosine (mxbai-embed-large)
  text_vector: size=768, distance=Cosine (nomic-embed-text)

Sparse Vectors:
  bm25: computed TF-IDF weights per token

Payload Indexes:
  language: keyword
  framework: keyword
  doc_type: keyword
  content_type: keyword
  section_path: text (for Qdrant text matching)
  source: keyword

Quantization: scalar (int8) — 4x memory reduction, <1% accuracy loss

Metadata per collection:
  embedding_model_versions: { code: "mxbai-embed-large:v1", text: "nomic-embed-text:v1.5" }
  → On startup, compare with current model versions
  → If mismatch: warn user, offer /kb rebuild
```

### 4.4 Fix Recipes Collection (additional fields)

```
Additional payload:
  error_code: keyword
  strategy: keyword
  fix_diff: text
  fix_file: keyword
  success_count: integer
  last_used: datetime
  trigger: text
  error_message: text
```

---

## 5. Retrieval Pipeline

### 5.1 Query Analysis

```javascript
function analyzeQuery(query, context) {
  const tech = detectTechCollection(context);

  if (/error|TypeError|Cannot find|undefined|null|FAIL|crash|500/i.test(query)) {
    return { type: "error", collections: ["fix_recipes", tech], preferVector: "code_vector" };
  }
  if (/how to|how do|explain|what is|why does/i.test(query)) {
    return { type: "conceptual", collections: [tech, "general"], preferVector: "text_vector" };
  }
  if (/import|require|syntax|API|method|function|class/i.test(query)) {
    return { type: "api", collections: [tech], preferVector: "code_vector" };
  }
  return { type: "general", collections: [tech, "general"], preferVector: "text_vector" };
}

function detectTechCollection(context) {
  // Priority 1: SESSION._lastDetectedTech (from build_and_test / edit_file)
  // Priority 2: package.json / requirements.txt in SESSION.cwd
  // Priority 3: keywords in query
  // Fallback: "general"
  // Can return MULTIPLE collections for multi-tech projects
}
```

### 5.2 Query Expansion (adaptive — only when needed)

```
Initial search returns <3 results with score >0.6?
  → YES: trigger query expansion
  → NO: use initial results (fast path)

Expansion: Ollama generates 3 reformulations
  → Search all 3 in parallel
  → Merge results
```

### 5.3 Hybrid Search

For each query, execute in parallel:

```
Sparse Vector Search (BM25-equivalent):
  → Exact matches: "req.user", "TS2304", "useState"
  → Returns: top 20 by sparse vector score

Dense Vector Search (semantic):
  → Route to code_vector or text_vector based on query type
  → Returns: top 20 by cosine similarity

Reciprocal Rank Fusion (configurable k):
  → RRF(d) = SUM(1 / (k + rank_sparse(d))) + SUM(1 / (k + rank_dense(d)))
  → Default k=60 (configurable via config.json: kb.rrfK)
  → Merge into single ranked list: top 20
```

### 5.4 Reranking

**Integration: persistent Python sidecar managed by search-proxy (not cold-start per query).**

```
search-proxy starts → spawns reranker sidecar:
  python reranker_server.py --port 6334 --model ms-marco-MiniLM-L6-v2

reranker_server.py:
  FastAPI app
  Loads model once on startup (warm, stays in memory)
  POST /rerank { query, documents[] } → { scores[] }
  Uses CPU (80MB model, <100ms per batch of 20)

Degradation: if reranker sidecar fails to start → skip reranking, return un-reranked results
```

Top 20 → reranked → top 5 returned.

### 5.5 Score Threshold & Filtering

```
Minimum score: 0.5 (after reranking)
If no chunks pass → return "No relevant documentation found"
Never return irrelevant chunks

Deduplication: if two chunks from same document are >80% similar → keep only higher-scored one
```

### 5.6 Context Assembly

```
For each top chunk:
  1. Fetch adjacent chunks from same document (previous + next)
  2. Merge overlapping content
  3. Format:
     [Source: Express.js Guide > Chapter 3 > Middleware]
     [Score: 0.92 | Type: tutorial]

     {contextual_prefix}
     {chunk_content}
```

---

## 6. Feedback Loop Integration

### 6.1 Fix Recipe Storage

When fix succeeds:
```
1. Extract: error_message, error_code, fix_file, fix_diff, language, framework

2. Generate searchable summary (Ollama, async, non-blocking):
   "Express.js TypeError: Cannot read properties of null in auth middleware.
    Fixed by adding null guard in src/middleware/auth.js"

3. Dual embed the summary (mxbai + nomic)

4. Store in fix_recipes collection:
   - Check if similar recipe exists (cosine >0.9): update success_count
   - Otherwise: create new recipe

5. Promotion: if success_count >= 5 → mark as "proven" in metadata
```

### 6.2 Recipe Retrieval Priority

```
Error occurs → query fix_recipes FIRST (score > 0.7)
  Found? → return recipe with actual diff
  Not found? → fall through to general KB
```

---

## 7. CLI Integration

### 7.1 Commands

```
/kb status                Show collections, chunks, models, storage size
/kb add <file>            Ingest file (auto-detect format + collection)
/kb add <url>             Fetch URL and ingest
/kb add --deep <file>     Ingest with LLM contextual enrichment
/kb add-dir <path>        Bulk ingest directory
/kb add-docs <name>       Download + ingest official docs (pre-processed packages preferred)
/kb search <query>        Manual search with formatted results
/kb collections           List all collections with sizes
/kb rebuild <name>        Re-process and re-index a collection
/kb remove <name>         Remove a collection
/kb stats                 Retrieval metrics: avg latency, hit rate, query count
/proxy                    Status/start/stop for search-proxy + Qdrant + reranker
```

### 7.2 Model Tool

```javascript
{
  name: "kb_search",
  parameters: {
    query: { type: "string" },
    language: { type: "string", description: "Filter by language (optional)" },
    doc_type: { type: "string", enum: ["api","tutorial","reference","fix","all"] },
    collection: { type: "string", description: "Override auto-routing (optional)" },
    search_type: { type: "string", enum: ["code","conceptual","auto"], default: "auto" },
    include_recipes: { type: "boolean", default: true },
    num: { type: "number", default: 5 }
  }
}
```

### 7.3 Auto-Behaviors

```
On CLI startup:
  → Start search-proxy (manages Qdrant + reranker + embedding)
  → Verify KB health
  → Check embedding model version matches collection metadata

On build_and_test error:
  → Auto-search fix_recipes + tech collection
  → Inject top result into error output

On test_endpoint error:
  → Auto-search fix_recipes

On fix success:
  → Auto-store recipe in fix_recipes

On write_file (new project):
  → Auto-detect technology
  → If collection empty: suggest "/kb add-docs <framework>"
```

---

## 8. search-proxy.js Rewrite

```
search-proxy.js manages:
  ├── Qdrant (spawn binary, health check, port 6333)
  ├── Reranker sidecar (spawn Python FastAPI, port 6334)
  ├── Ollama embedding calls (dual model, via localhost:11434)
  ├── Ingestion pipeline (preprocess → chunk → enrich → embed → store)
  ├── Retrieval pipeline (analyze → route → hybrid → rerank → filter)
  ├── Fix recipe management
  ├── Web search (DuckDuckGo — existing)
  └── REST API

Endpoints:
  POST /kb/ingest          Full ingestion pipeline
  POST /kb/ingest-url      Fetch URL + ingest
  POST /kb/ingest-dir      Bulk ingest directory
  POST /kb/search          Hybrid search + reranking
  GET  /kb/collections     List all collections
  POST /kb/recipe/store    Store fix recipe
  POST /kb/recipe/search   Search fix recipes
  GET  /kb/status          Full system status
  POST /search             Web search (existing)
  POST /fetch              URL fetch (existing)
```

---

## 9. Dependencies

| Dependency | Type | Purpose | Size | Install |
|-----------|------|---------|------|---------|
| **Qdrant** | Binary | Vector DB | ~50MB | Auto-downloaded to ~/.attar-code/bin/ |
| **mxbai-embed-large** | Ollama model | Code embedding | ~700MB | `ollama pull mxbai-embed-large` |
| **nomic-embed-text** | Ollama model | Text embedding | ~300MB | `ollama pull nomic-embed-text` |
| **tree-sitter** | npm | AST code parsing | ~5MB | `npm install tree-sitter` |
| **pymupdf4llm** | Python | PDF → Markdown | ~20MB | `pip install pymupdf4llm` |
| **@mozilla/readability** | npm | HTML extraction | ~100KB | `npm install @mozilla/readability` |
| **turndown** | npm | HTML → Markdown | ~50KB | `npm install turndown` |
| **ms-marco-MiniLM-L6-v2** | Python model | Reranker | ~80MB | `pip install sentence-transformers` |
| **wink-bm25-text-search** | npm | BM25 sparse vectors | ~50KB | `npm install wink-bm25-text-search` |
| **@qdrant/js-client-rest** | npm | Qdrant client | ~200KB | `npm install @qdrant/js-client-rest` |

---

## 10. Degradation Strategy

| Component Missing | Fallback Behavior |
|------------------|-------------------|
| Qdrant binary not installed | Auto-download on first use. If download fails: fall back to ChromaDB (existing) |
| Qdrant fails to start | Search-proxy logs warning, KB search returns "KB unavailable". CLI continues without KB |
| mxbai-embed-large not pulled | Use nomic-embed-text for both vectors (single-vector mode). Prompt user to pull model |
| nomic-embed-text not pulled | Use mxbai-embed-large for both vectors. Prompt user to pull model |
| Both embedding models missing | Skip KB features entirely. Log warning on startup |
| Reranker sidecar fails | Return un-reranked results (slightly lower accuracy, still functional) |
| Ollama down during enrichment | Store chunks WITHOUT contextual prefix (rule-based section_path only) |
| Python not installed | Skip PDF ingestion + reranker. Log: "Install Python 3 for PDF support and reranking" |
| tree-sitter not installed | Fall back to RecursiveCharacterSplitter for code files (word-based, worse quality) |

**Principle:** Every component degrades gracefully. The CLI always works. KB features enhance but never block.

---

## 11. Performance Estimates

| Operation | Time | Hardware |
|----------|------|---------|
| Ingest 1 PDF book (500 pages, ~2000 chunks, fast mode) | ~5 min | CPU preprocessing + GPU embedding |
| Ingest 1 PDF book (deep mode with LLM enrichment) | ~30-60 min | Chat model must swap with embedding model |
| Embed 1 chunk (dual vector) | ~50-200ms | GPU (fast) or CPU (slower) |
| Compute BM25 sparse vector | ~1ms | CPU |
| Search query (hybrid + rerank) | <1 second | Qdrant + CPU reranker |
| Search query (with query expansion) | ~2-3 seconds | + Ollama for reformulations |
| Fix recipe lookup | <500ms | Qdrant direct search |
| Total KB storage (1M chunks, quantized) | ~4-6GB | Qdrant with scalar quantization |

---

## 12. Migration Plan

### Phase 1: Install New Dependencies (no disruption)
- Download Qdrant binary
- Pull embedding models via Ollama
- Install npm/Python packages
- **Verify:** Qdrant starts, models respond to embed requests

### Phase 2: Rewrite search-proxy.js
- New architecture with Qdrant + reranker management
- Keep ALL existing endpoints working (backward compatible)
- Add new endpoints alongside
- **Verify:** Old `kb_search` still works, new `/kb/search` also works

### Phase 3: Migrate ChromaDB → Qdrant
- Read all chunks from ChromaDB via chroma_bridge.py
- Re-embed with new dual models
- Store in Qdrant collections
- **Verify:** Run 10 test queries against both old and new. Compare result quality. Count chunks: old vs new must match.
- **Rollback:** If new results worse, keep ChromaDB endpoints active

### Phase 4: Migrate fix-outcomes.jsonl → fix_recipes collection
- Read JSONL, filter entries with fixDiff
- Generate summaries, embed, store in fix_recipes
- **Verify:** Count recipes: JSONL entries with diffs vs Qdrant points
- **Rollback:** JSONL file preserved as backup

### Phase 5: Update attar-code.js
- Point KB tools to new endpoints
- Add auto-search on errors
- Add new slash commands
- **Verify:** Full CLI test: build project, trigger error, verify KB result appears

### Phase 6: Deprecate old system
- Remove chroma_bridge.py
- Remove ChromaDB dependency
- Clean up old search-proxy code
- **Verify:** All 192 smart-fix tests still pass

### Ingestion Progress Tracking
```
Per document, store in ~/.attar-code/kb-ingestion-state.json:
{
  "express-guide.pdf": {
    "total_chunks": 2000,
    "processed_chunks": 1500,
    "status": "in_progress",
    "collection": "nodejs",
    "started_at": "2026-03-27T00:00:00Z"
  }
}
On resume: skip chunks 0-1499, continue from 1500
```

---

## 13. Pre-Built Documentation Packages

To avoid every user spending hours ingesting common docs:

```
/kb add-docs express    → downloads pre-built package from attar-code releases
                        → contains: pre-chunked, pre-enriched, pre-embedded Qdrant snapshot
                        → user just restores the snapshot: instant KB for Express.js

Package format:
  express-docs-v4.21-qdrant.tar.gz
    ├── collection.json (Qdrant collection config)
    ├── vectors/ (pre-computed embeddings)
    └── metadata.json (model versions, chunk count, date)
```

Model version check: if user's embedding model differs from package's, re-embed (but skip preprocessing + enrichment — already done).

---

## 14. Concurrency & Locking

```
All writes go through search-proxy (single writer):
  → Ingestion jobs use batched upserts (100 chunks per batch)
  → Ingestion lock: only 1 ingestion job per collection at a time
  → Concurrent reads always allowed (Qdrant handles this)

Multiple CLI sessions:
  → All share same search-proxy instance
  → search-proxy detects if already running (port check)
  → Reads: concurrent, no conflict
  → Writes (fix recipes): atomic via Qdrant upsert, no lock needed
```

---

## 15. Security Notes

```
Data at rest:
  → Qdrant storage is NOT encrypted (local-only tool)
  → Warning on /kb add if file contains patterns matching:
    API keys, tokens, passwords, private keys
  → User can /kb remove <collection> to delete sensitive data

Data in transit:
  → All communication is localhost (no network exposure)
  → Qdrant binds to 127.0.0.1 only (not 0.0.0.0)
```
