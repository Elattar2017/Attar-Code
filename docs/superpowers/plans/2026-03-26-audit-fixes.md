# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 34 issues found in the smart-fix audit — 15 critical, 15 important, 4 minor.

**Architecture:** All fixes are surgical edits to existing files. No new files created. Each task is independent after Task 1.

**Tech Stack:** Node.js, JavaScript, JSON plugins

---

## Task 1: Critical Module Fixes (M1-M4) — 4 one-line to five-line fixes

**Files:**
- Modify: `Attar-Code/smart-fix/tree-manager.js`
- Modify: `Attar-Code/smart-fix/file-analyzer.js`

### M1: Remove `SESSION` reference (crash fix)

- [ ] **Step 1:** In `smart-fix/tree-manager.js`, find line containing `SESSION?.cwd`:
```javascript
// BEFORE (line ~308):
const root = this.projectRoot || SESSION?.cwd || dir;

// AFTER:
const root = this.projectRoot || dir;
```

- [ ] **Step 2:** Run tests: `npx jest smart-fix/tests/ --verbose`

### M2: Fix `updateFile` to use `_analyzeFileAuto`

- [ ] **Step 3:** In `smart-fix/tree-manager.js`, find `updateFile` method, line ~109:
```javascript
// BEFORE:
const newAnalysis = analyzeFile(content, filePath);

// AFTER:
const newAnalysis = this._analyzeFileAuto(content, filePath);
```

- [ ] **Step 4:** Run tests

### M3: Clean `edgeSymbols` in `updateFile`

- [ ] **Step 5:** In `smart-fix/tree-manager.js`, find the edge removal loop in `updateFile` (~line 120-124). After the two delete lines, add:
```javascript
// BEFORE:
for (const dep of this.graph.getDependenciesOf(filePath)) {
  this.graph.edges.get(filePath)?.delete(dep);
  this.graph.reverseEdges.get(dep)?.delete(filePath);
}

// AFTER:
for (const dep of this.graph.getDependenciesOf(filePath)) {
  this.graph.edges.get(filePath)?.delete(dep);
  this.graph.reverseEdges.get(dep)?.delete(filePath);
  this.graph.edgeSymbols.delete(`${filePath}|${dep}`);
}
```

- [ ] **Step 6:** Run tests

### M4: Guard empty module path in Python resolver

- [ ] **Step 7:** In `smart-fix/tree-manager.js`, find the Python relative import section (~line 291). After stripping dots, add guard:
```javascript
// AFTER the while loop that strips dots:
if (!rest) {
  // "from .. import X" — import parent package
  const candidates = [path.join(base, "__init__.py")];
  for (const c of candidates) {
    if (this.graph.hasNode(c)) return c;
    if (fs.existsSync(c)) return c;
  }
  return null;
}
```

### M6: Remove pydantic/fastapi/sqlalchemy/starlette from stdlib

- [ ] **Step 8:** In `smart-fix/file-analyzer.js`, find the `stdlibModules` Set (~line 243). Remove these 4 entries:
```javascript
// REMOVE these from the Set:
"pydantic", "fastapi", "sqlalchemy", "starlette",
```

### M12: Hoist noiseNames to module level

- [ ] **Step 9:** In `smart-fix/file-analyzer.js`, move the `noiseNames` Set from inside the loop (~line 343) to module level (top of file, after require statements):
```javascript
// At module level:
const NOISE_NAMES = new Set(["id", "name", "email", "title", "description", "value", "key", "type", "data", "result", "error", "message", "status", "count", "index", "length", "size", "port", "host", "path", "url"]);

// Inside the loop, replace:
// const noiseNames = new Set([...]);
// if (name && name.length < 100 && name.length >= 2 && !noiseNames.has(name.toLowerCase())) {
// WITH:
// if (name && name.length < 100 && name.length >= 2 && !NOISE_NAMES.has(name.toLowerCase())) {
```

- [ ] **Step 10:** Run ALL tests: `npx jest smart-fix/tests/ --verbose`
- [ ] **Step 11:** Commit: `git add smart-fix/ && git commit -m "fix: critical module bugs — SESSION crash, updateFile analyzer, edgeSymbols leak, Python resolver, stdlib list"`

---

## Task 2: Critical CLI Fixes (C1-C3) — attar-code.js

**Files:**
- Modify: `Attar-Code/attar-code.js`

### C3: Multi-language error regex in build_and_test

- [ ] **Step 1:** Find the TypeScript-only error regex in build_and_test smart-fix path (search for `line\s+(\d+):\s*(TS\d+)`). Replace with universal parser:

```javascript
// BEFORE (~line 3423-3429):
const structuredErrors = parsed.sorted.flatMap(({ file: f, errors: errs }) =>
  errs.map(e => {
    const m = e.match(/line\s+(\d+):\s*(TS\d+):\s*(.*)/);
    return m ? { file: path.resolve(dir, f), line: parseInt(m[1]), code: m[2], message: m[3].trim() } : null;
  }).filter(Boolean)
);

// AFTER:
const structuredErrors = parsed.sorted.flatMap(({ file: f, errors: errs }) =>
  errs.map(e => {
    // TypeScript: line N: TS####: message
    let m = e.match(/line\s+(\d+):\s*(TS\d+):\s*(.*)/);
    if (m) return { file: path.resolve(dir, f), line: parseInt(m[1]), code: m[2], message: m[3].trim() };
    // Python: line N: ErrorType: message
    m = e.match(/line\s+(\d+):\s*((?:Type|Import|Name|Attribute|Value|Key|Syntax)Error):\s*(.*)/);
    if (m) return { file: path.resolve(dir, f), line: parseInt(m[1]), code: m[2], message: m[3].trim() };
    // Go: line N: message (no error code)
    m = e.match(/line\s+(\d+):\s*(.*)/);
    if (m) return { file: path.resolve(dir, f), line: parseInt(m[1]), code: "GO_ERROR", message: m[2].trim() };
    // Rust: error[E####]: message
    m = e.match(/(E\d{4}):\s*(.*)/);
    if (m) return { file: path.resolve(dir, f), line: 0, code: m[1], message: m[2].trim() };
    // C#: CS####: message
    m = e.match(/(CS\d{4}):\s*(.*)/);
    if (m) return { file: path.resolve(dir, f), line: 0, code: m[1], message: m[2].trim() };
    // Generic fallback
    if (e.length > 10) return { file: path.resolve(dir, f), line: 0, code: "UNKNOWN", message: e.trim().slice(0, 120) };
    return null;
  }).filter(Boolean)
);
```

- [ ] **Step 2:** Run quick test: `node -e "require('./smart-fix'); console.log('OK')"`

### C1: Fix auto-rollback to use pre-build checkpoint

- [ ] **Step 3:** Find `SESSION._buildState.lastBuildSuccess` (search for `lastBuildSuccess`). Add checkpoint tracking:

After the line that sets `lastBuildSuccess`:
```javascript
// ADD after: SESSION._buildState.lastBuildSuccess = Date.now();
SESSION._buildState._lastBuildCheckpointIdx = SESSION.checkpoints?.length || 0;
```

- [ ] **Step 4:** Find the auto-rollback logic (search for `AUTO-REVERTED`). Replace `SESSION.checkpoints[SESSION.checkpoints.length - 1]` with the pre-build checkpoint:

```javascript
// BEFORE:
const lastCp = SESSION.checkpoints[SESSION.checkpoints.length - 1];

// AFTER:
const revertIdx = SESSION._buildState._lastBuildCheckpointIdx || 0;
const lastCp = SESSION.checkpoints[Math.max(0, revertIdx - 1)];
```

### C2: Merge error signatures instead of overwriting

- [ ] **Step 5:** In `build_and_test`, find where `_errorSignatures` is set (search for `SESSION._buildState._errorSignatures = errorSignatures`). Add the symbol-based grouping from the `run_bash` path. Replace:

```javascript
// BEFORE:
SESSION._buildState._errorSignatures = errorSignatures;

// AFTER — merge with existing if present:
if (SESSION._buildState._errorSignatures) {
  for (const [key, files] of errorSignatures) {
    const existing = SESSION._buildState._errorSignatures.get(key);
    if (existing) {
      for (const f of files) { if (!existing.includes(f)) existing.push(f); }
    } else {
      SESSION._buildState._errorSignatures.set(key, files);
    }
  }
} else {
  SESSION._buildState._errorSignatures = errorSignatures;
}
```

### I1: Dynamic extensions in build_and_test fullRebuild

- [ ] **Step 6:** Find the hardcoded extensions in build_and_test (search for `[".ts",".tsx",".js",".jsx"]` near `fullRebuild` in the build_and_test section). Replace:

```javascript
// BEFORE:
SESSION._depGraph.fullRebuild(dir, [".ts",".tsx",".js",".jsx"]);

// AFTER:
SESSION._depGraph.fullRebuild(dir);
// fullRebuild auto-detects language and sets extensions from plugin
```

- [ ] **Step 7:** Verify: `node -e "require('./smart-fix'); console.log('OK')"` and `npx jest smart-fix/tests/`
- [ ] **Step 8:** Commit: `git add attar-code.js && git commit -m "fix: critical CLI bugs — multi-language error parsing, rollback anchor, signature merge, dynamic extensions"`

---

## Task 3: Important CLI Fixes (I2-I6)

**Files:**
- Modify: `Attar-Code/attar-code.js`

### I4: Auto-detect plugin in one-shot mode

- [ ] **Step 1:** Find the one-shot `-p` init block (search for `initSmartFix` near `-p`). Add plugin detection:

```javascript
// AFTER: SESSION._depGraph = smartFix.initSmartFix();
// ADD:
SESSION._depGraph.autoDetectAndLoadPlugin(SESSION.cwd);
```

### I6: Lower symbol-group threshold to >=2

- [ ] **Step 2:** Search for `files.length >= 3` in write-block and edit-loop checks. Change to `>= 2`:

There are 2 locations — both in the `_errorSignatures` lookup blocks. Change `files.length >= 3` to `files.length >= 2`.

### I5: Clear stale errorSignatures on build success

- [ ] **Step 3:** Find `SESSION._buildState.lastBuildSuccess = Date.now()`. After it, add:

```javascript
SESSION._buildState._errorSignatures = null;
SESSION._buildState.errorHistory = [];
```

### I3: Single file read for hash + summary

- [ ] **Step 4:** In the read gate section, find the two `readFileSync` calls. Refactor to read once:

```javascript
// BEFORE (two reads):
const currentHash = crypto.createHash("md5").update(fs.readFileSync(fp, "utf-8")).digest("hex");
// ... later ...
const fileContent = fs.readFileSync(fp, "utf-8");

// AFTER (single read):
const fileContent = fs.readFileSync(fp, "utf-8");
const currentHash = crypto.createHash("md5").update(fileContent).digest("hex");
```

- [ ] **Step 5:** Run tests: `npx jest smart-fix/tests/`
- [ ] **Step 6:** Commit: `git add attar-code.js && git commit -m "fix: important CLI fixes — plugin detect in -p mode, threshold, stale state, read perf"`

---

## Task 4: Important Module Fixes (M5, M7, M8-M10)

**Files:**
- Modify: `Attar-Code/smart-fix/fix-order.js`
- Modify: `Attar-Code/smart-fix/file-ranker.js`
- Modify: `Attar-Code/smart-fix/graph-builder.js`

### M5: Fix `allFromSameOrigin` in fix-order.js

- [ ] **Step 1:** Find `allFromSameOrigin` (~line 30-31). Replace:

```javascript
// BEFORE:
const allFromSameOrigin = errors.every(e => e.originFile && e.originFile !== file);
const originFile = allFromSameOrigin ? errors[0].originFile : null;

// AFTER:
const uniqueOrigins = new Set(errors.map(e => e.originFile).filter(Boolean));
const allFromSameOrigin = uniqueOrigins.size === 1 && ![...uniqueOrigins][0] !== file;
const originFile = allFromSameOrigin ? [...uniqueOrigins][0] : null;
```

### M11: Populate or remove external queue

- [ ] **Step 2:** Find `const external = []` in fix-order.js. Add external error routing:

```javascript
// In the classification loop, add before the queue routing:
if (errors.every(e => e.originType === "external_package")) {
  for (const err of errors) external.push({ ...err, package: err.captures?.modulePath || "unknown" });
  continue;
}
```

### M10: Convert recursive DFS to iterative

- [ ] **Step 3:** In `smart-fix/graph-builder.js`, replace the recursive `detectCycles` with iterative:

```javascript
detectCycles() {
  const cycles = [];
  const visited = new Set();
  const inStack = new Set();

  for (const startNode of this.nodes.keys()) {
    if (visited.has(startNode)) continue;
    const stack = [[startNode, [...(this.edges.get(startNode) || [])]]];
    const pathStack = [startNode];
    visited.add(startNode);
    inStack.add(startNode);

    while (stack.length > 0) {
      const [node, neighbors] = stack[stack.length - 1];
      if (neighbors.length === 0) {
        stack.pop();
        pathStack.pop();
        inStack.delete(node);
        continue;
      }
      const dep = neighbors.pop();
      if (!visited.has(dep)) {
        visited.add(dep);
        inStack.add(dep);
        pathStack.push(dep);
        stack.push([dep, [...(this.edges.get(dep) || [])]]);
      } else if (inStack.has(dep)) {
        const cycleStart = pathStack.indexOf(dep);
        if (cycleStart >= 0) cycles.push(pathStack.slice(cycleStart));
      }
    }
  }
  return cycles;
}
```

### M13: Validate default and namespace imports

- [ ] **Step 4:** In `smart-fix/tree-manager.js`, find `validateImports`. After the `for (const sym of imp.symbols)` loop, add checks for defaultSymbol and namespaceAlias:

```javascript
// After the symbols loop:
if (imp.defaultSymbol && resolved) {
  results.push({ line: imp.line, source: imp.rawSource, status: "ok", message: `default import ${imp.defaultSymbol} resolved` });
}
if (imp.namespaceAlias && resolved) {
  results.push({ line: imp.line, source: imp.rawSource, status: "ok", message: `namespace import * as ${imp.namespaceAlias} resolved` });
}
```

- [ ] **Step 5:** Run tests: `npx jest smart-fix/tests/`
- [ ] **Step 6:** Commit: `git add smart-fix/ && git commit -m "fix: important module fixes — fix-order origin, iterative DFS, validate default imports"`

---

## Task 5: Plugin Fixes — Python, TypeScript, Swift, Go

**Files:**
- Modify: `Attar-Code/defaults/plugins/python.json`
- Modify: `Attar-Code/defaults/plugins/typescript.json`
- Modify: `Attar-Code/defaults/plugins/swift.json`
- Modify: `Attar-Code/defaults/plugins/go.json`

### P1: Fix Python mypy import match

- [ ] **Step 1:** In `python.json`, find `MYPY_IMPORT` match field. Change:
```
BEFORE: .*\[import\]
AFTER:  .*\[import(?:-untyped|-not-found)?\]
```

### P2: Fix TypeScript TS2769 captures

- [ ] **Step 2:** In `typescript.json`, find TS2769 entry. Either add a capture or remove dead refinements:
```json
// Option A: Remove refinements (safest):
"refinements": [],

// Option B: Add context-based capture (if messagePattern can extract function name)
```

### P3: Fix Swift internal_declaration anchor

- [ ] **Step 3:** In `swift.json`, find `internal_declaration` export pattern. Add `^` anchor:
```
BEFORE: (?:^|\\s)(?:internal\\s+)?(?:class|struct|enum|...
AFTER:  ^(?:internal\\s+)?(?:class|struct|enum|...
```

### P4: Merge Go duplicate patterns

- [ ] **Step 4:** In `go.json`, find `GO_MISSING_CASE_RETURN`. Merge into `GO_MISSING_RETURN` by adding a condition:
```json
"conditions": [
  {
    "when": "message contains switch",
    "rootCause": "Missing return or default case in switch statement",
    "prescription": "Add a default case with a return statement to the switch block"
  }
]
```
Remove the `GO_MISSING_CASE_RETURN` entry.

- [ ] **Step 5:** Validate all 4 JSONs: `node -e "for (const f of ['python','typescript','swift','go']) { JSON.parse(require('fs').readFileSync('defaults/plugins/'+f+'.json')); console.log(f+': OK'); }"`
- [ ] **Step 6:** Commit: `git add defaults/plugins/ && git commit -m "fix: plugin fixes — mypy import, TS2769 captures, Swift anchor, Go dedup"`

---

## Task 6: Plugin Fixes — PHP, Rust, Java, C#

**Files:**
- Modify: `Attar-Code/defaults/plugins/php.json`
- Modify: `Attar-Code/defaults/plugins/rust.json`
- Modify: `Attar-Code/defaults/plugins/java.json`
- Modify: `Attar-Code/defaults/plugins/csharp.json`

### P5: Fix PHP function_declaration export

- [ ] **Step 1:** In `php.json`, find `function_declaration` export pattern. Add `^` anchor:
```
BEFORE: function\\s+(?<functionName>\\w+)\\s*\\(
AFTER:  ^function\\s+(?<functionName>\\w+)\\s*\\(
```

### P6+P8: Rust errorFormat + compound codes

- [ ] **Step 2:** In `rust.json`, add `actualCode` field to compound entries:
```json
// For each E0277_display, E0382_closure, E0308_return etc:
"actualCode": "E0277",
```

- [ ] **Step 3:** Add a comment to the Rust toolchain noting multiline requirement:
```json
"note": "errorFormat requires multiline input — buffer error blocks before matching"
```

### P7: Java multiline pattern note

- [ ] **Step 4:** In `java.json`, for `JAVA_CANNOT_FIND_SYMBOL`, `JAVA_METHOD_NOT_FOUND`, `JAVA_DOES_NOT_HAVE_MEMBER` — add a simpler single-line `match` fallback:
```json
"match": "cannot find symbol.*"
```
Keep the multiline `messagePattern` for engines that support it.

### P11: PHP named groups in match fields

- [ ] **Step 5:** In `php.json`, search for all `match` fields containing `(?<`. Replace named groups with non-capturing groups `(?:`:
```
BEFORE: (?<className>[^:]+)
AFTER:  ([^:]+)
```

### Add missing C# patterns

- [ ] **Step 6:** In `csharp.json`, add CS0161 and CS0162:
```json
{
  "code": "CS0161",
  "category": "method_signature",
  "severity": "error",
  "messagePattern": "not all code paths return a value",
  "match": "CS0161:.*not all code paths return a value",
  "captures": [],
  "baseCrossFileProbability": 0.1,
  "refinements": [],
  "fixHint": { "primaryStrategy": "add_missing_return", "requiresCrossFileEdit": false, "typicalScope": "function_body" },
  "coOccurrence": [],
  "rootCause": "Not all code paths in the method return a value. Some branches are missing a return statement.",
  "prescription": "Add return statements to all code paths, or throw an exception for unreachable branches.",
  "codeBlock": null,
  "conditions": []
}
```

- [ ] **Step 7:** Validate all 4 JSONs
- [ ] **Step 8:** Commit: `git add defaults/plugins/ && git commit -m "fix: plugin fixes — PHP anchor, Rust compound codes, Java fallback, C# missing patterns"`

---

## Task 7: Final Verification

- [ ] **Step 1:** Run all smart-fix tests: `npx jest smart-fix/tests/ --verbose`
- [ ] **Step 2:** Validate all 8 plugins: `node -e "const fs=require('fs'); for (const f of fs.readdirSync('defaults/plugins').filter(f=>f.endsWith('.json'))) { JSON.parse(fs.readFileSync('defaults/plugins/'+f)); console.log(f+': OK'); }"`
- [ ] **Step 3:** Quick CLI test: `node attar-code.js --model glm-4.7-flash:latest --cwd /tmp/test --auto -p "echo hello"`
- [ ] **Step 4:** Verify smart-fix loads: `node -e "const sf=require('./smart-fix'); const t=sf.initSmartFix(); console.log('OK:', typeof t.fullRebuild)"`

---

## Summary

| Task | Fixes | Files | Effort |
|------|-------|-------|--------|
| 1: Critical modules | M1,M2,M3,M4,M6,M12 | tree-manager.js, file-analyzer.js | ~15 lines |
| 2: Critical CLI | C1,C2,C3,I1 | attar-code.js | ~60 lines |
| 3: Important CLI | I2,I3,I4,I5,I6 | attar-code.js | ~20 lines |
| 4: Important modules | M5,M10,M11,M13 | fix-order.js, graph-builder.js, tree-manager.js | ~50 lines |
| 5: Plugins (Py,TS,Swift,Go) | P1,P2,P3,P4 | 4 JSON files | ~20 lines |
| 6: Plugins (PHP,Rust,Java,C#) | P5,P6,P7,P8,P11 | 4 JSON files | ~30 lines |
| 7: Verification | — | — | Tests only |
| **Total** | **34 fixes** | **~12 files** | **~195 lines** |
