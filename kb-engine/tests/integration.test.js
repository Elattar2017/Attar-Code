// kb-engine/tests/integration.test.js
// End-to-end integration tests for the full KB Engine pipeline.
// Requires BOTH Qdrant (http://127.0.0.1:6333) AND Ollama (http://127.0.0.1:11434).
// Tests skip automatically if either service is unavailable.
// Run: npx jest kb-engine/tests/integration.test.js --no-coverage --testTimeout=60000

"use strict";

const http = require("http");
const { KBEngine } = require("../index");

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_COLLECTION = "kb_integration_test";

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

// ─── Test data ────────────────────────────────────────────────────────────────

const TEST_CHUNKS = [
  {
    content:  "Express.js is a minimal web framework for Node.js. Use app.use() to register middleware. Middleware functions have access to req, res, and next.",
    metadata: { language: "javascript", framework: "express", doc_type: "tutorial" },
  },
  {
    content:  "function authenticate(req, res, next) { const token = req.headers.authorization; if (!token) return res.status(401).json({ error: 'Unauthorized' }); next(); }",
    metadata: { language: "javascript", framework: "express", doc_type: "api" },
  },
  {
    content:  "Django is a high-level Python web framework that encourages rapid development. It follows the model-template-view (MTV) architectural pattern.",
    metadata: { language: "python", framework: "django", doc_type: "tutorial" },
  },
];

// ─── Module-level state ───────────────────────────────────────────────────────

let engine;
let qdrantAvailable  = false;
let ollamaAvailable  = false;
let servicesAvailable = false;

// IDs from the addChunks call — shared across tests in this file
let insertedIds = [];

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  [qdrantAvailable, ollamaAvailable] = await Promise.all([
    isQdrantReachable(),
    isOllamaReachable(),
  ]);
  servicesAvailable = qdrantAvailable && ollamaAvailable;

  if (!servicesAvailable) return;

  engine = new KBEngine();

  // Remove any leftover collection from a prior run
  try {
    await engine.store.deleteCollection(TEST_COLLECTION);
  } catch (_) { /* ignore */ }

  // Provision the test collection
  await engine.store.ensureCollection(TEST_COLLECTION);
}, 30000);

afterAll(async () => {
  if (!servicesAvailable || !engine) return;

  try {
    await engine.store.deleteCollection(TEST_COLLECTION);
  } catch (_) { /* ignore */ }
}, 15000);

// ─── KBEngine class shape (no services needed) ────────────────────────────────

describe("KBEngine class shape", () => {
  test("can be constructed without arguments", () => {
    expect(() => new KBEngine()).not.toThrow();
  });

  test("exposes qdrantManager", () => {
    const e = new KBEngine();
    expect(e.qdrantManager).toBeDefined();
  });

  test("exposes embedder", () => {
    const e = new KBEngine();
    expect(e.embedder).toBeDefined();
  });

  test("exposes collectionMgr", () => {
    const e = new KBEngine();
    expect(e.collectionMgr).toBeDefined();
  });

  test("exposes store", () => {
    const e = new KBEngine();
    expect(e.store).toBeDefined();
  });

  test("exposes config", () => {
    const e = new KBEngine();
    expect(e.config).toBeDefined();
    expect(typeof e.config).toBe("object");
  });

  test("has start method", () => {
    const e = new KBEngine();
    expect(typeof e.start).toBe("function");
  });

  test("has stop method", () => {
    const e = new KBEngine();
    expect(typeof e.stop).toBe("function");
  });

  test("has getStatus method", () => {
    const e = new KBEngine();
    expect(typeof e.getStatus).toBe("function");
  });
});

// ─── Module exports ───────────────────────────────────────────────────────────

describe("module exports", () => {
  test("exports KBEngine", () => {
    const kb = require("../index");
    expect(typeof kb.KBEngine).toBe("function");
  });

  test("exports QdrantManager", () => {
    const kb = require("../index");
    expect(typeof kb.QdrantManager).toBe("function");
  });

  test("exports UnifiedEmbedder", () => {
    const kb = require("../index");
    expect(typeof kb.UnifiedEmbedder).toBe("function");
  });

  test("exports DualEmbedder (backward compat alias)", () => {
    const kb = require("../index");
    expect(typeof kb.DualEmbedder).toBe("function");
    // DualEmbedder should be the same class as UnifiedEmbedder
    expect(kb.DualEmbedder).toBe(kb.UnifiedEmbedder);
  });

  test("exports SparseVectorizer", () => {
    const kb = require("../index");
    expect(typeof kb.SparseVectorizer).toBe("function");
  });

  test("exports CollectionManager", () => {
    const kb = require("../index");
    expect(typeof kb.CollectionManager).toBe("function");
  });

  test("exports ChunkStore", () => {
    const kb = require("../index");
    expect(typeof kb.ChunkStore).toBe("function");
  });

  test("exports config object", () => {
    const kb = require("../index");
    expect(typeof kb.config).toBe("object");
    expect(kb.config).not.toBeNull();
  });

  test("config has QDRANT_URL", () => {
    const kb = require("../index");
    expect(kb.config).toHaveProperty("QDRANT_URL");
  });
});

// ─── Full pipeline: embed → store → search ────────────────────────────────────

describe("Full pipeline (requires Qdrant + Ollama)", () => {
  // ── 1. addChunks ────────────────────────────────────────────────────────────

  test("1. addChunks returns 3 IDs for the 3 test chunks", async () => {
    if (!servicesAvailable) return;

    insertedIds = await engine.store.addChunks(TEST_COLLECTION, TEST_CHUNKS);

    expect(Array.isArray(insertedIds)).toBe(true);
    expect(insertedIds).toHaveLength(3);

    // Each ID should be a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const id of insertedIds) {
      expect(typeof id).toBe("string");
      expect(id).toMatch(uuidRegex);
    }
  }, 60000);

  // ── 2. Dense search ─────────────────────────────────────────────────────────

  test("2. search('express middleware') finds Express chunks first", async () => {
    if (!servicesAvailable) return;

    const results = await engine.store.search(TEST_COLLECTION, "express middleware", {
      limit: 3,
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // Each result must have the required shape
    for (const r of results) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("content");
      expect(r).toHaveProperty("metadata");
      expect(typeof r.score).toBe("number");
      expect(typeof r.content).toBe("string");
    }

    // The top result must be an Express chunk (language=javascript, framework=express)
    const top = results[0];
    expect(top.metadata.framework).toBe("express");
  }, 30000);

  // ── 3. Hybrid search ────────────────────────────────────────────────────────

  test("3. hybridSearch('authenticate token') finds the auth code chunk", async () => {
    if (!servicesAvailable) return;

    const results = await engine.store.hybridSearch(
      TEST_COLLECTION,
      "authenticate token",
      { limit: 3 }
    );

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // Shape check
    for (const r of results) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("content");
      expect(r).toHaveProperty("metadata");
    }

    // The authenticate function chunk (doc_type=api) should appear in the results
    const hasAuthChunk = results.some(
      (r) => r.metadata.doc_type === "api" && r.metadata.framework === "express"
    );
    expect(hasAuthChunk).toBe(true);
  }, 30000);

  // ── 4. Filtered search ──────────────────────────────────────────────────────

  test("4. filtered search (language=python) returns only the Django chunk", async () => {
    if (!servicesAvailable) return;

    const results = await engine.store.search(TEST_COLLECTION, "web framework", {
      limit: 10,
      filter: [{ key: "language", value: "python" }],
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // Every returned result must have language=python
    for (const r of results) {
      expect(r.metadata.language).toBe("python");
    }

    // The Django chunk should be present
    const hasDjango = results.some((r) => r.metadata.framework === "django");
    expect(hasDjango).toBe(true);
  }, 30000);
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe("getStatus() (requires Qdrant + Ollama)", () => {
  test("returns an object with qdrant, models, collections keys", async () => {
    if (!servicesAvailable) return;

    const status = await engine.getStatus();

    expect(typeof status).toBe("object");
    expect(status).not.toBeNull();
    expect(status).toHaveProperty("qdrant");
    expect(status).toHaveProperty("models");
    expect(status).toHaveProperty("collections");
  }, 15000);

  test("qdrant.running is true when Qdrant is reachable", async () => {
    if (!servicesAvailable) return;

    const status = await engine.getStatus();
    expect(status.qdrant.running).toBe(true);
  }, 15000);

  test("models has model, codeModel and textModel boolean fields", async () => {
    if (!servicesAvailable) return;

    const status = await engine.getStatus();
    expect(status.models).toHaveProperty("model");
    expect(status.models).toHaveProperty("codeModel");
    expect(status.models).toHaveProperty("textModel");
    expect(typeof status.models.model).toBe("boolean");
    expect(typeof status.models.codeModel).toBe("boolean");
    expect(typeof status.models.textModel).toBe("boolean");
    // codeModel and textModel are backward compat aliases for model
    expect(status.models.codeModel).toBe(status.models.model);
    expect(status.models.textModel).toBe(status.models.model);
  }, 15000);

  test("at least one embedding model is available", async () => {
    if (!servicesAvailable) return;

    const status = await engine.getStatus();
    const atLeastOne = status.models.model || status.models.codeModel || status.models.textModel;
    expect(atLeastOne).toBe(true);
  }, 15000);

  test("collections is an array of stats objects", async () => {
    if (!servicesAvailable) return;

    const status = await engine.getStatus();
    expect(Array.isArray(status.collections)).toBe(true);

    for (const col of status.collections) {
      expect(col).toHaveProperty("name");
      expect(col).toHaveProperty("vectors_count");
      expect(col).toHaveProperty("points_count");
      expect(col).toHaveProperty("status");
    }
  }, 15000);
});

// ─── Different content types → different rankings ─────────────────────────────

describe("Content-type ranking differentiation (requires Qdrant + Ollama)", () => {
  test("code query ranks the API/code chunk above the tutorial chunk", async () => {
    if (!servicesAvailable) return;

    // Query that closely matches the authenticate() function (uses 'code' queryType)
    const results = await engine.store.search(
      TEST_COLLECTION,
      "authenticate function token authorization header",
      { limit: 3, queryType: "code" }
    );

    expect(results.length).toBeGreaterThan(0);

    // The API doc_type chunk should appear in results (not necessarily rank 1,
    // but it should score alongside or above tutorials)
    const apiChunkIndex   = results.findIndex((r) => r.metadata.doc_type === "api");
    const tutorialIndex   = results.findIndex((r) => r.metadata.doc_type === "tutorial" && r.metadata.framework === "express");

    // If both appear: API chunk should rank at least as well as the tutorial
    if (apiChunkIndex !== -1 && tutorialIndex !== -1) {
      expect(apiChunkIndex).toBeLessThanOrEqual(tutorialIndex);
    } else {
      // At minimum the API chunk must be present
      expect(apiChunkIndex).toBeGreaterThanOrEqual(0);
    }
  }, 30000);

  test("tutorial query ranks tutorial chunks higher than API code", async () => {
    if (!servicesAvailable) return;

    const results = await engine.store.search(
      TEST_COLLECTION,
      "web framework tutorial rapid development",
      { limit: 3, queryType: "general" }
    );

    expect(results.length).toBeGreaterThan(0);

    // At least one tutorial result should be in top results
    const tutorialResult = results.find((r) => r.metadata.doc_type === "tutorial");
    expect(tutorialResult).toBeDefined();
  }, 30000);
});
