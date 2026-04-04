"use strict";

const { QueryCache, cosineSim } = require("../retrieval/query-cache");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a random unit vector of given dimension */
function randomUnitVec(dim = 16) {
  const vec = Array.from({ length: dim }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/** Create a vector similar to base (cosine > 0.9) by adding small noise */
function similarVec(base, noise = 0.1) {
  const noisy = base.map((v) => v + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(noisy.reduce((s, v) => s + v * v, 0));
  return noisy.map((v) => v / norm);
}

// ---------------------------------------------------------------------------
// 1. cosineSim correctness
// ---------------------------------------------------------------------------
describe("cosineSim", () => {
  test("identical vectors → 1.0", () => {
    expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 6);
  });

  test("orthogonal vectors → 0.0", () => {
    expect(cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 6);
  });

  test("opposite vectors → -1.0", () => {
    expect(cosineSim([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 6);
  });

  test("45 degree vectors → ~0.707", () => {
    expect(cosineSim([1, 1, 0], [1, 0, 0])).toBeCloseTo(0.7071, 3);
  });

  test("zero vector → 0", () => {
    expect(cosineSim([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  test("empty arrays → 0", () => {
    expect(cosineSim([], [1, 0])).toBe(0);
    expect(cosineSim(null, [1, 0])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. QueryCache — store and lookup
// ---------------------------------------------------------------------------
describe("QueryCache — store and lookup", () => {
  test("store + lookup with identical embedding returns cached result", () => {
    const cache = new QueryCache({ threshold: 0.88 });
    const emb = randomUnitVec(16);
    const result = { chunks: [{ id: "a" }], formatted: "test", count: 1 };

    cache.store(emb, result, "test query", ["python"]);
    expect(cache.lookup(emb)).toBe(result);
  });

  test("lookup returns null for dissimilar embedding", () => {
    const cache = new QueryCache({ threshold: 0.88 });
    const emb1 = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const emb2 = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const result = { formatted: "test" };

    cache.store(emb1, result, "q1", []);
    expect(cache.lookup(emb2)).toBeNull();
  });

  test("lookup returns cached for similar embedding above threshold", () => {
    const cache = new QueryCache({ threshold: 0.88 });
    const base = randomUnitVec(64);
    const similar = similarVec(base, 0.05); // very small noise → high cosine
    const result = { formatted: "hit" };

    cache.store(base, result, "original query", []);

    const sim = cosineSim(base, similar);
    if (sim >= 0.88) {
      expect(cache.lookup(similar)).toBe(result);
    }
    // If noise made it below threshold, that's expected — just skip
  });

  test("returns highest-similarity match when multiple entries match", () => {
    const cache = new QueryCache({ threshold: 0.5 }); // low threshold for testing
    const query = [1, 0, 0, 0];

    // Entry A: cosine = 0.7071 (45 degrees)
    cache.store([1, 1, 0, 0].map((v) => v / Math.sqrt(2)), { id: "A" }, "qA", []);
    // Entry B: cosine = 1.0 (identical)
    cache.store([1, 0, 0, 0], { id: "B" }, "qB", []);
    // Entry C: cosine = 0.5774 (60 degrees)
    cache.store([1, 1, 1, 0].map((v) => v / Math.sqrt(3)), { id: "C" }, "qC", []);

    const hit = cache.lookup(query);
    expect(hit.id).toBe("B"); // highest similarity
  });

  test("lookup returns null on empty cache", () => {
    const cache = new QueryCache();
    expect(cache.lookup(randomUnitVec())).toBeNull();
  });

  test("lookup returns null for null/empty embedding", () => {
    const cache = new QueryCache();
    cache.store(randomUnitVec(), { test: true }, "q", []);
    expect(cache.lookup(null)).toBeNull();
    expect(cache.lookup([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. TTL expiry
// ---------------------------------------------------------------------------
describe("QueryCache — TTL", () => {
  test("expired entries are not returned", async () => {
    const cache = new QueryCache({ ttlMs: 50 });
    const emb = randomUnitVec(16);

    cache.store(emb, { hit: true }, "q", []);
    expect(cache.lookup(emb)).toEqual({ hit: true });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 80));

    expect(cache.lookup(emb)).toBeNull();
  });

  test("non-expired entries are still returned", async () => {
    const cache = new QueryCache({ ttlMs: 5000 });
    const emb = randomUnitVec(16);

    cache.store(emb, { hit: true }, "q", []);
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.lookup(emb)).toEqual({ hit: true });
  });
});

// ---------------------------------------------------------------------------
// 4. LRU eviction
// ---------------------------------------------------------------------------
describe("QueryCache — LRU eviction", () => {
  test("evicts oldest entry when maxEntries exceeded", () => {
    const cache = new QueryCache({ maxEntries: 3 });

    const e1 = randomUnitVec(16);
    const e2 = randomUnitVec(16);
    const e3 = randomUnitVec(16);
    const e4 = randomUnitVec(16);

    cache.store(e1, { id: 1 }, "q1", []);
    cache.store(e2, { id: 2 }, "q2", []);
    cache.store(e3, { id: 3 }, "q3", []);
    expect(cache.size).toBe(3);

    // This should evict e1
    cache.store(e4, { id: 4 }, "q4", []);
    expect(cache.size).toBe(3);

    // e1 should be gone
    expect(cache.lookup(e1)).toBeNull();
    // e4 should be present
    expect(cache.lookup(e4)).toEqual({ id: 4 });
  });
});

// ---------------------------------------------------------------------------
// 5. Invalidation
// ---------------------------------------------------------------------------
describe("QueryCache — invalidation", () => {
  test("invalidate() clears everything", () => {
    const cache = new QueryCache();
    for (let i = 0; i < 10; i++) {
      cache.store(randomUnitVec(16), { id: i }, `q${i}`, ["general"]);
    }
    expect(cache.size).toBe(10);

    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  test("collection-scoped invalidation only evicts matching entries", () => {
    const cache = new QueryCache();
    const e1 = randomUnitVec(16);
    const e2 = randomUnitVec(16);
    const e3 = randomUnitVec(16);

    cache.store(e1, { id: "py" }, "python query", ["python"]);
    cache.store(e2, { id: "node" }, "node query", ["nodejs"]);
    cache.store(e3, { id: "both" }, "mixed query", ["python", "general"]);

    cache.invalidate("python");

    expect(cache.size).toBe(1);
    expect(cache.lookup(e2)).toEqual({ id: "node" }); // nodejs entry survives
    expect(cache.lookup(e1)).toBeNull(); // python entry gone
    expect(cache.lookup(e3)).toBeNull(); // mixed entry gone (included python)
  });

  test("invalidating non-existent collection does nothing", () => {
    const cache = new QueryCache();
    cache.store(randomUnitVec(16), { id: 1 }, "q", ["python"]);

    cache.invalidate("nonexistent");
    expect(cache.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Cache stores collections metadata
// ---------------------------------------------------------------------------
describe("QueryCache — collections metadata", () => {
  test("entries store collections for scoped invalidation", () => {
    const cache = new QueryCache();
    const emb = randomUnitVec(16);

    cache.store(emb, {}, "q", ["python", "general"]);

    // Internal check: entry has collections field
    expect(cache._entries[0].collections).toEqual(["python", "general"]);
  });
});
