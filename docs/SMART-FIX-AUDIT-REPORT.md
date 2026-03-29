# Smart-Fix System — Comprehensive Audit Report

**Date:** 2026-03-26
**Audited by:** 3 parallel code review agents
**Scope:** 8 smart-fix modules, 8 language plugins, 20+ CLI integration points

---

## Part 1: CLI Integration Issues (attar-code.js)

### Critical — Must Fix

| # | Issue | Lines | Impact |
|---|-------|-------|--------|
| **C1** | Auto-rollback reverts wrong checkpoint — uses last checkpoint instead of pre-build checkpoint. Also no permission prompt before reverting. | 3339-3358 | Files incorrectly reverted, user loses intended edits |
| **C2** | `build_and_test` overwrites rich `_errorSignatures` (message + symbol groups) from `run_bash` with simpler message-only map | 3404-3406 | Symbol-based grouping lost when model uses both run_bash and build_and_test |
| **C3** | Error regex in `build_and_test` smart-fix path only matches TypeScript `TS\d+` format — silently drops Python, Go, Rust, Java, C#, PHP, Swift errors | 3423-3429 | Smart-fix classification never fires for non-TypeScript projects via build_and_test |

### Important — Should Fix

| # | Issue | Lines | Impact |
|---|-------|-------|--------|
| **I1** | `fullRebuild` in `build_and_test` hardcodes `[".ts",".tsx",".js",".jsx"]` — ignores detected language | 3274 | Empty dependency tree for Python/Go/Rust projects |
| **I2** | `autoSearchForSolution` fire-and-forget — hint arrives after model's next call, never seen in one-shot mode | 3446, 5954, 6377 | Auto-search results wasted |
| **I3** | Read gate reads file twice from disk (hash + summary) — TOCTOU window | 2054, 2065 | Minor perf + rare consistency issue |
| **I4** | One-shot `-p` mode doesn't call `autoDetectAndLoadPlugin` — `detectedLanguage` null for non-TS | 7376-7378 | Smart-fix bypassed for Go/Rust/Java/C#/PHP/Swift in one-shot |
| **I5** | Stale `_errorSignatures` persists after successful build — false positive hints | 3452 | Model gets old root-cause hints for fixed errors |
| **I6** | Symbol-group threshold mismatch: stored at >=2, looked up at >=3 — 2-file groups never trigger | 2024, 2255, 2371 | Common 2-file cross-file errors missed |

---

## Part 2: Smart-Fix Module Issues

### Critical — Must Fix

| # | Issue | File:Line | Confidence |
|---|-------|-----------|------------|
| **M1** | `SESSION` undeclared global in tree-manager.js — `ReferenceError` crash on Python absolute imports when `projectRoot` is null | tree-manager.js:308 | 97% |
| **M2** | `updateFile` calls `analyzeFile` (AST only) instead of `_analyzeFileAuto` — Python/Go/Rust files lose all graph data on update | tree-manager.js:109 | 95% |
| **M3** | `edgeSymbols` not cleaned in `updateFile` — memory leak + stale import data returned by `getImportedSymbols` | tree-manager.js:122-123 | 92% |
| **M4** | Python `from .. import X` (empty module path) produces false positive file matches | tree-manager.js:292-297 | 88% |

### Important — Should Fix

| # | Issue | File:Line | Confidence |
|---|-------|-----------|------------|
| **M5** | `allFromSameOrigin` in fix-order.js doesn't verify errors point to SAME origin — different origins grouped as one | fix-order.js:30-31 | 85% |
| **M6** | `pydantic`, `fastapi`, `sqlalchemy`, `starlette` misclassified as Python stdlib — external packages treated as local | file-analyzer.js:243 | 95% |
| **M7** | `cap.index` undefined causes silent null captures — no imports resolved for plugins without positional index | file-analyzer.js:260 | 87% |
| **M8** | BFS depth algorithm degrades on large diamond graphs — O(E*V) re-visits | file-ranker.js:23-33 | 83% |
| **M9** | `getTransitiveDependentsOf` called O(V) times — O(V*(V+E)) total for 500-file projects | file-ranker.js:46 | 83% |
| **M10** | Recursive DFS in `detectCycles` — stack overflow on 500+ deep chains | graph-builder.js:109 | 80% |

### Minor

| # | Issue | File:Line | Confidence |
|---|-------|-----------|------------|
| **M11** | `external` queue in fix-order.js never populated — `stats.externalErrors` always 0 | fix-order.js:7 | 99% |
| **M12** | `noiseNames` Set allocated per regex match inside inner loop — wasteful | file-analyzer.js:343 | 90% |
| **M13** | `validateImports` skips default and namespace imports — no validation result | tree-manager.js:222-233 | 85% |
| **M14** | `type_only_side_effect` nonsensical type string from error recovery | file-analyzer.js:66 | 82% |

---

## Part 3: Language Plugin Issues

### Critical — Broken Functionality

| # | Plugin | Issue | Impact |
|---|--------|-------|--------|
| **P1** | Python | `MYPY_IMPORT` match uses `[import]` but mypy >=1.0 uses `[import-untyped]` and `[import-not-found]` | All modern mypy import errors silently missed |
| **P2** | TypeScript | TS2769 refinements reference `symbolName` but captures array is empty | Cross-file probability adjustments never fire (always 0.6 fallback) |
| **P3** | Swift | `internal_declaration` export pattern matches struct fields and local variables | Definition index flooded with noise (every `var`, `let`, `func` anywhere) |
| **P4** | Go | `GO_MISSING_RETURN` and `GO_MISSING_CASE_RETURN` have identical match patterns | Duplicate prescriptions or wrong fix applied |
| **P5** | PHP | `function_declaration` export matches class methods, not just module-level functions | Every class method listed as a module export |
| **P6** | Rust | `errorFormat` regex requires multiline input but CLI parses line-by-line | Error parsing silently fails for all Rust projects |
| **P7** | Java | Multiline `messagePattern` captures fail with line-by-line parsers | `symbolName`, `methodName` captures always undefined |
| **P8** | Rust | Non-standard codes (`E0277_display`, `E0382_closure`) don't match compiler output | Lookup by error code fails for these variants |

### Important — Degraded Accuracy

| # | Plugin | Issue |
|---|--------|-------|
| **P9** | Python | `MYPY_IMPORT` dual-capture (`moduleName`/`moduleName2`) — one is always null |
| **P10** | Go | `GO_MISSING_METHOD` has undeclared `methodName2` capture |
| **P11** | PHP | Named capture groups in `match` fields conflict with `messagePattern` captures |

### Missing Patterns (High-Impact)

| Plugin | Missing | Frequency |
|--------|---------|-----------|
| **C#** | CS0161 (not all paths return), CS0162 (unreachable), CS8620, CS8625 | Very common |
| **Rust** | E0716 (temp dropped while borrowed), E0477, E0626 | Common |
| **Go** | Interface constraint mismatch (generics), invalid comparable | Common in Go 1.18+ |
| **PHP** | Call to undefined function (non-method), ArgumentCountError, array key undefined | Very common |
| **Python** | MYPY_OPTIONAL_ATTR ("Item None of Optional[X]") | Very common |
| **Swift** | Mutating on class, protocol requirement not satisfied | Common |
| **Java** | Implicit super constructor, checked exception broader | Moderate |

### Calibration Concerns

| Plugin | Issue |
|--------|-------|
| Go | `GO_NIL_DEREF` at 0.4 — runtime panics should be 0.0 (not compile-time) |
| Swift | `SWIFT_INVALID_REDECLARATION` `is_local` at 0.05 — too low (most redeclarations are local) |
| C# | CS8604 at 0.4 — should be 0.25-0.3 (call site usually local) |

---

## Proposed Fix Priority

### Phase 1: Critical — Will Crash or Silently Break (7 issues)

| Priority | Fix | What | Effort |
|----------|-----|------|--------|
| 1 | **M1** | Remove `SESSION` reference in tree-manager.js (use `this.projectRoot \|\| dir`) | 1 line |
| 2 | **M2** | Change `analyzeFile` to `this._analyzeFileAuto` in `updateFile` | 1 line |
| 3 | **C3** | Add multi-language error regex in build_and_test smart-fix path | ~30 lines |
| 4 | **M3** | Clean `edgeSymbols` in `updateFile` | 1 line |
| 5 | **C1** | Track pre-build checkpoint index, revert to that | ~15 lines |
| 6 | **C2** | Merge error signatures instead of overwriting | ~10 lines |
| 7 | **I1** | Use detected language extensions in build_and_test fullRebuild | ~5 lines |

### Phase 2: Important — Degrades Effectiveness (9 issues)

| Priority | Fix | What | Effort |
|----------|-----|------|--------|
| 8 | **M6** | Remove pydantic/fastapi/sqlalchemy/starlette from stdlib list | 1 line |
| 9 | **I4** | Call autoDetectAndLoadPlugin in one-shot mode | 1 line |
| 10 | **I6** | Lower symbol-group threshold to >=2 | 3 lines |
| 11 | **M5** | Fix `allFromSameOrigin` to verify same origin | 3 lines |
| 12 | **I5** | Clear stale errorSignatures on build success | 2 lines |
| 13 | **M4** | Guard empty module path in Python resolver | 5 lines |
| 14 | **M7** | Add validation for plugin capture index field | 5 lines |
| 15 | **I3** | Single file read for hash + summary | 5 lines |
| 16 | **I2** | Await autoSearchForSolution before next model call | ~10 lines |

### Phase 3: Performance + Polish (5 issues)

| Priority | Fix | What | Effort |
|----------|-----|------|--------|
| 17 | **M9** | Compute transitive dependents in single reverse topo pass | ~20 lines |
| 18 | **M10** | Convert recursive DFS to iterative | ~15 lines |
| 19 | **M8** | Use topological sort for depth instead of BFS | ~20 lines |
| 20 | **M12** | Hoist noiseNames Set to module level | 1 line |
| 21 | **M11** | Implement or remove external error queue | 5 lines |

### Phase 4: Plugin Fixes (8 critical, 3 important)

| Priority | Fix | Plugin | What | Effort |
|----------|-----|--------|------|--------|
| 22 | **P1** | Python | Fix mypy import match: `[import]` → `[import(?:-untyped\|-not-found)?]` | 1 line |
| 23 | **P2** | TypeScript | Add captures for TS2769 or remove dead refinements | 5 lines |
| 24 | **P3** | Swift | Add `^` anchor to `internal_declaration` export pattern | 1 line |
| 25 | **P4** | Go | Merge `GO_MISSING_RETURN` and `GO_MISSING_CASE_RETURN` | 10 lines |
| 26 | **P5** | PHP | Anchor `function_declaration` to line start: `^function` | 1 line |
| 27 | **P6** | Rust | Document multiline requirement OR add 2-pass parsing | 15 lines |
| 28 | **P7** | Java | Split multiline messagePattern into line-level patterns | 15 lines |
| 29 | **P8** | Rust | Add `actualCode` field for compound E-codes | 10 lines |
| 30 | **P9** | Python | Fix mypy dual-capture merge | 3 lines |
| 31 | **P10** | Go | Remove undeclared `methodName2` from regex | 1 line |
| 32 | **P11** | PHP | Remove named groups from `match` fields | 10 lines |

---

## Complete Summary

### Total Issues Found

| Category | Critical | Important | Minor | Total |
|----------|----------|-----------|-------|-------|
| **CLI Integration** (attar-code.js) | 3 | 6 | 0 | **9** |
| **Smart-Fix Modules** (smart-fix/) | 4 | 6 | 4 | **14** |
| **Language Plugins** (plugins/) | 8 | 3 | 0 | **11** |
| **Total** | **15** | **15** | **4** | **34** |

### Top 10 Most Impactful Fixes

| # | What | Why It Matters |
|---|------|---------------|
| 1 | **M1**: Remove `SESSION` from tree-manager.js | Crashes every Python project |
| 2 | **M2**: Use `_analyzeFileAuto` in `updateFile` | Python/Go/Rust files lose graph data on edit |
| 3 | **C3**: Multi-language error regex in build_and_test | Smart-fix only works for TypeScript currently |
| 4 | **P1**: Fix mypy import match regex | Python mypy errors silently dropped |
| 5 | **P6**: Rust errorFormat multiline issue | Rust error parsing completely broken |
| 6 | **I1**: Dynamic extensions in fullRebuild | Empty tree for non-TypeScript projects |
| 7 | **C1**: Pre-build checkpoint for rollback | Wrong files reverted on error increase |
| 8 | **M6**: Remove pydantic/fastapi from stdlib | External packages misclassified as local |
| 9 | **P2**: TS2769 captures empty | Most common TS overload error has no cross-file detection |
| 10 | **C2**: Merge error signatures | Symbol-based grouping lost between tools |

### Estimated Fix Effort

- **Phase 1** (7 critical code fixes): ~65 lines changed, ~2 hours
- **Phase 2** (9 important fixes): ~50 lines changed, ~1.5 hours
- **Phase 3** (5 performance fixes): ~75 lines changed, ~2 hours
- **Phase 4** (11 plugin fixes): ~75 lines changed in JSON, ~2 hours
- **Total**: ~265 lines, ~7.5 hours estimated
