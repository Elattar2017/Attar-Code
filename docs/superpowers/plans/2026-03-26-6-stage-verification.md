# 6-Stage Fix Pipeline — Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify all 6 stages work correctly with real-world error scenarios across all supported languages, identify remaining gaps, and produce a findings report with enhancement recommendations.

**Architecture:** Each task is a targeted probe that tests one stage with realistic inputs. Tasks 1-6 test individual stages. Task 7 tests cross-stage integration. Task 8 tests with the actual CLI against a real project. Task 9 compiles findings into a report.

**Tech Stack:** Node.js, Jest, Attar-Code CLI with Ollama (glm-4.7-flash:latest)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `smart-fix/tests/verify-stage1-parser.test.js` | CREATE | Stage 1: Real compiler output parsing |
| `smart-fix/tests/verify-stage2-rootcause.test.js` | CREATE | Stage 2: Cascading error collapse |
| `smart-fix/tests/verify-stage3-context.test.js` | CREATE | Stage 3: Function extraction edge cases |
| `smart-fix/tests/verify-stage4-classifier.test.js` | CREATE | Stage 4: codeBlock surfacing + hint auto-fix |
| `smart-fix/tests/verify-stage5-prompt.test.js` | CREATE | Stage 5: Prompt structure + language accuracy |
| `smart-fix/tests/verify-stage6-feedback.test.js` | CREATE | Stage 6: Cross-session learning + promotion |
| `smart-fix/tests/verify-cross-stage.test.js` | CREATE | Cross-stage: Full pipeline real-world errors |
| `docs/6-STAGE-VERIFICATION-REPORT.md` | CREATE | Final findings report |

---

## Task 1: Verify Stage 1 — Multi-Format Parser + Hint Extraction

**Files:**
- Create: `smart-fix/tests/verify-stage1-parser.test.js`

Tests real compiler output (not simplified snippets) to verify hints are extracted correctly and edge cases are handled.

- [ ] **Step 1: Write verification tests with REAL compiler output**

```javascript
// smart-fix/tests/verify-stage1-parser.test.js
const { extractHints } = require("../hint-extractor");

describe("Stage 1 Verification: Real Compiler Output", () => {

  // === RUST: Multi-line output with help spanning several lines ===
  test("Rust: extracts hint from multi-line error with decorators between", () => {
    const fullOutput = `error[E0425]: cannot find value \`prntln\` in this scope
  --> src/main.rs:12:5
   |
12 |     prntln!("Hello, world!");
   |     ^^^^^^ not found in this scope
   |
help: a macro with a similar name exists
   |
12 |     println!("Hello, world!");
   |     ~~~~~~~
   = note: \`println\` is defined in the standard library`;
    const hint = extractHints("cannot find value `prntln` in this scope", fullOutput, "Rust");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("println");
  });

  test("Rust: extracts 'consider borrowing' hint", () => {
    const msg = "expected `&str`, found `String`";
    const fullOutput = `error[E0308]: mismatched types
  --> src/lib.rs:5:20
   |
5  |     let s: &str = my_string;
   |                    ^^^^^^^^^ expected \`&str\`, found \`String\`
   |
help: consider borrowing here: \`&my_string\``;
    const hint = extractHints(msg, fullOutput, "Rust");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("borrow_suggestion");
    expect(hint.suggestion).toBe("&my_string");
  });

  // === PYTHON: Full traceback with multiple frames ===
  test("Python: hint from NameError with suggestion", () => {
    const msg = "NameError: name 'pritn' is not defined. Did you mean: 'print'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
    expect(hint.applicability).toBe("MachineApplicable");
  });

  test("Python: hint from AttributeError", () => {
    const msg = "AttributeError: module 'os' has no attribute 'pathh'. Did you mean: 'path'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("path");
  });

  // === GO: Real go build output ===
  test("Go: unused import with full path", () => {
    const msg = '"github.com/gin-gonic/gin" imported and not used';
    const hint = extractHints(msg, msg, "Go");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("unused_import");
    expect(hint.suggestion).toBe("github.com/gin-gonic/gin");
  });

  test("Go: declared and not used", () => {
    const msg = "err declared and not used";
    const hint = extractHints(msg, msg, "Go");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("unused_variable");
    expect(hint.suggestion).toBe("err");
  });

  // === TYPESCRIPT: Real tsc output ===
  test("TypeScript: 'Did you mean to use' suggestion", () => {
    const msg = "Cannot find name 'React'. Did you mean to use 'React'?";
    const hint = extractHints(msg, msg, "TypeScript");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("React");
  });

  // === EDGE CASES ===
  test("handles null message gracefully", () => {
    const hint = extractHints(null, null, "TypeScript");
    expect(hint).toBeNull();
  });

  test("handles empty string", () => {
    const hint = extractHints("", "", "Python");
    expect(hint).toBeNull();
  });

  test("handles undefined language", () => {
    const msg = "Did you mean 'test'?";
    const hint = extractHints(msg, msg, undefined);
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("test");
  });

  test("handles very long output without ReDoS", () => {
    // Simulate a 10KB build output with no hint — should return quickly
    const longOutput = "error: something\n".repeat(500) + "cannot find symbol";
    const start = Date.now();
    const hint = extractHints("cannot find symbol", longOutput, "Java");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should not take >100ms
  });

  // === C# ===
  test("C#: 'Are you missing' suggestion", () => {
    const msg = "The type or namespace name 'JsonConvert' could not be found. Are you missing 'Newtonsoft.Json' using directive?";
    const hint = extractHints(msg, msg, "CSharp");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("missing_reference");
    expect(hint.suggestion).toBe("Newtonsoft.Json");
  });

  // === SWIFT ===
  test("Swift: did you mean suggestion", () => {
    const msg = "use of unresolved identifier 'prnt'; did you mean 'print'?";
    const hint = extractHints(msg, msg, "Swift");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");
  });
});
```

- [ ] **Step 2: Run verification tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-stage1-parser.test.js --no-coverage --verbose`
Expected: All PASS. Document any failures — they reveal parser gaps.

- [ ] **Step 3: Record findings**

Create a temporary findings object noting:
- Which tests passed/failed
- Any patterns that need adjustment
- Languages with no hint coverage

---

## Task 2: Verify Stage 2 — Root Cause Engine

**Files:**
- Create: `smart-fix/tests/verify-stage2-rootcause.test.js`

Tests cascading error collapse with realistic multi-file error sets.

- [ ] **Step 1: Write verification tests**

```javascript
// smart-fix/tests/verify-stage2-rootcause.test.js
const { classifyErrors } = require("../error-classifier");
const { computeFixOrder } = require("../fix-order");

describe("Stage 2 Verification: Root Cause Collapse", () => {

  // Scenario: 10 errors across 4 files, but only 1 root cause (missing type definition)
  test("collapses 10 cascading errors to 1 root cause file", () => {
    const mockTree = {
      getFileAnalysis: (file) => {
        const analyses = {
          "types.ts": { imports: [], definitions: [{ name: "User", kind: "interface" }], exports: [{ symbols: ["User"] }] },
          "service.ts": { imports: [{ rawSource: "./types", symbols: ["User"], isExternal: false }], definitions: [], exports: [{ symbols: ["getUser"] }] },
          "controller.ts": { imports: [{ rawSource: "./service", symbols: ["getUser"], isExternal: false }, { rawSource: "./types", symbols: ["User"], isExternal: false }], definitions: [], exports: [] },
          "routes.ts": { imports: [{ rawSource: "./controller", symbols: ["handler"], isExternal: false }], definitions: [], exports: [] },
        };
        return analyses[file] || null;
      },
      _resolveImportPath: (from, source) => {
        const map = { "./types": "types.ts", "./service": "service.ts", "./controller": "controller.ts" };
        return map[source] || null;
      },
    };

    const plugin = {
      errorCatalog: { categories: [{ errors: [{
        code: "TS2304",
        baseCrossFileProbability: 0.7,
        messagePattern: "Cannot find name '(?<symbol>\\w+)'",
        captures: [{ name: "symbol" }],
        refinements: [{ check: { type: "is_imported", target: "symbol" }, adjustedProbability: 0.9, traceTarget: "cross_file" }],
        fixHint: null,
        coOccurrence: ["TS2305", "TS2307"],
      }]}]},
    };

    // 10 errors: 3 in controller, 4 in routes, 2 in service, 1 in types (the root)
    const errors = [
      { file: "controller.ts", line: 5, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "controller.ts", line: 8, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "controller.ts", line: 12, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "routes.ts", line: 3, code: "TS2304", message: "Cannot find name 'handler'" },
      { file: "routes.ts", line: 7, code: "TS2304", message: "Cannot find name 'handler'" },
      { file: "routes.ts", line: 11, code: "TS2304", message: "Cannot find name 'handler'" },
      { file: "routes.ts", line: 15, code: "TS2304", message: "Cannot find name 'handler'" },
      { file: "service.ts", line: 2, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "service.ts", line: 6, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "types.ts", line: 1, code: "TS2304", message: "Cannot find name 'SomeType'" },
    ];

    const classified = classifyErrors(errors, mockTree, plugin);

    // Verify recursive tracing: controller errors should trace through service to types
    const controllerErrors = classified.filter(e => e.file === "controller.ts");
    for (const err of controllerErrors) {
      expect(err.originFile).toBe("types.ts");
    }

    // Verify fix ordering: types.ts should be in queue1 (root cause)
    const ranks = new Map([
      ["types.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: true, dependentCount: 3, transitiveDependentCount: 3, inCircularDependency: false }],
      ["service.ts", { depth: 1, isRoot: false, isLeaf: false, isHub: false, dependentCount: 1, transitiveDependentCount: 2, inCircularDependency: false }],
      ["controller.ts", { depth: 2, isRoot: false, isLeaf: false, isHub: false, dependentCount: 1, transitiveDependentCount: 1, inCircularDependency: false }],
      ["routes.ts", { depth: 3, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(classified, ranks);

    // Root cause (types.ts) should be in queue1
    const q1Files = plan.queue1.map(g => g.file);
    expect(q1Files).toContain("types.ts");

    // Auto-resolvable should include some downstream errors
    expect(plan.autoResolvable.length).toBeGreaterThan(0);

    // Total should be 10
    expect(plan.stats.totalErrors).toBe(10);
  });

  // Scenario: coOccurrence-based root cause (no import chain, just error pattern correlation)
  test("coOccurrence identifies root cause without import chain", () => {
    const errors = [
      { file: "a.py", line: 1, code: "E0001", message: "syntax error", crossFileProbability: 0.1, originFile: null, coOccurrence: ["E0002", "E0003"], fixHint: null },
      { file: "b.py", line: 5, code: "E0002", message: "indent error", crossFileProbability: 0.1, originFile: null, coOccurrence: ["E0001"], fixHint: null },
      { file: "c.py", line: 8, code: "E0003", message: "name error", crossFileProbability: 0.1, originFile: null, coOccurrence: ["E0001"], fixHint: null },
    ];
    const ranks = new Map([
      ["a.py", { depth: 0, isRoot: true, isLeaf: false, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
      ["b.py", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
      ["c.py", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    // E0001 co-occurs with both others → should be prioritized
    const q1Codes = plan.queue1.flatMap(g => g.errors.map(e => e.code));
    expect(q1Codes).toContain("E0001");
  });

  test("handles circular imports without infinite loop", () => {
    const mockTree = {
      getFileAnalysis: (file) => {
        if (file === "a.ts") return { imports: [{ rawSource: "./b", symbols: ["X"], isExternal: false }], definitions: [], exports: [{ symbols: ["Y"] }] };
        if (file === "b.ts") return { imports: [{ rawSource: "./a", symbols: ["Y"], isExternal: false }], definitions: [], exports: [{ symbols: ["X"] }] };
        return null;
      },
      _resolveImportPath: (from, source) => ({ "./a": "a.ts", "./b": "b.ts" }[source] || null),
    };

    const plugin = {
      errorCatalog: { categories: [{ errors: [{
        code: "TS2304", baseCrossFileProbability: 0.7,
        messagePattern: "Cannot find name '(?<symbol>\\w+)'",
        captures: [{ name: "symbol" }],
        refinements: [{ check: { type: "is_imported", target: "symbol" }, adjustedProbability: 0.9, traceTarget: "cross_file" }],
        fixHint: null, coOccurrence: [],
      }]}]},
    };

    const errors = [{ file: "a.ts", line: 1, code: "TS2304", message: "Cannot find name 'X'" }];
    // Should NOT hang or throw — visited set prevents infinite recursion
    const classified = classifyErrors(errors, mockTree, plugin);
    expect(classified).toHaveLength(1);
    expect(classified[0].originFile).toBeDefined();
  });
});
```

- [ ] **Step 2: Run verification tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-stage2-rootcause.test.js --no-coverage --verbose`

- [ ] **Step 3: Record findings**

---

## Task 3: Verify Stage 3 — Deep Context Builder

**Files:**
- Create: `smart-fix/tests/verify-stage3-context.test.js`

Tests function extraction with real-world code patterns across multiple languages.

- [ ] **Step 1: Write verification tests**

```javascript
// smart-fix/tests/verify-stage3-context.test.js
const { extractEnclosingFunction } = require("../function-extractor");
const { buildComplexContext } = require("../fix-engine/tier3-complex");

describe("Stage 3 Verification: Function Extraction Edge Cases", () => {

  test("TypeScript: extracts async arrow function", () => {
    const code = `import { db } from './db';

const fetchUser = async (id: string) => {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!user) {
    throw new Error('User not found');
  }
  return user.rows[0];
};

export default fetchUser;`;
    const result = extractEnclosingFunction(code, 6, "TypeScript");
    expect(result.name).toBe("fetchUser");
    expect(result.code).toContain("async");
    expect(result.code).toContain("return user.rows[0]");
  });

  test("Python: extracts class method (indented def)", () => {
    const code = `class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, user_id):
        result = self.db.query(user_id)
        if not result:
            raise ValueError("Not found")
        return result

    def delete_user(self, user_id):
        pass`;
    const result = extractEnclosingFunction(code, 7, "Python");
    expect(result.name).toBe("get_user");
    expect(result.code).toContain("def get_user");
    expect(result.code).toContain("return result");
    // Should NOT include delete_user
    expect(result.code).not.toContain("delete_user");
  });

  test("Rust: extracts impl method with lifetime", () => {
    const code = `struct App {
    name: String,
}

impl App {
    pub fn new(name: &str) -> Self {
        App {
            name: name.to_string(),
        }
    }

    pub fn run(&self) -> Result<(), Box<dyn std::error::Error>> {
        let config = self.load_config()?;
        self.start(config)?;
        Ok(())
    }
}`;
    const result = extractEnclosingFunction(code, 14, "Rust");
    expect(result.name).toBe("run");
    expect(result.code).toContain("pub fn run");
    expect(result.code).toContain("Ok(())");
  });

  test("Java: extracts method with annotations", () => {
    const code = `public class UserController {
    private final UserService service;

    @GetMapping("/users/{id}")
    public ResponseEntity<User> getUser(@PathVariable Long id) {
        User user = service.findById(id);
        if (user == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(user);
    }

    @PostMapping("/users")
    public User createUser(@RequestBody User user) {
        return service.save(user);
    }
}`;
    const result = extractEnclosingFunction(code, 7, "Java");
    expect(result.name).toBe("getUser");
    expect(result.code).toContain("getUser");
    expect(result.code).toContain("ResponseEntity.ok(user)");
  });

  test("Go: extracts method receiver function", () => {
    const code = `package main

import "fmt"

func (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) {
    data := s.fetchData(r.URL.Path)
    if data == nil {
        http.Error(w, "not found", 404)
        return
    }
    fmt.Fprintf(w, "%v", data)
}

func (s *Server) start() {
    fmt.Println("starting")
}`;
    const result = extractEnclosingFunction(code, 8, "Go");
    // Go method receivers: func (s *Server) handleRequest(...)
    // The pattern should catch this
    expect(result.code).toContain("handleRequest");
  });

  test("PHP: extracts class method", () => {
    const code = `<?php
class UserController {
    public function index(Request $request) {
        $users = User::all();
        $filtered = $users->filter(function ($user) {
            return $user->active;
        });
        return response()->json($filtered);
    }

    public function show($id) {
        return User::find($id);
    }
}`;
    const result = extractEnclosingFunction(code, 5, "PHP");
    expect(result.name).toBe("index");
    expect(result.code).toContain("function index");
  });

  test("falls back gracefully for unsupported language", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = extractEnclosingFunction(code, 20, "Haskell");
    // Should fall back to ±15 lines
    expect(result.startLine).toBe(5);  // 20 - 15
    expect(result.endLine).toBe(35);   // 20 + 15
    expect(result.name).toBeNull();
  });

  test("buildComplexContext includes Language: in prompt", () => {
    const error = { file: "main.go", line: 5, code: "ERR", message: "undefined: foo", fixHint: null };
    const content = "package main\n\nfunc main() {\n\tx := 1\n\tfoo(x)\n}\n";
    const result = buildComplexContext(error, content, null, null);
    expect(result.promptBlock).toContain("Go");
  });
});
```

- [ ] **Step 2: Run verification tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-stage3-context.test.js --no-coverage --verbose`

- [ ] **Step 3: Record findings**

---

## Task 4: Verify Stage 4 — Error Classifier + codeBlock Surfacing

**Files:**
- Create: `smart-fix/tests/verify-stage4-classifier.test.js`

- [ ] **Step 1: Write verification tests**

```javascript
// smart-fix/tests/verify-stage4-classifier.test.js
const { generateDeterministicFix } = require("../fix-engine/tier1-deterministic");
const { generateHeuristicCandidates } = require("../fix-engine/tier2-heuristic");
const { buildComplexContext } = require("../fix-engine/tier3-complex");

describe("Stage 4 Verification: Classification + codeBlock", () => {

  test("tier1: auto-fixes TypeScript 'did you mean' with high confidence", () => {
    const error = {
      file: "app.ts", line: 1, code: "TS2551",
      message: "Property 'incldes' does not exist. Did you mean 'includes'?",
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "includes", type: "did_you_mean", applicability: "MachineApplicable" },
      captures: { wrong: "incldes" },
    };
    const content = 'const result = arr.incldes("test");';
    const fix = generateDeterministicFix(error, content, null, "TypeScript");
    expect(fix).not.toBeNull();
    expect(fix.patch.text).toBe('const result = arr.includes("test");');
    expect(fix.confidence).toBe(0.95);
  });

  test("tier1: auto-removes Go unused import", () => {
    const error = {
      file: "main.go", line: 2, code: "GO_UNUSED",
      message: '"fmt" imported and not used',
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "fmt", type: "unused_import", applicability: "MachineApplicable" },
      captures: {},
    };
    const content = 'package main\nimport "fmt"\n\nfunc main() {}';
    const fix = generateDeterministicFix(error, content, null, "Go");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("apply_compiler_hint");
    expect(fix.patch.action).toBe("delete_line");
  });

  test("tier1: rejects MaybeIncorrect hint (does not auto-apply)", () => {
    const error = {
      file: "lib.rs", line: 1, code: "E0425",
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "println", type: "did_you_mean", applicability: "MaybeIncorrect" },
      captures: { wrong: "prntln" },
      message: "cannot find value",
    };
    const fix = generateDeterministicFix(error, 'prntln!("hello");', null, "Rust");
    expect(fix).toBeNull();
  });

  test("tier2: codeBlock appears in [CHOICE] prompt", () => {
    const error = {
      file: "app.ts", line: 5, code: "TS2322",
      message: "Type 'number' not assignable to 'string'",
      fixHint: { primaryStrategy: "cast_type" },
      codeBlock: "// Wrong: const x: string = 123;\n// Fixed: const x: string = String(123);",
    };
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst x: string = 123;\nconst e = 5;";
    const result = generateHeuristicCandidates(error, content, {}, "TypeScript");
    if (result) {
      expect(result.promptBlock).toContain("Reference fix");
      expect(result.promptBlock).toContain("// Wrong");
      expect(result.promptBlock).toContain("Language: TypeScript");
    }
  });

  test("tier3: codeBlock appears in complex prompt", () => {
    const error = {
      file: "main.py", line: 3, code: "PY_ERR",
      message: "IndentationError",
      fixHint: { primaryStrategy: "fix_syntax" },
      codeBlock: "# Wrong:\nif True:\nprint('hi')\n# Fixed:\nif True:\n    print('hi')",
    };
    const content = "def test():\n    if True:\n    print('hi')\n    return 1\n";
    const result = buildComplexContext(error, content, null, null);
    expect(result.promptBlock).toContain("Fix example");
    expect(result.promptBlock).toContain("# Wrong");
    expect(result.promptBlock).toContain("Language: Python");
  });
});
```

- [ ] **Step 2: Run verification tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-stage4-classifier.test.js --no-coverage --verbose`

- [ ] **Step 3: Record findings**

---

## Task 5: Verify Stage 5 — Prompt Assembly

**Files:**
- Create: `smart-fix/tests/verify-stage5-prompt.test.js`

- [ ] **Step 1: Write verification tests**

```javascript
// smart-fix/tests/verify-stage5-prompt.test.js
const { assembleFixPrompt, detectLanguageFromFile } = require("../prompt-template");

describe("Stage 5 Verification: Prompt Structure", () => {

  test("all 7 sections appear in correct order for a complete input", () => {
    const prompt = assembleFixPrompt({
      error: { file: "app.ts", line: 10, code: "TS2304", message: "Cannot find name 'User'" },
      language: "TypeScript",
      classification: { rootCause: "Missing import", prescription: "Add import statement" },
      hint: { suggestion: "User", applicability: "MachineApplicable" },
      pastFix: { strategy: "add_import", file: "old.ts", confidence: 0.9 },
      codeBlock: "// Before: (missing)\n// After: import { User } from './models';",
      functionContext: " >>> 10: const u: User = {}",
      dependencies: [{ file: "models.ts", definitions: ["interface User"] }],
      dependents: [{ file: "routes.ts", imports: ["handler"] }],
      cascadeRisk: "HIGH",
    });

    // Verify ordering: Language → Error → Diagnosis → PastFix → Hint → Example → Code → Deps → Instruction
    const positions = {
      language: prompt.indexOf("Language: TypeScript"),
      errorType: prompt.indexOf("[ERROR TYPE]"),
      diagnosis: prompt.indexOf("DIAGNOSIS"),
      pastFix: prompt.indexOf("Previously successful"),
      hint: prompt.indexOf("Compiler suggestion"),
      example: prompt.indexOf("Fix example"),
      context: prompt.indexOf("Code context"),
      deps: prompt.indexOf("Available from imported"),
      affected: prompt.indexOf("Files affected"),
      instruction: prompt.indexOf("Fix this error"),
    };

    // Every section must exist
    for (const [name, pos] of Object.entries(positions)) {
      expect(pos).toBeGreaterThanOrEqual(0);
    }

    // Correct order
    expect(positions.language).toBeLessThan(positions.errorType);
    expect(positions.errorType).toBeLessThan(positions.diagnosis);
    expect(positions.diagnosis).toBeLessThan(positions.pastFix);
    expect(positions.pastFix).toBeLessThan(positions.hint);
    expect(positions.hint).toBeLessThan(positions.example);
    expect(positions.example).toBeLessThan(positions.context);
    expect(positions.context).toBeLessThan(positions.deps);
    expect(positions.deps).toBeLessThan(positions.affected);
    expect(positions.affected).toBeLessThan(positions.instruction);
  });

  test("language-aware instruction for each supported language", () => {
    const languages = [
      { file: "x.ts", expected: "TypeScript" },
      { file: "x.py", expected: "Python" },
      { file: "x.go", expected: "Go" },
      { file: "x.rs", expected: "Rust" },
      { file: "x.java", expected: "Java" },
      { file: "x.cs", expected: "C#" },
      { file: "x.php", expected: "PHP" },
      { file: "x.swift", expected: "Swift" },
      { file: "x.kt", expected: "Kotlin" },
      { file: "x.cpp", expected: "C++" },
      { file: "x.rb", expected: "Ruby" },
      { file: "x.dart", expected: "Dart" },
    ];
    for (const { file, expected } of languages) {
      const prompt = assembleFixPrompt({ error: { file, line: 1, code: "ERR", message: "error" } });
      expect(prompt).toContain(`Language: ${expected}`);
      expect(prompt).toContain(`Use correct ${expected} syntax`);
    }
  });

  test("detectLanguageFromFile handles all extensions", () => {
    expect(detectLanguageFromFile("test.ts")).toBe("TypeScript");
    expect(detectLanguageFromFile("test.tsx")).toContain("TypeScript");
    expect(detectLanguageFromFile("test.mjs")).toContain("JavaScript");
    expect(detectLanguageFromFile("test.cjs")).toContain("JavaScript");
    expect(detectLanguageFromFile("test.pyw")).toBe("Python");
    expect(detectLanguageFromFile("test.kts")).toBe("Kotlin");
    expect(detectLanguageFromFile("test.cc")).toBe("C++");
    expect(detectLanguageFromFile("test.ex")).toBe("Elixir");
    expect(detectLanguageFromFile("test.zig")).toBe("Zig");
    expect(detectLanguageFromFile("test.scala")).toBe("Scala");
    expect(detectLanguageFromFile("test.unknown")).toBeNull();
  });

  test("minimal input (just error) still produces valid prompt", () => {
    const prompt = assembleFixPrompt({ error: { file: "x.js", line: 1, code: "ERR", message: "bad" } });
    expect(prompt).toContain("Language: JavaScript");
    expect(prompt).toContain("[ERROR TYPE]");
    expect(prompt).toContain("Fix this error");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });
});
```

- [ ] **Step 2: Run verification tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-stage5-prompt.test.js --no-coverage --verbose`

- [ ] **Step 3: Record findings**

---

## Task 6: Verify Stage 6 — Feedback Loop

**Files:**
- Create: `smart-fix/tests/verify-stage6-feedback.test.js`

- [ ] **Step 1: Write verification tests**

```javascript
// smart-fix/tests/verify-stage6-feedback.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FixLearner } = require("../fix-engine/fix-learner");

describe("Stage 6 Verification: Feedback Loop", () => {
  const tmpFile = path.join(os.tmpdir(), `verify-learner-${Date.now()}.jsonl`);

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  test("cross-session: learns from past TypeScript fixes", () => {
    // Simulate past sessions
    const pastData = Array.from({ length: 10 }, (_, i) => JSON.stringify({
      timestamp: new Date(Date.now() - i * 86400000).toISOString(),
      errorCode: "TS2304", strategy: "add_import", language: "TypeScript",
      file: `file${i}.ts`, passed: true, confidence: 0.85,
    })).join("\n") + "\n";
    fs.writeFileSync(tmpFile, pastData);

    const learner = new FixLearner(tmpFile);
    const fix = learner.getSimilarSuccessfulFix("TS2304", {}, "TypeScript");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import");
    expect(fix.passed).toBe(true);
  });

  test("cross-session: learns from past Python fixes", () => {
    const pastData = [
      { errorCode: "PY_IMPORT", strategy: "add_import", language: "Python", passed: true },
      { errorCode: "PY_IMPORT", strategy: "update_import_path", language: "Python", passed: false },
    ].map(o => JSON.stringify(o)).join("\n") + "\n";
    fs.writeFileSync(tmpFile, pastData);

    const learner = new FixLearner(tmpFile);
    const fix = learner.getSimilarSuccessfulFix("PY_IMPORT", {}, "Python");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import"); // returns successful one
  });

  test("promotion after 5 consecutive successes", () => {
    const learner = new FixLearner(tmpFile);
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({
        errorCode: "TS2551", strategy: "apply_compiler_hint",
        language: "TypeScript", file: `f${i}.ts`, passed: true, confidence: 0.95,
      });
    }
    const promoted = learner.getPromotedStrategies("TypeScript");
    expect(promoted["TS2551"]).toBe("apply_compiler_hint");
  });

  test("promotion persists to disk", () => {
    const learner1 = new FixLearner(tmpFile);
    for (let i = 0; i < 5; i++) {
      learner1.recordOutcome({
        errorCode: "E0308", strategy: "cast_type",
        language: "Rust", file: `f${i}.rs`, passed: true, confidence: 0.9,
      });
    }

    // New learner instance should load promoted strategies
    const learner2 = new FixLearner(tmpFile);
    const promoted = learner2.getPromotedStrategies("Rust");
    expect(promoted["E0308"]).toBe("cast_type");
  });

  test("does not promote after mixed results", () => {
    const learner = new FixLearner(tmpFile);
    for (let i = 0; i < 3; i++) {
      learner.recordOutcome({ errorCode: "GO_ERR", strategy: "add_import", language: "Go", file: `f${i}.go`, passed: true, confidence: 0.8 });
    }
    learner.recordOutcome({ errorCode: "GO_ERR", strategy: "add_import", language: "Go", file: "f3.go", passed: false, confidence: 0.5 });
    learner.recordOutcome({ errorCode: "GO_ERR", strategy: "add_import", language: "Go", file: "f4.go", passed: true, confidence: 0.8 });

    const promoted = learner.getPromotedStrategies("Go");
    expect(promoted["GO_ERR"]).toBeUndefined(); // Not promoted — interrupted by failure
  });

  test("handles corrupted JSONL gracefully", () => {
    fs.writeFileSync(tmpFile, '{"valid":true}\n{broken json\n{"also":"valid"}\n');
    const learner = new FixLearner(tmpFile);
    // Should load 2 valid lines, skip 1 broken
    expect(learner.recentOutcomes.length).toBe(2);
  });

  test("caps at 500 most recent outcomes", () => {
    const data = Array.from({ length: 600 }, (_, i) => JSON.stringify({ errorCode: `E${i}`, passed: true })).join("\n") + "\n";
    fs.writeFileSync(tmpFile, data);
    const learner = new FixLearner(tmpFile);
    expect(learner.recentOutcomes.length).toBe(500);
    // Should have the LAST 500 (E100-E599)
    expect(learner.recentOutcomes[0].errorCode).toBe("E100");
  });
});
```

- [ ] **Step 2: Run verification tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-stage6-feedback.test.js --no-coverage --verbose`

- [ ] **Step 3: Record findings**

---

## Task 7: Verify Cross-Stage Integration

**Files:**
- Create: `smart-fix/tests/verify-cross-stage.test.js`

Tests the full pipeline with realistic multi-language scenarios.

- [ ] **Step 1: Write cross-stage verification tests**

```javascript
// smart-fix/tests/verify-cross-stage.test.js
const { extractHints } = require("../hint-extractor");
const { classifyErrors } = require("../error-classifier");
const { computeFixOrder } = require("../fix-order");
const { extractEnclosingFunction } = require("../function-extractor");
const { assembleFixPrompt } = require("../prompt-template");
const { generateDeterministicFix } = require("../fix-engine/tier1-deterministic");
const { buildComplexContext } = require("../fix-engine/tier3-complex");
const { FixLearner } = require("../fix-engine/fix-learner");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("Cross-Stage Verification", () => {

  test("TypeScript full pipeline: hint → auto-fix → learn", () => {
    // Stage 1: Extract hint
    const msg = "Property 'lenght' does not exist on type 'string'. Did you mean 'length'?";
    const hint = extractHints(msg, msg, "TypeScript");
    expect(hint.suggestion).toBe("length");

    // Stage 4: Auto-fix with hint
    const error = {
      file: "utils.ts", line: 3, code: "TS2551", message: msg,
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint, captures: { wrong: "lenght" },
    };
    const content = 'function getLen(s: string) {\n  return s.lenght;\n}';
    const fix = generateDeterministicFix(error, content, null, "TypeScript");
    expect(fix).not.toBeNull();
    expect(fix.patch.text).toContain("s.length");

    // Stage 6: Record outcome
    const tmpFile = path.join(os.tmpdir(), `cross-ts-${Date.now()}.jsonl`);
    const learner = new FixLearner(tmpFile);
    learner.recordOutcome({ errorCode: "TS2551", strategy: "apply_compiler_hint", language: "TypeScript", file: "utils.ts", passed: true, confidence: 0.95 });
    const similar = learner.getSimilarSuccessfulFix("TS2551", {}, "TypeScript");
    expect(similar.strategy).toBe("apply_compiler_hint");
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  test("Python full pipeline: hint → context → prompt with Language", () => {
    // Stage 1
    const msg = "NameError: name 'pritn' is not defined. Did you mean: 'print'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint.suggestion).toBe("print");

    // Stage 3: Function extraction
    const code = "import os\n\ndef main():\n    x = 1\n    pritn(x)\n    return x\n";
    const funcCtx = extractEnclosingFunction(code, 5, "Python");
    expect(funcCtx.name).toBe("main");

    // Stage 5: Prompt with language
    const prompt = assembleFixPrompt({
      error: { file: "main.py", line: 5, code: "PY_NAME", message: msg },
      hint,
      functionContext: funcCtx.code,
    });
    expect(prompt).toContain("Language: Python");
    expect(prompt).toContain("Use correct Python syntax");
    expect(prompt).toContain("def main");
    expect(prompt).toContain("print");
  });

  test("Go full pipeline: hint → prompt → correct language", () => {
    const msg = '"net/http" imported and not used';
    const hint = extractHints(msg, msg, "Go");
    expect(hint.type).toBe("unused_import");

    const prompt = assembleFixPrompt({
      error: { file: "server.go", line: 3, code: "GO_UNUSED", message: msg },
      hint,
    });
    expect(prompt).toContain("Language: Go");
    expect(prompt).toContain("unused_import");
  });

  test("Rust: complex error → tier3 with Language + codeBlock", () => {
    const error = {
      file: "lib.rs", line: 8, code: "E0308",
      message: "mismatched types: expected i32, found &str",
      fixHint: { primaryStrategy: "cast_type", requiresCrossFileEdit: false, typicalScope: "single_line" },
      codeBlock: "// Wrong: let x: i32 = \"hello\";\n// Fixed: let x: i32 = \"hello\".parse().unwrap();",
    };
    const content = 'use std::io;\n\nfn process() -> i32 {\n    let input = io::stdin();\n    let mut buf = String::new();\n    input.read_line(&mut buf).unwrap();\n    let num: i32 = buf.trim();\n    num\n}\n';
    const ctx = buildComplexContext(error, content, null, null);
    expect(ctx.promptBlock).toContain("Rust");
    expect(ctx.promptBlock).toContain("Fix example");
    expect(ctx.promptBlock).toContain("// Wrong");
  });

  test("Java: prompt structure is complete", () => {
    const prompt = assembleFixPrompt({
      error: { file: "App.java", line: 15, code: "JAVA_ERR", message: "cannot find symbol: method toLower()" },
      classification: { rootCause: "Method name typo", prescription: "Use toLowerCase()" },
      codeBlock: "// Wrong: str.toLower()\n// Fixed: str.toLowerCase()",
    });
    expect(prompt).toContain("Language: Java");
    expect(prompt).toContain("DIAGNOSIS");
    expect(prompt).toContain("Method name typo");
    expect(prompt).toContain("Fix example");
  });

  test("C#: prompt structure is complete", () => {
    const prompt = assembleFixPrompt({
      error: { file: "Program.cs", line: 10, code: "CS0246", message: "The type 'JsonConvert' could not be found" },
      classification: { rootCause: "Missing using directive", prescription: "Add using Newtonsoft.Json" },
    });
    expect(prompt).toContain("Language: C#");
    expect(prompt).toContain("DIAGNOSIS");
  });
});
```

- [ ] **Step 2: Run cross-stage tests**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify-cross-stage.test.js --no-coverage --verbose`

- [ ] **Step 3: Record findings**

---

## Task 8: Live CLI Test with Real Project

**Files:** None (CLI invocation)

Run the CLI against a real multi-file project to verify the 6-stage pipeline works in practice.

- [ ] **Step 1: Create a small test project with intentional errors**

Create 3 files in a temp directory that have cascading errors:

File: `/tmp/test-project/types.ts`
```typescript
// Intentionally broken: 'Usr' instead of 'User'
export interface Usr {
  name: string;
  email: string;
}
```

File: `/tmp/test-project/service.ts`
```typescript
import { User } from './types';  // Will fail — types exports 'Usr' not 'User'

export function getUser(id: number): User {
  return { name: "test", email: "test@test.com" };
}
```

File: `/tmp/test-project/index.ts`
```typescript
import { getUser } from './service';

const user = getUser(1);
console.log(user.naem);  // Typo: 'naem' instead of 'name'
```

- [ ] **Step 2: Run the CLI against the test project**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && node attar-code.js --model glm-4.7-flash:latest --cwd /tmp/test-project --prompt "Run build_and_test on this TypeScript project. Show me the full error analysis output including any smart-fix analysis, fix ordering, and prescriptions. Do NOT fix anything — just analyze and report."`

Expected: The CLI should show:
- Parsed errors with file/line/code
- Root cause analysis (types.ts → service.ts cascade)
- Fix ordering (types.ts first)
- Language: TypeScript in any prompts

- [ ] **Step 3: Record CLI output and findings**

Note: If TypeScript/tsc is not available, the CLI should gracefully handle it. Record whatever output is produced.

---

## Task 9: Compile Verification Report

**Files:**
- Create: `docs/6-STAGE-VERIFICATION-REPORT.md`

- [ ] **Step 1: Run ALL verification tests at once**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/verify- --no-coverage --verbose 2>&1`

- [ ] **Step 2: Run the existing 138 test suite to confirm no regressions**

Run: `cd C:/Users/Attar/Desktop/Cli/Attar-Code && npx jest smart-fix/tests/ --no-coverage 2>&1 | tail -5`

- [ ] **Step 3: Compile the report**

Create `docs/6-STAGE-VERIFICATION-REPORT.md` with this structure:

```markdown
# 6-Stage Fix Pipeline — Verification Report

**Date:** 2026-03-26
**Tests run:** [N verification + 138 existing = total]
**Pass rate:** [X/Y]

## Stage-by-Stage Results

### Stage 1: Multi-Format Parser
- Tests: [pass/fail count]
- Findings: [what worked, what didn't]
- Gaps found: [specific patterns missing or failing]

### Stage 2: Root Cause Engine
- Tests: [pass/fail count]
- Findings: [cascading collapse worked? circular deps handled?]
- Gaps found: [any root cause misidentification]

### Stage 3: Deep Context Builder
- Tests: [pass/fail count]
- Findings: [function extraction accuracy per language]
- Gaps found: [languages where extraction failed]

### Stage 4: Error Classifier
- Tests: [pass/fail count]
- Findings: [codeBlock surfacing, hint auto-fix accuracy]
- Gaps found: [missing strategies, unsurfaced data]

### Stage 5: Prompt Assembler
- Tests: [pass/fail count]
- Findings: [section ordering correct? all languages detected?]
- Gaps found: [extensions not mapped, ordering issues]

### Stage 6: Feedback Loop
- Tests: [pass/fail count]
- Findings: [cross-session loading, promotion, corruption handling]
- Gaps found: [any persistence issues]

## Cross-Stage Integration
- [Results of cross-stage tests]

## Live CLI Test
- [Results of real project test]

## Enhancement Recommendations

### Critical (must fix)
- [list]

### Important (should fix)
- [list]

### Nice to have
- [list]

## Conclusion
[Overall assessment: is the 6-stage pipeline production-ready?]
```

- [ ] **Step 4: Present findings to user**

---

## Summary

| Task | Stage | What It Tests | Tests |
|------|-------|--------------|-------|
| 1 | 1 | Real compiler output + edge cases + ReDoS safety | ~14 |
| 2 | 2 | 10-error cascade collapse + coOccurrence + circular deps | ~3 |
| 3 | 3 | Function extraction: async, class methods, receivers, PHP, fallback | ~8 |
| 4 | 4 | Tier1 auto-fix + tier2/tier3 codeBlock surfacing | ~5 |
| 5 | 5 | Prompt ordering + 12-language detection + minimal input | ~4 |
| 6 | 6 | Cross-session + promotion + corruption + 500 cap | ~7 |
| 7 | ALL | Full pipeline for TS, Python, Go, Rust, Java, C# | ~6 |
| 8 | ALL | Live CLI with real project | Manual |
| 9 | — | Compile findings report | Report |

**Total: ~47 new verification tests + 138 existing = ~185 tests**
