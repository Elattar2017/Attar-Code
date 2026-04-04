"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadDNA, saveDNA, flattenDNA } = require("../ingestion/dna-loader");
const { assembleContext } = require("../retrieval/context-assembler");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Override DNA_DIR for tests to use temp directory
const TEST_DNA_DIR = path.join(os.tmpdir(), `attar-dna-test-${Date.now()}`);

// Monkey-patch config.DNA_DIR for test isolation
beforeAll(() => {
  const config = require("../config");
  config.DNA_DIR = TEST_DNA_DIR;
});

afterAll(() => {
  try { fs.rmSync(TEST_DNA_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// 1. saveDNA / loadDNA
// ---------------------------------------------------------------------------
describe("saveDNA / loadDNA", () => {
  test("saveDNA creates valid JSON sidecar file", () => {
    const dna = {
      identity: { title: "Test Document" },
      authority: { level: "canonical", trust_rating: 5 },
    };
    saveDNA("abc123", dna);

    const filePath = path.join(TEST_DNA_DIR, "abc123.dna.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed).toEqual(dna);
  });

  test("loadDNA returns parsed object for existing file", () => {
    const dna = { authority: { level: "community", trust_rating: 3 } };
    saveDNA("def456", dna);
    expect(loadDNA("def456")).toEqual(dna);
  });

  test("loadDNA returns null for missing file", () => {
    expect(loadDNA("nonexistent")).toBeNull();
  });

  test("loadDNA returns null for corrupted JSON", () => {
    const dir = TEST_DNA_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "corrupt.dna.json"), "{{bad json", "utf-8");
    expect(loadDNA("corrupt")).toBeNull();
  });

  test("saveDNA overwrites existing file", () => {
    saveDNA("overwrite1", { v: 1 });
    saveDNA("overwrite1", { v: 2 });
    expect(loadDNA("overwrite1")).toEqual({ v: 2 });
  });
});

// ---------------------------------------------------------------------------
// 2. flattenDNA
// ---------------------------------------------------------------------------
describe("flattenDNA", () => {
  test("full DNA → all dna_* fields present", () => {
    const dna = {
      authority: { level: "canonical", trust_rating: 5, is_canonical: true, freshness: "current" },
      character: { depth: "Advanced", doc_type: "Book" },
      retrieval: { key_topics: ["async", "closures"], best_for: ["How-to"], anti_tags: ["ml"], prerequisites: "OOP basics" },
      relations: { conflict_priority: "high", supersedes: "Old Book" },
    };

    const flat = flattenDNA(dna);
    expect(flat.dna_authority).toBe("canonical");
    expect(flat.dna_trust).toBe(5);
    expect(flat.dna_canonical).toBe(true);
    expect(flat.dna_freshness).toBe("current");
    expect(flat.dna_depth).toBe("Advanced");
    expect(flat.dna_doc_type).toBe("Book");
    expect(flat.dna_key_topics).toEqual(["async", "closures"]);
    expect(flat.dna_best_for).toEqual(["How-to"]);
    expect(flat.dna_anti_tags).toEqual(["ml"]);
    expect(flat.dna_prerequisites).toBe("OOP basics");
    expect(flat.dna_conflict_priority).toBe("high");
    expect(flat.dna_supersedes).toBe("Old Book");
  });

  test("partial DNA → only present fields", () => {
    const flat = flattenDNA({ authority: { level: "community" } });
    expect(flat).toEqual({ dna_authority: "community" });
  });

  test("empty DNA → empty object", () => {
    expect(flattenDNA({})).toEqual({});
  });

  test("null/undefined → empty object", () => {
    expect(flattenDNA(null)).toEqual({});
    expect(flattenDNA(undefined)).toEqual({});
  });

  test("empty arrays are not included", () => {
    const flat = flattenDNA({ retrieval: { key_topics: [], anti_tags: [] } });
    expect(flat).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. DNA multiplicative scoring in assembleContext
// ---------------------------------------------------------------------------
describe("DNA scoring in assembleContext", () => {
  test("canonical authority multiplies score by 1.15", () => {
    const chunks = [
      {
        content: "canonical content here with enough text",
        score: 0.80,
        rerankScore: 0.80,
        metadata: { doc_title: "Doc A", dna_authority: "canonical" },
      },
      {
        content: "personal content here with enough text",
        score: 0.85,
        rerankScore: 0.85,
        metadata: { doc_title: "Doc B", dna_authority: "personal" },
      },
    ];

    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 2 });
    // Canonical: 0.80 * 1.15 = 0.92
    // Personal:  0.85 * 0.95 = 0.8075
    // After DNA boost, canonical should rank first
    expect(result.chunks[0].metadata.dna_authority).toBe("canonical");
  });

  test("legacy freshness penalizes score", () => {
    const chunks = [
      {
        content: "legacy documentation content text here",
        score: 0.90,
        rerankScore: 0.90,
        metadata: { doc_title: "Old Doc", dna_freshness: "legacy" },
      },
      {
        content: "current documentation content text here",
        score: 0.80,
        rerankScore: 0.80,
        metadata: { doc_title: "New Doc", dna_freshness: "current" },
      },
    ];

    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 2 });
    // Legacy:  0.90 * 0.90 = 0.81
    // Current: 0.80 * 1.05 = 0.84
    // Current should rank first after DNA boost
    expect(result.chunks[0].metadata.dna_freshness).toBe("current");
  });

  test("trust 5 boosts, trust 1 penalizes", () => {
    const chunks = [
      {
        content: "low trust content with enough words for the test",
        score: 0.85,
        rerankScore: 0.85,
        metadata: { doc_title: "Low Trust", dna_trust: 1 },
      },
      {
        content: "high trust content with enough words for the test",
        score: 0.80,
        rerankScore: 0.80,
        metadata: { doc_title: "High Trust", dna_trust: 5 },
      },
    ];

    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 2 });
    // Trust 1: 0.85 * (1.0 + (1-3)*0.03) = 0.85 * 0.94 = 0.799
    // Trust 5: 0.80 * (1.0 + (5-3)*0.03) = 0.80 * 1.06 = 0.848
    expect(result.chunks[0].metadata.dna_trust).toBe(5);
  });

  test("chunks without DNA are unaffected (neutral multiplier)", () => {
    const chunks = [
      {
        content: "chunk without any dna metadata fields at all",
        score: 0.80,
        rerankScore: 0.80,
        metadata: { doc_title: "No DNA" },
      },
    ];

    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 1 });
    // Score should remain 0.80 (multiplier = 1.0)
    expect(result.chunks[0].score).toBeCloseTo(0.80, 2);
  });

  test("all boosts compose multiplicatively", () => {
    const chunks = [
      {
        content: "maximally boosted content with canonical authority and current freshness and high trust",
        score: 0.70,
        rerankScore: 0.70,
        metadata: {
          doc_title: "Super Doc",
          dna_authority: "canonical",  // 1.15
          dna_freshness: "current",     // 1.05
          dna_trust: 5,                 // 1.06
        },
      },
    ];

    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 1 });
    // 0.70 * 1.15 * 1.05 * 1.06 ≈ 0.896
    expect(result.chunks[0].score).toBeCloseTo(0.70 * 1.15 * 1.05 * 1.06, 2);
  });
});
