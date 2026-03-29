# 6-Stage Fix Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boost the CLI's error fix rate from ~35-45% to ~60-75% by connecting existing but unwired systems and filling 12 critical gaps across 6 stages.

**Architecture:** Each stage is a discrete enhancement to the existing smart-fix pipeline. Stages are independent — each produces a testable improvement. The pipeline flows: Parse → Classify → Order → Context → Prompt → Feedback. All changes are in `smart-fix/` module files and `attar-code.js` integration points.

**Tech Stack:** Node.js, Jest (testing), Babel parser (AST), regex plugins (8 languages)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `smart-fix/hint-extractor.js` | CREATE | Stage 1: Extract compiler hints from error messages |
| `smart-fix/error-classifier.js` | MODIFY | Stage 2: Add recursive origin tracing + coOccurrence |
| `smart-fix/fix-order.js` | MODIFY | Stage 2: Use coOccurrence + transitiveDependentCount |
| `smart-fix/context-builder.js` | MODIFY | Stage 3: Function-level extraction + codeBlock injection |
| `smart-fix/function-extractor.js` | CREATE | Stage 3: Find enclosing function boundaries |
| `smart-fix/fix-engine/tier3-complex.js` | MODIFY | Stage 3+4: Add codeBlock + type signatures to prompt |
| `smart-fix/fix-engine/tier1-deterministic.js` | MODIFY | Stage 1+4: Add compiler-hint auto-fix strategy |
| `smart-fix/fix-engine/index.js` | MODIFY | Stage 1: Add `apply_compiler_hint` to TIER1_STRATEGIES |
| `smart-fix/fix-engine/tier2-heuristic.js` | MODIFY | Stage 4: Include codeBlock examples in [CHOICE] blocks |
| `smart-fix/prompt-template.js` | CREATE | Stage 5: Unified diagnosis-first prompt assembly |
| `smart-fix/fix-engine/fix-learner.js` | MODIFY | Stage 6: Cross-session loading + RAG retrieval |
| `smart-fix/fix-engine/index.js` | MODIFY | Stage 4+6: Wire new strategies + call getSimilarSuccessfulFix |
| `attar-code.js:4230-4286` | MODIFY | Stage 1: Structured hint extraction in parseBuildErrors |
| `attar-code.js:3587-3634` | MODIFY | Stage 5: Use unified prompt template |
| `smart-fix/tests/hint-extractor.test.js` | CREATE | Tests for Stage 1 |
| `smart-fix/tests/function-extractor.test.js` | CREATE | Tests for Stage 3 |
| `smart-fix/tests/prompt-template.test.js` | CREATE | Tests for Stage 5 |
| `smart-fix/tests/error-classifier.test.js` | MODIFY | Tests for Stage 2 additions |
| `smart-fix/tests/fix-order.test.js` | MODIFY | Tests for Stage 2 additions |
| `smart-fix/tests/fix-engine.test.js` | MODIFY | Tests for Stage 4+6 additions |
| `smart-fix/tests/tier3-complex.test.js` | MODIFY | Tests for Stage 3 additions |

---

## Task 1: Stage 1A — Compiler Hint Extraction

**Files:**
- Create: `smart-fix/hint-extractor.js`
- Create: `smart-fix/tests/hint-extractor.test.js`

This extracts "did you mean X?" suggestions from compiler output into a structured `hint` field on each parsed error.

- [ ] **Step 1: Write failing tests for hint extraction**

```javascript
// smart-fix/tests/hint-extractor.test.js
const { extractHints } = require("../hint-extractor");

describe("Hint Extractor", () => {
  test("extracts Rust 'did you mean' hint", () => {
    const message = "cannot find value `prnt` in this scope";
    const fullOutput = `error[E0425]: cannot find value \`prnt\` in this scope
 --> src/main.rs:5:9
  |
5 |         prnt!("hello");
  |         ^^^^ help: a macro with a similar name exists: \`print\``;
    const hint = extractHints(message, fullOutput, "Rust");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
    expect(hint.applicability).toBe("MaybeIncorrect");
    expect(hint.type).toBe("did_you_mean");
  });

  test("extracts TypeScript suggestion", () => {
    const message = "Property 'forEch' does not exist on type 'any[]'. Did you mean 'forEach'?";
    const hint = extractHints(message, message, "TypeScript");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("forEach");
    expect(hint.type).toBe("did_you_mean");
    expect(hint.applicability).toBe("MachineApplicable");
  });

  test("extracts Python ImportError suggestion", () => {
    const message = "cannot import name 'Listt' from 'typing'. Did you mean: 'List'?";
    const hint = extractHints(message, message, "Python");
    expect(hint.suggestion).toBe("List");
  });

  test("extracts Go unused import hint", () => {
    const message = '"fmt" imported and not used';
    const hint = extractHints(message, message, "Go");
    expect(hint.type).toBe("unused_import");
    expect(hint.suggestion).toBe("fmt");
  });

  test("extracts Java 'cannot find symbol' hint", () => {
    const message = "error: cannot find symbol\n  symbol: variable prntln\n  did you mean 'println'?";
    const hint = extractHints(message, message, "Java");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });

  test("extracts PHP undefined variable", () => {
    const message = "Undefined variable $ustName";
    const hint = extractHints(message, message, "PHP");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("ustName");
    expect(hint.type).toBe("undefined_variable");
  });

  test("extracts Kotlin unresolved reference hint", () => {
    const message = "Unresolved reference: prntln. Did you mean 'println'?";
    const hint = extractHints(message, message, "Kotlin");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });

  test("returns null when no hint present", () => {
    const hint = extractHints("syntax error", "syntax error", "TypeScript");
    expect(hint).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/hint-extractor.test.js --no-coverage 2>&1 | head -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement hint extractor**

```javascript
// smart-fix/hint-extractor.js
// Extracts structured compiler hints from error messages across all languages

const HINT_PATTERNS = [
  // "Did you mean 'X'?" — universal
  { re: /[Dd]id you mean[:\s]+['`"]([^'`"]+)['`"]\??/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Rust: "help: a X with a similar name exists: `Y`"
  { re: /help:\s+.*similar name exists:\s*[`']([^`']+)[`']/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Rust: "help: consider importing this Y: `use Z`"
  { re: /help:\s+consider (?:importing|using)[^:]*:\s*[`']?([^`'\n]+)[`']?/, type: "suggested_import", applicability: "MaybeIncorrect" },
  // Go: "imported and not used"
  { re: /"([^"]+)" imported and not used/, type: "unused_import", applicability: "MachineApplicable" },
  // Go: "declared and not used"
  { re: /(\w+) declared (?:and|but) not used/, type: "unused_variable", applicability: "MachineApplicable" },
  // TypeScript: "Did you mean to use 'X'?"
  { re: /[Dd]id you mean to (?:use|call)\s+['`"]([^'`"]+)['`"]\??/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Python: "Did you mean: 'X'?"
  { re: /[Dd]id you mean:\s*['`"]?([^'`"?\n]+)['`"]?\??/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Python: "perhaps you meant 'X'"
  { re: /perhaps you meant\s+['`"]([^'`"]+)['`"]/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // C#: "Are you missing X?"
  { re: /Are you missing.*?['`"]([^'`"]+)['`"]/, type: "missing_reference", applicability: "MaybeIncorrect" },
  // Java/Kotlin: "cannot find symbol... did you mean 'X'?"
  { re: /cannot find symbol[^]*?did you mean\s*['`"]?(\w+)['`"]?\??/i, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Java: "error: cannot access X"
  { re: /cannot access\s+(\w+)/, type: "missing_reference", applicability: "MaybeIncorrect" },
  // PHP: "Did you mean X?"
  { re: /Did you mean\s+\\?(\S+)\s*\?/i, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // PHP: "Undefined variable $X"
  { re: /Undefined variable \$(\w+)/, type: "undefined_variable", applicability: "MaybeIncorrect" },
  // Rust: "consider borrowing here: `&X`"
  { re: /consider borrowing here:\s*[`']([^`']+)[`']/, type: "borrow_suggestion", applicability: "MaybeIncorrect" },
  // Swift: "did you mean 'X'?"
  { re: /did you mean\s+'([^']+)'\?/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Kotlin: "Unresolved reference: X. Did you mean Y?"
  { re: /Unresolved reference:?\s*\w+.*?[Dd]id you mean\s+'?(\w+)'?\??/, type: "did_you_mean", applicability: "MaybeIncorrect" },
];

function extractHints(message, fullOutput, language) {
  // Try message first, then full output
  for (const source of [message, fullOutput]) {
    if (!source) continue;
    for (const { re, type, applicability } of HINT_PATTERNS) {
      const match = source.match(re);
      if (match) {
        return {
          suggestion: match[1].trim(),
          type,
          applicability,
          raw: match[0],
        };
      }
    }
  }
  return null;
}

module.exports = { extractHints, HINT_PATTERNS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/hint-extractor.test.js --no-coverage`
Expected: 8 PASS (TypeScript, Rust, Python, Go, Java, PHP, Kotlin, null case)

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/hint-extractor.js smart-fix/tests/hint-extractor.test.js
git commit -m "feat(stage1): add compiler hint extraction for 10+ languages"
```

---

## Task 2: Stage 1B — Wire Hints into parseBuildErrors

**Files:**
- Modify: `attar-code.js:4230-4286` (parseBuildErrors function)

This adds a `hint` field to each parsed error by calling `extractHints` on the raw output.

- [ ] **Step 1: Read the current parseBuildErrors function**

Run: Read `attar-code.js` lines 4225-4290 to see exact current state.

- [ ] **Step 2: Add hint extraction import near top of attar-code.js**

Find the smart-fix require section (search for `require("./smart-fix")`) and add:

```javascript
let extractHints;
try { extractHints = require("./smart-fix/hint-extractor").extractHints; } catch (_) {}
```

- [ ] **Step 3: Add hint extraction to parseBuildErrors output**

In parseBuildErrors, after the normalized error line is pushed to `fileMap[file]`, add hint extraction. Find the section around line 4275-4285 where errors are normalized into `line N: CODE: message` format.

After each error is pushed, extract and store the hint:

```javascript
// After: fileMap[file].push(`  line ${lineNum}: ${code}: ${msg}`);
// Add hint extraction to a parallel map
if (extractHints) {
  const hint = extractHints(msg, output, detectedLanguage);
  if (hint) {
    if (!hintMap[file]) hintMap[file] = {};
    hintMap[file][lineNum] = hint;
  }
}
```

At the top of `parseBuildErrors`, add:
```javascript
const hintMap = {};
// Detect language from file extensions in the output
function detectLangFromFile(f) {
  const ext = (f || "").split(".").pop()?.toLowerCase();
  const map = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java", cs: "CSharp", php: "PHP", swift: "Swift", kt: "Java" };
  return map[ext] || "JavaScript";
}
```

In the return statement at the end of `parseBuildErrors` (currently returns `{ summary, sorted, totalErrors, fileCount, topFile, topCount }`), add `hintMap`:
```javascript
return { summary, sorted, totalErrors, fileCount, topFile, topCount, hintMap };
```

Downstream consumers (e.g., `runFixEngine` in `attar-code.js:3587`) can access hints via `parsed.hintMap[file][lineNum]` and attach them to error objects before classification.

- [ ] **Step 4: Verify parseBuildErrors still works**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/ --no-coverage 2>&1 | tail -5`
Expected: All existing tests still pass

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add attar-code.js
git commit -m "feat(stage1): wire hint extraction into parseBuildErrors"
```

---

## Task 3: Stage 1C — Compiler-Hint Auto-Fix Strategy (Tier 1)

**Files:**
- Modify: `smart-fix/fix-engine/tier1-deterministic.js:7-10` (add strategy)
- Modify: `smart-fix/fix-engine/tier1-deterministic.js` (add fix function)
- Modify: `smart-fix/tests/fix-engine.test.js`

When a compiler hint has `MachineApplicable` applicability and type `did_you_mean`, auto-apply the suggestion as a tier1 fix.

- [ ] **Step 1: Write failing test**

Add to `smart-fix/tests/fix-engine.test.js`:

```javascript
describe("tier1 compiler-hint auto-fix", () => {
  test("auto-fixes 'did you mean' with MachineApplicable", () => {
    const error = {
      file: "test.ts", line: 5, code: "TS2551",
      message: "Property 'forEch' does not exist. Did you mean 'forEach'?",
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "forEach", type: "did_you_mean", applicability: "MachineApplicable" },
      captures: { wrong: "forEch" },
    };
    const content = 'const x = [1,2,3];\nx.forEch(v => console.log(v));';
    const fix = generateDeterministicFix(error, content, null, "TypeScript");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("apply_compiler_hint");
    expect(fix.patch.text).toContain("forEach");
    expect(fix.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("skips MaybeIncorrect hints", () => {
    const error = {
      file: "test.rs", line: 3, code: "E0425",
      message: "cannot find value `prnt`",
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "print", type: "did_you_mean", applicability: "MaybeIncorrect" },
    };
    const content = 'fn main() {\n  prnt!("hello");\n}';
    const fix = generateDeterministicFix(error, content, null, "Rust");
    expect(fix).toBeNull(); // MaybeIncorrect should NOT auto-apply
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/fix-engine.test.js --no-coverage -t "compiler-hint" 2>&1 | head -15`
Expected: FAIL

- [ ] **Step 3: Add apply_compiler_hint strategy to BOTH tier1 files**

**CRITICAL:** The strategy must be added in TWO places — `tier1-deterministic.js` AND `fix-engine/index.js` (which has its own `TIER1_STRATEGIES` set used by `classifyTier()`).

In `smart-fix/fix-engine/tier1-deterministic.js` (line 7-10):
```javascript
const TIER1_STRATEGIES = new Set([
  "add_import", "remove_import", "update_import_path",
  "add_semicolon", "fix_indentation", "remove_duplicate",
  "apply_compiler_hint",  // NEW
]);
```

In `smart-fix/fix-engine/index.js` (line 14-17):
```javascript
const TIER1_STRATEGIES = new Set([
  "add_import", "remove_import", "update_import_path",
  "add_semicolon", "fix_indentation", "remove_duplicate",
  "apply_compiler_hint",  // NEW — must match tier1-deterministic.js
]);
```

2. Add case to switch in generateDeterministicFix (after `case "remove_duplicate":`):
```javascript
case "apply_compiler_hint": return fixApplyCompilerHint(error, lines);
```

3. Add the function:
```javascript
function fixApplyCompilerHint(error, lines) {
  if (!error.hint || error.hint.applicability !== "MachineApplicable") return null;
  if (error.hint.type !== "did_you_mean" && error.hint.type !== "unused_import") return null;

  const lineIdx = (error.line || 1) - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  const originalLine = lines[lineIdx];

  if (error.hint.type === "did_you_mean") {
    // Extract the wrong token from captures or by diffing
    const wrong = error.captures?.wrong || error.captures?.symbol;
    if (!wrong) return null;
    if (!originalLine.includes(wrong)) return null;
    const newLine = originalLine.replace(wrong, error.hint.suggestion);
    if (newLine === originalLine) return null;
    return {
      strategy: "apply_compiler_hint",
      description: `Replace '${wrong}' with '${error.hint.suggestion}' (compiler suggestion)`,
      confidence: 0.95,
      patch: { file: error.file, line: error.line, text: newLine, original: originalLine },
    };
  }

  if (error.hint.type === "unused_import") {
    // Remove the unused import line
    return {
      strategy: "apply_compiler_hint",
      description: `Remove unused import '${error.hint.suggestion}'`,
      confidence: 0.9,
      patch: { file: error.file, line: error.line, text: "", original: originalLine, action: "delete_line" },
    };
  }

  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/fix-engine.test.js --no-coverage`
Expected: All PASS including new tests

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-engine/tier1-deterministic.js smart-fix/fix-engine/index.js smart-fix/tests/fix-engine.test.js
git commit -m "feat(stage1+4): add compiler-hint auto-fix as tier1 strategy"
```

---

## Task 4: Stage 2A — Recursive Origin Tracing

**Files:**
- Modify: `smart-fix/error-classifier.js:88-104`
- Modify: `smart-fix/tests/error-classifier.test.js`

Currently origin tracing stops at 1 level (A→B). This follows the import chain recursively (A→B→C) to find the true root cause.

- [ ] **Step 1: Write failing test**

Add to `smart-fix/tests/error-classifier.test.js`:

```javascript
describe("recursive origin tracing", () => {
  test("traces through 2-level import chain", () => {
    const mockTree = {
      getFileAnalysis: (file) => {
        if (file === "a.ts") return {
          imports: [{ rawSource: "./b", symbols: ["UserType"], isExternal: false }],
          definitions: [],
        };
        if (file === "b.ts") return {
          imports: [{ rawSource: "./c", symbols: ["UserType"], isExternal: false }],
          definitions: [],
          exports: [{ symbols: ["UserType"] }],
        };
        if (file === "c.ts") return {
          imports: [],
          definitions: [{ name: "UserType", kind: "interface" }],
          exports: [{ symbols: ["UserType"] }],
        };
        return null;
      },
      _resolveImportPath: (from, source) => {
        const map = { "./b": "b.ts", "./c": "c.ts" };
        return map[source] || null;
      },
    };

    const plugin = {
      errorCatalog: { categories: [{
        errors: [{
          code: "TS2304",
          baseCrossFileProbability: 0.7,
          messagePattern: "Cannot find name '(?<symbol>\\w+)'",
          captures: [{ name: "symbol", role: "identifier" }],
          refinements: [{ check: { type: "is_imported", target: "symbol" }, adjustedProbability: 0.9, traceTarget: "cross_file" }],
          fixHint: null, coOccurrence: [],
        }],
      }]},
    };

    const errors = [{ file: "a.ts", line: 5, code: "TS2304", message: "Cannot find name 'UserType'" }];
    const result = classifyErrors(errors, mockTree, plugin);
    // Should trace through b.ts to find c.ts as the root origin
    expect(result[0].originFile).toBe("c.ts");
    expect(result[0].originChain).toEqual(["b.ts", "c.ts"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/error-classifier.test.js --no-coverage -t "recursive" 2>&1 | head -15`
Expected: FAIL — originChain not in output

- [ ] **Step 3: Add recursive tracing to error-classifier.js**

After the current origin resolution (line 82 area), add recursive tracing:

```javascript
// After originFile is set from refinements (line 82):
// Add recursive tracing — follow the chain to find the true root
let originChain = [];
if (originFile && tree) {
  let current = originFile;
  const visited = new Set([error.file]);
  const MAX_DEPTH = 5;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    originChain.push(current);
    // Check if current file re-exports the symbol from another file
    const currentAnalysis = tree.getFileAnalysis?.(current);
    if (!currentAnalysis) break;
    const targetSymbol = captures.symbol || captures.symbolName || captures.name || captures.expected || captures.wrong || Object.values(captures)[0]; // prioritized capture lookup
    const reExport = currentAnalysis.imports?.find(imp =>
      !imp.isExternal && imp.symbols.some(s => s === targetSymbol || s.startsWith(targetSymbol + " as "))
    );
    if (!reExport) break; // Symbol is defined here — this is the root
    const deeper = tree._resolveImportPath?.(current, reExport.rawSource);
    if (!deeper || deeper === current) break;
    current = deeper;
  }
  // The last file in the chain that defines the symbol is the true origin
  if (originChain.length > 0) {
    originFile = originChain[originChain.length - 1];
  }
}
```

Add `originChain` to the return object (line 106):
```javascript
return { ...error, captures, crossFileProbability, originFile, originChain, originType, fixHint: catalogEntry.fixHint || null, coOccurrence: catalogEntry.coOccurrence || [] };
```

- [ ] **Step 4: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/error-classifier.test.js --no-coverage`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/error-classifier.js smart-fix/tests/error-classifier.test.js
git commit -m "feat(stage2): add recursive origin tracing through import chains"
```

---

## Task 5: Stage 2B — Wire coOccurrence into Fix Ordering

**Files:**
- Modify: `smart-fix/fix-order.js`
- Modify: `smart-fix/tests/fix-order.test.js`

Use the `coOccurrence` field (already stored on classified errors) to group related errors and predict cascading fixes.

- [ ] **Step 1: Write failing test**

Add to `smart-fix/tests/fix-order.test.js`:

```javascript
describe("coOccurrence grouping", () => {
  test("groups co-occurring errors and boosts root cause priority", () => {
    const errors = [
      { file: "a.ts", line: 5, code: "TS2304", message: "Cannot find name 'User'",
        crossFileProbability: 0.5, originFile: null, coOccurrence: ["TS2305", "TS2307"],
        fixHint: null },
      { file: "a.ts", line: 10, code: "TS2305", message: "Module has no exported member",
        crossFileProbability: 0.5, originFile: null, coOccurrence: ["TS2304"],
        fixHint: null },
      { file: "b.ts", line: 3, code: "TS2307", message: "Cannot find module './user'",
        crossFileProbability: 0.8, originFile: null, coOccurrence: ["TS2304"],
        fixHint: null },
    ];
    const ranks = new Map([
      ["a.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
      ["b.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: false, dependentCount: 1, transitiveDependentCount: 1, inCircularDependency: false }],
    ]);
    const result = computeFixOrder(errors, ranks);
    // TS2307 (missing module) co-occurs with both other errors → should be in queue1
    const q1Files = result.queue1.map(g => g.file);
    expect(q1Files).toContain("b.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/fix-order.test.js --no-coverage -t "coOccurrence" 2>&1 | head -15`
Expected: FAIL

- [ ] **Step 3: Add coOccurrence scoring to fix-order.js**

In `computeFixOrder()`, after line 23 (originFiles set), add coOccurrence analysis:

```javascript
// Build coOccurrence graph: which error codes appear together?
const coOccurrenceCount = new Map(); // errorCode → number of co-occurring errors present
for (const err of classifiedErrors) {
  if (err.coOccurrence?.length > 0) {
    for (const coCode of err.coOccurrence) {
      if (classifiedErrors.some(e => e.code === coCode)) {
        coOccurrenceCount.set(err.code, (coOccurrenceCount.get(err.code) || 0) + 1);
      }
    }
  }
}
```

First, update the rank default object (line 27 of fix-order.js) to include `transitiveDependentCount`:
```javascript
const rank = ranks.get(file) || { depth: 0, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false };
```

In the scoring section (around line 42-66), add coOccurrence bonus:

```javascript
// CoOccurrence bonus: errors that co-occur with many present errors are likely root causes
const maxCoOccurrence = Math.max(...errors.map(e => coOccurrenceCount.get(e.code) || 0), 0);
if (maxCoOccurrence >= 2) score -= 25; // Strong signal this is a root cause
```

In the queue routing (line 76-81), add coOccurrence as a queue1 signal:

```javascript
if (originFiles.has(file) || (rank.isHub && errors.some(e => !e.originFile || e.originFile === file)) || maxCoOccurrence >= 2) {
  queue1.push(group);
} else {
  queue2.push(group);
}
```

- [ ] **Step 4: Also add transitiveDependentCount to scoring**

In the scoring section, replace the hub bonus (line 50-53):

```javascript
// Hub bonus — use transitive count for better signal
if (rank.isHub && errors.some(e => !e.originFile || e.originFile === file)) {
  const transitiveWeight = Math.min(rank.transitiveDependentCount || rank.dependentCount, 20);
  score -= (10 + transitiveWeight); // More dependents = higher priority
}
```

- [ ] **Step 5: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/fix-order.test.js --no-coverage`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-order.js smart-fix/tests/fix-order.test.js
git commit -m "feat(stage2): wire coOccurrence and transitiveDependentCount into fix ordering"
```

---

## Task 6: Stage 3A — Function-Level Context Extraction

**Files:**
- Create: `smart-fix/function-extractor.js`
- Create: `smart-fix/tests/function-extractor.test.js`

Replace the ±15-line window with full enclosing function body extraction.

- [ ] **Step 1: Write failing tests**

```javascript
// smart-fix/tests/function-extractor.test.js
const { extractEnclosingFunction } = require("../function-extractor");

describe("Function Extractor", () => {
  test("extracts JavaScript function containing error line", () => {
    const code = `const x = 1;

function processUser(user) {
  const name = user.name;
  const email = user.email;
  const age = user.ag; // error line 6
  return { name, email, age };
}

function other() {}`;
    const result = extractEnclosingFunction(code, 6, "JavaScript");
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(8);
    expect(result.name).toBe("processUser");
    expect(result.code).toContain("function processUser");
    expect(result.code).toContain("return { name, email, age }");
  });

  test("extracts Python function", () => {
    const code = `import os

def process_user(user):
    name = user.name
    email = user.email
    age = user.ag  # error line 6
    return name, email, age

def other():
    pass`;
    const result = extractEnclosingFunction(code, 6, "Python");
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(7);
    expect(result.name).toBe("process_user");
  });

  test("falls back to ±15 lines when no function found", () => {
    const code = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = extractEnclosingFunction(code, 25, "JavaScript");
    expect(result.startLine).toBe(10); // 25 - 15
    expect(result.endLine).toBe(40);   // 25 + 15
    expect(result.name).toBeNull();
  });

  test("extracts Go function", () => {
    const code = `package main

func processUser(u User) string {
\tname := u.Name
\temail := u.Email
\tage := u.Ag // error line 6
\treturn name
}`;
    const result = extractEnclosingFunction(code, 6, "Go");
    expect(result.startLine).toBe(3);
    expect(result.name).toBe("processUser");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/function-extractor.test.js --no-coverage 2>&1 | head -15`
Expected: FAIL — module not found

- [ ] **Step 3: Implement function extractor**

```javascript
// smart-fix/function-extractor.js
// Finds the enclosing function for a given line number

// Language-specific function declaration patterns
const FUNC_PATTERNS = {
  JavaScript: /^[\s]*((?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)))/,
  TypeScript: /^[\s]*((?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*[:=]|(?:public|private|protected|static|async)\s+(\w+)\s*\())/,
  Python: /^(\s*)((?:async\s+)?def\s+(\w+)\s*\()/,
  Go: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,
  Rust: /^[\s]*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  Java: /^[\s]*(?:public|private|protected|static|\s)*\s+\w+(?:<[^>]*>)?\s+(\w+)\s*\(/,
  CSharp: /^[\s]*(?:public|private|protected|internal|static|async|virtual|override|\s)*\s+\w+(?:<[^>]*>)?\s+(\w+)\s*\(/,
  PHP: /^[\s]*(?:public|private|protected|static|\s)*function\s+(\w+)\s*\(/,
  Swift: /^[\s]*(?:public|private|internal|open|static|\s)*func\s+(\w+)/,
};

function extractEnclosingFunction(code, errorLine, language) {
  const lines = code.split("\n");
  const lang = normalizeLang(language);
  const pattern = FUNC_PATTERNS[lang];

  if (!pattern) return fallbackWindow(lines, errorLine);

  if (lang === "Python") {
    return extractPythonFunction(lines, errorLine, pattern);
  }

  return extractBraceFunction(lines, errorLine, pattern);
}

function extractBraceFunction(lines, errorLine, pattern) {
  // Walk backwards from error line to find function start
  let funcStart = -1;
  let funcName = null;

  for (let i = errorLine - 1; i >= 0; i--) {
    const match = lines[i].match(pattern);
    if (match) {
      funcStart = i + 1; // 1-based
      funcName = match[2] || match[3] || match[4] || match[1];
      break;
    }
  }

  if (funcStart === -1) return fallbackWindow(lines, errorLine);

  // Find matching closing brace
  let braceCount = 0;
  let funcEnd = lines.length;
  let started = false;

  for (let i = funcStart - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { braceCount++; started = true; }
      if (ch === "}") braceCount--;
      if (started && braceCount === 0) {
        funcEnd = i + 1; // 1-based
        return buildResult(lines, funcStart, funcEnd, funcName, errorLine);
      }
    }
  }

  return buildResult(lines, funcStart, Math.min(funcEnd, funcStart + 50), funcName, errorLine);
}

function extractPythonFunction(lines, errorLine, pattern) {
  let funcStart = -1;
  let funcName = null;
  let funcIndent = 0;

  for (let i = errorLine - 1; i >= 0; i--) {
    const match = lines[i].match(pattern);
    if (match) {
      funcStart = i + 1;
      funcIndent = match[1].length;
      funcName = match[3];
      break;
    }
  }

  if (funcStart === -1) return fallbackWindow(lines, errorLine);

  // Find end by indentation
  let funcEnd = lines.length;
  for (let i = funcStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= funcIndent && i > funcStart) {
      funcEnd = i; // 1-based (line i is first line AFTER function)
      break;
    }
  }

  return buildResult(lines, funcStart, funcEnd, funcName, errorLine);
}

function fallbackWindow(lines, errorLine) {
  const start = Math.max(1, errorLine - 15);
  const end = Math.min(lines.length, errorLine + 15);
  return buildResult(lines, start, end, null, errorLine);
}

function buildResult(lines, startLine, endLine, name, errorLine) {
  const codeLines = lines.slice(startLine - 1, endLine).map((l, i) => {
    const num = startLine + i;
    const marker = num === errorLine ? " >>> " : "     ";
    return `${marker}${num}: ${l}`;
  });
  return { startLine, endLine, name, code: codeLines.join("\n") };
}

function normalizeLang(lang) {
  if (!lang) return "JavaScript";
  const l = lang.toLowerCase();
  if (l.includes("typescript") || l === "ts") return "TypeScript";
  if (l.includes("javascript") || l === "js") return "JavaScript";
  if (l.includes("python") || l === "py") return "Python";
  if (l.includes("go") || l === "golang") return "Go";
  if (l.includes("rust") || l === "rs") return "Rust";
  if (l.includes("java") && !l.includes("script")) return "Java";
  if (l.includes("c#") || l.includes("csharp")) return "CSharp";
  if (l.includes("php")) return "PHP";
  if (l.includes("swift")) return "Swift";
  return "JavaScript";
}

module.exports = { extractEnclosingFunction };
```

- [ ] **Step 4: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/function-extractor.test.js --no-coverage`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/function-extractor.js smart-fix/tests/function-extractor.test.js
git commit -m "feat(stage3): add function-level context extraction for 9 languages"
```

---

## Task 7: Stage 3B — Add codeBlock + Function Context to Tier 3

**Files:**
- Modify: `smart-fix/fix-engine/tier3-complex.js:11-126`
- Modify: `smart-fix/tests/tier3-complex.test.js`

Replace the ±15-line window with function extraction, and inject the plugin's `codeBlock` example.

- [ ] **Step 1: Write failing test**

Add to `smart-fix/tests/tier3-complex.test.js`:

```javascript
describe("enhanced tier3 context", () => {
  test("includes codeBlock example in prompt when available", () => {
    const error = {
      file: "test.ts", line: 5, code: "TS1002",
      message: "Unterminated string literal",
      fixHint: { primaryStrategy: "fix_syntax" },
      codeBlock: "// Wrong\nconst s = 'this is a\\nmulti-line';\n\n// Correct\nconst s = `this is a\\nmulti-line`;",
    };
    const content = "const a = 1;\nconst b = 2;\nfunction test() {\n  const c = 3;\n  const s = 'broken\n  return c;\n}\n";
    const result = buildComplexContext(error, content, null, null);
    expect(result.promptBlock).toContain("Fix example");
    expect(result.promptBlock).toContain("// Wrong");
    expect(result.promptBlock).toContain("// Correct");
  });

  test("uses function-level extraction when available", () => {
    const error = { file: "test.js", line: 8, code: "ERR", message: "test error", fixHint: null };
    const content = Array.from({ length: 50 }, (_, i) => {
      if (i === 3) return "function myFunc() {";
      if (i === 7) return "  const broken = x.y; // error";
      if (i === 11) return "}";
      return `  const line${i} = ${i};`;
    }).join("\n");
    const result = buildComplexContext(error, content, null, null);
    expect(result.promptBlock).toContain("function myFunc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/tier3-complex.test.js --no-coverage -t "enhanced" 2>&1 | head -15`
Expected: FAIL

- [ ] **Step 3: Modify tier3-complex.js**

At top of file, add require:
```javascript
let extractEnclosingFunction;
try { extractEnclosingFunction = require("../function-extractor").extractEnclosingFunction; } catch (_) {}
```

Replace the ±15 lines code block (lines 15-22) with function-aware extraction:

```javascript
// Try function-level extraction first, fall back to ±15 lines
let surroundingLines;
if (extractEnclosingFunction) {
  const lang = detectLanguage(error.file);
  const extracted = extractEnclosingFunction(fileContent, error.line || 1, lang);
  surroundingLines = extracted.code;
} else {
  const ctxStart = Math.max(0, lineIdx - 15);
  const ctxEnd = Math.min(lines.length, lineIdx + 16);
  surroundingLines = lines.slice(ctxStart, ctxEnd).map((l, i) => {
    const num = ctxStart + i + 1;
    const marker = num === error.line ? " >>> " : "     ";
    return `${marker}${num}: ${l}`;
  }).join("\n");
}
```

Add helper at bottom of file:
```javascript
function detectLanguage(filePath) {
  const ext = (filePath || "").split(".").pop()?.toLowerCase();
  const map = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java", cs: "CSharp", php: "PHP", swift: "Swift", kt: "Java" };
  return map[ext] || "JavaScript";
}
```

In `buildComplexPromptBlock()`, make two additions:

**A) After the first line `[FIX_CONTEXT]...` (line 81), add language detection:**
```javascript
// Add detected language to help LLM generate correct syntax
const lang = detectLanguage(error.file);
if (lang) lines.push(`Language: ${lang}`);
```

**B) After the fix hint section (line 120), add codeBlock:**
```javascript
// Fix example from error catalog
if (error.codeBlock) {
  lines.push("");
  lines.push("Fix example (from error catalog):");
  lines.push(error.codeBlock);
}
```

- [ ] **Step 4: Run all tier3 tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/tier3-complex.test.js --no-coverage`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-engine/tier3-complex.js smart-fix/tests/tier3-complex.test.js
git commit -m "feat(stage3+4): function-level context + codeBlock examples in tier3"
```

---

## Task 8: Stage 4 — Add codeBlock to Tier 2 [CHOICE] Blocks

**Files:**
- Modify: `smart-fix/fix-engine/tier2-heuristic.js` (buildPromptBlock function, ~line 308)
- Modify: `smart-fix/tests/tier2-heuristic.test.js`

- [ ] **Step 1: Write failing test**

Add to `smart-fix/tests/tier2-heuristic.test.js`:

```javascript
test("includes codeBlock example in choice prompt when available", () => {
  const error = {
    file: "test.ts", line: 5, code: "TS2322",
    message: "Type 'number' is not assignable to type 'string'",
    fixHint: { primaryStrategy: "cast_type" },
    codeBlock: "// Before: const x: string = 123;\n// After:  const x: string = String(123);",
  };
  const content = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst x: string = 123;\nconst e = 5;";
  const result = generateHeuristicCandidates(error, content, {}, "TypeScript");
  expect(result).not.toBeNull();
  expect(result.promptBlock).toContain("Reference fix");
  expect(result.promptBlock).toContain("// Before");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/tier2-heuristic.test.js --no-coverage -t "codeBlock" 2>&1 | head -15`
Expected: FAIL

- [ ] **Step 3: Modify buildPromptBlock in tier2-heuristic.js**

In `buildPromptBlock()` (around line 308), make two additions:

**A) After the first `[CHOICE]` header line, add language detection:**
```javascript
// Add language so LLM generates correct syntax for fixes
const ext = (error.file || "").split(".").pop()?.toLowerCase();
const LANG_MAP = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#", php: "PHP", swift: "Swift" };
const lang = LANG_MAP[ext];
if (lang) lines.push(`Language: ${lang}`);
```

**B) After the candidates loop and before the final "Reply with" line, add codeBlock:**
```javascript
// Include codeBlock example if available from plugin
if (error.codeBlock) {
  lines.push("");
  lines.push("Reference fix (from error catalog):");
  lines.push(error.codeBlock);
}
```

**Note:** `buildPromptBlock` already receives the full `error` object as its first parameter (line 308: `function buildPromptBlock(error, context, candidates)`). No signature change is needed — `error.codeBlock` and `error.file` are accessible directly.

- [ ] **Step 4: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/tier2-heuristic.test.js --no-coverage`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-engine/tier2-heuristic.js smart-fix/tests/tier2-heuristic.test.js
git commit -m "feat(stage4): surface codeBlock examples in tier2 choice prompts"
```

---

## Task 9: Stage 5 — Unified Diagnosis-First Prompt Template

**Files:**
- Create: `smart-fix/prompt-template.js`
- Create: `smart-fix/tests/prompt-template.test.js`
- Modify: `attar-code.js:3587-3634` (use new template)

- [ ] **Step 1: Write failing tests**

```javascript
// smart-fix/tests/prompt-template.test.js
const { assembleFixPrompt } = require("../prompt-template");

describe("Prompt Template", () => {
  test("puts diagnosis BEFORE code context", () => {
    const input = {
      error: { file: "a.ts", line: 5, code: "TS2304", message: "Cannot find name 'User'" },
      classification: { rootCause: "Missing import for 'User'", prescription: "Add import from './models/user'" },
      codeBlock: "// Before: (no import)\\n// After: import { User } from './models/user';",
      functionContext: "     3: function process() {\\n >>> 5:   const u: User = {}\\n     7: }",
      dependencies: [{ file: "user.ts", definitions: ["interface User", "type UserRole"] }],
      cascadeRisk: "MEDIUM",
    };
    const prompt = assembleFixPrompt(input);
    const diagnosisIdx = prompt.indexOf("DIAGNOSIS");
    const codeIdx = prompt.indexOf("Code context");
    expect(diagnosisIdx).toBeLessThan(codeIdx);
    expect(prompt).toContain("Missing import");
    expect(prompt).toContain("Fix example");
  });

  test("detects language from file extension and includes in prompt", () => {
    const tsPrompt = assembleFixPrompt({ error: { file: "app.ts", line: 1, code: "TS2304", message: "err" } });
    expect(tsPrompt).toContain("Language: TypeScript");
    expect(tsPrompt).toContain("Use correct TypeScript syntax");

    const pyPrompt = assembleFixPrompt({ error: { file: "main.py", line: 1, code: "E001", message: "err" } });
    expect(pyPrompt).toContain("Language: Python");
    expect(pyPrompt).toContain("Use correct Python syntax");

    const goPrompt = assembleFixPrompt({ error: { file: "main.go", line: 1, code: "ERR", message: "err" } });
    expect(goPrompt).toContain("Language: Go");

    const rsPrompt = assembleFixPrompt({ error: { file: "lib.rs", line: 1, code: "E0308", message: "err" } });
    expect(rsPrompt).toContain("Language: Rust");

    const javaPrompt = assembleFixPrompt({ error: { file: "App.java", line: 1, code: "ERR", message: "err" } });
    expect(javaPrompt).toContain("Language: Java");

    const csPrompt = assembleFixPrompt({ error: { file: "Program.cs", line: 1, code: "CS0246", message: "err" } });
    expect(csPrompt).toContain("Language: C#");

    const phpPrompt = assembleFixPrompt({ error: { file: "index.php", line: 1, code: "ERR", message: "err" } });
    expect(phpPrompt).toContain("Language: PHP");

    const swiftPrompt = assembleFixPrompt({ error: { file: "main.swift", line: 1, code: "ERR", message: "err" } });
    expect(swiftPrompt).toContain("Language: Swift");

    const ktPrompt = assembleFixPrompt({ error: { file: "App.kt", line: 1, code: "ERR", message: "err" } });
    expect(ktPrompt).toContain("Language: Kotlin");
  });

  test("accepts explicit language parameter override", () => {
    const prompt = assembleFixPrompt({
      error: { file: "unknown.xyz", line: 1, code: "ERR", message: "err" },
      language: "Rust",
    });
    expect(prompt).toContain("Language: Rust");
  });

  test("includes all sections in correct order", () => {
    const input = {
      error: { file: "b.py", line: 10, code: "PY_IMPORT", message: "No module named 'utils'" },
      classification: { rootCause: "Module not installed", prescription: "pip install utils or fix import path" },
      codeBlock: null,
      functionContext: " >>> 10: import utils",
      dependencies: [],
      cascadeRisk: "LOW",
    };
    const prompt = assembleFixPrompt(input);
    // Language should come FIRST, then error type, then diagnosis, then code
    const sections = ["Language:", "ERROR TYPE", "DIAGNOSIS", "Code context", "Fix this error"];
    let lastIdx = -1;
    for (const section of sections) {
      const idx = prompt.indexOf(section);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/prompt-template.test.js --no-coverage 2>&1 | head -15`
Expected: FAIL

- [ ] **Step 3: Implement unified prompt template**

```javascript
// smart-fix/prompt-template.js
// Unified diagnosis-first prompt assembly for all fix tiers

const path = require("path");

// Detect language from file extension — universal mapping for all supported technologies
function detectLanguageFromFile(filePath) {
  const ext = (filePath || "").split(".").pop()?.toLowerCase();
  const LANG_MAP = {
    ts: "TypeScript", tsx: "TypeScript (React)",
    js: "JavaScript", jsx: "JavaScript (React)", mjs: "JavaScript (ESM)", cjs: "JavaScript (CommonJS)",
    py: "Python", pyw: "Python",
    go: "Go",
    rs: "Rust",
    java: "Java",
    kt: "Kotlin", kts: "Kotlin",
    cs: "C#",
    php: "PHP",
    swift: "Swift",
    rb: "Ruby",
    cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
    c: "C", h: "C/C++",
    dart: "Dart",
    scala: "Scala",
    ex: "Elixir", exs: "Elixir",
    lua: "Lua",
    zig: "Zig",
  };
  return LANG_MAP[ext] || null;
}

function assembleFixPrompt(input) {
  const { error, classification, codeBlock, functionContext, dependencies, dependents, cascadeRisk, hint, language } = input;
  const lines = [];

  // Section 0: LANGUAGE/TECHNOLOGY (tells LLM what syntax to use)
  const detectedLang = language || detectLanguageFromFile(error.file);
  if (detectedLang) {
    lines.push(`Language: ${detectedLang}`);
  }

  // Section 1: ERROR TYPE + LOCATION (what and where)
  lines.push(`[ERROR TYPE] ${error.code} in ${path.basename(error.file)} line ${error.line}`);
  lines.push(`Message: ${error.message}`);
  if (cascadeRisk && cascadeRisk !== "UNKNOWN") {
    lines.push(`Cascade risk: ${cascadeRisk}`);
  }
  lines.push("");

  // Section 2: DIAGNOSIS (what's wrong and why — BEFORE the code)
  if (classification) {
    lines.push("DIAGNOSIS:");
    if (classification.rootCause) lines.push(`  Cause: ${classification.rootCause}`);
    if (classification.prescription) lines.push(`  Fix: ${classification.prescription}`);
    lines.push("");
  }

  // Section 3: COMPILER HINT (if available — highest confidence signal)
  if (hint?.suggestion) {
    lines.push(`Compiler suggestion: replace with '${hint.suggestion}' (confidence: ${hint.applicability})`);
    lines.push("");
  }

  // Section 4: FIX EXAMPLE (before/after from pattern database)
  if (codeBlock) {
    lines.push("Fix example (from error catalog):");
    lines.push(codeBlock);
    lines.push("");
  }

  // Section 5: CODE CONTEXT (the actual code with error marked)
  lines.push("Code context:");
  lines.push(functionContext || `  (line ${error.line} in ${path.basename(error.file)})`);
  lines.push("");

  // Section 6: DEPENDENCY INFO (types/exports available)
  if (dependencies?.length > 0) {
    lines.push("Available from imported files:");
    for (const dep of dependencies) {
      if (dep.definitions?.length > 0) {
        lines.push(`  ${dep.file}: ${dep.definitions.join(", ")}`);
      } else if (dep.exports?.length > 0) {
        lines.push(`  ${dep.file}: exports ${dep.exports.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (dependents?.length > 0) {
    lines.push("Files affected by changes here:");
    for (const dep of dependents) {
      lines.push(`  ${dep.file}: uses ${dep.imports?.join(", ") || "module"}`);
    }
    lines.push("");
  }

  // Section 7: INSTRUCTION (language-aware)
  const langNote = detectedLang ? ` Use correct ${detectedLang} syntax.` : "";
  lines.push(`Fix this error.${langNote} If the fix requires changing another file (the root cause), change THAT file, not this one.`);

  return lines.join("\n");
}

module.exports = { assembleFixPrompt, detectLanguageFromFile };
```

- [ ] **Step 4: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/prompt-template.test.js --no-coverage`
Expected: 4 PASS (diagnosis order, language detection for 9 langs, explicit override, section order)

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/prompt-template.js smart-fix/tests/prompt-template.test.js
git commit -m "feat(stage5): unified diagnosis-first prompt template"
```

---

## Task 10: Stage 5B — Wire Prompt Template into Tier 3

> **DEPENDENCY:** This task MUST be implemented AFTER Task 7 (which modifies tier3-complex.js to add function extraction and the `surroundingLines` variable referenced below).

**Files:**
- Modify: `smart-fix/fix-engine/tier3-complex.js` (use assembleFixPrompt)

- [ ] **Step 1: Read current tier3 buildComplexPromptBlock**

Verify current state at `tier3-complex.js:79-126`.

- [ ] **Step 2: Replace buildComplexPromptBlock with assembleFixPrompt**

At top of tier3-complex.js, add:
```javascript
let assembleFixPrompt;
try { assembleFixPrompt = require("../prompt-template").assembleFixPrompt; } catch (_) {}
```

In `buildComplexContext()`, replace the promptBlock construction (line 67):

```javascript
let promptBlock;
if (assembleFixPrompt) {
  const detectedLang = detectLanguage(error.file); // from Task 7's helper
  promptBlock = assembleFixPrompt({
    error,
    language: detectedLang, // Pass detected language to prompt template
    classification: {
      rootCause: error.fixHint ? `Strategy: ${error.fixHint.primaryStrategy}` : null,
      prescription: error.fixHint?.requiresCrossFileEdit ? "May require editing multiple files" : null,
    },
    codeBlock: error.codeBlock || null,
    functionContext: surroundingLines,
    dependencies,
    dependents,
    cascadeRisk,
    hint: error.hint || null,
  });
} else {
  promptBlock = buildComplexPromptBlock(error, surroundingLines, dependencies, dependents, cascadeRisk, fileRank);
}
```

Keep the old `buildComplexPromptBlock` as fallback (don't delete it).

- [ ] **Step 3: Run all tier3 and prompt tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/tier3-complex.test.js smart-fix/tests/prompt-template.test.js --no-coverage`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-engine/tier3-complex.js
git commit -m "feat(stage5): wire unified prompt template into tier3"
```

---

## Task 11: Stage 6A — Cross-Session Outcome Loading

**Files:**
- Modify: `smart-fix/fix-engine/fix-learner.js`
- Modify: `smart-fix/tests/fix-engine.test.js`

Load past fix outcomes from `fix-outcomes.jsonl` on startup to enable cross-session learning.

- [ ] **Step 1: Write failing test**

Add to `smart-fix/tests/fix-engine.test.js`:

```javascript
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("FixLearner cross-session", () => {
  const testOutcomesFile = path.join(os.tmpdir(), "test-fix-outcomes.jsonl");

  afterEach(() => {
    try { fs.unlinkSync(testOutcomesFile); } catch (_) {}
  });

  test("loads past outcomes from JSONL file", () => {
    // Write some past outcomes
    const pastOutcomes = [
      { errorCode: "TS2304", strategy: "add_import", language: "TypeScript", passed: true },
      { errorCode: "TS2304", strategy: "add_import", language: "TypeScript", passed: true },
      { errorCode: "TS2304", strategy: "update_type_annotation", language: "TypeScript", passed: false },
    ];
    fs.writeFileSync(testOutcomesFile, pastOutcomes.map(o => JSON.stringify(o)).join("\n") + "\n");

    const { FixLearner } = require("../fix-engine/fix-learner");
    const learner = new FixLearner(testOutcomesFile);
    const similar = learner.getSimilarSuccessfulFix("TS2304", {}, "TypeScript");
    expect(similar).not.toBeNull();
    expect(similar.strategy).toBe("add_import");
    expect(similar.passed).toBe(true);
  });

  test("getSimilarSuccessfulFix returns most recent success", () => {
    const outcomes = [
      { errorCode: "E0308", strategy: "cast_type", language: "Rust", passed: true, timestamp: "2026-01-01" },
      { errorCode: "E0308", strategy: "add_null_check", language: "Rust", passed: true, timestamp: "2026-03-01" },
    ];
    fs.writeFileSync(testOutcomesFile, outcomes.map(o => JSON.stringify(o)).join("\n") + "\n");

    const { FixLearner } = require("../fix-engine/fix-learner");
    const learner = new FixLearner(testOutcomesFile);
    const similar = learner.getSimilarSuccessfulFix("E0308", {}, "Rust");
    expect(similar.strategy).toBe("add_null_check"); // most recent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/fix-engine.test.js --no-coverage -t "cross-session" 2>&1 | head -15`
Expected: FAIL

- [ ] **Step 3: Modify FixLearner constructor to load past outcomes**

In `fix-learner.js`, update constructor:

```javascript
constructor(outcomesFilePath) {
  this.outcomesFile = outcomesFilePath || OUTCOMES_FILE;
  this.promoted = this._loadPromoted();
  this.recentOutcomes = this._loadPastOutcomes();
}

_loadPastOutcomes() {
  try {
    if (fs.existsSync(this.outcomesFile)) {
      const content = fs.readFileSync(this.outcomesFile, "utf-8").trim();
      if (!content) return [];
      const lines = content.split("\n").filter(l => l.trim());
      // Load last 500 outcomes to keep memory bounded
      return lines.slice(-500).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
    }
  } catch (_) {}
  return [];
}
```

Also update `recordOutcome` to use `this.outcomesFile`. Replace the full try/catch block in `recordOutcome` (lines 36-40):

```javascript
  // Append to file (non-blocking, best-effort)
  try {
    const dir = path.dirname(this.outcomesFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.outcomesFile, JSON.stringify(record) + "\n");
  } catch (_) {}
```

This replaces the old code that used the constant `OUTCOMES_FILE` with the instance property `this.outcomesFile`. Without this change, the constructor's custom path parameter would be ignored during writes.

- [ ] **Step 4: Run tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/fix-engine.test.js --no-coverage`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-engine/fix-learner.js smart-fix/tests/fix-engine.test.js
git commit -m "feat(stage6): cross-session outcome loading from fix-outcomes.jsonl"
```

---

## Task 12: Stage 6B — Wire getSimilarSuccessfulFix into Fix Engine

**Files:**
- Modify: `smart-fix/fix-engine/index.js`

Currently `getSimilarSuccessfulFix()` exists but is never called. Wire it into the tier classification and context building.

- [ ] **Step 1: Read current fix-engine/index.js**

Verify the `runFixEngine` function and where tier classification happens.

- [ ] **Step 2: Add similar-fix context to tier3 errors**

In `runFixEngine()`, when building tier3 context, add past fix lookup:

Find the section where tier3 errors are processed (around the complex error loop). Before building context, add:

```javascript
// Check for similar successful fix from history
if (learner) {
  const similar = learner.getSimilarSuccessfulFix(error.code, error.captures || {}, language);
  if (similar) {
    error._pastFix = {
      strategy: similar.strategy,
      file: similar.file,
      confidence: similar.confidence,
    };
  }
}
```

In tier3-complex.js `assembleFixPrompt` call, pass the past fix:

```javascript
// In the assembleFixPrompt input, add:
pastFix: error._pastFix || null,
```

In `prompt-template.js`, add a section between diagnosis and compiler hint. Find this exact code:

```javascript
  // Section 3: COMPILER HINT (if available — highest confidence signal)
```

Insert BEFORE that line:

```javascript
  // Section 2.5: PAST SUCCESSFUL FIX (personalized from history)
  if (input.pastFix) {
    lines.push(`Previously successful strategy for ${error.code}: ${input.pastFix.strategy} (used in ${input.pastFix.file})`);
    lines.push("");
  }

```

- [ ] **Step 3: Run all tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/ --no-coverage`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/fix-engine/index.js smart-fix/fix-engine/tier3-complex.js smart-fix/prompt-template.js
git commit -m "feat(stage6): wire past fix lookup into tier3 context and prompt"
```

---

## Task 13: Integration Test — Full Pipeline

**Files:**
- Modify: `smart-fix/tests/full-integration.test.js`

- [ ] **Step 1: Write integration test covering all 6 stages**

Add to `smart-fix/tests/full-integration.test.js`:

```javascript
describe("6-Stage Pipeline Integration", () => {
  test("hint extraction → classification → ordering → context → prompt → learning", () => {
    const { extractHints } = require("../hint-extractor");
    const { classifyErrors } = require("../error-classifier");
    const { computeFixOrder } = require("../fix-order");
    const { buildComplexContext } = require("../fix-engine/tier3-complex");
    const { FixLearner } = require("../fix-engine/fix-learner");

    // Stage 1: Parse + extract hint
    const msg = "Property 'forEch' does not exist. Did you mean 'forEach'?";
    const hint = extractHints(msg, msg, "TypeScript");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("forEach");

    // Stage 4: Classify with hint attached
    const plugin = {
      errorCatalog: { categories: [{ errors: [{
        code: "TS2551",
        baseCrossFileProbability: 0.1,
        messagePattern: "Property '(?<wrong>\\w+)' does not exist.*Did you mean '(?<right>\\w+)'",
        captures: [{ name: "wrong" }, { name: "right" }],
        refinements: [],
        fixHint: { primaryStrategy: "apply_compiler_hint", typicalScope: "single_line" },
        coOccurrence: [],
        codeBlock: "// Before: arr.forEch()\n// After: arr.forEach()",
      }]}]},
    };
    const errors = [{ file: "app.ts", line: 10, code: "TS2551", message: msg, hint }];
    const classified = classifyErrors(errors, null, plugin);
    expect(classified[0].fixHint.primaryStrategy).toBe("apply_compiler_hint");
    expect(classified[0].captures.wrong).toBe("forEch");

    // Stage 2: Fix ordering
    const ranks = new Map([["app.ts", { depth: 0, isRoot: true, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }]]);
    const plan = computeFixOrder(classified, ranks);
    expect(plan.queue2.length).toBe(1); // isolated error

    // Stage 3+5: Context building (includes codeBlock, function extraction, diagnosis-first, LANGUAGE)
    const content = "import { x } from './y';\n\nfunction processItems(arr) {\n  const items = [];\n  for (const item of arr) {\n    items.push(item);\n  }\n  arr.forEch(i => console.log(i));\n  return items;\n}\n";
    const ctx = buildComplexContext({ ...classified[0], codeBlock: plugin.errorCatalog.categories[0].errors[0].codeBlock }, content, null, ranks);
    expect(ctx.promptBlock).toBeDefined();
    expect(ctx.promptBlock.length).toBeGreaterThan(50);
    // Verify language is in the prompt
    expect(ctx.promptBlock).toContain("TypeScript");

    // Stage 6: Record outcome
    const fs = require("fs");
    const testFile = require("path").join(require("os").tmpdir(), "test-pipeline.jsonl");
    try { fs.unlinkSync(testFile); } catch (_) {}
    const learner = new FixLearner(testFile);
    learner.recordOutcome({ errorCode: "TS2551", strategy: "apply_compiler_hint", language: "TypeScript", file: "app.ts", passed: true, confidence: 0.95 });
    const similar = learner.getSimilarSuccessfulFix("TS2551", {}, "TypeScript");
    expect(similar).not.toBeNull();
    expect(similar.strategy).toBe("apply_compiler_hint");

    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  test("pipeline works for Python errors", () => {
    const { extractHints } = require("../hint-extractor");
    const { assembleFixPrompt } = require("../prompt-template");

    // Stage 1: Python hint
    const msg = "NameError: name 'prnt' is not defined. Did you mean: 'print'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");

    // Stage 5: Prompt includes Python language
    const prompt = assembleFixPrompt({
      error: { file: "main.py", line: 5, code: "PY_NAME_ERROR", message: msg },
      hint,
      functionContext: " >>> 5: prnt('hello')",
    });
    expect(prompt).toContain("Language: Python");
    expect(prompt).toContain("Use correct Python syntax");
    expect(prompt).toContain("print");
  });

  test("pipeline works for Go errors", () => {
    const { extractHints } = require("../hint-extractor");
    const { assembleFixPrompt } = require("../prompt-template");

    // Stage 1: Go unused import
    const msg = '"fmt" imported and not used';
    const hint = extractHints(msg, msg, "Go");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("unused_import");

    // Stage 5: Prompt includes Go language
    const prompt = assembleFixPrompt({
      error: { file: "main.go", line: 3, code: "GO_UNUSED", message: msg },
      hint,
    });
    expect(prompt).toContain("Language: Go");
    expect(prompt).toContain("Use correct Go syntax");
  });

  test("pipeline works for Rust errors", () => {
    const { assembleFixPrompt } = require("../prompt-template");
    const prompt = assembleFixPrompt({
      error: { file: "lib.rs", line: 10, code: "E0308", message: "mismatched types" },
      classification: { rootCause: "Expected i32, found &str", prescription: "Convert type or change annotation" },
    });
    expect(prompt).toContain("Language: Rust");
    expect(prompt).toContain("Use correct Rust syntax");
  });

  test("pipeline works for Java errors", () => {
    const { assembleFixPrompt } = require("../prompt-template");
    const prompt = assembleFixPrompt({
      error: { file: "App.java", line: 15, code: "JAVA_ERR", message: "cannot find symbol" },
    });
    expect(prompt).toContain("Language: Java");
  });

  test("pipeline works for C# errors", () => {
    const { assembleFixPrompt } = require("../prompt-template");
    const prompt = assembleFixPrompt({
      error: { file: "Program.cs", line: 8, code: "CS0246", message: "type or namespace not found" },
    });
    expect(prompt).toContain("Language: C#");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/full-integration.test.js --no-coverage -t "6-Stage"`
Expected: PASS

- [ ] **Step 3: Run ALL smart-fix tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/ --no-coverage`
Expected: All PASS (107 existing + ~15 new = ~122 tests)

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/tests/full-integration.test.js
git commit -m "test: add 6-stage pipeline integration test"
```

---

## Task 14: Update smart-fix/index.js Exports

**Files:**
- Modify: `smart-fix/index.js`

- [ ] **Step 1: Add new module exports**

```javascript
// Add to smart-fix/index.js:
const { extractHints } = require("./hint-extractor");
const { extractEnclosingFunction } = require("./function-extractor");
const { assembleFixPrompt, detectLanguageFromFile } = require("./prompt-template");

// Add to module.exports:
module.exports = {
  // ...existing exports...
  extractHints,
  extractEnclosingFunction,
  assembleFixPrompt,
  detectLanguageFromFile,
};
```

- [ ] **Step 2: Run smoke test**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && node -e "const sf = require('./smart-fix'); console.log(Object.keys(sf).sort().join(', '))"`
Expected: Lists all exports including new ones

- [ ] **Step 3: Commit**

```bash
cd C:/Users/Attar/Desktop/Cli/Attar-Code
git add smart-fix/index.js
git commit -m "chore: export new modules from smart-fix index"
```

---

## Task 15: Final Verification — Run CLI with Test Project

**Files:** None (manual verification)

- [ ] **Step 1: Run full test suite**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/ --no-coverage --verbose 2>&1 | tail -30`
Expected: All tests pass, including ~15 new tests

- [ ] **Step 2: Smoke test CLI startup**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && timeout 10 node attar-code.js --model glm-4.7-flash:latest --prompt "read file package.json" 2>&1 | head -20`
Expected: CLI starts, processes prompt, exits cleanly

- [ ] **Step 3: Verify hint extractor works with real build output**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && node -e "
const { extractHints } = require('./smart-fix/hint-extractor');
console.log(extractHints('Did you mean forEach?', '', 'TypeScript'));
console.log(extractHints('cannot find value prnt', 'help: a macro with a similar name exists: print', 'Rust'));
console.log(extractHints('No module named utils', 'Did you mean: util?', 'Python'));
"`
Expected: 3 non-null hint objects

- [ ] **Step 4: Final commit with all changes**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && git log --oneline -15`
Expected: 13 clean commits for the 6-stage pipeline

---

## Summary

| Task | Stage | What It Does | New Files | Modified Files |
|------|-------|-------------|-----------|---------------|
| 1 | 1A | Compiler hint extraction | 2 | 0 |
| 2 | 1B | Wire hints into parseBuildErrors | 0 | 1 |
| 3 | 1C+4 | Compiler-hint auto-fix (tier1) | 0 | 2 |
| 4 | 2A | Recursive origin tracing | 0 | 2 |
| 5 | 2B | coOccurrence + transitive ordering | 0 | 2 |
| 6 | 3A | Function-level context extraction | 2 | 0 |
| 7 | 3B+4 | codeBlock + function context in tier3 | 0 | 2 |
| 8 | 4 | codeBlock in tier2 [CHOICE] blocks | 0 | 2 |
| 9 | 5A | Unified diagnosis-first template | 2 | 0 |
| 10 | 5B | Wire template into tier3 | 0 | 1 |
| 11 | 6A | Cross-session outcome loading | 0 | 2 |
| 12 | 6B | Wire past-fix lookup into engine | 0 | 3 |
| 13 | ALL | Integration test | 0 | 1 |
| 14 | — | Export new modules | 0 | 1 |
| 15 | — | Final verification | 0 | 0 |

**Total: 6 new files, 19 file modifications, ~15 tasks, ~60 steps**
**Estimated new code: ~450 lines implementation + ~250 lines tests = ~700 lines**
