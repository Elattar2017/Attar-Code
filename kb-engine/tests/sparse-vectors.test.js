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
