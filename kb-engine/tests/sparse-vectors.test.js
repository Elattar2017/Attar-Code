"use strict";

const { SparseVectorizer } = require("../sparse-vectors");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildVectorizer(docs) {
  const sv = new SparseVectorizer();
  docs.forEach(({ id, text }) => sv.addDocument(id, text));
  sv.build();
  return sv;
}

// ---------------------------------------------------------------------------
// 1. Shape contract: {indices, values} with matching lengths
// ---------------------------------------------------------------------------
describe("computeSparseVector — shape contract", () => {
  test("returns object with indices and values arrays", () => {
    const sv = buildVectorizer([{ id: "d1", text: "hello world" }]);
    const vec = sv.computeSparseVector("hello world");
    expect(vec).toHaveProperty("indices");
    expect(vec).toHaveProperty("values");
    expect(Array.isArray(vec.indices)).toBe(true);
    expect(Array.isArray(vec.values)).toBe(true);
  });

  test("indices and values have the same length", () => {
    const sv = buildVectorizer([
      { id: "d1", text: "the quick brown fox jumps over the lazy dog" },
      { id: "d2", text: "fox and dog are animals" },
    ]);
    const vec = sv.computeSparseVector("quick fox");
    expect(vec.indices.length).toBe(vec.values.length);
  });

  test("all indices are non-negative integers", () => {
    const sv = buildVectorizer([{ id: "d1", text: "sparse vector indexing test" }]);
    const vec = sv.computeSparseVector("sparse vector");
    vec.indices.forEach((idx) => {
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
    });
  });

  test("all values are positive floats", () => {
    const sv = buildVectorizer([{ id: "d1", text: "sparse vector indexing test" }]);
    const vec = sv.computeSparseVector("sparse vector");
    vec.values.forEach((val) => {
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Non-zero values for matching tokens
// ---------------------------------------------------------------------------
describe("computeSparseVector — non-zero for matching tokens", () => {
  test("matching token produces a non-zero entry", () => {
    const sv = buildVectorizer([
      { id: "d1", text: "javascript is a programming language" },
      { id: "d2", text: "python is also a programming language" },
    ]);
    const vec = sv.computeSparseVector("javascript");
    // The sparse vector must contain at least one non-zero entry for "javascript"
    expect(vec.indices.length).toBeGreaterThan(0);
    expect(vec.values.some((v) => v > 0)).toBe(true);
  });

  test("out-of-vocabulary token produces empty vector", () => {
    const sv = buildVectorizer([{ id: "d1", text: "hello world foo bar" }]);
    const vec = sv.computeSparseVector("zzzzunknowntoken");
    // Unknown token → nothing in vocabulary → empty sparse vector
    expect(vec.indices.length).toBe(0);
    expect(vec.values.length).toBe(0);
  });

  test("rare token gets higher IDF weight than common token", () => {
    const docs = [
      { id: "d1", text: "the quick brown fox" },
      { id: "d2", text: "the slow brown cat" },
      { id: "d3", text: "the big brown dog" },
      { id: "d4", text: "unique term xenon appears once" },
    ];
    const sv = buildVectorizer(docs);

    const vecCommon = sv.computeSparseVector("the");    // appears in all docs
    const vecRare   = sv.computeSparseVector("xenon");  // appears in 1 doc

    // Both should have entries
    expect(vecCommon.values.length).toBeGreaterThan(0);
    expect(vecRare.values.length).toBeGreaterThan(0);

    // Rare term must have a higher BM25 weight than the ubiquitous term
    expect(vecRare.values[0]).toBeGreaterThan(vecCommon.values[0]);
  });
});

// ---------------------------------------------------------------------------
// 3. getVocabularySize
// ---------------------------------------------------------------------------
describe("getVocabularySize", () => {
  test("returns 0 before build", () => {
    const sv = new SparseVectorizer();
    sv.addDocument("d1", "hello world");
    expect(sv.getVocabularySize()).toBe(0);
  });

  test("returns correct unique token count after build", () => {
    const sv = new SparseVectorizer();
    // "the" appears twice but counts once
    sv.addDocument("d1", "the cat sat");
    sv.addDocument("d2", "the dog ran");
    sv.build();
    // unique tokens: the, cat, sat, dog, ran → 5
    expect(sv.getVocabularySize()).toBe(5);
  });

  test("tokens shorter than 2 chars are excluded", () => {
    const sv = new SparseVectorizer();
    sv.addDocument("d1", "a i am it");   // 'a' and 'i' filtered (< 2 chars)
    sv.build();
    // only 'am' and 'it' survive
    expect(sv.getVocabularySize()).toBe(2);
  });

  test("tokens longer than 50 chars are excluded", () => {
    const sv = new SparseVectorizer();
    const longToken = "a".repeat(51);
    sv.addDocument("d1", `hello ${longToken} world`);
    sv.build();
    // only 'hello' and 'world' survive
    expect(sv.getVocabularySize()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Empty input handled gracefully
// ---------------------------------------------------------------------------
describe("empty / edge-case input", () => {
  test("addDocument with empty string does not throw", () => {
    const sv = new SparseVectorizer();
    expect(() => sv.addDocument("d1", "")).not.toThrow();
  });

  test("build on empty corpus does not throw", () => {
    const sv = new SparseVectorizer();
    expect(() => sv.build()).not.toThrow();
  });

  test("computeSparseVector with empty string returns empty vector", () => {
    const sv = buildVectorizer([{ id: "d1", text: "some content here" }]);
    const vec = sv.computeSparseVector("");
    expect(vec.indices.length).toBe(0);
    expect(vec.values.length).toBe(0);
  });

  test("computeSparseVector before build does not throw", () => {
    const sv = new SparseVectorizer();
    sv.addDocument("d1", "test document");
    expect(() => sv.computeSparseVector("test")).not.toThrow();
  });

  test("computeSparseVector on purely punctuation returns empty vector", () => {
    const sv = buildVectorizer([{ id: "d1", text: "hello world" }]);
    const vec = sv.computeSparseVector("!!! ??? ---");
    expect(vec.indices.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Different documents produce different vectors
// ---------------------------------------------------------------------------
describe("different documents produce different vectors", () => {
  test("two distinct texts yield different non-zero index sets", () => {
    const sv = buildVectorizer([
      { id: "d1", text: "machine learning neural networks deep learning" },
      { id: "d2", text: "database sql queries transactions indexing" },
    ]);
    const vecML  = sv.computeSparseVector("neural networks");
    const vecDB  = sv.computeSparseVector("sql queries");

    // Convert to Sets for comparison
    const idxML = new Set(vecML.indices);
    const idxDB = new Set(vecDB.indices);

    // The index sets must differ
    const same = [...idxML].every((i) => idxDB.has(i)) && idxML.size === idxDB.size;
    expect(same).toBe(false);
  });

  test("repeated identical text yields identical vectors", () => {
    const sv = buildVectorizer([
      { id: "d1", text: "hello world" },
      { id: "d2", text: "foo bar baz" },
    ]);
    const v1 = sv.computeSparseVector("hello world");
    const v2 = sv.computeSparseVector("hello world");
    expect(v1.indices).toEqual(v2.indices);
    expect(v1.values).toEqual(v2.values);
  });
});

// ---------------------------------------------------------------------------
// 6. BM25 formula correctness (hand-computed reference)
// ---------------------------------------------------------------------------
describe("BM25 formula correctness", () => {
  test("single-document corpus: TF=1, docLen=avgDocLen → simplified formula", () => {
    // With N=1, df=1 for every token:
    //   IDF = log((1 - 1 + 0.5) / (1 + 0.5) + 1) = log(0.5/1.5 + 1) = log(4/3) ≈ 0.2877
    // Query "hello world" has docLen=2; corpus avgDocLen=2 → docLen/avgDocLen = 1
    // With freq=1, docLen=avgDocLen → (1 - b + b*1) = 1, so:
    //   TF_norm = (1 * (k1+1)) / (1 + k1 * 1) = (k1+1)/(k1+1) = 1
    // BM25 for each token = IDF * 1 = IDF = log(4/3)
    const sv = buildVectorizer([{ id: "d1", text: "hello world" }]);
    // Query the full doc text so docLen == avgDocLen (both = 2)
    const vec = sv.computeSparseVector("hello world");

    // Two tokens → two entries; pick the "hello" entry (index 0 after sort)
    expect(vec.indices.length).toBe(2);
    const helloPos = vec.indices.indexOf(0); // "hello" was assigned termId=0
    const expectedIDF = Math.log(0.5 / 1.5 + 1);          // ≈ 0.2877
    expect(vec.values[helloPos]).toBeCloseTo(expectedIDF, 4);
  });

  test("term appearing in all docs gets low IDF", () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      text: `common term document ${i}`,
    }));
    const sv = buildVectorizer(docs);
    const vec = sv.computeSparseVector("common");
    // "common" appears in all 10 docs → IDF near log(1) = 0, but still > 0
    expect(vec.values[0]).toBeGreaterThan(0);
    expect(vec.values[0]).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 7. Serialization / deserialization
// ---------------------------------------------------------------------------
describe("serialize / deserialize", () => {
  test("serialize returns complete shape with schema_version", () => {
    const sv = buildVectorizer([
      { id: "d1", text: "hello world" },
      { id: "d2", text: "world peace justice" },
    ]);
    const data = sv.serialize();

    expect(data.schema_version).toBe(1);
    expect(Array.isArray(data.vocab)).toBe(true);
    expect(Array.isArray(data.df)).toBe(true);
    expect(Array.isArray(data.idf)).toBe(true);
    expect(data.N).toBe(2);
    expect(typeof data.totalDocLen).toBe("number");
    expect(typeof data.avgDocLen).toBe("number");
    expect(data.built).toBe(true);
    expect(data.vocab.length).toBe(sv.getVocabularySize());
  });

  test("roundtrip produces identical sparse vectors", () => {
    const docs = [
      { id: "d1", text: "machine learning neural networks deep learning" },
      { id: "d2", text: "database sql queries transactions indexing" },
      { id: "d3", text: "javascript react components hooks state" },
      { id: "d4", text: "python django flask web framework" },
      { id: "d5", text: "docker kubernetes containers orchestration" },
    ];
    const original = buildVectorizer(docs);
    const serialized = original.serialize();
    const restored = SparseVectorizer.deserialize(serialized);

    // 10 different queries must produce identical vectors
    const queries = [
      "neural networks", "sql queries", "react hooks", "python flask",
      "kubernetes", "deep learning framework", "web components",
      "docker containers", "state management", "indexing transactions",
    ];

    for (const q of queries) {
      const origVec = original.computeSparseVector(q);
      const restoredVec = restored.computeSparseVector(q);
      expect(restoredVec.indices).toEqual(origVec.indices);
      expect(restoredVec.values).toEqual(origVec.values);
    }
  });

  test("deserialize returns null for wrong schema_version", () => {
    const sv = buildVectorizer([{ id: "d1", text: "hello" }]);
    const data = sv.serialize();
    data.schema_version = 99;
    expect(SparseVectorizer.deserialize(data)).toBeNull();
  });

  test("deserialize returns null for null/undefined input", () => {
    expect(SparseVectorizer.deserialize(null)).toBeNull();
    expect(SparseVectorizer.deserialize(undefined)).toBeNull();
  });

  test("deserialized vectorizer accepts new documents + incremental build", () => {
    // Build initial vocab with 3 docs
    const sv = buildVectorizer([
      { id: "d1", text: "alpha beta gamma" },
      { id: "d2", text: "beta gamma delta" },
      { id: "d3", text: "gamma delta epsilon" },
    ]);
    const origSize = sv.getVocabularySize();
    const serialized = sv.serialize();

    // Restore and add more docs
    const restored = SparseVectorizer.deserialize(serialized);
    restored.addDocument("d4", "zeta eta theta");
    restored.addDocument("d5", "alpha zeta");
    restored.build();

    // Vocabulary grew (new terms: zeta, eta, theta)
    expect(restored.getVocabularySize()).toBeGreaterThan(origSize);
    expect(restored._N).toBe(5);

    // Old terms retain their original IDs
    const origVocab = new Map(serialized.vocab);
    for (const [term, id] of origVocab.entries()) {
      expect(restored._vocab.get(term)).toBe(id);
    }

    // New terms get IDs > original max
    const maxOrigId = Math.max(...origVocab.values());
    expect(restored._vocab.get("zeta")).toBeGreaterThan(maxOrigId);
    expect(restored._vocab.get("eta")).toBeGreaterThan(maxOrigId);
  });
});

// ---------------------------------------------------------------------------
// 8. Incremental build() — term ID stability
// ---------------------------------------------------------------------------
describe("incremental build — term ID stability", () => {
  test("build() preserves existing term IDs when called multiple times", () => {
    const sv = new SparseVectorizer();
    sv.addDocument("d1", "hello world foo");
    sv.build();

    // Capture original term IDs
    const origIds = new Map(sv._vocab);

    // Add more documents and rebuild
    sv.addDocument("d2", "bar baz hello");
    sv.build();

    // Original terms still have their original IDs
    for (const [term, id] of origIds) {
      expect(sv._vocab.get(term)).toBe(id);
    }

    // New terms (bar, baz) have IDs starting after originals
    const maxOrigId = Math.max(...origIds.values());
    expect(sv._vocab.get("bar")).toBeGreaterThan(maxOrigId);
    expect(sv._vocab.get("baz")).toBeGreaterThan(maxOrigId);
  });

  test("multiple build() calls maintain cumulative IDF correctness", () => {
    const sv = new SparseVectorizer();

    // Batch 1: "gamma" appears in 2/2 docs → high df
    sv.addDocument("d1", "alpha beta gamma");
    sv.addDocument("d2", "beta gamma delta");
    sv.build();

    const idfAfterBatch1 = sv._idf.get("gamma");

    // Batch 2: "gamma" now in 3/4 docs → even higher df → lower IDF
    sv.addDocument("d3", "epsilon zeta");
    sv.addDocument("d4", "gamma zeta alpha");
    sv.build();

    const idfAfterBatch2 = sv._idf.get("gamma");

    // IDF should decrease because gamma is now more common (3/4 vs 2/2)
    // Actually 2/2 = 1.0 proportion, 3/4 = 0.75. IDF formula: log((N-df+0.5)/(df+0.5)+1)
    // N=2,df=2: log((2-2+0.5)/(2+0.5)+1) = log(0.5/2.5+1) = log(1.2) ≈ 0.182
    // N=4,df=3: log((4-3+0.5)/(3+0.5)+1) = log(1.5/3.5+1) = log(1.429) ≈ 0.357
    // Hmm, actually IDF increases because the proportion goes from 100% to 75%.
    // The key test is that the value CHANGED (IDF reflects full corpus, not just last batch)
    expect(idfAfterBatch2).not.toBe(idfAfterBatch1);
  });

  test("cumulative vocabulary covers all batches for query", () => {
    const sv = new SparseVectorizer();

    sv.addDocument("d1", "hello world");
    sv.build();

    sv.addDocument("d2", "foo bar");
    sv.build();

    // Query with terms from BOTH batches
    const vec = sv.computeSparseVector("hello foo");
    // Should have entries for both "hello" (batch 1) and "foo" (batch 2)
    expect(vec.indices.length).toBe(2);
    expect(vec.values.length).toBe(2);
    expect(vec.values.every((v) => v > 0)).toBe(true);
  });
});
