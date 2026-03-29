// smart-fix/tests/file-ranker.test.js
const { rankFiles } = require("../file-ranker");
const { DependencyGraph } = require("../graph-builder");

describe("FileRanker", () => {
  test("root files have depth 0, dependents have increasing depth", () => {
    const graph = new DependencyGraph();
    const stub = (f) => ({ file: f, imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/types.ts", stub("/types.ts"));
    graph.addNode("/config.ts", stub("/config.ts"));
    graph.addNode("/app.ts", stub("/app.ts"));
    graph.addEdge("/config.ts", "/types.ts", ["Config"]);
    graph.addEdge("/app.ts", "/types.ts", ["User"]);
    graph.addEdge("/app.ts", "/config.ts", ["getConfig"]);

    const ranks = rankFiles(graph);

    expect(ranks.get("/types.ts").depth).toBe(0);
    expect(ranks.get("/types.ts").isRoot).toBe(true);
    expect(ranks.get("/types.ts").isLeaf).toBe(false);
    expect(ranks.get("/config.ts").depth).toBe(1);
    expect(ranks.get("/app.ts").depth).toBe(2);
    expect(ranks.get("/app.ts").isLeaf).toBe(true);
  });

  test("hub score reflects dependent count", () => {
    const graph = new DependencyGraph();
    const stub = (f) => ({ file: f, imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/types.ts", stub("/types.ts"));
    graph.addNode("/a.ts", stub("/a.ts"));
    graph.addNode("/b.ts", stub("/b.ts"));
    graph.addNode("/c.ts", stub("/c.ts"));
    graph.addEdge("/a.ts", "/types.ts", []);
    graph.addEdge("/b.ts", "/types.ts", []);
    graph.addEdge("/c.ts", "/types.ts", []);

    const ranks = rankFiles(graph);
    expect(ranks.get("/types.ts").dependentCount).toBe(3);
    expect(ranks.get("/types.ts").isHub).toBe(true);
  });

  test("handles circular dependencies", () => {
    const graph = new DependencyGraph();
    const stub = (f) => ({ file: f, imports: [], exports: [], definitions: [], externalPackages: [] });
    graph.addNode("/a.ts", stub("/a.ts"));
    graph.addNode("/b.ts", stub("/b.ts"));
    graph.addEdge("/a.ts", "/b.ts", []);
    graph.addEdge("/b.ts", "/a.ts", []);

    const ranks = rankFiles(graph);
    expect(ranks.get("/a.ts").inCircularDependency).toBe(true);
    expect(ranks.get("/b.ts").inCircularDependency).toBe(true);
  });
});
