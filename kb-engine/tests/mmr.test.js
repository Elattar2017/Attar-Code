"use strict";

const { mmrSelect, cosineSim, computeOverlap } = require("../retrieval/context-assembler");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a chunk with score, optional rerankScore, optional _vector */
function makeChunk(id, score, vector = null, rerankScore = undefined, content = "") {
  return {
    id,
    score,
    rerankScore,
    content: content || `content for chunk ${id}`,
    metadata: { doc_title: "Test", section: id },
    _vector: vector,
  };
}

/** Normalize a vector to unit length */
function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

// ---------------------------------------------------------------------------
// 1. cosineSim
// ---------------------------------------------------------------------------
describe("cosineSim", () => {
  test("identical → 1.0", () => {
    expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 6);
  });

  test("orthogonal → 0.0", () => {
    expect(cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 6);
  });

  test("opposite → -1.0", () => {
    expect(cosineSim([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 6);
  });

  test("45 degrees → ~0.707", () => {
    expect(cosineSim([1, 1, 0], [1, 0, 0])).toBeCloseTo(0.7071, 3);
  });

  test("null/empty → 0", () => {
    expect(cosineSim(null, [1, 0])).toBe(0);
    expect(cosineSim([], [1, 0])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. mmrSelect — lambda extremes
// ---------------------------------------------------------------------------
describe("mmrSelect — lambda extremes", () => {
  test("lambda=1.0 → pure relevance (same as descending sort)", () => {
    const chunks = [
      makeChunk("a", 0.5, normalize([1, 0, 0, 0]), 0.5),
      makeChunk("b", 0.9, normalize([0, 1, 0, 0]), 0.9),
      makeChunk("c", 0.7, normalize([0, 0, 1, 0]), 0.7),
      makeChunk("d", 0.6, normalize([0, 0, 0, 1]), 0.6),
      makeChunk("e", 0.8, normalize([1, 1, 0, 0]), 0.8),
    ];

    const selected = mmrSelect(chunks, 3, 1.0);
    expect(selected.map((c) => c.id)).toEqual(["b", "e", "c"]);
  });

  test("lambda=0.0 → pure diversity (maximally different)", () => {
    // A and B are near-identical vectors; C is orthogonal
    const vecA = normalize([1, 0.01, 0]);
    const vecB = normalize([1, 0.02, 0]); // cosine(A,B) ≈ 1.0
    const vecC = normalize([0, 0, 1]);     // cosine(A,C) ≈ 0.0

    const chunks = [
      makeChunk("a", 0.9, vecA, 0.9),
      makeChunk("b", 0.85, vecB, 0.85),
      makeChunk("c", 0.7, vecC, 0.7),
    ];

    const selected = mmrSelect(chunks, 2, 0.0);
    // First pick: A (highest relevance, even at lambda=0 the initial pick is top relevance)
    // Second pick: C (most different from A, NOT B which is nearly identical)
    expect(selected[0].id).toBe("a");
    expect(selected[1].id).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// 3. mmrSelect — balanced lambda
// ---------------------------------------------------------------------------
describe("mmrSelect — balanced lambda=0.7", () => {
  test("diverse chunk selected over similar-but-higher-scored chunk", () => {
    // A and B are very similar vectors (cosine ≈ 0.99)
    const vecA = normalize([1, 0, 0, 0]);
    const vecB = normalize([0.99, 0.1, 0, 0]);
    const vecC = normalize([0, 0, 1, 0]); // completely different

    const chunks = [
      makeChunk("a", 0.9, vecA, 0.9),  // highest score
      makeChunk("b", 0.85, vecB, 0.85), // high score but similar to A
      makeChunk("c", 0.7, vecC, 0.7),   // lower score but unique
    ];

    const selected = mmrSelect(chunks, 2, 0.7);
    expect(selected[0].id).toBe("a"); // highest relevance
    // Second should be C (diversity wins): MMR(B) = 0.7*0.85 - 0.3*0.99 ≈ 0.298
    //                                      MMR(C) = 0.7*0.7  - 0.3*0.0  ≈ 0.490
    expect(selected[1].id).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// 4. mmrSelect — uses rerankScore over raw score
// ---------------------------------------------------------------------------
describe("mmrSelect — score selection", () => {
  test("uses rerankScore when available", () => {
    const chunks = [
      makeChunk("a", 0.9, normalize([1, 0]), 0.3),  // high raw, low rerank
      makeChunk("b", 0.5, normalize([0, 1]), 0.95),  // low raw, high rerank
    ];

    const selected = mmrSelect(chunks, 1, 1.0); // pure relevance
    // Should pick B because rerankScore 0.95 > 0.3
    expect(selected[0].id).toBe("b");
  });

  test("falls back to score when rerankScore is undefined", () => {
    const chunks = [
      makeChunk("a", 0.9, normalize([1, 0])),  // no rerankScore
      makeChunk("b", 0.7, normalize([0, 1])),
    ];

    const selected = mmrSelect(chunks, 1, 1.0);
    expect(selected[0].id).toBe("a"); // highest raw score
  });
});

// ---------------------------------------------------------------------------
// 5. mmrSelect — Jaccard fallback
// ---------------------------------------------------------------------------
describe("mmrSelect — Jaccard fallback when _vector missing", () => {
  test("falls back to Jaccard overlap without crash", () => {
    const chunks = [
      makeChunk("a", 0.9, null, 0.9, "the quick brown fox jumps over the lazy dog"),
      makeChunk("b", 0.85, null, 0.85, "the quick brown fox jumps over the lazy cat"),  // similar text
      makeChunk("c", 0.7, null, 0.7, "machine learning neural networks deep learning"),  // different text
    ];

    const selected = mmrSelect(chunks, 2, 0.7);
    expect(selected).toHaveLength(2);
    expect(selected[0].id).toBe("a"); // highest score
    // B has high Jaccard overlap with A; C is diverse
    // With lambda=0.7, C should be preferred over B
    expect(selected[1].id).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// 6. mmrSelect — edge cases
// ---------------------------------------------------------------------------
describe("mmrSelect — edge cases", () => {
  test("empty input → empty array", () => {
    expect(mmrSelect([], 5, 0.7)).toEqual([]);
  });

  test("null input → empty array", () => {
    expect(mmrSelect(null, 5, 0.7)).toEqual([]);
  });

  test("single chunk → returns that chunk", () => {
    const chunks = [makeChunk("a", 0.9, normalize([1, 0]))];
    const selected = mmrSelect(chunks, 3, 0.7);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("a");
  });

  test("maxChunks > candidates → returns all candidates", () => {
    const chunks = [
      makeChunk("a", 0.9, normalize([1, 0])),
      makeChunk("b", 0.7, normalize([0, 1])),
    ];
    const selected = mmrSelect(chunks, 10, 0.7);
    expect(selected).toHaveLength(2);
  });

  test("all identical vectors → still selects maxChunks items", () => {
    const vec = normalize([1, 0, 0]);
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(`c${i}`, 0.9 - i * 0.1, vec, 0.9 - i * 0.1)
    );
    const selected = mmrSelect(chunks, 3, 0.7);
    expect(selected).toHaveLength(3);
  });
});
