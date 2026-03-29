// kb-engine/tests/collections.test.js
// TDD: Tests written FIRST.
// Integration tests — require Qdrant running at http://127.0.0.1:6333
// Tests SKIP automatically if Qdrant is not reachable.
// Run: npx jest kb-engine/tests/collections.test.js --no-coverage --testTimeout=15000

"use strict";

const http = require("http");
const { CollectionManager } = require("../collections");
const { QDRANT_URL, COLLECTIONS } = require("../config");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_COLLECTION = "test_collections_xyz";

/**
 * Check if Qdrant is reachable — used to skip tests when it is not running.
 * @returns {Promise<boolean>}
 */
function isQdrantReachable() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:6333/healthz", (res) => {
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let manager;
let qdrantAvailable = false;

beforeAll(async () => {
  qdrantAvailable = await isQdrantReachable();
  if (qdrantAvailable) {
    manager = new CollectionManager({ url: "http://127.0.0.1:6333" });
    // Clean up any leftover test collection from a previous run
    try {
      await manager.deleteCollection(TEST_COLLECTION);
    } catch (_) {
      // Ignore — it may not exist
    }
  }
});

afterAll(async () => {
  if (qdrantAvailable && manager) {
    // Clean up the test collection we created
    try {
      await manager.deleteCollection(TEST_COLLECTION);
    } catch (_) {
      // Ignore
    }
  }
});

// ─── Class Shape ──────────────────────────────────────────────────────────────

describe("CollectionManager class shape", () => {
  test("CollectionManager can be constructed without arguments", () => {
    expect(() => new CollectionManager()).not.toThrow();
  });

  test("constructor accepts optional url override", () => {
    expect(
      () => new CollectionManager({ url: "http://127.0.0.1:6333" })
    ).not.toThrow();
  });

  test("instance has ensureCollection method", () => {
    const m = new CollectionManager();
    expect(typeof m.ensureCollection).toBe("function");
  });

  test("instance has ensureAllCollections method", () => {
    const m = new CollectionManager();
    expect(typeof m.ensureAllCollections).toBe("function");
  });

  test("instance has collectionExists method", () => {
    const m = new CollectionManager();
    expect(typeof m.collectionExists).toBe("function");
  });

  test("instance has listCollections method", () => {
    const m = new CollectionManager();
    expect(typeof m.listCollections).toBe("function");
  });

  test("instance has getCollectionInfo method", () => {
    const m = new CollectionManager();
    expect(typeof m.getCollectionInfo).toBe("function");
  });

  test("instance has deleteCollection method", () => {
    const m = new CollectionManager();
    expect(typeof m.deleteCollection).toBe("function");
  });

  test("instance has getAllStats method", () => {
    const m = new CollectionManager();
    expect(typeof m.getAllStats).toBe("function");
  });
});

// ─── Integration Tests (require Qdrant) ───────────────────────────────────────

describe("ensureCollection(name)", () => {
  test("creates a collection that did not exist", async () => {
    if (!qdrantAvailable) return;
    await expect(manager.ensureCollection(TEST_COLLECTION)).resolves.not.toThrow();
  });

  test("is idempotent — calling twice does not throw", async () => {
    if (!qdrantAvailable) return;
    await manager.ensureCollection(TEST_COLLECTION);
    await expect(manager.ensureCollection(TEST_COLLECTION)).resolves.not.toThrow();
  });
});

describe("collectionExists(name)", () => {
  beforeAll(async () => {
    if (qdrantAvailable) {
      await manager.ensureCollection(TEST_COLLECTION);
    }
  });

  test("returns a Promise", () => {
    if (!qdrantAvailable) return;
    const result = manager.collectionExists(TEST_COLLECTION);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  test("returns true after ensureCollection", async () => {
    if (!qdrantAvailable) return;
    const exists = await manager.collectionExists(TEST_COLLECTION);
    expect(exists).toBe(true);
  });

  test("returns false for a collection that does not exist", async () => {
    if (!qdrantAvailable) return;
    const exists = await manager.collectionExists("__nonexistent_collection_xyz__");
    expect(exists).toBe(false);
  });
});

describe("listCollections()", () => {
  beforeAll(async () => {
    if (qdrantAvailable) {
      await manager.ensureCollection(TEST_COLLECTION);
    }
  });

  test("returns an array of strings", async () => {
    if (!qdrantAvailable) return;
    const list = await manager.listCollections();
    expect(Array.isArray(list)).toBe(true);
    for (const item of list) {
      expect(typeof item).toBe("string");
    }
  });

  test("includes the test collection after creation", async () => {
    if (!qdrantAvailable) return;
    const list = await manager.listCollections();
    expect(list).toContain(TEST_COLLECTION);
  });
});

describe("getCollectionInfo(name)", () => {
  beforeAll(async () => {
    if (qdrantAvailable) {
      await manager.ensureCollection(TEST_COLLECTION);
    }
  });

  test("returns an object", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(typeof info).toBe("object");
    expect(info).not.toBeNull();
  });

  test("returned object has name property matching requested collection", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(info.name).toBe(TEST_COLLECTION);
  });

  test("returned object has vectors_count property", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(info).toHaveProperty("vectors_count");
  });

  test("returned object has points_count property", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(info).toHaveProperty("points_count");
  });

  test("returned object has status property", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(info).toHaveProperty("status");
  });

  test("vectors_count is 0 for a freshly created empty collection", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(info.vectors_count).toBe(0);
  });

  test("status is a non-empty string", async () => {
    if (!qdrantAvailable) return;
    const info = await manager.getCollectionInfo(TEST_COLLECTION);
    expect(typeof info.status).toBe("string");
    expect(info.status.length).toBeGreaterThan(0);
  });
});

describe("deleteCollection(name)", () => {
  const TO_DELETE = "test_collections_delete_me";

  beforeAll(async () => {
    if (qdrantAvailable) {
      await manager.ensureCollection(TO_DELETE);
    }
  });

  test("deletes an existing collection without throwing", async () => {
    if (!qdrantAvailable) return;
    await expect(manager.deleteCollection(TO_DELETE)).resolves.not.toThrow();
  });

  test("collectionExists returns false after deletion", async () => {
    if (!qdrantAvailable) return;
    const exists = await manager.collectionExists(TO_DELETE);
    expect(exists).toBe(false);
  });

  test("is safe to call on a non-existent collection (does not throw)", async () => {
    if (!qdrantAvailable) return;
    await expect(
      manager.deleteCollection("__nonexistent_xyz_999__")
    ).resolves.not.toThrow();
  });
});

describe("getAllStats()", () => {
  beforeAll(async () => {
    if (qdrantAvailable) {
      await manager.ensureCollection(TEST_COLLECTION);
    }
  });

  test("returns an array", async () => {
    if (!qdrantAvailable) return;
    const stats = await manager.getAllStats();
    expect(Array.isArray(stats)).toBe(true);
  });

  test("each element has name, vectors_count, points_count, status", async () => {
    if (!qdrantAvailable) return;
    const stats = await manager.getAllStats();
    for (const item of stats) {
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("vectors_count");
      expect(item).toHaveProperty("points_count");
      expect(item).toHaveProperty("status");
    }
  });
});

describe("ensureAllCollections()", () => {
  test("returns a Promise", () => {
    if (!qdrantAvailable) return;
    const result = manager.ensureAllCollections();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  test("creates all 15 default collections", async () => {
    if (!qdrantAvailable) return;
    await manager.ensureAllCollections();
    const list = await manager.listCollections();
    for (const name of COLLECTIONS) {
      expect(list).toContain(name);
    }
  }, 30000); // allow extra time for 15 collection creations
});
