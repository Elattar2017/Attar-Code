const { assembleFixPrompt, detectLanguageFromFile } = require("../prompt-template");

describe("Stage 5 Verification: Prompt Structure", () => {
  test("all sections in correct order for complete input", () => {
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

    const positions = {
      language: prompt.indexOf("Language: TypeScript"),
      errorType: prompt.indexOf("[ERROR TYPE]"),
      diagnosis: prompt.indexOf("DIAGNOSIS"),
      pastFix: prompt.indexOf("PREVIOUS FIX"),
      hint: prompt.indexOf("Compiler suggestion"),
      example: prompt.indexOf("Fix example"),
      context: prompt.indexOf("Code context"),
      deps: prompt.indexOf("Available from imported"),
      affected: prompt.indexOf("Files affected"),
      instruction: prompt.indexOf("Fix this error"),
    };
    for (const [name, pos] of Object.entries(positions)) {
      expect(pos).toBeGreaterThanOrEqual(0);
    }
    expect(positions.language).toBeLessThan(positions.errorType);
    expect(positions.diagnosis).toBeLessThan(positions.pastFix);
    expect(positions.pastFix).toBeLessThan(positions.hint);
    expect(positions.hint).toBeLessThan(positions.example);
    expect(positions.example).toBeLessThan(positions.context);
    expect(positions.context).toBeLessThan(positions.instruction);
  });

  test("language-aware instruction for 12 languages", () => {
    const langs = [
      { file: "x.ts", expected: "TypeScript" }, { file: "x.py", expected: "Python" },
      { file: "x.go", expected: "Go" }, { file: "x.rs", expected: "Rust" },
      { file: "x.java", expected: "Java" }, { file: "x.cs", expected: "C#" },
      { file: "x.php", expected: "PHP" }, { file: "x.swift", expected: "Swift" },
      { file: "x.kt", expected: "Kotlin" }, { file: "x.cpp", expected: "C++" },
      { file: "x.rb", expected: "Ruby" }, { file: "x.dart", expected: "Dart" },
    ];
    for (const { file, expected } of langs) {
      const prompt = assembleFixPrompt({ error: { file, line: 1, code: "E", message: "err" } });
      expect(prompt).toContain("Language: " + expected);
      expect(prompt).toContain("Use correct " + expected + " syntax");
    }
  });

  test("detectLanguageFromFile edge cases", () => {
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

  test("minimal input produces valid prompt", () => {
    const prompt = assembleFixPrompt({ error: { file: "x.js", line: 1, code: "E", message: "bad" } });
    expect(prompt).toContain("Language: JavaScript");
    expect(prompt).toContain("[ERROR TYPE]");
    expect(prompt).toContain("Fix this error");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });
});
