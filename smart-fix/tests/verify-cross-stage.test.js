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
  test("TypeScript: hint → auto-fix → learn", () => {
    const msg = "Property 'lenght' does not exist on type 'string'. Did you mean 'length'?";
    const hint = extractHints(msg, msg, "TypeScript");
    expect(hint.suggestion).toBe("length");

    const error = {
      file: "utils.ts", line: 2, code: "TS2551", message: msg,
      fixHint: { primaryStrategy: "apply_compiler_hint" },
      hint, captures: { wrong: "lenght" },
    };
    const fix = generateDeterministicFix(error, "function getLen(s: string) {\n  return s.lenght;\n}", null, "TypeScript");
    expect(fix).not.toBeNull();
    expect(fix.patch.text).toContain("s.length");

    const tmpFile = path.join(os.tmpdir(), "cross-ts-" + Date.now() + ".jsonl");
    const learner = new FixLearner(tmpFile);
    learner.recordOutcome({ errorCode: "TS2551", strategy: "apply_compiler_hint", language: "TypeScript", file: "utils.ts", passed: true, confidence: 0.95 });
    expect(learner.getSimilarSuccessfulFix("TS2551", {}, "TypeScript").strategy).toBe("apply_compiler_hint");
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  test("Python: hint → context → prompt with Language", () => {
    const msg = "NameError: name 'pritn' is not defined. Did you mean: 'print'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint.suggestion).toBe("print");

    const code = "import os\n\ndef main():\n    x = 1\n    pritn(x)\n    return x\n";
    const funcCtx = extractEnclosingFunction(code, 5, "Python");
    expect(funcCtx.name).toBe("main");

    const prompt = assembleFixPrompt({
      error: { file: "main.py", line: 5, code: "PY_NAME", message: msg },
      hint, functionContext: funcCtx.code,
    });
    expect(prompt).toContain("Language: Python");
    expect(prompt).toContain("Use correct Python syntax");
    expect(prompt).toContain("def main");
  });

  test("Go: hint → prompt with correct language", () => {
    const msg = '"net/http" imported and not used';
    const hint = extractHints(msg, msg, "Go");
    expect(hint.type).toBe("unused_import");

    const prompt = assembleFixPrompt({
      error: { file: "server.go", line: 3, code: "GO_UNUSED", message: msg },
      hint,
    });
    expect(prompt).toContain("Language: Go");
  });

  test("Rust: complex error → tier3 with Language + codeBlock", () => {
    const error = {
      file: "lib.rs", line: 7, code: "E0308",
      message: "mismatched types: expected i32, found &str",
      fixHint: { primaryStrategy: "cast_type" },
      codeBlock: "// Wrong: let x: i32 = \"hello\";\n// Fixed: let x: i32 = \"hello\".parse().unwrap();",
    };
    const content = "use std::io;\n\nfn process() -> i32 {\n    let input = io::stdin();\n    let mut buf = String::new();\n    input.read_line(&mut buf).unwrap();\n    let num: i32 = buf.trim();\n    num\n}\n";
    const ctx = buildComplexContext(error, content, null, null);
    expect(ctx.promptBlock).toContain("Rust");
    expect(ctx.promptBlock).toContain("Fix example");
    expect(ctx.promptBlock).toContain("// Wrong");
  });

  test("Java: prompt structure complete", () => {
    const prompt = assembleFixPrompt({
      error: { file: "App.java", line: 15, code: "JAVA_ERR", message: "cannot find symbol: method toLower()" },
      classification: { rootCause: "Method name typo", prescription: "Use toLowerCase()" },
      codeBlock: "// Wrong: str.toLower()\n// Fixed: str.toLowerCase()",
    });
    expect(prompt).toContain("Language: Java");
    expect(prompt).toContain("DIAGNOSIS");
    expect(prompt).toContain("Fix example");
  });

  test("C#: prompt structure complete", () => {
    const prompt = assembleFixPrompt({
      error: { file: "Program.cs", line: 10, code: "CS0246", message: "The type 'JsonConvert' could not be found" },
      classification: { rootCause: "Missing using", prescription: "Add using Newtonsoft.Json" },
    });
    expect(prompt).toContain("Language: C#");
    expect(prompt).toContain("DIAGNOSIS");
    expect(prompt).toContain("Missing using");
  });
});
