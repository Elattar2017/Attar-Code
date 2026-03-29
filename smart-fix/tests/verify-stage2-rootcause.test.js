const { classifyErrors } = require("../error-classifier");
const { computeFixOrder } = require("../fix-order");

describe("Stage 2 Verification: Root Cause Collapse", () => {
  test("collapses cascading errors — types.ts identified as root", () => {
    const mockTree = {
      getFileAnalysis: (file) => ({
        "types.ts": { imports: [], definitions: [{ name: "User", kind: "interface" }], exports: [{ symbols: ["User"] }] },
        "service.ts": { imports: [{ rawSource: "./types", symbols: ["User"], isExternal: false }], definitions: [], exports: [{ symbols: ["getUser"] }] },
        "controller.ts": { imports: [{ rawSource: "./service", symbols: ["getUser"], isExternal: false }, { rawSource: "./types", symbols: ["User"], isExternal: false }], definitions: [], exports: [] },
      }[file] || null),
      _resolveImportPath: (from, source) => ({ "./types": "types.ts", "./service": "service.ts" }[source] || null),
    };
    const plugin = { errorCatalog: { categories: [{ errors: [{ code: "TS2304", baseCrossFileProbability: 0.7, messagePattern: "Cannot find name '(?<symbol>\\w+)'", captures: [{ name: "symbol" }], refinements: [{ check: { type: "is_imported", target: "symbol" }, adjustedProbability: 0.9, traceTarget: "cross_file" }], fixHint: null, coOccurrence: [] }] }] } };
    const errors = [
      { file: "controller.ts", line: 5, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "controller.ts", line: 10, code: "TS2304", message: "Cannot find name 'User'" },
      { file: "service.ts", line: 2, code: "TS2304", message: "Cannot find name 'User'" },
    ];
    const classified = classifyErrors(errors, mockTree, plugin);
    // All should trace to types.ts as origin
    expect(classified[0].originFile).toBe("types.ts");
    expect(classified[2].originFile).toBe("types.ts");
  });

  test("coOccurrence identifies root cause without import chain", () => {
    const errors = [
      { file: "a.py", line: 1, code: "E0001", message: "syntax", crossFileProbability: 0.1, originFile: null, coOccurrence: ["E0002", "E0003"], fixHint: null },
      { file: "b.py", line: 5, code: "E0002", message: "indent", crossFileProbability: 0.1, originFile: null, coOccurrence: ["E0001"], fixHint: null },
      { file: "c.py", line: 8, code: "E0003", message: "name", crossFileProbability: 0.1, originFile: null, coOccurrence: ["E0001"], fixHint: null },
    ];
    const ranks = new Map([
      ["a.py", { depth: 0, isRoot: true, isLeaf: false, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
      ["b.py", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
      ["c.py", { depth: 1, isRoot: false, isLeaf: true, isHub: false, dependentCount: 0, transitiveDependentCount: 0, inCircularDependency: false }],
    ]);
    const plan = computeFixOrder(errors, ranks);
    const q1Codes = plan.queue1.flatMap(g => g.errors.map(e => e.code));
    expect(q1Codes).toContain("E0001");
  });

  test("circular imports do not cause infinite loop", () => {
    const mockTree = {
      getFileAnalysis: (file) => ({
        "a.ts": { imports: [{ rawSource: "./b", symbols: ["X"], isExternal: false }], definitions: [], exports: [{ symbols: ["Y"] }] },
        "b.ts": { imports: [{ rawSource: "./a", symbols: ["Y"], isExternal: false }], definitions: [], exports: [{ symbols: ["X"] }] },
      }[file] || null),
      _resolveImportPath: (from, source) => ({ "./a": "a.ts", "./b": "b.ts" }[source] || null),
    };
    const plugin = { errorCatalog: { categories: [{ errors: [{ code: "TS2304", baseCrossFileProbability: 0.7, messagePattern: "Cannot find name '(?<symbol>\\w+)'", captures: [{ name: "symbol" }], refinements: [{ check: { type: "is_imported", target: "symbol" }, adjustedProbability: 0.9, traceTarget: "cross_file" }], fixHint: null, coOccurrence: [] }] }] } };
    const errors = [{ file: "a.ts", line: 1, code: "TS2304", message: "Cannot find name 'X'" }];
    const start = Date.now();
    const classified = classifyErrors(errors, mockTree, plugin);
    expect(Date.now() - start).toBeLessThan(100);
    expect(classified).toHaveLength(1);
  });
});
