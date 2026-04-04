"use strict";

const { generateHypothetical, HYDE_TYPES } = require("../retrieval/hyde");

// ---------------------------------------------------------------------------
// Mock fetch globally for unit tests
// ---------------------------------------------------------------------------
const originalFetch = global.fetch;

function mockFetch(response) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
  });
}

function mockFetchError(error) {
  global.fetch = jest.fn().mockRejectedValue(error);
}

function mockFetchStatus(status) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: "Server error" }),
  });
}

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 1. generateHypothetical — success cases
// ---------------------------------------------------------------------------
describe("generateHypothetical — success", () => {
  test("returns hypothetical string on valid response", async () => {
    mockFetch({
      message: {
        content:
          "Garbage collection in CPython uses reference counting as its primary mechanism. Each object maintains a count of references pointing to it. When the count drops to zero, the memory is immediately freed. For cyclic references, Python uses a generational collector that periodically scans for unreachable cycles.",
      },
    });

    const result = await generateHypothetical("how does Python garbage collection work");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(30);
    expect(result).toContain("reference counting");
  });

  test("respects model parameter (uses provided model, not hardcoded)", async () => {
    mockFetch({ message: { content: "A hypothetical answer that is long enough to pass the threshold check." } });

    await generateHypothetical("test query", "http://localhost:11434", "my-custom-model");

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe("my-custom-model");
  });

  test("uses config ENRICHMENT_MODEL when model param is undefined", async () => {
    mockFetch({ message: { content: "A sufficiently long hypothetical answer for testing purposes here." } });

    await generateHypothetical("test query", "http://localhost:11434");

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    // Should use ENRICHMENT_MODEL from config (not undefined)
    expect(body.model).toBeDefined();
    expect(typeof body.model).toBe("string");
    expect(body.model.length).toBeGreaterThan(0);
  });

  test("sends think:false to suppress reasoning chain", async () => {
    mockFetch({ message: { content: "A long enough hypothetical answer for the test to pass correctly." } });

    await generateHypothetical("test query");

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.think).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. generateHypothetical — failure cases
// ---------------------------------------------------------------------------
describe("generateHypothetical — failure", () => {
  test("returns null on timeout (AbortError)", async () => {
    mockFetchError(new DOMException("The operation was aborted", "AbortError"));
    const result = await generateHypothetical("test query");
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    mockFetchError(new Error("ECONNREFUSED"));
    const result = await generateHypothetical("test query");
    expect(result).toBeNull();
  });

  test("returns null on HTTP 500", async () => {
    mockFetchStatus(500);
    const result = await generateHypothetical("test query");
    expect(result).toBeNull();
  });

  test("returns null on empty response content", async () => {
    mockFetch({ message: { content: "" } });
    const result = await generateHypothetical("test query");
    expect(result).toBeNull();
  });

  test("returns null on short response (<30 chars)", async () => {
    mockFetch({ message: { content: "Not sure." } });
    const result = await generateHypothetical("test query");
    expect(result).toBeNull();
  });

  test("returns null when message field is missing", async () => {
    mockFetch({ response: "some text" });
    const result = await generateHypothetical("test query");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. HYDE_TYPES membership
// ---------------------------------------------------------------------------
describe("HYDE_TYPES", () => {
  test("includes conceptual", () => {
    expect(HYDE_TYPES.has("conceptual")).toBe(true);
  });

  test("includes error", () => {
    expect(HYDE_TYPES.has("error")).toBe(true);
  });

  test("includes api", () => {
    expect(HYDE_TYPES.has("api")).toBe(true);
  });

  test("includes general", () => {
    expect(HYDE_TYPES.has("general")).toBe(true);
  });

  test("excludes scope", () => {
    expect(HYDE_TYPES.has("scope")).toBe(false);
  });

  test("excludes structural", () => {
    expect(HYDE_TYPES.has("structural")).toBe(false);
  });

  test("excludes code_examples", () => {
    expect(HYDE_TYPES.has("code_examples")).toBe(false);
  });
});
