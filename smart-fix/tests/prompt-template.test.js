// smart-fix/tests/prompt-template.test.js
const { assembleFixPrompt } = require("../prompt-template");

describe("Prompt Template", () => {
  test("puts diagnosis BEFORE code context", () => {
    const input = {
      error: { file: "a.ts", line: 5, code: "TS2304", message: "Cannot find name 'User'" },
      classification: { rootCause: "Missing import for 'User'", prescription: "Add import from './models/user'" },
      codeBlock: "// Before: (no import)\n// After: import { User } from './models/user';",
      functionContext: "     3: function process() {\n >>> 5:   const u: User = {}\n     7: }",
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
    const sections = ["Language:", "ERROR TYPE", "DIAGNOSIS", "Code context", "Fix this error"];
    let lastIdx = -1;
    for (const section of sections) {
      const idx = prompt.indexOf(section);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});
