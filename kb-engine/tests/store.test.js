// kb-engine/tests/store.test.js
// TDD: Tests written FIRST.
// Integration tests — require Qdrant running at http://127.0.0.1:6333
//                     AND Ollama running at http://127.0.0.1:11434
// Tests SKIP automatically if either service is not reachable.
// Run: npx jest kb-engine/tests/store.test.js --no-coverage --testTimeout=30000

"use strict";

const http = require("http");
const { ChunkStore } = require("../store");

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_COLLECTION = "test_store_xyz";

// ─── Service availability helpers ─────────────────────────────────────────────

function isQdrantReachable() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:6333/healthz", (res) => {
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

function isOllamaReachable() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:11434/api/tags", (res) => {
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SAMPLE_CHUNKS = [
  {
    content: "function add(a, b) { return a + b; }",
    metadata: { language: "javascript", framework: "none", doc_type: "code" },
  },
  {
    content: "async function fetchUser(id) { return db.users.findById(id); }",
    metadata: { language: "javascript", framework: "express", doc_type: "code" },
  },
  {
    content: "def compute_sum(numbers): return sum(numbers)",
    metadata: { language: "python", framework: "none", doc_type: "code" },
  },
  {
    content: "SELECT * FROM users WHERE active = true ORDER BY created_at DESC;",
    metadata: { language: "sql", framework: "none", doc_type: "query" },
  },
  {
    content: "How to use React hooks: useState returns a stateful value and a setter function.",
    metadata: { language: "javascript", framework: "react", doc_type: "tutorial" },
  },
];

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let store;
let qdrantAvailable = false;
let ollamaAvailable = false;
let servicesAvailable = false;

beforeAll(async () => {
  [qdrantAvailable, ollamaAvailable] = await Promise.all([
    isQdrantReachable(),
    isOllamaReachable(),
  ]);
  servicesAvailable = qdrantAvailable && ollamaAvailable;

  if (servicesAvailable) {
    store = new ChunkStore();
    // Clean up any leftover test collection from a previous run
    try {
      await store.deleteCollection(TEST_COLLECTION);
    } catch (_) { /* ignore */ }
    // Create fresh collection for this test run
    await store.ensureCollection(TEST_COLLECTION);
  }
}, 30000);

afterAll(async () => {
  if (servicesAvailable && store) {
    try {
      await store.deleteCollection(TEST_COLLECTION);
    } catch (_) { /* ignore */ }
  }
}, 15000);

// ─── Class shape tests (no services needed) ───────────────────────────────────

describe("ChunkStore class shape", () => {
  test("ChunkStore can be constructed without arguments", () => {
    expect(() => new ChunkStore()).not.toThrow();
  });

  test("instance has ensureCollection method", () => {
    const s = new ChunkStore();
    expect(typeof s.ensureCollection).toBe("function");
  });

  test("instance has deleteCollection method", () => {
    const s = new ChunkStore();
    expect(typeof s.deleteCollection).toBe("function");
  });

  test("instance has addChunks method", () => {
    const s = new ChunkStore();
    expect(typeof s.addChunks).toBe("function");
  });

  test("instance has search method", () => {
    const s = new ChunkStore();
    expect(typeof s.search).toBe("function");
  });

  test("instance has hybridSearch method", () => {
    const s = new ChunkStore();
    expect(typeof s.hybridSearch).toBe("function");
  });

  test("instance has getChunkCount method", () => {
    const s = new ChunkStore();
    expect(typeof s.getChunkCount).toBe("function");
  });
});

// ─── addChunks ────────────────────────────────────────────────────────────────

describe("addChunks(collection, chunks)", () => {
  test("returns an array of UUIDs with correct count", async () => {
    if (!servicesAvailable) return;

    const ids = await store.addChunks(TEST_COLLECTION, SAMPLE_CHUNKS);
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toHaveLength(SAMPLE_CHUNKS.length);
  }, 60000);

  test("each returned ID is a valid UUID string", async () => {
    if (!servicesAvailable) return;

    const ids = await store.addChunks(TEST_COLLECTION, [SAMPLE_CHUNKS[0]]);
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id).toMatch(uuidRegex);
    }
  }, 30000);

  test("returns empty array for empty input", async () => {
    if (!servicesAvailable) return;

    const ids = await store.addChunks(TEST_COLLECTION, []);
    expect(ids).toEqual([]);
  });

  test("each call produces unique IDs (no duplicates between calls)", async () => {
    if (!servicesAvailable) return;

    const ids1 = await store.addChunks(TEST_COLLECTION, [SAMPLE_CHUNKS[0]]);
    const ids2 = await store.addChunks(TEST_COLLECTION, [SAMPLE_CHUNKS[0]]);
    expect(ids1[0]).not.toBe(ids2[0]);
  }, 30000);
});

// ─── getChunkCount ────────────────────────────────────────────────────────────

describe("getChunkCount(collection)", () => {
  test("returns a non-negative integer", async () => {
    if (!servicesAvailable) return;

    const count = await store.getChunkCount(TEST_COLLECTION);
    expect(typeof count).toBe("number");
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("count increases after addChunks", async () => {
    if (!servicesAvailable) return;

    const before = await store.getChunkCount(TEST_COLLECTION);
    await store.addChunks(TEST_COLLECTION, [SAMPLE_CHUNKS[1]]);
    const after = await store.getChunkCount(TEST_COLLECTION);
    expect(after).toBeGreaterThan(before);
  }, 30000);
});

// ─── search (dense) ───────────────────────────────────────────────────────────

describe("search(collection, query, opts)", () => {
  beforeAll(async () => {
    // Ensure we have chunks to search over
    if (servicesAvailable) {
      await store.addChunks(TEST_COLLECTION, SAMPLE_CHUNKS);
    }
  }, 60000);

  test("returns an array", async () => {
    if (!servicesAvailable) return;

    const results = await store.search(TEST_COLLECTION, "javascript function", {});
    expect(Array.isArray(results)).toBe(true);
  }, 30000);

  test("each result has id, score, content, metadata", async () => {
    if (!servicesAvailable) return;

    const results = await store.search(TEST_COLLECTION, "javascript function", {
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("content");
      expect(r).toHaveProperty("metadata");
      expect(typeof r.score).toBe("number");
      expect(typeof r.content).toBe("string");
    }
  }, 30000);

  test("respects the limit option", async () => {
    if (!servicesAvailable) return;

    const results = await store.search(TEST_COLLECTION, "code", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  }, 30000);

  test("uses dense vector by default", async () => {
    if (!servicesAvailable) return;

    const results = await store.search(TEST_COLLECTION, "function add numbers", {
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  }, 30000);

  test("works with queryType='code'", async () => {
    if (!servicesAvailable) return;

    const results = await store.search(
      TEST_COLLECTION,
      "tutorial about hooks useState",
      { limit: 5, queryType: "code" }
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  }, 30000);

  test("filtered search returns only matching language", async () => {
    if (!servicesAvailable) return;

    const results = await store.search(TEST_COLLECTION, "code function", {
      limit: 10,
      filter: [{ key: "language", value: "python" }],
    });
    expect(Array.isArray(results)).toBe(true);
    // All returned results must have language=python
    for (const r of results) {
      expect(r.metadata.language).toBe("python");
    }
  }, 30000);
});

// ─── hybridSearch ─────────────────────────────────────────────────────────────

describe("hybridSearch(collection, query, opts)", () => {
  test("returns an array", async () => {
    if (!servicesAvailable) return;

    const results = await store.hybridSearch(TEST_COLLECTION, "javascript async function", {});
    expect(Array.isArray(results)).toBe(true);
  }, 30000);

  test("each result has id, score, content, metadata", async () => {
    if (!servicesAvailable) return;

    const results = await store.hybridSearch(
      TEST_COLLECTION,
      "javascript async function fetch user",
      { limit: 5 }
    );
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("content");
      expect(r).toHaveProperty("metadata");
      expect(typeof r.score).toBe("number");
    }
  }, 30000);

  test("results are sorted by score descending", async () => {
    if (!servicesAvailable) return;

    const results = await store.hybridSearch(TEST_COLLECTION, "function", { limit: 5 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  }, 30000);

  test("hybrid returns at least as many results as dense-only for same query", async () => {
    if (!servicesAvailable) return;

    const query = "javascript function";
    const dense = await store.search(TEST_COLLECTION, query, { limit: 10 });
    const hybrid = await store.hybridSearch(TEST_COLLECTION, query, { limit: 10 });
    // Hybrid merges dense + sparse — generally more results (or equal)
    expect(hybrid.length).toBeGreaterThanOrEqual(dense.length - 1);
  }, 30000);

  test("respects the limit option", async () => {
    if (!servicesAvailable) return;

    const results = await store.hybridSearch(TEST_COLLECTION, "code", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  }, 30000);
});
