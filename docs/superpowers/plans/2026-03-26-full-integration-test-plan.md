# Full Integration Test Plan — Smart-Fix v2

> Verify EVERY fix and enhancement works end-to-end with the CLI

**Goal:** Programmatic integration test that exercises the complete pipeline without depending on model behavior. Tests the CODE, not the model.

**Strategy:** 3 layers of testing, each building on the previous:
1. **Layer 1: Module integration** — require chains, exports, data flow between modules
2. **Layer 2: CLI handler simulation** — call the same functions attar-code.js calls, in the same order
3. **Layer 3: Live CLI run** — actual CLI invocation with model

---

## Layer 1: Module Integration Test

**File:** `smart-fix/tests/full-integration.test.js`

Tests the complete data pipeline:
```
file creation → tree analysis → build errors → error classification
→ fix ordering → fix engine (tier1+2+3) → context building → verify
```

### Test 1.1: Full pipeline for TypeScript project
1. Create temp project with types.ts, db.ts, routes.ts
2. Routes.ts has a deliberate missing import (references `User` without importing)
3. Run: TreeManager.fullRebuild() → verify tree has 3 files
4. Run: parseBuildErrors() with simulated tsc output → verify structured errors
5. Run: classifyErrors() → verify crossFileProbability for the missing import
6. Run: computeFixOrder() → verify queue1 has root cause
7. Run: runFixEngine() → verify tier1 auto-fixes the missing import
8. Verify: the file on disk now has the import line
9. Run: verifyFix() → verify the fix passes

### Test 1.2: Full pipeline for Python project
Same as 1.1 but with Python files + Python plugin

### Test 1.3: Tier 2 candidate generation end-to-end
1. Create a file with TS2531 (null dereference)
2. Run through the full pipeline
3. Verify: tier2 generates 3 candidates with prompt block
4. Verify: prompt block contains [CHOICE] format

### Test 1.4: Tier 3 complex context end-to-end
1. Create a hub file (types.ts) with 5 dependents
2. Introduce a cross-file error (change_signature)
3. Run through pipeline
4. Verify: tier3 builds context with dependency info + cascade risk HIGH

### Test 1.5: Auto-rollback integration
1. Create project with 1 build error
2. Apply a "fix" that increases errors to 3
3. Verify: the auto-rollback mechanism would detect error increase
4. (Simulated — no actual build, just error count comparison)

### Test 1.6: Fix learner records outcomes
1. Run tier1 fix → passes verification
2. Check: fix-learner recorded the outcome
3. Run same error code 5 times → check: strategy promoted

### Test 1.7: Available exports in write_file response
1. Create types.ts with exports
2. Create routes.ts (new file)
3. Call buildCreateFileResponse with exports from tree
4. Verify: response contains "Available imports from existing files"
5. Verify: types.ts exports listed

### Test 1.8: Multi-language plugin loading
For each of 8 languages:
1. Create project marker file (package.json, requirements.txt, etc.)
2. Call autoDetectAndLoadPlugin
3. Verify: correct plugin loaded
4. Verify: file analysis works for that language

---

## Layer 2: CLI Handler Simulation

**File:** `smart-fix/tests/cli-simulation.test.js`

Simulates what attar-code.js tool handlers do, using the same code paths.

### Test 2.1: write_file handler simulation
```javascript
// Simulate the exact code from attar-code.js write_file handler
SESSION._depGraph = smartFix.initSmartFix();
SESSION._depGraph.autoDetectAndLoadPlugin(cwd);
// ... create file ...
SESSION._depGraph.addFile(fp);
const validation = SESSION._depGraph.validateImports(fp);
const exports = SESSION._depGraph.getAllExports();
const response = smartFix.buildCreateFileResponse(fp, validation, summary, count, exports);
// Verify response format
```

### Test 2.2: edit_file handler simulation
```javascript
// Simulate edit_file with structural change
const updateResult = SESSION._depGraph.updateFile(fp);
const response = smartFix.buildEditFileResponse(fp, updateResult);
// Verify: exports changed detected, dependents listed
```

### Test 2.3: build_and_test handler simulation
```javascript
// Simulate build failure → fix engine → output
const parsed = parseBuildErrors(buildOutput);
const classified = classifyErrors(structuredErrors, tree, plugin);
const fixPlan = computeFixOrder(classified, ranks);
const fixResult = await runFixEngine(fixPlan, tree, language, dir);
// Verify: autoFixed > 0, candidatesForLLM has prompt blocks, complexForLLM has context
```

### Test 2.4: Error signature grouping
```javascript
// Simulate cross-file errors, verify grouping
// 3 files reference missing 'User' → SHARED ROOT CAUSE
```

### Test 2.5: Search query generation
```javascript
// Simulate buildSmartSearchQuery for each language
// Verify queries are clean (no file paths, no stack traces)
```

### Test 2.6: Tool count cap
```javascript
// Simulate selectToolsForContext with a complex prompt
// Verify: max 12 tools returned, priority ordering correct
```

---

## Layer 3: Live CLI Run

**File:** Shell script `tests/run-live-integration.sh`

Actual CLI invocation with model. Checks system outputs via grep.

### Test 3.1: Build TypeScript project (5 files)
```bash
node attar-code.js --model glm-4.7-flash:latest --cwd /tmp/test-ts --auto --ctx 32768 \
  -p "Create 5 TS files..."
# Verify: 📊 Smart-fix appears, Available imports appears, build_and_test runs
```

### Test 3.2: Build Python project (5 files)
```bash
node attar-code.js --model glm-4.7-flash:latest --cwd /tmp/test-py --auto --ctx 32768 \
  -p "Create 5 Python files..."
# Verify: Python plugin detected, smart-fix outputs appear
```

### Test 3.3: CLI self-protection
```bash
node attar-code.js --cwd $ATTAR_CODE_DIR --auto \
  -p "Create test.js with console.log('hello')"
# Verify: BLOCKED appears
```

---

## Execution Plan

| Step | What | Time |
|------|------|------|
| 1 | Write `full-integration.test.js` (Layer 1: 8 tests) | Implement |
| 2 | Write `cli-simulation.test.js` (Layer 2: 6 tests) | Implement |
| 3 | Run all tests | Verify |
| 4 | Live CLI test (Layer 3) | Run if tests pass |

**Total new tests: ~14 integration tests**
**Expected total: 85 + 14 = 99 tests**
