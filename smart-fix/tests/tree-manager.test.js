// smart-fix/tests/tree-manager.test.js
const { TreeManager } = require("../tree-manager");
const { fixturePath } = require("./setup");

describe("TreeManager", () => {
  let tree;

  beforeEach(() => {
    tree = new TreeManager();
  });

  test("addFile analyzes and adds to graph", () => {
    tree.addFile(fixturePath("simple-ts", "src", "types.ts"));
    const analysis = tree.getFileAnalysis(fixturePath("simple-ts", "src", "types.ts"));
    expect(analysis).not.toBeNull();
    expect(analysis.exports.length).toBeGreaterThan(0);
  });

  test("fullRebuild scans entire project", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    expect(tree.getFileCount()).toBe(3); // types.ts, config.ts, app.ts
  });

  test("fullRebuild resolves import edges", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const typesPath = fixturePath("simple-ts", "src", "types.ts");
    const dependents = tree.getDependentsOf(typesPath);
    expect(dependents.length).toBe(2); // config.ts and app.ts both import from types.ts
  });

  test("getRanks returns depth and hub info", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const typesPath = fixturePath("simple-ts", "src", "types.ts");
    const rank = tree.getFileRank(typesPath);
    expect(rank.depth).toBe(0);
    expect(rank.isRoot).toBe(true);
    expect(rank.dependentCount).toBeGreaterThanOrEqual(2);
  });

  test("updateFile detects structural changes", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const configPath = fixturePath("simple-ts", "src", "config.ts");
    const result = tree.updateFile(configPath);
    expect(result).toHaveProperty("structuralChange");
  });

  test("getProjectSummary returns compact summary", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const summary = tree.getProjectSummary();
    expect(summary).toContain("3 files");
  });

  test("validateImports detects valid imports", () => {
    tree.fullRebuild(fixturePath("simple-ts", "src"), [".ts", ".tsx"]);
    const appPath = fixturePath("simple-ts", "src", "app.ts");
    const warnings = tree.validateImports(appPath);
    expect(warnings.filter(w => w.status === "error")).toHaveLength(0);
  });
});
