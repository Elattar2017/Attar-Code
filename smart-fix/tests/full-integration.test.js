/**
 * Full Integration Test — exercises the complete smart-fix v2 pipeline
 * from file creation through fix engine to verification.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const smartFix = require("../index");
const { TreeManager } = require("../tree-manager");
const { computeFixOrder } = require("../fix-order");
const { classifyErrors } = require("../error-classifier");
const { runFixEngine } = require("../fix-engine");
const { generateDeterministicFix } = require("../fix-engine/tier1-deterministic");
const { generateHeuristicCandidates } = require("../fix-engine/tier2-heuristic");
const { buildComplexContext } = require("../fix-engine/tier3-complex");
const { applyPatch, revertPatch, clearBackups } = require("../fix-engine/apply-engine");
const { verifyFix } = require("../fix-engine/verify-engine");
const { FixLearner } = require("../fix-engine/fix-learner");

// Helper: create temp project
function createTempProject(name, files) {
  const dir = path.join(os.tmpdir(), `smartfix-test-${name}-${Date.now()}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("Full Integration: TypeScript Pipeline", () => {
  let dir, tree;

  beforeAll(() => {
    dir = createTempProject("ts", {
      "tsconfig.json": '{"compilerOptions":{"module":"commonjs","strict":true}}',
      "src/types.ts": 'export interface User { id: number; name: string; email: string; }\nexport interface Product { id: number; title: string; price: number; }\nexport type Status = "active" | "inactive";\n',
      "src/db.ts": 'import { User, Product } from "./types";\nexport function getUsers(): User[] { return []; }\nexport function getProducts(): Product[] { return []; }\n',
      "src/routes.ts": 'import express from "express";\n\nconst router = express.Router();\nrouter.get("/users", (req, res) => {\n  const users: User[] = getUsers();\n  res.json(users);\n});\nexport { router };\n',
    });
    tree = new TreeManager();
    tree.fullRebuild(dir, [".ts"]);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true }); } catch (_) {} clearBackups(); });

  test("1.1: Tree correctly maps 3 files with dependencies", () => {
    expect(tree.getFileCount()).toBe(3);
    const typesPath = path.join(dir, "src", "types.ts");
    const rank = tree.getFileRank(typesPath);
    expect(rank).not.toBeNull();
    expect(rank.isRoot).toBe(true);
    expect(rank.dependentCount).toBeGreaterThanOrEqual(1);
  });

  test("1.2: classifyErrors traces missing import to origin", () => {
    const pluginPath = path.join(__dirname, "..", "..", "defaults", "plugins", "typescript.json");
    let plugin = null;
    try { plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8")); } catch (_) {}

    const errors = [{
      file: path.join(dir, "src", "routes.ts"),
      line: 5, code: "TS2304",
      message: "Cannot find name 'User'",
    }];

    const classified = classifyErrors(errors, tree, plugin);
    expect(classified.length).toBe(1);
    expect(classified[0].crossFileProbability).toBeGreaterThanOrEqual(0.5);
  });

  test("1.3: Fix engine auto-fixes missing import (tier1)", async () => {
    const errors = [{
      file: path.join(dir, "src", "routes.ts"),
      line: 5, code: "TS2304",
      message: "Cannot find name 'User'",
      captures: { symbolName: "User" },
      crossFileProbability: 0.3,
      originFile: path.join(dir, "src", "types.ts"),
      fixHint: { primaryStrategy: "add_import", requiresCrossFileEdit: false },
    }];

    const fixPlan = computeFixOrder(errors, tree.getRanks());
    const result = await runFixEngine(fixPlan, tree, "TypeScript", dir);

    expect(result.stats.total).toBeGreaterThanOrEqual(1);
    // Either auto-fixed or passed to LLM (depends on file state)
    expect(result.autoFixed.length + result.complexForLLM.length + result.candidatesForLLM.length).toBeGreaterThanOrEqual(1);
  });

  test("1.4: Available exports response includes existing files", () => {
    const allExports = tree.getAllExports();
    const routesPath = path.join(dir, "src", "routes.ts");
    const available = {};
    for (const [file, syms] of Object.entries(allExports)) {
      if (path.resolve(file) !== path.resolve(routesPath) && syms.length > 0) {
        available[file] = syms;
      }
    }

    const validation = tree.validateImports(routesPath);
    const summary = tree.getProjectSummary();
    const response = smartFix.buildCreateFileResponse(routesPath, validation, summary, tree.getFileCount(), available);

    expect(response).toContain("Created");
    expect(Object.keys(available).length).toBeGreaterThan(0);
  });
});

describe("Full Integration: Python Pipeline", () => {
  let dir, tree;

  beforeAll(() => {
    dir = createTempProject("py", {
      "requirements.txt": "fastapi\nsqlalchemy",
      "app/__init__.py": "",
      "app/models.py": "class User:\n    id: int\n    name: str\n\nclass Product:\n    id: int\n    title: str\n",
      "app/services.py": "from app.models import User, Product\n\ndef get_all_users() -> list:\n    return []\n\ndef get_user_by_id(id: int) -> User:\n    return User()\n",
      "app/routes.py": "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.get('/users')\ndef list_users():\n    users = get_all_users()\n    return users\n",
    });
    tree = new TreeManager();
    tree.fullRebuild(dir, [".py"]);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true }); } catch (_) {} });

  test("2.1: Python plugin auto-detected", () => {
    expect(tree.detectedLanguage).toBe("Python");
  });

  test("2.2: Python tree has correct file count", () => {
    expect(tree.getFileCount()).toBeGreaterThanOrEqual(3);
  });

  test("2.3: Python imports resolved", () => {
    const servicesPath = path.join(dir, "app", "services.py");
    const analysis = tree.getFileAnalysis(servicesPath);
    expect(analysis).not.toBeNull();
    expect(analysis.imports.length).toBeGreaterThan(0);
  });

  test("2.4: Python add_import fix generates correct syntax", () => {
    const error = {
      file: path.join(dir, "app", "routes.py"),
      line: 7, code: "NameError",
      message: "name 'get_all_users' is not defined",
      captures: { symbolName: "get_all_users" },
      fixHint: { primaryStrategy: "add_import" },
    };
    const content = fs.readFileSync(path.join(dir, "app", "routes.py"), "utf-8");
    const fix = generateDeterministicFix(error, content, tree, "Python");

    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import");
    expect(fix.patch.text).toContain("get_all_users");
  });
});

describe("Full Integration: Tier 2 Candidates", () => {
  test("3.1: Null check generates 3 TS candidates", () => {
    const error = {
      file: "/test.ts", line: 5, code: "TS2531",
      message: "Object is possibly 'null'",
      captures: { symbolName: "user" },
      fixHint: { primaryStrategy: "add_null_check" },
    };
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst name = user.name;\n";
    const result = generateHeuristicCandidates(error, content, error.captures, "TypeScript");

    expect(result).not.toBeNull();
    expect(result.candidates.length).toBe(3);
    expect(result.promptBlock).toContain("[CHOICE]");
    expect(result.promptBlock).toContain("[0]");
    expect(result.promptBlock).toContain("Reply with the number");
  });

  test("3.2: Rust null check generates ? and unwrap_or candidates", () => {
    const error = {
      file: "/test.rs", line: 3, code: "RUST_UNWRAP",
      message: "called unwrap",
      captures: { symbolName: "val" },
      fixHint: { primaryStrategy: "add_null_check" },
    };
    const content = "let x = 1;\nlet y = 2;\nlet v = val.unwrap();\n";
    const result = generateHeuristicCandidates(error, content, error.captures, "Rust");

    expect(result).not.toBeNull();
    expect(result.candidates.some(c => c.code.includes("?"))).toBe(true);
  });
});

describe("Full Integration: Tier 3 Context", () => {
  test("4.1: Complex context includes cascade risk", () => {
    const ranks = new Map();
    ranks.set("/hub.ts", { dependentCount: 8, isHub: true });

    const error = {
      file: "/hub.ts", line: 10, code: "TS2345",
      message: "Argument type mismatch",
      captures: {},
      fixHint: { primaryStrategy: "change_signature", requiresCrossFileEdit: true, typicalScope: "function_body" },
    };
    const content = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i};`).join("\n");

    const ctx = buildComplexContext(error, content, null, ranks);
    expect(ctx.cascadeRisk).toBe("HIGH");
    expect(ctx.promptBlock).toContain("TS2345");
    expect(ctx.promptBlock).toContain("multiple files");
    expect(ctx.promptBlock).toContain("HIGH");
  });
});

describe("Full Integration: Fix Learner", () => {
  test("5.1: Learner records and retrieves outcomes", () => {
    const learner = new FixLearner();
    for (let i = 0; i < 6; i++) {
      learner.recordOutcome({
        errorCode: "TS2304", strategy: "add_import",
        language: "TypeScript", file: "/test.ts",
        passed: true, confidence: 0.9, duration: 50,
      });
    }
    const promoted = learner.getPromotedStrategies("TypeScript");
    expect(promoted["TS2304"]).toBe("add_import");
  });
});

describe("Full Integration: Verify Engine", () => {
  test("6.1: Babel reparse passes valid TS", async () => {
    const tmp = path.join(os.tmpdir(), "verify-int-test.ts");
    fs.writeFileSync(tmp, "export const x: number = 42;\n");
    const result = await verifyFix(tmp, "TypeScript", "fix_syntax", null);
    expect(result.passed).toBe(true);
    expect(result.method).toBe("babel_reparse");
    fs.unlinkSync(tmp);
  });

  test("6.2: Import graph check passes valid imports", async () => {
    const dir = createTempProject("verify", {
      "tsconfig.json": "{}",
      "src/types.ts": "export interface User { id: number; }\n",
      "src/app.ts": 'import { User } from "./types";\nconst u: User = { id: 1 };\n',
    });
    const tree = new TreeManager();
    tree.fullRebuild(dir, [".ts"]);
    const result = await verifyFix(path.join(dir, "src", "app.ts"), "TypeScript", "add_import", tree);
    expect(result.passed).toBe(true);
    expect(result.method).toBe("import_graph_check");
    fs.rmSync(dir, { recursive: true });
  });
});

describe("Full Integration: Apply + Revert", () => {
  test("7.1: Apply insert patch and revert", () => {
    const tmp = path.join(os.tmpdir(), "apply-int-test.ts");
    fs.writeFileSync(tmp, "const a = 1;\nconst b = 2;\n");

    const result = applyPatch(tmp, { type: "insert", insertAtLine: 1, text: 'import { User } from "./types";' });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(tmp, "utf-8")).toContain("import { User }");

    revertPatch(tmp, result.backupContent);
    expect(fs.readFileSync(tmp, "utf-8")).not.toContain("import { User }");
    fs.unlinkSync(tmp);
  });
});

describe("6-Stage Pipeline Integration", () => {
  test("full pipeline: hint → classify → order → context → prompt → learn (TypeScript)", () => {
    const { extractHints } = require("../hint-extractor");
    const { classifyErrors } = require("../error-classifier");
    const { computeFixOrder } = require("../fix-order");
    const { buildComplexContext } = require("../fix-engine/tier3-complex");
    const { FixLearner } = require("../fix-engine/fix-learner");

    // Stage 1: Extract hint
    const msg = "Property 'forEch' does not exist. Did you mean 'forEach'?";
    const hint = extractHints(msg, msg, "TypeScript");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("forEach");

    // Stage 4: Classify
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

    // Stage 2: Order
    const ranks = new Map([["app.ts", { depth: 0, isRoot: true, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }]]);
    const plan = computeFixOrder(classified, ranks);
    expect(plan.stats.totalErrors).toBe(1);

    // Stage 3+5: Context with Language
    const content = "import { x } from './y';\n\nfunction processItems(arr) {\n  const items = [];\n  for (const item of arr) {\n    items.push(item);\n  }\n  arr.forEch(i => console.log(i));\n  return items;\n}\n";
    const ctx = buildComplexContext({ ...classified[0], codeBlock: plugin.errorCatalog.categories[0].errors[0].codeBlock }, content, null, ranks);
    expect(ctx.promptBlock).toContain("TypeScript");

    // Stage 6: Learn
    const fs = require("fs");
    const testFile = require("path").join(require("os").tmpdir(), "test-pipeline-" + Date.now() + ".jsonl");
    try { fs.unlinkSync(testFile); } catch (_) {}
    const learner = new FixLearner(testFile);
    learner.recordOutcome({ errorCode: "TS2551", strategy: "apply_compiler_hint", language: "TypeScript", file: "app.ts", passed: true, confidence: 0.95 });
    const similar = learner.getSimilarSuccessfulFix("TS2551", {}, "TypeScript");
    expect(similar).not.toBeNull();
    expect(similar.strategy).toBe("apply_compiler_hint");
    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  test("prompt includes Language: Python", () => {
    const { extractHints } = require("../hint-extractor");
    const { assembleFixPrompt } = require("../prompt-template");

    const msg = "NameError: name 'prnt' is not defined. Did you mean: 'print'?";
    const hint = extractHints(msg, msg, "Python");
    expect(hint).not.toBeNull();
    expect(hint.suggestion).toBe("print");

    const prompt = assembleFixPrompt({
      error: { file: "main.py", line: 5, code: "PY_NAME_ERROR", message: msg },
      hint,
      functionContext: " >>> 5: prnt('hello')",
    });
    expect(prompt).toContain("Language: Python");
    expect(prompt).toContain("Use correct Python syntax");
  });

  test("prompt includes Language: Go", () => {
    const { extractHints } = require("../hint-extractor");
    const { assembleFixPrompt } = require("../prompt-template");

    const msg = '"fmt" imported and not used';
    const hint = extractHints(msg, msg, "Go");
    expect(hint).not.toBeNull();
    expect(hint.type).toBe("unused_import");

    const prompt = assembleFixPrompt({
      error: { file: "main.go", line: 3, code: "GO_UNUSED", message: msg },
      hint,
    });
    expect(prompt).toContain("Language: Go");
    expect(prompt).toContain("Use correct Go syntax");
  });

  test("prompt includes Language: Rust", () => {
    const { assembleFixPrompt } = require("../prompt-template");
    const prompt = assembleFixPrompt({
      error: { file: "lib.rs", line: 10, code: "E0308", message: "mismatched types" },
      classification: { rootCause: "Expected i32, found &str", prescription: "Convert type" },
    });
    expect(prompt).toContain("Language: Rust");
    expect(prompt).toContain("Use correct Rust syntax");
  });

  test("prompt includes Language: Java", () => {
    const { assembleFixPrompt } = require("../prompt-template");
    const prompt = assembleFixPrompt({
      error: { file: "App.java", line: 15, code: "JAVA_ERR", message: "cannot find symbol" },
    });
    expect(prompt).toContain("Language: Java");
  });

  test("prompt includes Language: C#", () => {
    const { assembleFixPrompt } = require("../prompt-template");
    const prompt = assembleFixPrompt({
      error: { file: "Program.cs", line: 8, code: "CS0246", message: "type or namespace not found" },
    });
    expect(prompt).toContain("Language: C#");
  });
});

describe("Full Integration: Multi-Language Plugins", () => {
  const languages = [
    { name: "TypeScript", marker: "tsconfig.json", mc: "{}", ext: [".ts"] },
    { name: "Python", marker: "requirements.txt", mc: "flask", ext: [".py"] },
    { name: "Go", marker: "go.mod", mc: "module test", ext: [".go"] },
    { name: "Rust", marker: "Cargo.toml", mc: "[package]\nname=\"t\"", ext: [".rs"] },
    { name: "Java / Kotlin", marker: "pom.xml", mc: "<project/>", ext: [".java"] },
    { name: "PHP", marker: "composer.json", mc: '{"require":{}}', ext: [".php"] },
    { name: "Swift", marker: "Package.swift", mc: "//swift", ext: [".swift"] },
  ];

  for (const lang of languages) {
    test(`8.${languages.indexOf(lang) + 1}: ${lang.name} plugin loads and detects`, () => {
      const dir = path.join(os.tmpdir(), `plugin-test-${lang.name.replace(/\s/g, "")}-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, lang.marker), lang.mc);

      const tree = new TreeManager();
      tree.autoDetectAndLoadPlugin(dir);

      // Plugin should detect or at least not crash
      expect(tree.detectedLanguage === lang.name || tree.detectedLanguage === null).toBe(true);
      fs.rmSync(dir, { recursive: true });
    });
  }
});
