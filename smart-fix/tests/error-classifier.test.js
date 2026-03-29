// smart-fix/tests/error-classifier.test.js
const { classifyErrors } = require("../error-classifier");


describe("classifyErrors", () => {
  test("classifies local syntax errors with 0.0 cross-file probability", () => {
    const parsedErrors = [
      { file: "/utils.ts", line: 15, code: "TS1005", message: "';' expected" },
    ];
    const tree = null; // No tree needed for syntax errors
    const plugin = {
      errorCatalog: { categories: [{ errors: [
        { code: "TS1005", messagePattern: "'(.+?)' expected", baseCrossFileProbability: 0.0, refinements: [], fixHint: { primaryStrategy: "fix_syntax" }, coOccurrence: [] }
      ]}]}
    };

    const classified = classifyErrors(parsedErrors, tree, plugin);
    expect(classified[0].crossFileProbability).toBe(0.0);
    expect(classified[0].originFile).toBeNull();
  });

  test("classifies cross-file errors with origin tracing", () => {
    const parsedErrors = [
      { file: "/api.ts", line: 12, code: "TS2339", message: "Property 'phone' does not exist on type 'User'" },
    ];
    // Mock tree that knows User comes from types.ts
    const mockTree = {
      getFileAnalysis: (f) => {
        if (f === "/api.ts") return {
          imports: [{ rawSource: "./types", symbols: ["User"], isExternal: false }],
          definitions: [],
        };
        return null;
      },
      _resolveImportPath: (from, source) => source === "./types" ? "/types.ts" : null,
      getFileRank: (f) => ({ depth: f === "/types.ts" ? 0 : 1, isHub: f === "/types.ts", isLeaf: f !== "/types.ts" }),
    };
    const plugin = {
      errorCatalog: { categories: [{ errors: [
        { code: "TS2339",
          messagePattern: "Property '(?<propertyName>.+?)' does not exist on type '(?<typeName>.+?)'",
          captures: [
            { "name": "propertyName", "role": "property_name" },
            { "name": "typeName", "role": "type_name" }
          ],
          baseCrossFileProbability: 0.7,
          refinements: [{ check: { type: "is_imported", target: "typeName" }, adjustedProbability: 0.9, traceDepth: "transitive", traceTarget: "re_export_origin" }],
          fixHint: { primaryStrategy: "add_property", requiresCrossFileEdit: true },
          coOccurrence: []
        }
      ]}]}
    };

    const classified = classifyErrors(parsedErrors, mockTree, plugin);
    // Refinement fires: User is imported, so probability goes to 0.9
    expect(classified[0].crossFileProbability).toBe(0.9);
    // originFile should be resolved to /types.ts
    expect(classified[0].originFile).toBe("/types.ts");
  });
});

describe("recursive origin tracing", () => {
  test("traces through 2-level import chain", () => {
    const { classifyErrors } = require("../error-classifier");
    const mockTree = {
      getFileAnalysis: (file) => {
        if (file === "a.ts") return {
          imports: [{ rawSource: "./b", symbols: ["UserType"], isExternal: false }],
          definitions: [],
        };
        if (file === "b.ts") return {
          imports: [{ rawSource: "./c", symbols: ["UserType"], isExternal: false }],
          definitions: [],
          exports: [{ symbols: ["UserType"] }],
        };
        if (file === "c.ts") return {
          imports: [],
          definitions: [{ name: "UserType", kind: "interface" }],
          exports: [{ symbols: ["UserType"] }],
        };
        return null;
      },
      _resolveImportPath: (from, source) => {
        const map = { "./b": "b.ts", "./c": "c.ts" };
        return map[source] || null;
      },
    };

    const plugin = {
      errorCatalog: { categories: [{
        errors: [{
          code: "TS2304",
          baseCrossFileProbability: 0.7,
          messagePattern: "Cannot find name '(?<symbol>\\w+)'",
          captures: [{ name: "symbol", role: "identifier" }],
          refinements: [{ check: { type: "is_imported", target: "symbol" }, adjustedProbability: 0.9, traceTarget: "cross_file" }],
          fixHint: null, coOccurrence: [],
        }],
      }]},
    };

    const errors = [{ file: "a.ts", line: 5, code: "TS2304", message: "Cannot find name 'UserType'" }];
    const result = classifyErrors(errors, mockTree, plugin);
    expect(result[0].originFile).toBe("c.ts");
    expect(result[0].originChain).toEqual(["b.ts", "c.ts"]);
  });
});
