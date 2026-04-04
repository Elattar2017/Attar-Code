"use strict";

const { analyzeQuery } = require("../retrieval/query-analyzer");

// ---------------------------------------------------------------------------
// 1. Specific error TYPE names must win over scope
// ---------------------------------------------------------------------------
describe("specific error types win over scope", () => {
  test("TypeError + chapter → error", () => {
    expect(analyzeQuery("TypeError in chapter 3").type).toBe("error");
  });

  test("SyntaxError + section → error", () => {
    expect(analyzeQuery("SyntaxError in section 2.1").type).toBe("error");
  });

  test("KeyError + chapter + book hint → error", () => {
    expect(analyzeQuery("KeyError in chapter 8 from my docs").type).toBe("error");
  });

  test("ModuleNotFoundError (no structural reference) → error", () => {
    expect(analyzeQuery("ModuleNotFoundError: No module named requests").type).toBe("error");
  });

  test("ECONNREFUSED + chapter → error", () => {
    expect(analyzeQuery("ECONNREFUSED when connecting to chapter 5 service").type).toBe("error");
  });

  test("traceback + chapter → error", () => {
    expect(analyzeQuery("traceback in chapter 4 code").type).toBe("error");
  });

  test("unhandled rejection + section → error", () => {
    expect(analyzeQuery("unhandled rejection in section 3.2").type).toBe("error");
  });

  test("ENOENT + section → error", () => {
    expect(analyzeQuery("ENOENT error in section 5").type).toBe("error");
  });

  test("cannot read property + chapter → error", () => {
    expect(analyzeQuery("cannot read property of null in chapter 2").type).toBe("error");
  });

  test("stack trace + section → error", () => {
    expect(analyzeQuery("stack trace from section 3 code").type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 2. Broad error words must NOT override scope
// ---------------------------------------------------------------------------
describe("broad error words do not override scope", () => {
  test("explain the error handling chapter → scope", () => {
    expect(analyzeQuery("explain the error handling chapter").type).toBe("scope");
  });

  test("summarize the exception hierarchy section → scope", () => {
    // "exception" is broad — scope wins
    expect(analyzeQuery("summarize the exception hierarchy section").type).toBe("scope");
  });

  test("chapter 5 covers null safety → scope", () => {
    // "null" is broad — scope wins
    expect(analyzeQuery("chapter 5 covers null safety").type).toBe("scope");
  });

  test("describe the undefined behavior section → scope", () => {
    expect(analyzeQuery("describe the undefined behavior section").type).toBe("scope");
  });

  test("explain failure recovery in chapter 7 → scope", () => {
    expect(analyzeQuery("explain failure recovery in chapter 7").type).toBe("scope");
  });

  test("explain the panic recovery section → scope (intent verb + section)", () => {
    // With intent verb "explain", scope pattern fires before broad "panic"
    expect(analyzeQuery("explain the panic recovery section").type).toBe("scope");
  });
});

// ---------------------------------------------------------------------------
// 3. Pure scope (no error words at all)
// ---------------------------------------------------------------------------
describe("pure scope queries", () => {
  test("explain chapter 3 → scope", () => {
    const r = analyzeQuery("explain chapter 3");
    expect(r.type).toBe("scope");
    expect(r.scopeHint).toBe("explain chapter 3");
  });

  test("chapter 5 overview → scope", () => {
    expect(analyzeQuery("chapter 5 overview").type).toBe("scope");
  });

  test("summarize Part II → scope", () => {
    expect(analyzeQuery("summarize Part II").type).toBe("scope");
  });

  test("section 3.1.2 details → scope", () => {
    expect(analyzeQuery("section 3.1.2 details").type).toBe("scope");
  });

  test("appendix A from my docs → scope with scopeBook", () => {
    const r = analyzeQuery("explain appendix A from Python Programming");
    expect(r.type).toBe("scope");
    expect(r.scopeBook).toBe("Python Programming");
  });

  test("3.1.2 About the source data → scope (bare dotted number)", () => {
    expect(analyzeQuery("3.1.2 About the source data").type).toBe("scope");
  });
});

// ---------------------------------------------------------------------------
// 4. Pure error (no structural words)
// ---------------------------------------------------------------------------
describe("pure error queries", () => {
  test("TypeError: Cannot read property of undefined → error", () => {
    expect(analyzeQuery("TypeError: Cannot read property of undefined").type).toBe("error");
  });

  test("ENOENT no such file or directory → error", () => {
    expect(analyzeQuery("ENOENT no such file or directory").type).toBe("error");
  });

  test("my app crashed with a null pointer → error (broad)", () => {
    expect(analyzeQuery("my app crashed with a null pointer").type).toBe("error");
  });

  test("500 internal server error → error (specific)", () => {
    expect(analyzeQuery("500 internal server error").type).toBe("error");
  });

  test("no module named pandas → error", () => {
    expect(analyzeQuery("no module named pandas").type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 5. Other types unaffected by the priority change
// ---------------------------------------------------------------------------
describe("other types unaffected", () => {
  test("how to handle async errors → conceptual (not error)", () => {
    // "how to" triggers conceptual; "errors" is broad but conceptual wins
    expect(analyzeQuery("how to handle async errors in Node").type).toBe("conceptual");
  });

  test("list all chapters → structural", () => {
    expect(analyzeQuery("list all chapters").type).toBe("structural");
  });

  test("table of contents → structural", () => {
    expect(analyzeQuery("show me the table of contents").type).toBe("structural");
  });

  test("show code examples for decorators → code_examples", () => {
    expect(analyzeQuery("show code examples for decorators").type).toBe("code_examples");
  });

  test("import syntax for pandas → api", () => {
    expect(analyzeQuery("import syntax for pandas").type).toBe("api");
  });

  test("generic query → general", () => {
    expect(analyzeQuery("closures in functional programming").type).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// 6. Tech detection still works alongside priority changes
// ---------------------------------------------------------------------------
describe("tech detection with new priority", () => {
  test("TypeError in chapter 3 → error + tech python", () => {
    // TypeError is Python-associated
    const r = analyzeQuery("TypeError in chapter 3");
    expect(r.type).toBe("error");
  });

  test("explain chapter 3 from Python book → scope + tech python", () => {
    const r = analyzeQuery("explain chapter 3 from Python book");
    expect(r.type).toBe("scope");
    expect(r.tech).toBe("python");
  });

  test("ECONNREFUSED express → error + tech nodejs", () => {
    const r = analyzeQuery("ECONNREFUSED in express server");
    expect(r.type).toBe("error");
    expect(r.tech).toBe("nodejs");
  });
});
