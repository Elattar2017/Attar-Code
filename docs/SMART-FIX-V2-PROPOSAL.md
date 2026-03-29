# Smart-Fix v2: Autonomous Fix Engine — Research & Design Report

**Date:** 2026-03-26
**Status:** Research complete, architecture proposed
**Based on:** 3 parallel research agents analyzing automated program repair, fix templates, and architecture design

---

## Executive Summary

The current smart-fix system DETECTS and CLASSIFIES errors across 8 languages. The proposed v2 adds a **Fix Engine** that GENERATES and APPLIES fixes automatically — without LLM involvement for 60-70% of common errors.

**The key insight from research:** "Fault localization is more important than fix generation." Smart-fix v1 already solves localization (dependency tree, cross-file tracing, root-cause ordering). The missing piece is a tiered fix pipeline that handles errors from simple (add missing import) to complex (logic bugs) with increasing levels of intelligence.

---

## The 4-Layer Fix Architecture

### Layer 1: COMPILER AUTOFIX (no LLM, under 2 seconds)

Use built-in compiler/linter fix commands before the LLM sees errors:
- TypeScript: eslint --fix
- Python: ruff check --fix + ruff format
- Go: goimports + gofmt
- Rust: cargo fix (MachineApplicable only)
- C#: dotnet format
- PHP: php-cs-fixer fix

Expected resolution: 30-50% of errors

### Layer 2: TEMPLATE FIX ENGINE (no LLM, under 500ms per fix)

Pattern-match error to fix template, apply, verify:
- Missing import: search project exports, add import
- Unused variable: remove or prefix with _
- Missing property: add to interface/class
- Type mismatch: add assertion/conversion
- Missing return: add return with zero-value
- Missing await: insert await keyword

Expected resolution: 15-25% more

### Layer 3: LLM FIX LOOP (model-assisted, 2-10s per fix)

Send error + file context + what Layers 1-2 tried to LLM.
Apply fix, recompile, verify error count decreased.
Max 5 iterations with rollback on increase.

Expected resolution: 20-40% more

### Layer 4: MULTI-PATCH (model-assisted, 10-60s total)

Generate 5-10 candidate patches at varying temperatures.
Run compiler on each candidate.
Pick the patch with fewest remaining errors + smallest diff.

Expected resolution: 5-15% of remaining

**Total expected resolution: 70-95% of mechanically fixable errors**

---

## Research Findings

### Key Finding 1: Compiler QuickFix APIs Are a Goldmine

TypeScript, Rust, Go, and ESLint all have programmatic autofix APIs:

- TypeScript Language Service: getCodeFixesAtPosition() returns exact text changes
- Rust: error-format=json with MachineApplicable suggestions
- Go: goimports resolves nearly all import errors automatically
- ESLint: 200+ rules with fixable: true and automated fix() functions
- Python ruff: 150+ auto-fixable rules
- LSP Protocol: textDocument/codeAction is the universal API for all languages

### Key Finding 2: Fix Template Coverage

The top 10 fix templates cover 70-95% of mechanically fixable errors:

| Template | Coverage | Confidence |
|----------|----------|------------|
| Missing/unused import | 40-50% | HIGH |
| Formatting/whitespace | 20% | HIGH (delegate to formatters) |
| Unused variable | 10% | HIGH |
| Type mismatch (simple) | 8% | MEDIUM-HIGH |
| Missing property | 5% | MEDIUM |
| Missing return | 3% | MEDIUM |
| Missing await/async | 2% | HIGH |
| Wrong string type | 1% | HIGH |
| Duplicate identifier | 1% | LOW |
| Wrong module path | 1% | HIGH |

### Key Finding 3: Verification Pipeline

Every auto-fix needs 4-step verification (under 3 seconds total):

1. Syntax parse (under 100ms) — reject if file doesn't parse
2. Targeted re-check (under 1s) — verify original error is gone
3. New error scan (under 1s) — verify no regressions introduced
4. Error count comparison — total must decrease, never increase

### Key Finding 4: The Agentless Approach

Research shows generating multiple candidate patches and testing each is surprisingly effective. The "Agentless" approach from UIUC generates 10 patches at different temperatures and picks the one that passes tests — competitive with complex agent architectures.

### Key Finding 5: Tree-Sitter as Universal Parser

For multi-language fix verification, tree-sitter provides fast, incremental, error-tolerant parsing for all 8 target languages with a single API. This eliminates the need for language-specific parsers in the verification step.

---

## Integration with Existing System

The fix engine sits between error classification and the LLM:

```
build fails
  -> parseBuildErrors() [existing]
  -> Layer 1: compiler autofix [NEW] -> recompile
  -> Layer 2: template fixes [NEW] -> verify each
  -> prescribeFixesForBuild() [existing, for REMAINING errors only]
  -> smart-fix classification [existing]
  -> Model sees only errors that Layers 1-2 could not fix [ENHANCED]
```

The model gets richer context: what was tried, what failed, what remains.

---

## New Modules

| Module | Purpose | Est. Lines |
|--------|---------|------------|
| smart-fix/fix-engine.js | Core fix generation + template matching | 300 |
| smart-fix/fix-templates.js | 10 universal fix templates | 400 |
| smart-fix/fix-verifier.js | Syntax parse + targeted re-check | 150 |
| smart-fix/compiler-autofix.js | Language-specific autofix commands | 100 |
| **Total** | | **950** |

---

## Plugin Enhancement

Each plugin JSON gets a new fixTemplates section:

```json
{
  "fixTemplates": [
    {
      "id": "ts-missing-import",
      "errorCodes": ["TS2304", "TS2305"],
      "confidence": "high",
      "autoApply": true,
      "fixType": "add_import",
      "resolution": {
        "strategy": "search_exports",
        "insertPosition": "after_last_import"
      }
    }
  ]
}
```

---

## Expected Impact

| Metric | Current (v1) | Proposed (v2) |
|--------|-------------|---------------|
| Errors auto-fixed before model sees them | 0% | 50-70% |
| Model fix attempts needed | All errors | Only complex errors |
| Build-fix cycles | 10-20 | 3-5 |
| Total time to clean build | 5-15 min | 2-5 min |
| 30B model success rate | 60% | 85% (fewer, easier errors) |

---

## Implementation Roadmap

| Phase | What | Effort | Impact |
|-------|------|--------|--------|
| 1 | Layer 1: Compiler autofix commands | 2 hours | 30-50% errors eliminated |
| 2 | Layer 2: Top 3 templates (import, unused, semicolon) | 4 hours | 15-20% more |
| 3 | Layer 2: Next 4 templates (type, property, return, await) | 4 hours | 10-15% more |
| 4 | Verification pipeline | 2 hours | Prevents regressions |
| 5 | Layer 3: Richer context for LLM | 2 hours | Better model fix rate |
| 6 | Layer 4: Multi-patch generation | 3 hours | Stubborn errors |
| 7 | Plugin fixTemplates for all 8 languages | 4 hours | Universal support |
| **Total** | | **21 hours** | **70-95% auto-fix** |

---

## Conclusion

Smart-fix v1 answers "WHAT is broken and WHERE." Smart-fix v2 answers "HOW to fix it." The 4-layer architecture provides graceful degradation — simple errors are fixed instantly by compilers, common patterns by templates, and only truly complex errors reach the LLM. This reduces the burden on 30B models by 50-70%, making autonomous project building practical even with local hardware.
