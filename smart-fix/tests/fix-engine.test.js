const { generateDeterministicFix } = require("../fix-engine/tier1-deterministic");
const { applyPatch, revertPatch, clearBackups } = require("../fix-engine/apply-engine");
const { verifyFix } = require("../fix-engine/verify-engine");
const { runFixEngine, classifyTier } = require("../fix-engine");
const { FixLearner } = require("../fix-engine/fix-learner");

describe("Fix Engine", () => {
  afterEach(() => clearBackups());

  describe("classifyTier", () => {
    test("add_import → tier 1", () => {
      const error = { fixHint: { primaryStrategy: "add_import" }, crossFileProbability: 0.3 };
      expect(classifyTier(error, null, "TypeScript")).toBe(1);
    });

    test("add_null_check → tier 2", () => {
      const error = { fixHint: { primaryStrategy: "add_null_check" }, crossFileProbability: 0.3 };
      expect(classifyTier(error, null, "TypeScript")).toBe(2);
    });

    test("change_signature → tier 3", () => {
      const error = { fixHint: { primaryStrategy: "change_signature" }, crossFileProbability: 0.3 };
      expect(classifyTier(error, null, "TypeScript")).toBe(3);
    });

    test("requiresCrossFileEdit → tier 3 override", () => {
      const error = { fixHint: { primaryStrategy: "add_import", requiresCrossFileEdit: true }, crossFileProbability: 0.3 };
      expect(classifyTier(error, null, "TypeScript")).toBe(3);
    });

    test("high crossFileProbability → tier 2 minimum", () => {
      const error = { fixHint: { primaryStrategy: "add_import" }, crossFileProbability: 0.8 };
      expect(classifyTier(error, null, "TypeScript")).toBe(2);
    });
  });

  describe("tier1-deterministic", () => {
    test("add_import generates correct TypeScript import", () => {
      const error = {
        file: "/project/src/routes.ts",
        line: 5,
        code: "TS2304",
        message: "Cannot find name 'User'",
        captures: { symbolName: "User" },
        fixHint: { primaryStrategy: "add_import" },
      };
      const fileContent = "import express from 'express';\n\nconst user: User = {};\n";
      const mockTree = {
        getAllExports: () => ({
          "/project/src/types.ts": ["User", "Product", "Order"],
          "/project/src/routes.ts": ["router"],
        }),
      };

      const fix = generateDeterministicFix(error, fileContent, mockTree, "TypeScript");
      expect(fix).not.toBeNull();
      expect(fix.strategy).toBe("add_import");
      expect(fix.patch.text).toContain("import { User }");
      expect(fix.patch.text).toContain("types");
      expect(fix.confidence).toBeGreaterThan(0.7);
    });

    test("add_import generates correct Python import", () => {
      const error = {
        file: "/project/app/routes.py",
        line: 3,
        code: "NameError",
        message: "name 'User' is not defined",
        captures: { symbolName: "User" },
        fixHint: { primaryStrategy: "add_import" },
      };
      const fileContent = "from flask import Flask\n\ndef get_user() -> User:\n    pass\n";
      const mockTree = {
        getAllExports: () => ({
          "/project/app/models.py": ["User", "Product"],
        }),
      };

      const fix = generateDeterministicFix(error, fileContent, mockTree, "Python");
      expect(fix).not.toBeNull();
      expect(fix.strategy).toBe("add_import");
      expect(fix.patch.text).toContain("User");
    });

    test("remove_import generates delete patch", () => {
      const error = {
        file: "/project/src/app.ts",
        line: 2,
        code: "TS6133",
        message: "'fs' is declared but its value is never read",
        captures: { symbolName: "fs" },
        fixHint: { primaryStrategy: "remove_import" },
      };
      const fileContent = "import express from 'express';\nimport fs from 'fs';\n\nconst app = express();\n";

      const fix = generateDeterministicFix(error, fileContent, null, "TypeScript");
      expect(fix).not.toBeNull();
      expect(fix.strategy).toBe("remove_import");
      expect(fix.patch.type).toBe("delete_line");
      expect(fix.patch.deleteLine).toBe(2);
    });

    test("add_semicolon appends semicolon", () => {
      const error = {
        file: "/project/src/app.ts",
        line: 3,
        code: "TS1005",
        message: "';' expected",
        captures: { expected: ";" },
        fixHint: { primaryStrategy: "add_semicolon" },
      };
      const fileContent = "const a = 1;\nconst b = 2;\nconst c = 3\nconst d = 4;\n";

      const fix = generateDeterministicFix(error, fileContent, null, "TypeScript");
      expect(fix).not.toBeNull();
      expect(fix.strategy).toBe("add_semicolon");
      expect(fix.patch.newText).toBe("const c = 3;");
    });

    test("returns null for unsupported strategy", () => {
      const error = {
        file: "/project/src/app.ts",
        line: 5,
        code: "TS2345",
        message: "Argument type mismatch",
        captures: {},
        fixHint: { primaryStrategy: "change_signature" },
      };
      const fix = generateDeterministicFix(error, "code", null, "TypeScript");
      expect(fix).toBeNull();
    });

    test("returns null when symbol not found in exports", () => {
      const error = {
        file: "/project/src/app.ts",
        line: 5,
        code: "TS2304",
        message: "Cannot find name 'NonExistent'",
        captures: { symbolName: "NonExistent" },
        fixHint: { primaryStrategy: "add_import" },
      };
      const mockTree = {
        getAllExports: () => ({ "/project/src/types.ts": ["User", "Product"] }),
      };
      const fix = generateDeterministicFix(error, "code", mockTree, "TypeScript");
      expect(fix).toBeNull();
    });
  });

  describe("apply-engine", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmpFile = path.join(os.tmpdir(), "fix-engine-test.txt");

    beforeEach(() => fs.writeFileSync(tmpFile, "line1\nline2\nline3\n"));
    afterEach(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

    test("insert patch adds line", () => {
      const result = applyPatch(tmpFile, { type: "insert", insertAtLine: 2, text: "inserted" });
      expect(result.success).toBe(true);
      expect(result.linesChanged).toBe(1);
      expect(fs.readFileSync(tmpFile, "utf-8")).toContain("inserted");
    });

    test("delete_line removes line", () => {
      const result = applyPatch(tmpFile, { type: "delete_line", deleteLine: 2 });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(tmpFile, "utf-8")).not.toContain("line2");
    });

    test("revert restores original", () => {
      const original = fs.readFileSync(tmpFile, "utf-8");
      applyPatch(tmpFile, { type: "delete_line", deleteLine: 2 });
      expect(fs.readFileSync(tmpFile, "utf-8")).not.toContain("line2");
      revertPatch(tmpFile, original);
      expect(fs.readFileSync(tmpFile, "utf-8")).toContain("line2");
    });
  });

  describe("verify-engine", () => {
    test("babel_reparse passes for valid TypeScript", async () => {
      const fs = require("fs");
      const os = require("os");
      const path = require("path");
      const tmpFile = path.join(os.tmpdir(), "verify-test.ts");
      fs.writeFileSync(tmpFile, "const x: number = 42;\nexport { x };\n");

      const result = await verifyFix(tmpFile, "TypeScript", "fix_syntax", null);
      expect(result.passed).toBe(true);
      expect(result.method).toBe("babel_reparse");

      fs.unlinkSync(tmpFile);
    });

    test("babel_reparse fails for invalid syntax", async () => {
      const fs = require("fs");
      const os = require("os");
      const path = require("path");
      const tmpFile = path.join(os.tmpdir(), "verify-test-bad.ts");
      fs.writeFileSync(tmpFile, "const x: number = {{\n");

      const result = await verifyFix(tmpFile, "TypeScript", "fix_syntax", null);
      expect(result.passed).toBe(false);

      fs.unlinkSync(tmpFile);
    });
  });

  describe("tier1 compiler-hint auto-fix", () => {
    test("auto-fixes 'did you mean' with MachineApplicable", () => {
      const error = {
        file: "test.ts", line: 2, code: "TS2551",
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
        file: "test.rs", line: 2, code: "E0425",
        message: "cannot find value `prnt`",
        fixHint: { primaryStrategy: "apply_compiler_hint" },
        hint: { suggestion: "print", type: "did_you_mean", applicability: "MaybeIncorrect" },
        captures: { wrong: "prnt" },
      };
      const content = 'fn main() {\n  prnt!("hello");\n}';
      const fix = generateDeterministicFix(error, content, null, "Rust");
      expect(fix).toBeNull();
    });
  });

  describe("fix-learner", () => {
    test("records outcomes", () => {
      const learner = new FixLearner();
      learner.recordOutcome({
        errorCode: "TS2304", strategy: "add_import",
        language: "TypeScript", file: "/test.ts", passed: true,
        confidence: 0.9, duration: 50,
      });
      const similar = learner.getSimilarSuccessfulFix("TS2304", {}, "TypeScript");
      expect(similar).not.toBeNull();
      expect(similar.strategy).toBe("add_import");
    });
  });
});

const fss = require("fs");
const oss = require("os");
const pathh = require("path");

describe("FixLearner cross-session", () => {
  const testOutcomesFile = pathh.join(oss.tmpdir(), "test-fix-outcomes-" + Date.now() + ".jsonl");

  afterEach(() => {
    try { fss.unlinkSync(testOutcomesFile); } catch (_) {}
  });

  test("loads past outcomes from JSONL file", () => {
    const pastOutcomes = [
      { errorCode: "TS2304", strategy: "add_import", language: "TypeScript", passed: true },
      { errorCode: "TS2304", strategy: "add_import", language: "TypeScript", passed: true },
      { errorCode: "TS2304", strategy: "update_type_annotation", language: "TypeScript", passed: false },
    ];
    fss.writeFileSync(testOutcomesFile, pastOutcomes.map(o => JSON.stringify(o)).join("\n") + "\n");

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
    fss.writeFileSync(testOutcomesFile, outcomes.map(o => JSON.stringify(o)).join("\n") + "\n");

    const { FixLearner } = require("../fix-engine/fix-learner");
    const learner = new FixLearner(testOutcomesFile);
    const similar = learner.getSimilarSuccessfulFix("E0308", {}, "Rust");
    expect(similar.strategy).toBe("add_null_check");
  });
});
