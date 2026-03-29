# Smart-Fix System — Full Assessment Report

**Date:** 2026-03-25
**Project:** Attar-Code CLI (attar-code.js)
**Test Subject:** E-Commerce API (Python/FastAPI, 32+ files)
**Model:** glm-4.7-flash:latest (29.9B, Q4_K_M)

---

## Executive Summary

We built a dependency tree + error classification system ("smart-fix") for the Attar-Code CLI and tested it by having the CLI autonomously build a 32-file Python e-commerce API. The system went through **8 iterative runs**, each revealing new gaps that were fixed. The final system is significantly better than the original but still has areas for improvement.

---

## What Was Built

### Smart-Fix Modules (8 files in `smart-fix/`)
| Module | Lines | Purpose |
|--------|-------|---------|
| file-analyzer.js | 350+ | AST-based (JS/TS) + plugin regex (all languages) import/export extraction |
| graph-builder.js | ~120 | Dependency graph with cycle detection |
| file-ranker.js | ~80 | Depth, hub score, leaf/root classification |
| tree-manager.js | ~300 | Orchestrates analysis, auto-detects language, loads plugins |
| fix-order.js | ~100 | Two-queue fix ordering (root causes first) |
| error-classifier.js | ~120 | Classifies errors with cross-file probability |
| context-builder.js | ~100 | Formats enriched tool responses |
| index.js | ~25 | Entry point |

### Language Plugins (8 files in `defaults/plugins/`)
| Plugin | Errors | Categories |
|--------|--------|------------|
| TypeScript | 151 | 11 |
| Go | 92 | 15 |
| Swift | 90 | 17 |
| C#/.NET | 82 | 12 |
| Java/Kotlin | 81 | 11 |
| Python | 81 | 13 |
| Rust | 73 | 11 |
| PHP | 53 | 6 |
| **Total** | **703** | |

### CLI Enhancements (7 changes to attar-code.js)
1. Cross-file error pattern detection in build output
2. Enhanced edit loop detection with shared root cause awareness
3. Force-build nudge after 10+ file creates
4. Python import validation in write_file hook
5. Write blocker with root cause hint
6. Auto-search for test_endpoint and start_server failures
7. Smart search query extraction (strips paths, extracts error essence)

### Prompt Improvements (prompt.txt)
- Create files in dependency order
- Check import warnings immediately
- Build after 10+ files (not "all files")
- Fix shared root causes, not individual files
- Search after 2+ same failures
- Read server logs on test_endpoint failures

---

## Test Results: 8 Runs

### Run 1 (Before any fixes)
| Metric | Value |
|--------|-------|
| Duration | 25+ min (killed) |
| write_file | 107 |
| build_and_test | 0 |
| Files blocked | 11 |
| Result | **STUCK IN LOOP** |

**Root cause:** 7 files imported from `app.utils.exceptions` which didn't exist. Model rewrote each file 5+ times instead of creating the missing module.

### Run 3 (After smart-fix fixes)
| Metric | Value |
|--------|-------|
| Duration | ~10 min |
| write_file | 45 |
| build_and_test | 6 |
| Files blocked | 0 |
| Result | **COMPLETED** (32 files) |

**Improvement:** 57% fewer writes, 6 builds (vs 0), no loops, completed autonomously.

### Run 5 (Fix import errors)
| Metric | Value |
|--------|-------|
| Duration | ~9 min |
| edit_file | 5 |
| web_search | 2 |
| web_fetch | 1 |
| Result | **Fixed imports**, server wouldn't start (bcrypt) |

**The CLI used web search** to research FastAPI dependency injection patterns.

### Run 6 (Fix runtime errors)
| Metric | Value |
|--------|-------|
| Duration | ~6 min |
| edit_file | 8 |
| bash | 17 |
| Result | **Fixed AuthService pattern**, identified bcrypt incompatibility |

**The CLI correctly diagnosed** passlib/bcrypt version conflict and asked user how to proceed.

### Run 8 (Start server + test endpoints)
| Metric | Value |
|--------|-------|
| Duration | 10+ min (killed at 100 steps) |
| edit_file | 18 |
| start_server | 17 |
| test_endpoint | 39 |
| PASS | 16 |
| FAIL | 31 |
| web_search | 0 |
| Result | **GET endpoints PASS**, POST register stuck |

**Gap found:** CLI never searched web for the register endpoint error. Auto-search only triggered for build_and_test, not test_endpoint.

---

## Comparison: Before vs After

| Capability | Before Smart-Fix | After Smart-Fix |
|-----------|-----------------|----------------|
| Dependency tree | None | 8 languages supported |
| Import validation | TS/JS only (brace check) | All languages (AST + plugin regex) |
| Write loop prevention | Per-file counter only | + shared root cause detection |
| Build timing | "Build after all files" | "Build after 10 files" |
| Error grouping | By file count | By error signature (shared root cause) |
| Edit loop | "Fix next file" (useless) | "Create missing module" (actionable) |
| Auto-search | build_and_test only, after 3x | + test_endpoint + start_server |
| Search query | Raw error text (80 chars) | Smart extraction (error type + message, no paths) |
| Fix ordering | Sort by error count | Two-queue: root causes first |
| System prompt | "Create all, then build" | "Dependency order, check warnings, build early" |

---

## Known Remaining Gaps

### Gap 1: Model doesn't always follow smart-fix guidance
The system correctly outputs "CREATE the missing module first" but the 30B model sometimes ignores this and continues editing other files. This is a model intelligence issue, not a system issue.

### Gap 2: start_server port reuse
When the model restarts the server, the old port is still in use for a few seconds. The model works around this by using new ports (8000→8001→8002) but this creates confusion.

### Gap 3: No model-driven error summarization for search
The `buildSmartSearchQuery` function uses regex heuristics to extract error messages. A better approach would be to ask the model to summarize the error into a search query. This requires async model calls from within tool handlers, which the current architecture doesn't support.

### Gap 4: Python plugin regex patterns need testing
The universal file analyzer uses plugin regex patterns for Python imports. These work for standard patterns (`from app.X import Y`) but may miss complex cases (conditional imports, `TYPE_CHECKING` blocks, dynamic imports).

### Gap 5: No automatic dependency installation
When a project requires packages (pip install, npm install), the CLI blocks in auto mode because package installs require explicit user approval. This is a safety feature but creates friction for autonomous builds.

---

## Recommendations for Next Steps

1. **Test with more projects** — Run the CLI against Go, Rust, Java projects to validate multi-language support
2. **Improve model prompting** — Add few-shot examples to the system prompt showing the correct "create missing file" pattern
3. **Add a "pre-flight check"** — Before starting to create files, scan the plan/description for all imports and create stub files for dependencies first
4. **Port management** — Kill old server process before starting new one in start_server
5. **Async model queries** — Allow tool handlers to call the model for error summarization before searching

---

## Architecture Diagram

```
User Request
    │
    ▼
┌─────────────────────────────────────────────┐
│           attar-code.js (main loop)         │
│                                             │
│  write_file ──┐                             │
│  edit_file ───┤── Smart-Fix Hooks ──────────┤
│  build_test ──┘     │                       │
│                     ▼                       │
│         ┌─────────────────────┐             │
│         │   smart-fix/        │             │
│         │                     │             │
│         │  file-analyzer.js   │◄── @babel/parser (JS/TS)
│         │       +             │◄── plugin regex (Python/Go/Rust/...)
│         │  graph-builder.js   │             │
│         │  file-ranker.js     │             │
│         │  tree-manager.js    │             │
│         │  error-classifier.js│◄── plugins/python.json
│         │  fix-order.js       │◄── plugins/typescript.json
│         │  context-builder.js │◄── plugins/*.json (8 total)
│         └─────────────────────┘             │
│                                             │
│  Prompt rules ──── prompt.txt               │
│  Error patterns ── defaults/error-patterns/ │
│  Language plugins ─ defaults/plugins/       │
│  Auto-search ───── search-proxy.js:3001     │
└─────────────────────────────────────────────┘
```
