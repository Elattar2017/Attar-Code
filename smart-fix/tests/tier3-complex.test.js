const { buildComplexContext } = require("../fix-engine/tier3-complex");
const { TreeManager } = require("../tree-manager");
const { fixturePath } = require("./setup");
const path = require("path");

describe("Tier 3 Complex Context", () => {
  test("builds context with surrounding code and cascade risk", () => {
    const error = {
      file: "/project/src/routes.ts",
      line: 10,
      code: "TS2345",
      message: "Argument of type 'string' is not assignable to parameter of type 'number'",
      captures: { actualType: "string", expectedType: "number" },
      fixHint: { primaryStrategy: "change_signature", requiresCrossFileEdit: true, typicalScope: "function_body" },
    };
    const fileContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

    const ctx = buildComplexContext(error, fileContent, null, null);

    expect(ctx).toHaveProperty("primaryFile");
    expect(ctx).toHaveProperty("cascadeRisk");
    expect(ctx).toHaveProperty("promptBlock");
    expect(ctx.primaryFile.errorLine).toBe(10);
    expect(ctx.promptBlock).toContain("TS2345");
    expect(ctx.promptBlock).toContain(">>> ");
    expect(ctx.promptBlock).toContain("change_signature");
    expect(ctx.promptBlock).toContain("multiple files");
  });

  test("includes dependency type definitions from tree", () => {
    const tree = new TreeManager();
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts"]);

    const appPath = fixturePath("simple-ts", "src", "app.ts");
    const error = {
      file: appPath,
      line: 5,
      code: "TS2322",
      message: "Type mismatch",
      captures: {},
      fixHint: { primaryStrategy: "update_type_annotation", typicalScope: "type_definition" },
    };
    const fileContent = require("fs").readFileSync(appPath, "utf-8");
    const ranks = tree.getRanks();

    const ctx = buildComplexContext(error, fileContent, tree, ranks);

    expect(ctx.dependencies.length).toBeGreaterThan(0);
    expect(ctx.promptBlock).toContain("Available from imported files");
  });

  test("shows cascade risk based on dependent count", () => {
    const ranks = new Map();
    ranks.set("/hub.ts", { dependentCount: 10, isHub: true });

    const error = {
      file: "/hub.ts", line: 1, code: "TS2339",
      message: "Property missing",
      captures: {},
      fixHint: { primaryStrategy: "add_property" },
    };

    const ctx = buildComplexContext(error, "const x = 1;", null, ranks);
    expect(ctx.cascadeRisk).toBe("HIGH");
    expect(ctx.promptBlock).toContain("HIGH");
  });

  test("handles missing tree gracefully", () => {
    const error = {
      file: "/test.py", line: 5, code: "E0001",
      message: "some error",
      captures: {},
      fixHint: { primaryStrategy: "restructure_code" },
    };

    const ctx = buildComplexContext(error, "line1\nline2\nline3\nline4\nline5\n", null, null);
    expect(ctx).not.toBeNull();
    expect(ctx.dependencies).toEqual([]);
    expect(ctx.dependents).toEqual([]);
    expect(ctx.cascadeRisk).toBe("UNKNOWN");
  });
});

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
