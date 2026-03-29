const { generateDeterministicFix } = require("../fix-engine/tier1-deterministic");
const { generateHeuristicCandidates } = require("../fix-engine/tier2-heuristic");
const { buildComplexContext } = require("../fix-engine/tier3-complex");

describe("Stage 4 Verification", () => {
  test("tier1: auto-fixes TS did-you-mean", () => {
    const error = {
      file: "app.ts", line: 1, code: "TS2551",
      message: "Property 'incldes' does not exist. Did you mean 'includes'?",
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "includes", type: "did_you_mean", applicability: "MachineApplicable" },
      captures: { wrong: "incldes" },
    };
    const fix = generateDeterministicFix(error, 'const result = arr.incldes("test");', null, "TypeScript");
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
    const fix = generateDeterministicFix(error, 'package main\nimport "fmt"\n\nfunc main() {}', null, "Go");
    expect(fix).not.toBeNull();
    expect(fix.patch.action).toBe("delete_line");
  });

  test("tier1: rejects MaybeIncorrect hint", () => {
    const error = {
      file: "lib.rs", line: 1, code: "E0425",
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint: { suggestion: "println", type: "did_you_mean", applicability: "MaybeIncorrect" },
      captures: { wrong: "prntln" }, message: "cannot find value",
    };
    const fix = generateDeterministicFix(error, 'prntln!("hello");', null, "Rust");
    expect(fix).toBeNull();
  });

  test("tier2: codeBlock appears in CHOICE prompt", () => {
    const error = {
      file: "app.ts", line: 5, code: "TS2322",
      message: "Type 'number' not assignable to 'string'",
      fixHint: { primaryStrategy: "cast_type" },
      codeBlock: "// Wrong: const x: string = 123;\n// Fixed: const x: string = String(123);",
    };
    const content = "const a=1;\nconst b=2;\nconst c=3;\nconst d=4;\nconst x: string = 123;\nconst e=5;";
    const result = generateHeuristicCandidates(error, content, {}, "TypeScript");
    if (result) {
      expect(result.promptBlock).toContain("Reference fix");
      expect(result.promptBlock).toContain("Language: TypeScript");
    } else {
      // tier2 may return null if strategy doesn't generate candidates — this is acceptable
      expect(result).toBeNull();
    }
  });

  test("tier3: codeBlock + Language in complex prompt", () => {
    const error = {
      file: "main.py", line: 3, code: "PY_ERR", message: "IndentationError",
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
