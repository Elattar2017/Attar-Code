# KB Engine Plan 1: Qdrant Foundation + Dual Embedding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ChromaDB with Qdrant and dual embedding models (mxbai-embed-large + nomic-embed-text), providing the storage foundation for the entire KB engine.

**Architecture:** A new `kb-engine/` module handles Qdrant operations, embedding, and collection management. search-proxy.js will be updated in Plan 4 to use this module. Qdrant binary is auto-downloaded and managed. Dual embeddings via Ollama API.

**Tech Stack:** Qdrant (binary), Ollama embedding API, @qdrant/js-client-rest (npm), wink-bm25-text-search (npm), Node.js

**Spec:** `docs/superpowers/specs/2026-03-26-knowledge-base-engine-design.md`

**This is Plan 1 of 5:**
- Plan 1: Qdrant Foundation + Dual Embedding (this plan)
- Plan 2: Ingestion Pipeline (preprocessing + chunking + enrichment)
- Plan 3: Retrieval Pipeline (hybrid search + reranking + context assembly)
- Plan 4: CLI Integration + Feedback Loop Migration
- Plan 5: Pre-built Documentation Packages

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `kb-engine/config.js` | CREATE | Constants: ports, models, dimensions, paths, thresholds |
| `kb-engine/qdrant-manager.js` | CREATE | Qdrant binary download, spawn, health check, lifecycle |
| `kb-engine/embedder.js` | CREATE | Dual Ollama embedding with graceful fallback |
| `kb-engine/sparse-vectors.js` | CREATE | BM25 sparse vector computation |
| `kb-engine/collections.js` | CREATE | Collection CRUD, schema, model versioning |
| `kb-engine/store.js` | CREATE | Chunk add, search (dense + hybrid), delete |
| `kb-engine/index.js` | CREATE | Main exports: KBEngine class |
| `kb-engine/tests/embedder.test.js` | CREATE | Dual embedding tests |
| `kb-engine/tests/sparse-vectors.test.js` | CREATE | BM25 computation tests |
| `kb-engine/tests/collections.test.js` | CREATE | Collection management tests |
| `kb-engine/tests/store.test.js` | CREATE | Storage + search tests |
| `kb-engine/tests/integration.test.js` | CREATE | End-to-end pipeline test |
| `package.json` | MODIFY | Add dependencies |

---

## Task 1: Install Dependencies + Create Config

**Files:**
- Create: `kb-engine/config.js`
- Modify: `package.json`

- [ ] **Step 1: Install npm dependencies**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npm install @qdrant/js-client-rest wink-bm25-text-search`

- [ ] **Step 2: Pull Ollama embedding models**

Run: `ollama pull mxbai-embed-large && ollama pull nomic-embed-text`

- [ ] **Step 3: Create kb-engine/config.js**

Create the config file with all constants: Qdrant URLs/ports, download URLs per platform, Ollama model names/dimensions, collection names, search thresholds, paths. See spec Section 4.1 for Qdrant config, Section 3.5 for embedding config. All platform download URLs for win32/darwin/linux x64/arm64.

- [ ] **Step 4: Verify config loads**

Run: `node -e "const c = require('./kb-engine/config'); console.log('OK:', c.COLLECTIONS.length, 'collections')"`
Expected: `OK: 15 collections`

---

## Task 2: Dual Embedder

**Files:**
- Create: `kb-engine/embedder.js`
- Create: `kb-engine/tests/embedder.test.js`

- [ ] **Step 1: Write tests**

Tests for: `embedCode` returns 1024-dim vector, `embedText` returns 768-dim vector, `embedDual` returns both, `embedBatch` processes multiple chunks, `getAvailableModels` detects pulled models, fallback when one model missing.

- [ ] **Step 2: Run tests — verify fail**

Run: `npx jest kb-engine/tests/embedder.test.js --no-coverage`

- [ ] **Step 3: Implement DualEmbedder**

Uses Ollama `POST /api/embed { model, input }` API. Supports batch embedding (array input). Graceful fallback: if code model missing → use text model for both. If text model missing → use code model. If both missing → throw with install instructions. Caches model availability check.

- [ ] **Step 4: Run tests — verify pass**

Run: `npx jest kb-engine/tests/embedder.test.js --no-coverage`

---

## Task 3: BM25 Sparse Vectors

**Files:**
- Create: `kb-engine/sparse-vectors.js`
- Create: `kb-engine/tests/sparse-vectors.test.js`

- [ ] **Step 1: Write tests**

Tests for: `computeSparseVector` returns {indices, values}, keyword matching works, `getVocabularySize` returns token count, empty input handled.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement SparseVectorizer**

BM25 implementation: tokenize (lowercase, split on non-alphanumeric), compute TF-IDF per token, store as {indices, values} compatible with Qdrant sparse vectors. Parameters: k1=1.2, b=0.75 (standard BM25).

- [ ] **Step 4: Run tests — verify pass**

---

## Task 4: Collection Manager

**Files:**
- Create: `kb-engine/collections.js`
- Create: `kb-engine/tests/collections.test.js`

- [ ] **Step 1: Write tests**

Tests for: create collection with dual vectors + sparse, list collections, get info, delete. Tests skip if Qdrant not running.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement CollectionManager**

Uses `@qdrant/js-client-rest`. Creates collections with: code_vector (1024, Cosine), text_vector (768, Cosine), bm25 (sparse), scalar quantization (int8). Creates payload indexes for language, framework, doc_type, source. `ensureAllCollections()` creates all 15 default collections.

- [ ] **Step 4: Run tests — verify pass** (requires Qdrant running)

---

## Task 5: Chunk Store

**Files:**
- Create: `kb-engine/store.js`
- Create: `kb-engine/tests/store.test.js`

- [ ] **Step 1: Write tests**

Tests for: `addChunks` stores and returns IDs, `search` (dense) finds relevant chunks, `hybridSearch` (dense + sparse + RRF) works, `getChunkCount` returns count, filtered search by language works.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement ChunkStore**

`addChunks(collection, chunks[])`: dual embed + sparse vectorize + batch upsert. `search(collection, query, opts)`: single-vector dense search with optional payload filters. `hybridSearch(collection, query, opts)`: parallel dense + sparse search, Reciprocal Rank Fusion (k=60 configurable), returns merged ranked results. Uses crypto.randomUUID for point IDs.

- [ ] **Step 4: Run tests — verify pass** (requires Qdrant + Ollama)

---

## Task 6: Qdrant Manager

**Files:**
- Create: `kb-engine/qdrant-manager.js`
- Create: `kb-engine/tests/qdrant-manager.test.js`

Note: This is the most platform-sensitive task. Uses child_process.spawn (not exec) for security.

- [ ] **Step 1: Write tests**

Tests for: `getDownloadUrl` returns correct URL per platform, `getBinaryPath` correct for OS, `isRunning` returns false on unused port, `getStatus` returns not_running. Integration tests (start/stop) marked as optional.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement QdrantManager**

`download()`: detect OS+arch → download from GitHub releases → extract (PowerShell on Windows, tar on Unix) → chmod +x on Unix. `start()`: check if running → if not, check binary → spawn with --storage-path and env vars for port/host → wait up to 15s for health. `stop()`: taskkill on Windows, SIGTERM→SIGKILL on Unix. `isRunning()`: fetch /healthz. All child processes use spawn (not exec) with no shell for security.

- [ ] **Step 4: Run tests — verify pass**

---

## Task 7: KB Engine Index + Integration Test

**Files:**
- Create: `kb-engine/index.js`
- Create: `kb-engine/tests/integration.test.js`

- [ ] **Step 1: Create index.js**

Exports: KBEngine (orchestrator class with start/stop/getStatus), QdrantManager, DualEmbedder, SparseVectorizer, CollectionManager, ChunkStore, config.

- [ ] **Step 2: Write integration test**

End-to-end test: embed 3 chunks (JS Express, JS auth code, Python Django) → store in test collection → dense search finds Express → hybrid search finds auth code → filtered search returns only Python → cleanup.

- [ ] **Step 3: Run integration test**

Run: `npx jest kb-engine/tests/integration.test.js --no-coverage --testTimeout=30000`

- [ ] **Step 4: Run ALL tests (no regressions)**

Run: `npx jest kb-engine/tests/ --no-coverage --testTimeout=30000 && npx jest smart-fix/tests/ --no-coverage`
Expected: All kb-engine tests pass + 192 smart-fix tests pass

---

## Summary

| Task | Component | Files | Key Dependencies |
|------|----------|-------|-----------------|
| 1 | Config + deps | 1 + package.json | @qdrant/js-client-rest, wink-bm25 |
| 2 | Dual Embedder | 2 | Ollama API |
| 3 | BM25 Sparse Vectors | 2 | wink-bm25-text-search |
| 4 | Collection Manager | 2 | @qdrant/js-client-rest |
| 5 | Chunk Store | 2 | Embedder + Sparse + Qdrant |
| 6 | Qdrant Manager | 2 | child_process.spawn |
| 7 | Index + Integration | 2 | All above |

**Total: 13 new files, 7 tasks**
**After completion:** The kb-engine module is ready to be used by Plan 2 (ingestion), Plan 3 (retrieval), and Plan 4 (CLI integration).
