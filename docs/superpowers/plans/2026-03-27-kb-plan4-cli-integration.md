# KB Engine Plan 4: CLI Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the KB engine into the Attar-Code CLI: update search-proxy.js to use the new kb-engine modules, add/update slash commands, auto-search on errors, migrate feedback loop from JSONL to Qdrant fix_recipes, and update the model's kb_search tool.

**Architecture:** search-proxy.js becomes a thin HTTP layer over kb-engine modules. attar-code.js gets updated commands and auto-behaviors. FixLearner stores recipes in Qdrant instead of (or in addition to) JSONL.

**Depends on:** Plans 1-3 (kb-engine foundation, ingestion, retrieval)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `search-proxy.js` | REWRITE | Use kb-engine for all KB operations, manage Qdrant + reranker |
| `attar-code.js` | MODIFY | Update /kb commands, auto-search, kb_search tool, startup |
| `smart-fix/fix-engine/fix-learner.js` | MODIFY | Store recipes in Qdrant via kb-engine |
| `kb-engine/index.js` | MODIFY | Export IngestPipeline + RetrievalPipeline |

---

## Task 1: Update kb-engine/index.js Exports

Add IngestPipeline and RetrievalPipeline to the main kb-engine exports so search-proxy can use them.

- [ ] **Step 1: Read current kb-engine/index.js**
- [ ] **Step 2: Add ingestion + retrieval imports and exports**

Add:
```javascript
const { IngestPipeline } = require("./ingestion");
const { RetrievalPipeline } = require("./retrieval");
```

And add to module.exports: `IngestPipeline, RetrievalPipeline`

Also update KBEngine class to include them:
```javascript
class KBEngine {
  constructor(opts) {
    // ...existing...
    this.ingestion = new IngestPipeline({ store: this.store, ...opts });
    this.retrieval = new RetrievalPipeline({ store: this.store, ...opts });
  }
  async start() {
    await this.qdrantManager.start();
    await this.collectionMgr.ensureAllCollections();
    // Start reranker sidecar
    await this.retrieval.start();
    // ...rest...
  }
  stop() {
    this.retrieval.stop();
    this.qdrantManager.stop();
  }
}
```

- [ ] **Step 3: Verify exports**

Run: `node -e "const kb = require('./kb-engine'); console.log(Object.keys(kb).join(', '))"`
Expected: includes IngestPipeline, RetrievalPipeline

---

## Task 2: Rewrite search-proxy.js

Replace ChromaDB-based KB operations with kb-engine. Keep all existing non-KB endpoints (web search, fetch, github search) unchanged.

- [ ] **Step 1: Read current search-proxy.js to understand ALL endpoints**
- [ ] **Step 2: Rewrite KB endpoints to use kb-engine**

Replace:
```
OLD: POST /kb/search → chroma_bridge.py → ChromaDB
NEW: POST /kb/search → kb-engine RetrievalPipeline.search()

OLD: POST /kb/add → copy file + chroma_bridge.py index
NEW: POST /kb/ingest → kb-engine IngestPipeline.ingestFile()

OLD: POST /kb/add-text → write file + chroma_bridge.py index
NEW: POST /kb/ingest-text → kb-engine IngestPipeline (write temp file + ingest)

OLD: GET /kb/list → chroma_bridge.py list
NEW: GET /kb/collections → kb-engine CollectionManager.getAllStats()

OLD: GET /kb/count → chroma_bridge.py count
NEW: GET /kb/status → kb-engine KBEngine.getStatus()
```

Keep backward-compatible aliases: `/kb/add` still works (calls ingest internally), `/kb/search` still works.

Add new endpoints:
```
POST /kb/ingest-dir     → IngestPipeline.ingestDirectory()
POST /kb/ingest-url     → fetch URL → IngestPipeline.ingestFile()
POST /kb/recipe/store   → store fix recipe in fix_recipes collection
POST /kb/recipe/search  → RetrievalPipeline.searchFixRecipes()
GET  /kb/collections    → list all collections with stats
```

- [ ] **Step 3: Update startup to manage Qdrant + reranker**

On search-proxy start:
```javascript
const { KBEngine } = require("./kb-engine");
const engine = new KBEngine();
await engine.start(); // starts Qdrant + reranker + ensures collections
```

On shutdown: `engine.stop()`

- [ ] **Step 4: Test that old endpoints still work**

Run search-proxy, test: POST /search (web), POST /kb/search, GET /health

---

## Task 3: Update attar-code.js — Slash Commands

Update the /kb slash command handler and /help output.

- [ ] **Step 1: Read current /kb command handler in attar-code.js**
- [ ] **Step 2: Update /kb commands**

```
/kb                     → show status (collections, chunks, models)
/kb status              → detailed status (same as /kb)
/kb add <file>          → POST /kb/ingest { filepath }
/kb add <url>           → POST /kb/ingest-url { url }
/kb add-dir <path>      → POST /kb/ingest-dir { dirpath }
/kb add-docs <name>     → (Plan 5 — stub for now: print "coming soon")
/kb search <query>      → POST /kb/search { query } → display results
/kb collections         → GET /kb/collections → display table
/kb rebuild <name>      → POST /kb/ingest-dir (re-ingest collection source files)
/kb remove <name>       → DELETE /kb/collections/:name
/kb stats               → show retrieval metrics
```

- [ ] **Step 3: Update /help with new KB commands**

Add to the "Search & Knowledge" section in printHelp().

---

## Task 4: Update attar-code.js — Auto-Search on Errors

Wire KB into the error handling pipeline: when build_and_test fails or test_endpoint fails, auto-search the KB for relevant documentation + fix recipes.

- [ ] **Step 1: Find build_and_test error handling section**

After parseBuildErrors, before showing results to LLM, add KB search:

```javascript
// Auto-search KB for relevant docs + fix recipes
if (CONFIG.proxyUrl) {
  try {
    const kbResult = await proxyPost("/kb/search", {
      query: parsed.sorted[0]?.errors[0] || build.out.slice(0, 200),
      doc_type: "fix",
      num: 3,
    });
    if (kbResult.formatted && !kbResult.formatted.includes("No relevant")) {
      results.push("\n📚 KB KNOWLEDGE (from documentation + past fixes):\n" + kbResult.formatted);
    }
  } catch (_) {}
}
```

- [ ] **Step 2: Find test_endpoint error handling**

When test_endpoint fails (status >= 400), add KB search:

```javascript
// Auto-search KB for fix recipe
if (CONFIG.proxyUrl && actualStatus >= 400) {
  try {
    const kbResult = await proxyPost("/kb/recipe/search", {
      query: `${method} ${args.url} ${actualStatus} ${responseText.slice(0, 100)}`,
    });
    if (kbResult.formatted && !kbResult.formatted.includes("No relevant")) {
      // Append KB context to error output
      lines.push("\n📚 SIMILAR FIX FOUND:\n" + kbResult.formatted);
    }
  } catch (_) {}
}
```

- [ ] **Step 3: Update the kb_search tool definition**

Update the model's tool to use new parameters:

```javascript
{
  name: "kb_search",
  parameters: {
    query: { type: "string" },
    language: { type: "string", description: "Filter by language (optional)" },
    doc_type: { type: "string", enum: ["api","tutorial","reference","fix","all"] },
    collection: { type: "string", description: "Override collection routing (optional)" },
    num: { type: "number", default: 5 }
  }
}
```

---

## Task 5: Migrate FixLearner to Qdrant

Update fix-learner.js to store fix recipes in Qdrant fix_recipes collection (via search-proxy) in addition to JSONL.

- [ ] **Step 1: Read current fix-learner.js**
- [ ] **Step 2: Update _storeInKB to use new endpoint**

Replace the current `_storeInKB` method (which POSTs to `/kb/add-text`) with:

```javascript
async _storeInKB(record) {
  if (!record.fixDiff) return;
  try {
    await fetch(`${this.proxyUrl}/kb/recipe/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        language: record.language,
        strategy: record.strategy,
        fixDiff: record.fixDiff,
        fixFile: record.fixFile,
        fixDescription: record.fixDescription,
        trigger: record.trigger,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}
}
```

- [ ] **Step 3: Update searchKBForFix to use new endpoint**

```javascript
async searchKBForFix(errorMessage, language, num) {
  try {
    const res = await fetch(`${this.proxyUrl}/kb/recipe/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `${language || ""} ${errorMessage}`, num: num || 3 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.count > 0 && data.chunks?.length > 0) {
      const best = data.chunks[0];
      return { fixDiff: best.metadata?.fixDiff, fixDescription: best.metadata?.fixDescription, fixFile: best.metadata?.fixFile, strategy: best.metadata?.strategy, source: "qdrant" };
    }
  } catch (_) {}
  return null;
}
```

---

## Task 6: Update CLI Startup

Wire kb-engine into CLI startup alongside search-proxy.

- [ ] **Step 1: Update ensureSearchProxy to also verify Qdrant + models**

After search-proxy starts, check KB readiness:

```javascript
// In ensureSearchProxy(), after proxy health check:
try {
  const kbStatus = await proxyGet("/kb/status");
  if (kbStatus.qdrant?.running) {
    console.log(co(C.bGreen, "  ✓") + co(C.dim, ` Qdrant running (${kbStatus.collections?.length || 0} collections)`));
  }
  if (kbStatus.models) {
    const modelInfo = [];
    if (kbStatus.models.codeModel) modelInfo.push("code");
    if (kbStatus.models.textModel) modelInfo.push("text");
    if (modelInfo.length > 0) console.log(co(C.bGreen, "  ✓") + co(C.dim, ` Embedding models: ${modelInfo.join(" + ")}`));
  }
} catch (_) {}
```

- [ ] **Step 2: Run full test suite**

Run: `npx jest kb-engine/tests/ --no-coverage --testTimeout=30000 && npx jest smart-fix/tests/ --no-coverage`

---

## Summary

| Task | What | Files Modified |
|------|------|---------------|
| 1 | Export IngestPipeline + RetrievalPipeline | kb-engine/index.js |
| 2 | Rewrite search-proxy.js | search-proxy.js |
| 3 | Update /kb slash commands + /help | attar-code.js |
| 4 | Auto-search KB on errors | attar-code.js |
| 5 | Migrate FixLearner to Qdrant | fix-learner.js |
| 6 | Update CLI startup | attar-code.js |

**Total: 4 files modified, 6 tasks**
