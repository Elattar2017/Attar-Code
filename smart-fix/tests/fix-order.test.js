// smart-fix/tests/fix-order.test.js
const { computeFixOrder } = require("../fix-order");

describe("computeFixOrder", () => {
  test("root cause errors come before dependent errors", () => {
    const errors = [
      { file: "/api.ts", code: "TS2339", message: "Property 'phone' does not exist on type 'User'", originFile: "/types.ts", crossFileProbability: 0.9 },
      { file: "/types.ts", code: "TS2322", message: "Type 'string' not assignable to 'number'", originFile: null, crossFileProbability: 0.1 },
    ];
    const ranks = new Map([
      ["/types.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: true, dependentCount: 5, inCircularDependency: false }],
      ["/api.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    // Queue 1 (root causes) should contain types.ts
    // Queue 2 (isolated) or auto-resolve should contain api.ts
    expect(plan.queue1[0].file).toBe("/types.ts");
  });

  test("syntax errors in leaves come first within queue 2", () => {
    const errors = [
      { file: "/utils.ts", code: "TS1005", message: "';' expected", originFile: null, crossFileProbability: 0.0 },
      { file: "/helpers.ts", code: "TS7006", message: "Parameter implicitly has any type", originFile: null, crossFileProbability: 0.0 },
    ];
    const ranks = new Map([
      ["/utils.ts", { depth: 0, isRoot: true, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
      ["/helpers.ts", { depth: 0, isRoot: true, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    // Both are isolated, should be in queue2
    expect(plan.queue2.length).toBe(2);
  });

  test("auto-resolvable errors are flagged", () => {
    const errors = [
      { file: "/types.ts", code: "TS2322", message: "Type mismatch", originFile: null, crossFileProbability: 0.1 },
      { file: "/a.ts", code: "TS2339", message: "Property missing", originFile: "/types.ts", crossFileProbability: 0.9 },
      { file: "/b.ts", code: "TS2339", message: "Property missing", originFile: "/types.ts", crossFileProbability: 0.9 },
    ];
    const ranks = new Map([
      ["/types.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: true, dependentCount: 2, inCircularDependency: false }],
      ["/a.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
      ["/b.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, inCircularDependency: false }],
    ]);

    const plan = computeFixOrder(errors, ranks);
    expect(plan.autoResolvable.length).toBe(2);
    expect(plan.stats.autoResolvableCandidates).toBe(2);
  });
});

describe("coOccurrence grouping", () => {
  test("groups co-occurring errors and boosts root cause priority", () => {
    const errors = [
      { file: "a.ts", line: 5, code: "TS2304", message: "Cannot find name 'User'",
        crossFileProbability: 0.5, originFile: null, coOccurrence: ["TS2305", "TS2307"],
        fixHint: null },
      { file: "a.ts", line: 10, code: "TS2305", message: "Module has no exported member",
        crossFileProbability: 0.5, originFile: null, coOccurrence: ["TS2304"],
        fixHint: null },
      { file: "b.ts", line: 3, code: "TS2307", message: "Cannot find module './user'",
        crossFileProbability: 0.8, originFile: null, coOccurrence: ["TS2304"],
        fixHint: null },
    ];
    const ranks = new Map([
      ["a.ts", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
      ["b.ts", { depth: 0, isRoot: true, isLeaf: false, isHub: false, dependentCount: 1, transitiveDependentCount: 1, inCircularDependency: false }],
    ]);
    const result = computeFixOrder(errors, ranks);
    const q1Files = result.queue1.map(g => g.file);
    expect(q1Files).toContain("b.ts");
  });
});
