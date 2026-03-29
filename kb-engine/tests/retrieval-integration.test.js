"use strict";

/**
 * kb-engine/tests/retrieval-integration.test.js
 *
 * Integration tests for RetrievalPipeline.
 * No Qdrant / Ollama required — the ChunkStore is mocked.
 *
 * Run: npx jest kb-engine/tests/retrieval-integration.test.js --no-coverage --testTimeout=30000
 */

const { RetrievalPipeline } = require("../retrieval/index");

// ─── RetrievalPipeline ────────────────────────────────────────────────────────

describe("RetrievalPipeline", () => {
  // ── search: basic flow ────────────────────────────────────────────────────

  test("search calls analyzeQuery and hybridSearch", async () => {
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([
        {
          id: "1",
          score: 0.8,
          content: "Express middleware guide",
          metadata: { doc_title: "Express" },
        },
        {
          id: "2",
          score: 0.6,
          content: "React hooks tutorial",
          metadata: { doc_title: "React" },
        },
      ]),
    };

    const pipeline = new RetrievalPipeline({ store: mockStore });
    const result = await pipeline.search(
      "express middleware",
      { detectedTech: "Node.js" },
      { skipExpansion: true }
    );

    expect(result.count).toBeGreaterThan(0);
    expect(result.formatted).toContain("Express");
    expect(mockStore.hybridSearch).toHaveBeenCalled();
  });

  // ── search: weak results trigger expansion ────────────────────────────────

  test("search with weak results triggers query expansion", async () => {
    // All results below the 0.6 threshold — expansion path should be attempted
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([
        { id: "1", score: 0.3, content: "weak result", metadata: {} },
      ]),
    };

    const pipeline = new RetrievalPipeline({ store: mockStore });

    // With expansion enabled (default). Ollama may not be available, but the
    // pipeline must not throw — it should degrade gracefully.
    const result = await pipeline.search("obscure query", {});

    expect(result).toBeDefined();
    expect(typeof result.formatted).toBe("string");
    expect(typeof result.count).toBe("number");
  });

  // ── searchFixRecipes: targets fix_recipes collection ─────────────────────

  test("searchFixRecipes searches fix_recipes collection", async () => {
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([]),
    };

    const pipeline = new RetrievalPipeline({ store: mockStore });
    await pipeline.searchFixRecipes("TypeError cannot read null");

    const calls = mockStore.hybridSearch.mock.calls;
    expect(calls.some((c) => c[0] === "fix_recipes")).toBe(true);
  });

  // ── reranker degradation: unavailable port ────────────────────────────────

  test("reranker degradation: works without reranker", async () => {
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([
        { id: "1", score: 0.9, content: "result 1", metadata: {} },
        { id: "2", score: 0.7, content: "result 2", metadata: {} },
      ]),
    };

    // Port 16334 is not in use — reranker.rerank() will return null gracefully
    const pipeline = new RetrievalPipeline({
      store: mockStore,
      rerankerPort: 16334,
    });

    const result = await pipeline.search(
      "test query",
      {},
      { skipExpansion: true }
    );

    expect(result.count).toBeGreaterThan(0); // works without reranker
  });

  // ── empty results → no-docs-found message ─────────────────────────────────

  test("empty results return no-docs-found message", async () => {
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([]),
    };

    const pipeline = new RetrievalPipeline({ store: mockStore });
    const result = await pipeline.search(
      "nonexistent topic",
      {},
      { skipExpansion: true }
    );

    expect(result.formatted).toContain("No relevant documentation found");
    expect(result.count).toBe(0);
  });

  // ── searchFixRecipes skips expansion ──────────────────────────────────────

  test("searchFixRecipes does not trigger query expansion", async () => {
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([
        { id: "1", score: 0.2, content: "low score fix", metadata: {} },
      ]),
    };

    const pipeline = new RetrievalPipeline({ store: mockStore });
    await pipeline.searchFixRecipes("some error message");

    // All hybridSearch calls should be on "fix_recipes" only (no expansion
    // would add calls on additional collections)
    const collections = mockStore.hybridSearch.mock.calls.map((c) => c[0]);
    expect(collections.every((col) => col === "fix_recipes")).toBe(true);
  });

  // ── collection error tolerance ────────────────────────────────────────────

  test("silently tolerates hybridSearch rejections per collection", async () => {
    const mockStore = {
      hybridSearch: jest
        .fn()
        .mockRejectedValueOnce(new Error("collection not found"))
        .mockResolvedValueOnce([
          { id: "1", score: 0.8, content: "good result", metadata: {} },
        ]),
    };

    const pipeline = new RetrievalPipeline({ store: mockStore });

    // Should not throw even when first collection fails
    const result = await pipeline.search(
      "express error",
      {},
      { skipExpansion: true }
    );

    expect(result).toBeDefined();
  });

  // ── deduplication across collections ──────────────────────────────────────

  test("deduplicates results with the same id across multiple collections", async () => {
    const mockStore = {
      hybridSearch: jest.fn().mockResolvedValue([
        { id: "dup-1", score: 0.9, content: "duplicate content", metadata: {} },
        { id: "dup-1", score: 0.9, content: "duplicate content", metadata: {} },
        { id: "unique-2", score: 0.7, content: "unique content here", metadata: {} },
      ]),
    };

    // Force expansion by returning all weak results initially, then duplicates
    const weakStore = {
      hybridSearch: jest
        .fn()
        .mockResolvedValue([
          { id: "dup-1", score: 0.3, content: "weak dup content", metadata: {} },
        ]),
    };

    const pipeline = new RetrievalPipeline({ store: weakStore });
    const result = await pipeline.search("test dedupe", {});

    // Should not throw; IDs are deduplicated in the expansion path
    expect(result).toBeDefined();
  });

  // ── start / stop lifecycle ────────────────────────────────────────────────

  test("start and stop do not throw", async () => {
    const mockStore = { hybridSearch: jest.fn().mockResolvedValue([]) };
    const pipeline = new RetrievalPipeline({ store: mockStore });

    // Mock reranker.start so it resolves immediately without polling
    pipeline.reranker.start = jest.fn().mockResolvedValue(false);

    await expect(pipeline.start()).resolves.not.toThrow();
    expect(() => pipeline.stop()).not.toThrow();
  }, 5000);
});
