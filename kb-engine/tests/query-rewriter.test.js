"use strict";

const {
  rewriteQuery,
  decomposeQuery,
  needsRewriting,
  needsDecomposition,
  REWRITE_TYPES,
} = require("../retrieval/query-rewriter");

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------
const originalFetch = global.fetch;

function mockFetch(response) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
  });
}

function mockFetchError() {
  global.fetch = jest.fn().mockRejectedValue(new Error("network error"));
}

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 1. needsRewriting detection
// ---------------------------------------------------------------------------
describe("needsRewriting", () => {
  test("vague short query → true", () => {
    expect(needsRewriting("fix this")).toBe(true);
    expect(needsRewriting("help me")).toBe(true);
  });

  test("query with pronouns → true", () => {
    expect(needsRewriting("how do I fix this error")).toBe(true);
    expect(needsRewriting("what does that function do")).toBe(true);
  });

  test("long pasted error output → true", () => {
    const longError = "Error: ENOENT: no such file or directory, open '/usr/local/lib/node_modules/.package-lock.json' at Object.openSync (node:fs:603:3) at Object.readFileSync (node:fs:471:35) at something else that is very long";
    expect(needsRewriting(longError)).toBe(true);
  });

  test("already clean/specific query → false", () => {
    expect(needsRewriting("TypeError: Cannot read property of undefined")).toBe(false);
    expect(needsRewriting("ENOENT no such file")).toBe(false);
    expect(needsRewriting("import pandas as pd")).toBe(false);
    expect(needsRewriting("class MyComponent extends React.Component")).toBe(false);
  });

  test("empty/null → false", () => {
    expect(needsRewriting("")).toBe(false);
    expect(needsRewriting(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. needsDecomposition detection
// ---------------------------------------------------------------------------
describe("needsDecomposition", () => {
  test("comparison queries → true", () => {
    expect(needsDecomposition("Python vs JavaScript async")).toBe(true);
    expect(needsDecomposition("compare React and Vue")).toBe(true);
    expect(needsDecomposition("difference between REST and GraphQL")).toBe(true);
    expect(needsDecomposition("Flask versus Django")).toBe(true);
  });

  test("single-topic query → false", () => {
    expect(needsDecomposition("how to use async await in Python")).toBe(false);
    expect(needsDecomposition("Python error handling")).toBe(false);
    expect(needsDecomposition("explain closures")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. rewriteQuery
// ---------------------------------------------------------------------------
describe("rewriteQuery", () => {
  test("rewrites vague query on success", async () => {
    mockFetch({
      message: { content: "Python TypeError handling in async context managers" },
    });

    const result = await rewriteQuery("fix this error", "http://localhost:11434", "test-model");
    expect(result).toBe("Python TypeError handling in async context managers");
    expect(result).not.toBe("fix this error");
  });

  test("passes tech context to LLM prompt", async () => {
    mockFetch({ message: { content: "Express.js middleware error handling patterns" } });

    await rewriteQuery("fix this", "http://localhost:11434", "test-model", { tech: "nodejs" });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("nodejs");
  });

  test("returns original for clean query (no LLM call)", async () => {
    const spy = jest.fn();
    global.fetch = spy;

    const result = await rewriteQuery("TypeError: Cannot read property of undefined");
    expect(result).toBe("TypeError: Cannot read property of undefined");
    expect(spy).not.toHaveBeenCalled(); // no LLM call needed
  });

  test("returns original on LLM failure", async () => {
    mockFetchError();
    const result = await rewriteQuery("fix this error");
    expect(result).toBe("fix this error");
  });

  test("returns original on empty LLM response", async () => {
    mockFetch({ message: { content: "" } });
    const result = await rewriteQuery("fix this error");
    expect(result).toBe("fix this error");
  });

  test("strips quotes from LLM response", async () => {
    mockFetch({ message: { content: '"Python async error handling best practices"' } });
    const result = await rewriteQuery("fix this async thing");
    expect(result).not.toContain('"');
  });
});

// ---------------------------------------------------------------------------
// 4. decomposeQuery
// ---------------------------------------------------------------------------
describe("decomposeQuery", () => {
  test("decomposes comparison query into sub-queries", async () => {
    mockFetch({
      message: { content: "async patterns in Python\nasync patterns in JavaScript" },
    });

    const result = await decomposeQuery("compare async in Python vs JavaScript");
    expect(result.length).toBe(2);
    expect(result[0]).toContain("Python");
    expect(result[1]).toContain("JavaScript");
  });

  test("returns original for single-topic query (no LLM call)", async () => {
    const spy = jest.fn();
    global.fetch = spy;

    const result = await decomposeQuery("how to use async await");
    expect(result).toEqual(["how to use async await"]);
    expect(spy).not.toHaveBeenCalled();
  });

  test("returns [query] on LLM failure", async () => {
    mockFetchError();
    const result = await decomposeQuery("Python vs JavaScript async");
    expect(result).toEqual(["Python vs JavaScript async"]);
  });

  test("caps at 3 sub-queries", async () => {
    mockFetch({
      message: { content: "query 1 here\nquery 2 here\nquery 3 here\nquery 4 here" },
    });
    const result = await decomposeQuery("compare A vs B vs C vs D");
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test("returns [query] when LLM returns single line", async () => {
    mockFetch({ message: { content: "just one rewritten query" } });
    const result = await decomposeQuery("Python vs JavaScript");
    expect(result).toEqual(["Python vs JavaScript"]);
  });
});

// ---------------------------------------------------------------------------
// 5. REWRITE_TYPES
// ---------------------------------------------------------------------------
describe("REWRITE_TYPES", () => {
  test("includes general, conceptual, error, api", () => {
    expect(REWRITE_TYPES.has("general")).toBe(true);
    expect(REWRITE_TYPES.has("conceptual")).toBe(true);
    expect(REWRITE_TYPES.has("error")).toBe(true);
    expect(REWRITE_TYPES.has("api")).toBe(true);
  });

  test("excludes scope, structural, code_examples, cross_structural", () => {
    expect(REWRITE_TYPES.has("scope")).toBe(false);
    expect(REWRITE_TYPES.has("structural")).toBe(false);
    expect(REWRITE_TYPES.has("code_examples")).toBe(false);
    expect(REWRITE_TYPES.has("cross_structural")).toBe(false);
  });
});
