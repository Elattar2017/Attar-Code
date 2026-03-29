// kb-engine/tests/embedder.test.js
// TDD: Test file written FIRST — verifies UnifiedEmbedder against real Ollama API.
// Requires: ollama serve + Qwen3-Embedding-4B model pulled.
// Run: npx jest kb-engine/tests/embedder.test.js --no-coverage --testTimeout=30000

"use strict";

const { UnifiedEmbedder } = require("../embedder");
const { EMBED_DIM } = require("../config");

let embedder;

beforeAll(() => {
  embedder = new UnifiedEmbedder();
});

afterAll(() => {
  // Clean up any cached state
  if (embedder && typeof embedder.resetCache === "function") {
    embedder.resetCache();
  }
});

// ─────────────────────────────────────────────
// getAvailableModels
// ─────────────────────────────────────────────
describe("getAvailableModels()", () => {
  test("returns object with model, codeModel and textModel booleans", async () => {
    const availability = await embedder.getAvailableModels();

    expect(availability).toHaveProperty("model");
    expect(availability).toHaveProperty("codeModel");
    expect(availability).toHaveProperty("textModel");
    expect(typeof availability.model).toBe("boolean");
    expect(typeof availability.codeModel).toBe("boolean");
    expect(typeof availability.textModel).toBe("boolean");
  });

  test("at least one model is available (Ollama must be running)", async () => {
    const availability = await embedder.getAvailableModels();
    const atLeastOne = availability.model || availability.codeModel || availability.textModel;
    expect(atLeastOne).toBe(true);
  });

  test("codeModel and textModel are aliases for model (backward compat)", async () => {
    const availability = await embedder.getAvailableModels();
    expect(availability.codeModel).toBe(availability.model);
    expect(availability.textModel).toBe(availability.model);
  });
});

// ─────────────────────────────────────────────
// embedForStorage(text)
// ─────────────────────────────────────────────
describe("embedForStorage(text)", () => {
  test("returns an array", async () => {
    const vec = await embedder.embedForStorage("function add(a, b) { return a + b; }");
    expect(Array.isArray(vec)).toBe(true);
  });

  test(`returns exactly ${EMBED_DIM} dimensions`, async () => {
    const vec = await embedder.embedForStorage("const x = require('path');");
    expect(vec).toHaveLength(EMBED_DIM);
  });

  test("all elements are numbers", async () => {
    const vec = await embedder.embedForStorage("SELECT * FROM users WHERE id = 1;");
    for (const v of vec) {
      expect(typeof v).toBe("number");
      expect(isNaN(v)).toBe(false);
    }
  });

  test("non-zero vector (not all zeros)", async () => {
    const vec = await embedder.embedForStorage("async function fetchData(url) {}");
    const hasNonZero = vec.some((v) => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  test("different inputs produce different vectors", async () => {
    const v1 = await embedder.embedForStorage("function foo() {}");
    const v2 = await embedder.embedForStorage("class DatabaseConnection { connect() {} }");
    const identical = v1.every((val, i) => val === v2[i]);
    expect(identical).toBe(false);
  });
});

// ─────────────────────────────────────────────
// embedForQuery(text, queryType)
// ─────────────────────────────────────────────
describe("embedForQuery(text, queryType)", () => {
  test("returns an array", async () => {
    const vec = await embedder.embedForQuery("This tutorial explains how to use React hooks.");
    expect(Array.isArray(vec)).toBe(true);
  });

  test(`returns exactly ${EMBED_DIM} dimensions`, async () => {
    const vec = await embedder.embedForQuery("Getting started with machine learning in Python.");
    expect(vec).toHaveLength(EMBED_DIM);
  });

  test("all elements are numbers", async () => {
    const vec = await embedder.embedForQuery("The quick brown fox jumps over the lazy dog.");
    for (const v of vec) {
      expect(typeof v).toBe("number");
      expect(isNaN(v)).toBe(false);
    }
  });

  test("non-zero vector (not all zeros)", async () => {
    const vec = await embedder.embedForQuery("Understanding dependency injection in software design.");
    const hasNonZero = vec.some((v) => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  test("different inputs produce different vectors", async () => {
    const v1 = await embedder.embedForQuery("Introduction to TypeScript.");
    const v2 = await embedder.embedForQuery("Advanced Kubernetes deployment strategies.");
    const identical = v1.every((val, i) => val === v2[i]);
    expect(identical).toBe(false);
  });

  test("accepts queryType parameter ('code', 'error', 'structural')", async () => {
    const vecGeneral = await embedder.embedForQuery("express middleware", "general");
    const vecCode = await embedder.embedForQuery("express middleware", "code");
    expect(vecGeneral).toHaveLength(EMBED_DIM);
    expect(vecCode).toHaveLength(EMBED_DIM);
    // Different prefixes should produce different vectors for the same text
    const identical = vecGeneral.every((val, i) => val === vecCode[i]);
    expect(identical).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Combined storage + query tests
// ─────────────────────────────────────────────
describe("embedForStorage + embedForQuery (combined)", () => {
  test("storage and query embeddings have the same dimensionality", async () => {
    const storageVec = await embedder.embedForStorage("import React from 'react';");
    const queryVec = await embedder.embedForQuery("import React from 'react';");
    expect(storageVec).toHaveLength(EMBED_DIM);
    expect(queryVec).toHaveLength(EMBED_DIM);
  });

  test("both return non-zero arrays of numbers", async () => {
    const storageVec = await embedder.embedForStorage("async/await syntax in JavaScript");
    const queryVec = await embedder.embedForQuery("async/await syntax in JavaScript");

    for (const v of storageVec) {
      expect(typeof v).toBe("number");
      expect(isNaN(v)).toBe(false);
    }
    for (const v of queryVec) {
      expect(typeof v).toBe("number");
      expect(isNaN(v)).toBe(false);
    }

    expect(storageVec.some((v) => v !== 0)).toBe(true);
    expect(queryVec.some((v) => v !== 0)).toBe(true);
  });

  test("storage and query vectors differ (asymmetric prefix effect)", async () => {
    const storageVec = await embedder.embedForStorage("const express = require('express');");
    const queryVec = await embedder.embedForQuery("const express = require('express');");
    // Asymmetric prefix means the same text produces different embeddings for storage vs query
    const identical = storageVec.every((val, i) => val === queryVec[i]);
    expect(identical).toBe(false);
  });
});

// ─────────────────────────────────────────────
// embedBatch()
// ─────────────────────────────────────────────
describe("embedBatch(texts[])", () => {
  const chunks = [
    "function mergeSort(arr) { /* ... */ }",
    "Merge sort is a divide-and-conquer sorting algorithm.",
    "const sorted = arr.slice().sort((a, b) => a - b);",
  ];

  test("returns an array of results", async () => {
    const results = await embedder.embedBatch(chunks);
    expect(Array.isArray(results)).toBe(true);
  });

  test("returns same count as input", async () => {
    const results = await embedder.embedBatch(chunks);
    expect(results).toHaveLength(chunks.length);
  });

  test("each result is a flat number[] vector (not an object)", async () => {
    const results = await embedder.embedBatch(chunks);
    for (const r of results) {
      expect(Array.isArray(r)).toBe(true);
      for (const v of r) {
        expect(typeof v).toBe("number");
      }
    }
  });

  test(`each vector is ${EMBED_DIM}-dimensional`, async () => {
    const results = await embedder.embedBatch(chunks);
    for (const r of results) {
      expect(r).toHaveLength(EMBED_DIM);
    }
  });

  test("handles empty array", async () => {
    const results = await embedder.embedBatch([]);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  test("handles single-item array", async () => {
    const results = await embedder.embedBatch(["hello world"]);
    expect(results).toHaveLength(1);
    expect(Array.isArray(results[0])).toBe(true);
    expect(results[0]).toHaveLength(EMBED_DIM);
  });
});

// ─────────────────────────────────────────────
// resetCache()
// ─────────────────────────────────────────────
describe("resetCache()", () => {
  test("can be called without error", () => {
    expect(() => embedder.resetCache()).not.toThrow();
  });

  test("getAvailableModels still works after reset", async () => {
    embedder.resetCache();
    const availability = await embedder.getAvailableModels();
    expect(typeof availability.model).toBe("boolean");
    expect(typeof availability.codeModel).toBe("boolean");
    expect(typeof availability.textModel).toBe("boolean");
  });
});
