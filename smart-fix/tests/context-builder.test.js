// smart-fix/tests/context-builder.test.js
const { buildCreateFileResponse, buildEditFileResponse, buildBuildErrorAnalysis } = require("../context-builder");

describe("ContextBuilder", () => {
  test("buildCreateFileResponse includes validation and project summary", () => {
    const result = buildCreateFileResponse(
      "/src/app.ts",
      [{ line: 1, source: "./types", status: "ok", message: "User resolved" }],
      "3 files, 10 exported symbols",
      3
    );
    expect(result).toContain("Created");
    expect(result).toContain("Validation");
    expect(result).toContain("Project structure");
  });

  test("buildCreateFileResponse shows warnings for bad imports", () => {
    const result = buildCreateFileResponse(
      "/src/app.ts",
      [{ line: 2, source: "./db", status: "error", message: "'verifyUser' is not exported from db.ts. Available: findUser, createUser" }],
      "3 files",
      3
    );
    expect(result).toContain("WARNING");
    expect(result).toContain("verifyUser");
    expect(result).toContain("Available");
  });

  test("buildBuildErrorAnalysis formats fix plan", () => {
    const fixPlan = {
      queue1: [{ file: "/types.ts", errors: [{ code: "TS2322", message: "Type mismatch" }], errorCount: 1, rank: { depth: 0, isHub: true } }],
      queue2: [{ file: "/utils.ts", errors: [{ code: "TS1005", message: "';' expected" }], errorCount: 1, rank: { depth: 0, isLeaf: true } }],
      autoResolvable: [{ file: "/api.ts", code: "TS2339", autoResolveWhen: "/types.ts" }],
      stats: { totalErrors: 3, rootCauseGroups: 1, isolatedGroups: 1, autoResolvableCandidates: 1 },
    };
    const result = buildBuildErrorAnalysis(fixPlan, 3);
    expect(result).toContain("Priority 1");
    expect(result).toContain("types.ts");
    expect(result).toContain("auto-resolve");
  });
});
