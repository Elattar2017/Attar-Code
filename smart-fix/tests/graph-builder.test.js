// smart-fix/tests/graph-builder.test.js
const { DependencyGraph } = require("../graph-builder");

describe("DependencyGraph", () => {
  let graph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  test("addNode stores file analysis", () => {
    graph.addNode("/src/types.ts", {
      file: "/src/types.ts",
      imports: [],
      exports: [{ type: "inline_named", symbols: ["User"], isReExport: false }],
      definitions: [{ kind: "interface", name: "User", line: 1, isExported: true }],
      externalPackages: [],
    });

    expect(graph.hasNode("/src/types.ts")).toBe(true);
    expect(graph.getNode("/src/types.ts").exports[0].symbols).toContain("User");
  });

  test("addEdge creates dependency relationship", () => {
    graph.addNode("/src/types.ts", { file: "/src/types.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/src/app.ts", { file: "/src/app.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addEdge("/src/app.ts", "/src/types.ts", ["User"]);

    expect(graph.getDependenciesOf("/src/app.ts")).toContain("/src/types.ts");
    expect(graph.getDependentsOf("/src/types.ts")).toContain("/src/app.ts");
  });

  test("removeNode cleans up edges", () => {
    graph.addNode("/src/a.ts", { file: "/src/a.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/src/b.ts", { file: "/src/b.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addEdge("/src/b.ts", "/src/a.ts", ["X"]);
    graph.removeNode("/src/a.ts");

    expect(graph.hasNode("/src/a.ts")).toBe(false);
    expect(graph.getDependenciesOf("/src/b.ts")).toEqual([]);
  });

  test("getAllExports returns all exported symbols keyed by file", () => {
    graph.addNode("/src/types.ts", {
      file: "/src/types.ts", imports: [],
      exports: [{ type: "inline_named", symbols: ["User", "Config"], isReExport: false }],
      definitions: [], externalPackages: [],
    });
    const all = graph.getAllExports();
    expect(all["/src/types.ts"]).toEqual(["User", "Config"]);
  });

  test("detectCycles finds circular dependencies", () => {
    graph.addNode("/src/a.ts", { file: "/src/a.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/src/b.ts", { file: "/src/b.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addEdge("/src/a.ts", "/src/b.ts", ["B"]);
    graph.addEdge("/src/b.ts", "/src/a.ts", ["A"]);

    const cycles = graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("/src/a.ts");
    expect(cycles[0]).toContain("/src/b.ts");
  });

  test("getNodeCount returns correct count", () => {
    graph.addNode("/a.ts", { file: "/a.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/b.ts", { file: "/b.ts", imports: [], exports: [], definitions: [], externalPackages: [] });
    expect(graph.getNodeCount()).toBe(2);
  });
});
