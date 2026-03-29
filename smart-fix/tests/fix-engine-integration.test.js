const { runFixEngine, classifyTier } = require("../fix-engine");
const { generateDeterministicFix } = require("../fix-engine/tier1-deterministic");
const { TreeManager } = require("../tree-manager");
const { computeFixOrder } = require("../fix-order");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("Fix Engine Integration", () => {
  const tmpDir = path.join(os.tmpdir(), "fix-engine-integration-test");
  const srcDir = path.join(tmpDir, "src");

  beforeAll(() => {
    // Create a mini TypeScript project
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), '{"compilerOptions":{"module":"commonjs"}}');
    fs.writeFileSync(path.join(srcDir, "types.ts"),
      'export interface User { id: number; name: string; }\nexport interface Product { id: number; title: string; }\n');
    fs.writeFileSync(path.join(srcDir, "app.ts"),
      'import express from "express";\n\nconst user: User = { id: 1, name: "test" };\nconsole.log(user);\n');
  });

  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} });

  test("add_import fixes TS2304 for TypeScript project", () => {
    // Build tree
    const tree = new TreeManager();
    tree.fullRebuild(tmpDir, [".ts"]);

    // Simulate TS2304: Cannot find name 'User' in app.ts
    const error = {
      file: path.join(srcDir, "app.ts"),
      line: 3,
      code: "TS2304",
      message: "Cannot find name 'User'",
      captures: { symbolName: "User" },
      crossFileProbability: 0.75,
      fixHint: { primaryStrategy: "add_import", requiresCrossFileEdit: false },
    };

    const fileContent = fs.readFileSync(path.join(srcDir, "app.ts"), "utf-8");
    const fix = generateDeterministicFix(error, fileContent, tree, "TypeScript");

    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import");
    expect(fix.patch.text).toContain("User");
    expect(fix.patch.text).toContain("types");
    expect(fix.description).toContain("import");
  });

  test("runFixEngine processes fix plan and returns results", async () => {
    const tree = new TreeManager();
    tree.fullRebuild(tmpDir, [".ts"]);

    // Create a minimal fix plan
    const fixPlan = {
      queue1: [],
      queue2: [{
        file: path.join(srcDir, "app.ts"),
        errors: [{
          file: path.join(srcDir, "app.ts"),
          line: 3,
          code: "TS2304",
          message: "Cannot find name 'User'",
          captures: { symbolName: "User" },
          crossFileProbability: 0.3,
          fixHint: { primaryStrategy: "add_import", requiresCrossFileEdit: false },
        }],
        score: -30,
        rank: { depth: 1, isLeaf: true, isHub: false },
        errorCount: 1,
      }],
      autoResolvable: [],
      stats: { totalErrors: 1 },
    };

    const result = await runFixEngine(fixPlan, tree, "TypeScript", tmpDir);

    expect(result).toHaveProperty("autoFixed");
    expect(result).toHaveProperty("complexForLLM");
    expect(result).toHaveProperty("stats");
    expect(result.stats.total).toBe(1);
    // Should have auto-fixed (add_import is tier1 with low crossFileProbability)
    expect(result.autoFixed.length + result.complexForLLM.length).toBe(1);
  });

  test("Python add_import generates correct import", () => {
    const pyDir = path.join(os.tmpdir(), "fix-py-test");
    fs.mkdirSync(path.join(pyDir, "app"), { recursive: true });
    fs.writeFileSync(path.join(pyDir, "requirements.txt"), "fastapi");
    fs.writeFileSync(path.join(pyDir, "app", "__init__.py"), "");
    fs.writeFileSync(path.join(pyDir, "app", "models.py"), "class User:\n    pass\nclass Product:\n    pass\n");
    fs.writeFileSync(path.join(pyDir, "app", "routes.py"), "from flask import Flask\n\ndef get_user() -> User:\n    pass\n");

    const tree = new TreeManager();
    tree.fullRebuild(pyDir, [".py"]);

    const error = {
      file: path.join(pyDir, "app", "routes.py"),
      line: 3,
      code: "NameError",
      message: "name 'User' is not defined",
      captures: { symbolName: "User" },
      fixHint: { primaryStrategy: "add_import" },
    };

    const fileContent = fs.readFileSync(path.join(pyDir, "app", "routes.py"), "utf-8");
    const fix = generateDeterministicFix(error, fileContent, tree, "Python");

    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import");
    expect(fix.patch.text).toContain("User");

    fs.rmSync(pyDir, { recursive: true });
  });

  test("Go remove_import generates delete patch", () => {
    const error = {
      file: "/project/main.go",
      line: 3,
      code: "GO_UNUSED_IMPORT",
      message: "imported and not used: \"fmt\"",
      captures: { symbolName: "fmt" },
      fixHint: { primaryStrategy: "remove_import" },
    };
    const fileContent = 'package main\n\nimport "fmt"\n\nfunc main() {}\n';

    const fix = generateDeterministicFix(error, fileContent, null, "Go");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("remove_import");
    expect(fix.patch.type).toBe("delete_line");
    expect(fix.patch.deleteLine).toBe(3);
  });
});
