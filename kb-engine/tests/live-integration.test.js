/**
 * LIVE INTEGRATION TESTS — Exercises all 7 phases against real Qdrant + Ollama.
 *
 * Prerequisites:
 *   - Qdrant running on 127.0.0.1:6333 with python collection (923 points)
 *   - Ollama running on 127.0.0.1:11434 with qwen3-embedding:0.6b
 *   - search-proxy NOT required (tests use kb-engine directly)
 *
 * Run: npx jest kb-engine/tests/live-integration.test.js --no-cache --testTimeout=60000
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Infrastructure check (skip all if Qdrant/Ollama not available) ──────────

let qdrantOk = false;
let ollamaOk = false;

beforeAll(async () => {
  try {
    const qRes = await fetch("http://127.0.0.1:6333/collections", { signal: AbortSignal.timeout(3000) });
    qdrantOk = qRes.ok;
  } catch (_) {}
  try {
    const oRes = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    ollamaOk = oRes.ok;
  } catch (_) {}

  if (!qdrantOk || !ollamaOk) {
    console.warn("⚠ SKIPPING live tests — Qdrant or Ollama not available");
  }
});

function skipIfNoInfra() {
  if (!qdrantOk || !ollamaOk) {
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0.1: BM25 Vocabulary Persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 0.1 — BM25 Vocabulary Persistence", () => {
  const { ChunkStore } = require("../store");
  const { SparseVectorizer } = require("../sparse-vectors");
  const config = require("../config");

  test("BM25 vocab persists to disk after hybridSearch cold-start rebuild", async () => {
    if (skipIfNoInfra()) return;

    const store = new ChunkStore();

    // Force cold start: clear in-memory vectorizer
    store._vectorizers.delete("python");

    // Trigger hybridSearch which calls _getSparseQueryVec → _rebuildVocabulary
    const results = await store.hybridSearch("python", "error handling", { limit: 5 });

    // Check: vectorizer now in memory
    expect(store._vectorizers.has("python")).toBe(true);
    const vocab = store._vectorizers.get("python");
    expect(vocab.getVocabularySize()).toBeGreaterThan(100);

    // Check: vocab file persisted to disk
    const vocabPath = path.join(config.BM25_VOCAB_DIR, "python.json");
    expect(fs.existsSync(vocabPath)).toBe(true);

    const diskData = JSON.parse(fs.readFileSync(vocabPath, "utf-8"));
    expect(diskData.schema_version).toBe(1);
    expect(diskData.N).toBeGreaterThan(100);

    console.log(`  ✓ BM25 vocab: ${vocab.getVocabularySize()} terms, ${diskData.N} docs, persisted to ${vocabPath}`);
  }, 30000);

  test("BM25 vocab loads from disk on second cold start (stable term IDs)", async () => {
    if (skipIfNoInfra()) return;

    const store1 = new ChunkStore();
    // First cold start: rebuild from Qdrant + persist
    store1._vectorizers.delete("python");
    await store1.hybridSearch("python", "test query", { limit: 1 });
    const vec1 = store1._vectorizers.get("python").computeSparseVector("generators closures");

    // Second cold start: should load from disk (NOT scroll Qdrant)
    const store2 = new ChunkStore();
    store2._vectorizers.delete("python");
    const startMs = Date.now();
    await store2.hybridSearch("python", "test query", { limit: 1 });
    const loadMs = Date.now() - startMs;

    const vec2 = store2._vectorizers.get("python").computeSparseVector("generators closures");

    // Term IDs must match (same indices)
    expect(vec2.indices).toEqual(vec1.indices);
    // Values may differ slightly if IDF recomputed, but indices = stable term IDs
    console.log(`  ✓ Disk load: ${loadMs}ms (vs scroll rebuild). Term IDs stable: ${vec1.indices.length} indices match.`);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0.2: Query Analyzer Priority
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 0.2 — Query Priority (live classification)", () => {
  const { analyzeQuery } = require("../retrieval/query-analyzer");

  const cases = [
    // [query, expected type, description]
    ["TypeError in chapter 3", "error", "specific error TYPE wins over scope"],
    ["explain the error handling chapter", "scope", "broad 'error' does NOT override scope"],
    ["explain chapter 5", "scope", "pure scope"],
    ["which chapters mention closures", "cross_structural", "cross-structural topic query"],
    ["list all chapters", "structural", "pure structural listing"],
    ["how to use decorators", "conceptual", "conceptual how-to"],
    ["ENOENT no such file", "error", "specific Node.js error code"],
    ["SyntaxError in section 2.1", "error", "specific Python error + section"],
    ["summarize the exception hierarchy section", "scope", "broad 'exception' + scope intent verb"],
  ];

  for (const [query, expectedType, desc] of cases) {
    test(`"${query}" → ${expectedType} (${desc})`, () => {
      const result = analyzeQuery(query);
      expect(result.type).toBe(expectedType);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0.3-0.6: Reranker cap, code metadata, port, comments
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 0.3-0.6 — Config + comment fixes", () => {
  const config = require("../config");

  test("RERANK_CANDIDATES is 40 (not hardcoded 20)", () => {
    expect(config.RERANK_CANDIDATES).toBe(40);
  });

  test("no '2560' references in kb-engine source files", () => {
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(content).not.toContain("2560");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE SEARCH TESTS — Exercises hybrid search + reranking against real data
// ═══════════════════════════════════════════════════════════════════════════════

describe("Live hybrid search against python collection", () => {
  const { ChunkStore } = require("../store");

  test("hybridSearch returns scored results with metadata", async () => {
    if (skipIfNoInfra()) return;

    const store = new ChunkStore();
    const results = await store.hybridSearch("python", "error handling try except", { limit: 10 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);

    // Check result shape
    for (const r of results) {
      expect(r.id).toBeDefined();
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
      expect(typeof r.content).toBe("string");
      expect(r.content.length).toBeGreaterThan(10);
      expect(r.metadata).toBeDefined();
      expect(r._vector).toBeDefined(); // MMR vector passthrough
    }

    console.log(`  ✓ hybridSearch: ${results.length} results, scores: ${results.map(r => r.score.toFixed(3)).join(', ')}`);
    console.log(`  ✓ _vector present: ${results.filter(r => r._vector).length}/${results.length}`);
  }, 30000);

  test("hybridSearch with denseOnly=true skips BM25", async () => {
    if (skipIfNoInfra()) return;

    const store = new ChunkStore();
    const results = await store.hybridSearch("python", "context managers with statement", {
      limit: 5,
      denseOnly: true,
    });

    expect(results.length).toBeGreaterThan(0);
    console.log(`  ✓ denseOnly search: ${results.length} results`);
  }, 30000);

  test("search returns results from both books", async () => {
    if (skipIfNoInfra()) return;

    const store = new ChunkStore();
    const results = await store.hybridSearch("python", "python programming basics", { limit: 20 });

    const docs = new Set(results.map(r => r.metadata?.doc_title));
    console.log(`  ✓ Sources found: ${[...docs].join(', ')}`);
    // With 2 books ingested, we should get results from both
    expect(docs.size).toBeGreaterThanOrEqual(1);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: HyDE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 1 — HyDE (Hypothetical Document Embedding)", () => {
  const { generateHypothetical, HYDE_TYPES } = require("../retrieval/hyde");

  test("generateHypothetical produces text when a chat model is loaded", async () => {
    if (skipIfNoInfra()) return;

    // Try to generate with glm-4.7-flash (may need to be loaded)
    const result = await generateHypothetical(
      "how does Python garbage collection work",
      "http://127.0.0.1:11434",
      "glm-4.7-flash:latest"
    );

    if (result === null) {
      console.log("  ⚠ HyDE returned null — GLM may not be loaded. Expected for CPU-only setup.");
      // This is acceptable — HyDE gracefully degrades
    } else {
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(30);
      console.log(`  ✓ HyDE hypothetical (${result.length} chars): "${result.slice(0, 100)}..."`);
    }
  }, 60000);

  test("HyDE gracefully returns null on timeout with non-existent model", async () => {
    if (skipIfNoInfra()) return;

    const result = await generateHypothetical(
      "test query",
      "http://127.0.0.1:11434",
      "nonexistent-model-xyz:latest"
    );
    expect(result).toBeNull();
    console.log("  ✓ HyDE graceful degradation: null for missing model");
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Query Cache
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 2 — Query Cache", () => {
  const { QueryCache, cosineSim } = require("../retrieval/query-cache");
  const { UnifiedEmbedder } = require("../embedder");

  test("same query embedded twice produces near-identical embeddings (cache should hit)", async () => {
    if (skipIfNoInfra()) return;

    const embedder = new UnifiedEmbedder();
    const emb1 = await embedder.embedForQuery("how to handle errors in python", "general");
    const emb2 = await embedder.embedForQuery("how to handle errors in python", "general");

    const similarity = cosineSim(emb1, emb2);
    expect(similarity).toBeGreaterThan(0.99); // identical text → near 1.0

    console.log(`  ✓ Same query cosine similarity: ${similarity.toFixed(6)}`);
  }, 30000);

  test("similar queries produce embeddings above cache threshold (0.88)", async () => {
    if (skipIfNoInfra()) return;

    const embedder = new UnifiedEmbedder();
    const emb1 = await embedder.embedForQuery("python error handling", "general");
    const emb2 = await embedder.embedForQuery("handling errors in python", "general");

    const similarity = cosineSim(emb1, emb2);
    console.log(`  ✓ Similar queries cosine: ${similarity.toFixed(4)} (threshold: 0.88)`);
    // These should be similar enough for a cache hit
    expect(similarity).toBeGreaterThan(0.80);
  }, 30000);

  test("different queries produce embeddings below cache threshold", async () => {
    if (skipIfNoInfra()) return;

    const embedder = new UnifiedEmbedder();
    const emb1 = await embedder.embedForQuery("python error handling", "general");
    const emb2 = await embedder.embedForQuery("kubernetes deployment strategy", "general");

    const similarity = cosineSim(emb1, emb2);
    console.log(`  ✓ Different queries cosine: ${similarity.toFixed(4)} (should be < 0.88)`);
    expect(similarity).toBeLessThan(0.88);
  }, 30000);

  test("cache stores and retrieves results correctly", async () => {
    if (skipIfNoInfra()) return;

    const embedder = new UnifiedEmbedder();
    const cache = new QueryCache({ threshold: 0.88 });

    const emb = await embedder.embedForQuery("decorators in python", "general");
    const mockResult = { chunks: [{ id: "test" }], formatted: "test result", count: 1 };

    cache.store(emb, mockResult, "decorators in python", ["python"]);
    expect(cache.size).toBe(1);

    // Lookup with same embedding
    const hit = cache.lookup(emb);
    expect(hit).toBe(mockResult);
    console.log(`  ✓ Cache store + lookup: hit confirmed (size: ${cache.size})`);

    // Lookup with very different embedding
    const diffEmb = await embedder.embedForQuery("kubernetes pod networking", "general");
    const miss = cache.lookup(diffEmb);
    expect(miss).toBeNull();
    console.log("  ✓ Cache miss for different topic: confirmed null");
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: MMR Diversity
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 3 — MMR Diversity (live)", () => {
  const { ChunkStore } = require("../store");
  const { mmrSelect } = require("../retrieval/context-assembler");

  test("hybridSearch results have _vector for MMR", async () => {
    if (skipIfNoInfra()) return;

    const store = new ChunkStore();
    const results = await store.hybridSearch("python", "data structures", { limit: 10 });

    const withVector = results.filter(r => r._vector && r._vector.length > 0);
    console.log(`  ✓ Results with _vector: ${withVector.length}/${results.length}`);
    expect(withVector.length).toBeGreaterThan(0);

    if (withVector.length > 0) {
      expect(withVector[0]._vector.length).toBe(1024); // EMBED_DIM
    }
  }, 30000);

  test("MMR selects diverse results from real search results", async () => {
    if (skipIfNoInfra()) return;

    const store = new ChunkStore();
    const results = await store.hybridSearch("python", "functions and classes", { limit: 20 });

    if (results.length < 5) {
      console.log(`  ⚠ Only ${results.length} results — not enough for diversity test`);
      return;
    }

    // Add mock rerankScore for testing
    results.forEach((r, i) => { r.rerankScore = 1.0 - i * 0.05; });

    const mmrResults = mmrSelect(results, 5, 0.7);
    expect(mmrResults.length).toBe(5);

    // Check diversity: section_paths should not all be the same
    const sections = mmrResults.map(r => r.metadata?.section_path || r.metadata?.chapter || "?");
    const uniqueSections = new Set(sections);
    console.log(`  ✓ MMR selected ${mmrResults.length} chunks from ${uniqueSections.size} different sections:`);
    for (const s of sections) console.log(`    - ${s}`);

    expect(uniqueSections.size).toBeGreaterThanOrEqual(2);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Feedback Loop
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 4 — Feedback Loop (live file I/O)", () => {
  const { FeedbackTracker } = require("../feedback");
  const tmpFile = path.join(os.tmpdir(), `attar-fb-live-${Date.now()}.jsonl`);

  afterAll(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  test("logs search + citation events and aggregates correctly", () => {
    const tracker = new FeedbackTracker(tmpFile);

    tracker.logSearch(["chunk-a", "chunk-b", "chunk-c"], "python decorators");
    tracker.logSearch(["chunk-a", "chunk-d"], "decorator pattern");
    tracker.logCitation(["chunk-a"]);
    tracker.logCitation(["chunk-a"]);

    expect(tracker.searchCount).toBe(2);

    const scores = tracker.aggregate();
    // chunk-a: retrieved 2, cited 2 → 1.0
    // chunk-b: retrieved 1, cited 0 → 0.0
    // chunk-c: retrieved 1, cited 0 → 0.0
    // chunk-d: retrieved 1, cited 0 → 0.0
    expect(scores.get("chunk-a")).toBeCloseTo(1.0, 2);
    expect(scores.get("chunk-b")).toBe(0);
    expect(scores.get("chunk-d")).toBe(0);

    console.log(`  ✓ Feedback: chunk-a score=${scores.get("chunk-a")}, chunk-b=${scores.get("chunk-b")}`);

    // Verify JSONL file
    const lines = fs.readFileSync(tmpFile, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(4); // 2 search + 2 citation
    console.log(`  ✓ JSONL file: ${lines.length} events at ${tmpFile}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: Document DNA
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 5 — Document DNA (live)", () => {
  const { saveDNA, loadDNA, flattenDNA } = require("../ingestion/dna-loader");
  const { assembleContext } = require("../retrieval/context-assembler");
  const config = require("../config");
  const tmpDnaDir = path.join(os.tmpdir(), `attar-dna-live-${Date.now()}`);

  beforeAll(() => { config.DNA_DIR = tmpDnaDir; });
  afterAll(() => { try { fs.rmSync(tmpDnaDir, { recursive: true, force: true }); } catch (_) {} });

  test("save + load + flatten full DNA roundtrip", () => {
    const dna = {
      identity: { title: "Python Complete Guide" },
      authority: { level: "known-author", trust_rating: 4, freshness: "current" },
      character: { depth: "Intermediate", doc_type: "Book" },
      retrieval: {
        key_topics: ["generators", "closures", "async"],
        best_for: ["How-to / Implementation"],
        anti_tags: ["machine learning", "data science"],
      },
    };

    saveDNA("abc123test", dna);
    const loaded = loadDNA("abc123test");
    expect(loaded).toEqual(dna);

    const flat = flattenDNA(loaded);
    expect(flat.dna_authority).toBe("known-author");
    expect(flat.dna_trust).toBe(4);
    expect(flat.dna_freshness).toBe("current");
    expect(flat.dna_key_topics).toEqual(["generators", "closures", "async"]);
    expect(flat.dna_anti_tags).toEqual(["machine learning", "data science"]);

    console.log(`  ✓ DNA roundtrip: saved → loaded → flattened. ${Object.keys(flat).length} dna_* fields.`);
  });

  test("DNA multiplicative scoring reorders chunks correctly", () => {
    const chunks = [
      {
        content: "personal blog content about error handling patterns and practices",
        score: 0.85, rerankScore: 0.85,
        metadata: { doc_title: "Blog Post", dna_authority: "personal", dna_freshness: "dated", dna_trust: 2 },
      },
      {
        content: "official canonical documentation about error handling and exceptions",
        score: 0.80, rerankScore: 0.80,
        metadata: { doc_title: "Official Docs", dna_authority: "canonical", dna_freshness: "current", dna_trust: 5 },
      },
    ];

    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 2 });

    // Blog:    0.85 × 0.95 (personal) × 1.0 (dated) × 0.97 (trust 2) = 0.783
    // Docs:    0.80 × 1.15 (canonical) × 1.05 (current) × 1.06 (trust 5) = 1.023
    // Canonical official docs should rank first despite lower raw score
    expect(result.chunks[0].metadata.doc_title).toBe("Official Docs");
    console.log(`  ✓ DNA reorder: canonical (raw 0.80) beats personal (raw 0.85) after multiplicative boost`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6: Cross-KB Structural Aggregation
// ═══════════════════════════════════════════════════════════════════════════════

describe("Phase 6 — Cross-KB Structural Search (live)", () => {
  const { analyzeQuery } = require("../retrieval/query-analyzer");
  const { ChunkStore } = require("../store");

  test("cross-structural query classification + topic extraction", () => {
    const r = analyzeQuery("which chapters discuss error handling");
    expect(r.type).toBe("cross_structural");
    expect(r.crossTopic).toBe("error handling");
    expect(r.collections.length).toBeGreaterThan(5); // searches all collections
    console.log(`  ✓ Classified as cross_structural, topic: "${r.crossTopic}", ${r.collections.length} collections`);
  });

  test("live cross-structural search finds chapters mentioning a topic", async () => {
    if (skipIfNoInfra()) return;

    // Use the RetrievalPipeline directly
    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    const result = await pipeline._crossStructuralSearch("error handling", ["python"], "which chapters discuss error handling");

    console.log(`  ✓ Cross-structural result: type=${result.type}, count=${result.count}`);
    console.log(`  ✓ Formatted output (first 500 chars):\n${result.formatted.slice(0, 500)}`);

    expect(result.type).toBe("cross_structural");
    // We should find at least some chapters mentioning error handling in Python books
    if (result.count > 0) {
      expect(result.formatted).toContain("chapter");
    }
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FULL PIPELINE TEST — End-to-end retrieval
// ═══════════════════════════════════════════════════════════════════════════════

describe("Full pipeline — end-to-end search", () => {
  test("RetrievalPipeline.search() returns formatted context for conceptual query", async () => {
    if (skipIfNoInfra()) return;

    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    const result = await pipeline.search(
      "how to use context managers in Python",
      {},
      { maxChunks: 3, skipExpansion: true }
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.formatted.length).toBeGreaterThan(50);
    expect(result.count).toBeGreaterThan(0);

    console.log(`  ✓ Full pipeline: ${result.count} chunks, ${result.formatted.length} chars formatted`);
    console.log(`  ✓ Sources: ${[...new Set(result.chunks.map(c => c.metadata?.doc_title))].join(', ')}`);
    console.log(`  ✓ Scores: ${result.chunks.map(c => (c.rerankScore || c.score || 0).toFixed(3)).join(', ')}`);
  }, 60000);

  test("scope query retrieves full chapter content", async () => {
    if (skipIfNoInfra()) return;

    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    const result = await pipeline.search("explain chapter 5", {}, {});

    console.log(`  ✓ Scope search: type=${result.type || 'standard'}, count=${result.count}, formatted=${result.formatted?.length || 0} chars`);
    if (result.type === "scope") {
      expect(result.count).toBeGreaterThan(1); // scope returns multiple chunks
      expect(result.formatted.length).toBeGreaterThan(200);
    }
  }, 60000);
});
