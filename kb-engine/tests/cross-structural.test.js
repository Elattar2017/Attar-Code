"use strict";

const { analyzeQuery } = require("../retrieval/query-analyzer");

// ---------------------------------------------------------------------------
// 1. Query classification — cross_structural
// ---------------------------------------------------------------------------
describe("cross_structural query classification", () => {
  test('"which chapters mention closures" → cross_structural', () => {
    const r = analyzeQuery("which chapters mention closures");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("closures");
  });

  test('"how many sections discuss async await" → cross_structural', () => {
    const r = analyzeQuery("how many sections discuss async await");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("async await");
  });

  test('"list all chapters about testing across my docs" → cross_structural', () => {
    const r = analyzeQuery("list all chapters about testing across my docs");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toContain("testing");
  });

  test('"find sections that explain decorators" → cross_structural', () => {
    const r = analyzeQuery("find sections that explain decorators");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("decorators");
  });

  test('"which chapters cover error handling" → cross_structural', () => {
    const r = analyzeQuery("which chapters cover error handling");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("error handling");
  });

  test('"how many chapters mention generators" → cross_structural', () => {
    const r = analyzeQuery("how many chapters mention generators");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("generators");
  });

  test('"list sections discussing concurrency" → cross_structural', () => {
    const r = analyzeQuery("list sections discussing concurrency");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("concurrency");
  });
});

// ---------------------------------------------------------------------------
// 2. NOT cross_structural — must not misclassify
// ---------------------------------------------------------------------------
describe("not cross_structural", () => {
  test('"list all chapters" → structural (no topic)', () => {
    expect(analyzeQuery("list all chapters").type).toBe("structural");
  });

  test('"how many chapters" → structural (no topic verb)', () => {
    expect(analyzeQuery("how many chapters").type).toBe("structural");
  });

  test('"explain chapter 3" → scope (specific chapter)', () => {
    expect(analyzeQuery("explain chapter 3").type).toBe("scope");
  });

  test('"how to use closures" → conceptual (no structural words)', () => {
    expect(analyzeQuery("how to use closures").type).toBe("conceptual");
  });

  test('"TypeError in chapter 3" → error (specific error type wins)', () => {
    expect(analyzeQuery("TypeError in chapter 3").type).toBe("error");
  });

  test('"show code examples for decorators" → code_examples', () => {
    expect(analyzeQuery("show code examples for decorators").type).toBe("code_examples");
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-structural routes to all content collections
// ---------------------------------------------------------------------------
describe("cross_structural collection routing", () => {
  test("searches all content collections", () => {
    const r = analyzeQuery("which chapters mention closures");
    expect(r.collections.length).toBeGreaterThan(5);
    expect(r.collections).toContain("python");
    expect(r.collections).toContain("general");
  });

  test("detected tech goes first in collections", () => {
    const r = analyzeQuery("which chapters mention python decorators");
    expect(r.tech).toBe("python");
    expect(r.collections[0]).toBe("python");
  });
});

// ---------------------------------------------------------------------------
// 4. crossTopic is null for non-cross queries
// ---------------------------------------------------------------------------
describe("crossTopic field", () => {
  test("null for structural query", () => {
    expect(analyzeQuery("list all chapters").crossTopic).toBeNull();
  });

  test("null for scope query", () => {
    expect(analyzeQuery("explain chapter 3").crossTopic).toBeNull();
  });

  test("null for conceptual query", () => {
    expect(analyzeQuery("how to use closures").crossTopic).toBeNull();
  });

  test("non-empty string for cross_structural query", () => {
    const r = analyzeQuery("which chapters discuss testing");
    expect(typeof r.crossTopic).toBe("string");
    expect(r.crossTopic.length).toBeGreaterThan(0);
  });
});
