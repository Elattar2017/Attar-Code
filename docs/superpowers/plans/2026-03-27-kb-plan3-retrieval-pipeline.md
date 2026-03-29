# KB Engine Plan 3: Retrieval Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the intelligent retrieval pipeline: query analysis, collection routing, hybrid search, optional query expansion, cross-encoder reranking, context assembly for LLM.

**Architecture:** `kb-engine/retrieval/` module. Reranker runs as a persistent Python FastAPI sidecar. All other components are Node.js.

**Depends on:** Plan 1 (ChunkStore.hybridSearch)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `kb-engine/retrieval/query-analyzer.js` | CREATE | Detect query intent + route to collections |
| `kb-engine/retrieval/query-expander.js` | CREATE | Ollama query reformulation (adaptive) |
| `kb-engine/retrieval/reranker-server.py` | CREATE | Python FastAPI cross-encoder sidecar |
| `kb-engine/retrieval/reranker.js` | CREATE | Node.js client for reranker sidecar |
| `kb-engine/retrieval/context-assembler.js` | CREATE | Deduplicate, format chunks for LLM |
| `kb-engine/retrieval/index.js` | CREATE | RetrievalPipeline orchestrator |
| `kb-engine/tests/retrieval.test.js` | CREATE | Unit tests |
| `kb-engine/tests/retrieval-integration.test.js` | CREATE | End-to-end test |

---

## Task 1: Query Analyzer + Context Assembler

Two independent, pure-logic modules with no external dependencies.

**Query Analyzer:** Detects query type (error/conceptual/api/general), preferred vector (code vs text), target collections, and technology. Uses keyword patterns + context from SESSION.

**Context Assembler:** Takes ranked chunks, filters by score threshold (0.5), deduplicates (>80% Jaccard overlap), takes top N, formats with source/section/score headers.

Tests: query routing for error/conceptual/api queries, tech detection from keywords and context, deduplication removes similar chunks, score filtering works, formatting includes headers.

---

## Task 2: Query Expander (Ollama)

Generates 3 reformulations via Ollama when initial search returns weak results (<3 chunks with score >0.6). Always returns original query + expansions. Graceful fallback: returns [original] if Ollama unavailable.

Tests: returns original on Ollama failure, produces 1-4 queries, each expansion is different from original.

---

## Task 3: Reranker Sidecar (Python) + Client (Node.js)

**Python sidecar** (`reranker-server.py`): FastAPI app loading `cross-encoder/ms-marco-MiniLM-L-6-v2`. Single endpoint `POST /rerank { query, documents[] }` returning `{ scores[] }`. Health check at `GET /health`. Uses `spawn` (not exec) from Node.js.

**Node.js client** (`reranker.js`): Manages sidecar lifecycle (start/stop/health), calls `/rerank`, returns null on failure (graceful degradation — skip reranking).

Tests: isRunning returns false on unused port, rerank returns null when sidecar down, start/stop lifecycle (skip if Python unavailable).

---

## Task 4: Retrieval Pipeline Orchestrator + Integration

Wires everything: analyze → search each collection (hybrid) → merge → adaptive expansion → rerank top 20 → assemble top 5.

Integration test: store 5 test chunks across 2 collections → search "express middleware" → verify Express chunks ranked first → search "python django" → verify Python chunks found.

Run all: `npx jest kb-engine/tests/ --no-coverage --testTimeout=30000`

---

## Summary

| Task | Component | Files |
|------|----------|-------|
| 1 | Query Analyzer + Context Assembler | 2 |
| 2 | Query Expander | 1 |
| 3 | Reranker (Python + Node) | 2 |
| 4 | Pipeline + Integration | 2 + tests |

**Total: ~8 new files, 4 tasks**
