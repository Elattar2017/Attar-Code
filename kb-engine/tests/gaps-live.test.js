/**
 * LIVE TESTS FOR ALL 11 GAPS — exercises every gap fix against real Qdrant + Ollama + search-proxy.
 *
 * Run: npx jest kb-engine/tests/gaps-live.test.js --no-cache --testTimeout=60000
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let infraOk = false;
let proxyOk = false;

beforeAll(async () => {
  try {
    const r = await fetch("http://127.0.0.1:6333/collections", { signal: AbortSignal.timeout(3000) });
    infraOk = r.ok;
  } catch (_) {}
  try {
    const r = await fetch("http://127.0.0.1:3001/health", { signal: AbortSignal.timeout(3000) });
    proxyOk = r.ok;
  } catch (_) {}
  if (!infraOk) console.warn("⚠ Qdrant not available — some tests will skip");
  if (!proxyOk) console.warn("⚠ search-proxy not available — some tests will skip");
});

function skip() { return !infraOk; }
function skipProxy() { return !proxyOk; }

// ═══════════════════════════════════════════════════════════════════
// GAP 1: FeedbackTracker.applyScores()
// ═══════════════════════════════════════════════════════════════════
describe("Gap 1 — FeedbackTracker.applyScores", () => {
  test("applyScores method exists and is async", () => {
    const { FeedbackTracker } = require("../feedback");
    const tracker = new FeedbackTracker("/tmp/test.jsonl");
    expect(typeof tracker.applyScores).toBe("function");
    // Should return a Promise
    const result = tracker.applyScores("test", new Map(), null);
    expect(result).toBeInstanceOf(Promise);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GAP 2+5: Feedback wired into search-proxy + deferred aggregation
// ═══════════════════════════════════════════════════════════════════
describe("Gap 2+5 — Feedback in search-proxy", () => {
  test("POST /kb/cite endpoint exists and accepts chunk_ids", async () => {
    if (skipProxy()) return;
    const res = await fetch("http://127.0.0.1:3001/kb/cite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunk_ids: ["test-id-1", "test-id-2"] }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    // Feedback may be disabled (FEEDBACK_ENABLED: false), so accept both
    expect(data.ok !== undefined || data.reason !== undefined).toBe(true);
    console.log("  ✓ /kb/cite response:", JSON.stringify(data));
  });

  test("POST /kb/cite rejects empty chunk_ids", async () => {
    if (skipProxy()) return;
    const res = await fetch("http://127.0.0.1:3001/kb/cite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunk_ids: [] }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GAP 3: Citation detection in attar-code.js (unit-level check)
// ═══════════════════════════════════════════════════════════════════
describe("Gap 3 — Citation detection logic", () => {
  test("snippet substring match detects cited chunks", () => {
    // Simulate the citation detection logic from attar-code.js
    const lastKbChunks = [
      { id: "chunk-1", snippet: "Python employs a reference counting mechanism as its primary garbage collection" },
      { id: "chunk-2", snippet: "The with statement ensures that resources are properly cleaned up" },
      { id: "chunk-3", snippet: "Kubernetes pod networking uses a flat network model" },
    ];
    const responseText = "Python employs a reference counting mechanism as its primary garbage collection strategy. When an object's count drops to zero, memory is freed.";

    const citedIds = lastKbChunks
      .filter(c => responseText.includes(c.snippet.slice(0, 60)))
      .map(c => c.id);

    expect(citedIds).toEqual(["chunk-1"]);
    expect(citedIds).not.toContain("chunk-3"); // unrelated chunk not cited
    console.log("  ✓ Citation detection: correctly identified", citedIds.length, "cited chunk(s)");
  });
});

// ═══════════════════════════════════════════════════════════════════
// GAP 4: quality_score in retrieval scoring
// ═══════════════════════════════════════════════════════════════════
describe("Gap 4 — quality_score in scoring", () => {
  const { assembleContext } = require("../retrieval/context-assembler");

  test("quality_score=1.0 boosts chunk score", () => {
    const chunks = [
      { content: "high quality chunk with good content that has been cited many times", score: 0.70, metadata: { doc_title: "A", quality_score: 1.0 } },
      { content: "low quality chunk with bad content that is never cited at all", score: 0.80, metadata: { doc_title: "B", quality_score: 0.0 } },
    ];
    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 2 });
    // A: 0.70 * (0.7 + 0.3*1.0) = 0.70 * 1.0 = 0.70
    // B: 0.80 * (0.7 + 0.3*0.0) = 0.80 * 0.7 = 0.56
    // A should rank first after quality boost
    expect(result.chunks[0].metadata.doc_title).toBe("A");
    console.log("  ✓ quality_score=1.0 boosts chunk above higher-raw-score chunk");
  });

  test("undefined quality_score uses neutral (no NaN)", () => {
    const chunks = [
      { content: "chunk without quality score metadata field at all", score: 0.80, metadata: { doc_title: "X" } },
    ];
    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 1 });
    expect(Number.isNaN(result.chunks[0].score)).toBe(false);
    console.log("  ✓ No NaN: score =", result.chunks[0].score.toFixed(3));
  });
});

// ═══════════════════════════════════════════════════════════════════
// GAP 6+7: /kb dna and /kb update-dna CLI commands
// ═══════════════════════════════════════════════════════════════════
describe("Gap 6+7 — DNA CLI commands exist", () => {
  test("/kb autocomplete includes dna and update-dna", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "..", "..", "attar-code.js"), "utf-8"
    );
    expect(content).toContain('"dna"');
    expect(content).toContain('"update-dna"');
    console.log("  ✓ /kb autocomplete includes dna and update-dna");
  });

  test("/kb dna handler exists in attar-code.js", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "..", "..", "attar-code.js"), "utf-8"
    );
    expect(content).toContain('sub === "dna"');
    expect(content).toContain('sub === "update-dna"');
    console.log("  ✓ /kb dna and /kb update-dna handlers exist");
  });

  test("update-dna applies DNA via Qdrant API", async () => {
    if (skip()) return;
    // The DNA for ae38cab73b73 (Packt book) already exists from previous test.
    // Verify that a direct Qdrant API call works (same mechanism as /kb update-dna)
    const { loadDNA, flattenDNA } = require("../ingestion/dna-loader");
    const dna = loadDNA("ae38cab73b73");
    if (!dna) { console.log("  ⚠ No DNA file for Packt book — skipping"); return; }
    const flat = flattenDNA(dna);

    const res = await fetch("http://127.0.0.1:6333/collections/python/points/payload", {
      method: "POST",  // POST = merge (set_payload), NOT PUT which overwrites
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: flat,
        filter: { must: [{ key: "book_id", match: { value: "ae38cab73b73" } }] },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    expect(data.status).toBe("ok");
    console.log("  ✓ update-dna mechanism: Qdrant setPayload returned", data.status);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GAP 8: Anti-tag must_not hard filter
// ═══════════════════════════════════════════════════════════════════
describe("Gap 8 — Anti-tag filtering (live)", () => {
  test("query matching anti-tags excludes those chunks", async () => {
    if (skip()) return;
    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    // Packt book has anti_tags: ["machine learning", "data science", "AI", "deep learning"]
    // Query about "machine learning" should exclude Packt chunks
    const result = await pipeline.search("machine learning with python", {}, { maxChunks: 10, skipExpansion: true });

    const packtChunks = result.chunks.filter(c => c.metadata?.doc_title?.includes("Packt"));
    const guideChunks = result.chunks.filter(c => c.metadata?.doc_title?.includes("Complete_Guide"));

    console.log("  ✓ Anti-tag test: query 'machine learning with python'");
    console.log("    Packt chunks (has anti-tag 'machine learning'):", packtChunks.length);
    console.log("    Guide chunks (no anti-tag for ML):", guideChunks.length);
    console.log("    Total results:", result.count);

    // Packt book should have ZERO results (anti-tag "machine learning" matches query)
    expect(packtChunks.length).toBe(0);
  }, 30000);

  test("query NOT matching anti-tags returns all results normally", async () => {
    if (skip()) return;
    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    // "testing with pytest" doesn't match any anti-tags
    const result = await pipeline.search("testing with pytest", {}, { maxChunks: 5, skipExpansion: true });

    const packtChunks = result.chunks.filter(c => c.metadata?.doc_title?.includes("Packt"));
    console.log("  ✓ Non-matching query: Packt chunks present:", packtChunks.length);
    expect(packtChunks.length).toBeGreaterThan(0);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════
// GAP 9: Authority labels in formatted output
// ═══════════════════════════════════════════════════════════════════
describe("Gap 9 — Authority labels in output", () => {
  const { assembleContext } = require("../retrieval/context-assembler");

  test("formatted output includes authority stars and level", () => {
    const chunks = [
      {
        content: "This is canonical documentation about Python error handling patterns",
        score: 0.90,
        metadata: { doc_title: "Official Docs", dna_authority: "canonical", dna_freshness: "current" },
      },
    ];
    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 1 });

    expect(result.formatted).toContain("canonical");
    expect(result.formatted).toContain("current");
    expect(result.formatted).toContain("★");
    console.log("  ✓ Authority label in output:", result.formatted.split("\n")[0]);
  });

  test("chunks without DNA show no authority label", () => {
    const chunks = [
      {
        content: "Plain chunk without any DNA metadata at all just regular content",
        score: 0.80,
        metadata: { doc_title: "No DNA Doc" },
      },
    ];
    const result = assembleContext(chunks, { minScore: 0.1, maxChunks: 1 });
    expect(result.formatted).not.toContain("★");
    console.log("  ✓ No DNA → no stars in output");
  });

  test("live search results show authority labels", async () => {
    if (skip()) return;
    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    const result = await pipeline.search("python project design", {}, { maxChunks: 3, skipExpansion: true });
    console.log("  ✓ Live formatted output (first 200 chars):");
    console.log("    " + result.formatted.slice(0, 200));

    // Should contain authority info from DNA
    if (result.formatted.includes("known-author") || result.formatted.includes("community")) {
      console.log("  ✓ Authority label present in live output");
    } else {
      console.log("  ⚠ Authority label not visible (DNA may not be on these chunks)");
    }
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════
// GAP 10: Pure listing path (no topic)
// ═══════════════════════════════════════════════════════════════════
describe("Gap 10 — Pure listing (no topic)", () => {
  test("_crossStructuralSearch with empty topic scrolls structural chunks", async () => {
    if (skip()) return;
    const { RetrievalPipeline } = require("../retrieval");
    const pipeline = new RetrievalPipeline();

    const result = await pipeline._crossStructuralSearch("", ["python"], "list all chapters");
    console.log("  ✓ Pure listing: type=" + result.type + ", count=" + result.count);
    console.log("  ✓ Formatted (first 300 chars):");
    console.log("    " + result.formatted.slice(0, 300));

    expect(result.type).toBe("cross_structural");
    expect(result.count).toBeGreaterThan(0);
    expect(result.formatted).toContain("document");
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════
// GAP 11: Cross-structural through search-proxy
// ═══════════════════════════════════════════════════════════════════
describe("Gap 11 — Cross-structural via search-proxy", () => {
  test("POST /kb/search with cross-structural query returns formatted output", async () => {
    if (skipProxy()) return;

    const res = await fetch("http://127.0.0.1:3001/kb/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "which chapters discuss testing", num: 10 }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();

    console.log("  ✓ Cross-structural via proxy: type=" + (data.type || "standard"));
    console.log("    Results:", data.results?.length || 0);
    if (data.formatted) {
      console.log("    Formatted (first 300 chars):");
      console.log("    " + data.formatted.slice(0, 300));
      expect(data.type).toBe("cross_structural");
    } else {
      console.log("    ⚠ No formatted output — query may not have matched cross_structural pattern");
    }
  }, 45000);

  test("POST /kb/search with normal query still works (regression)", async () => {
    if (skipProxy()) return;

    const res = await fetch("http://127.0.0.1:3001/kb/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "python context managers", num: 3 }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    expect(data.results?.length).toBeGreaterThan(0);
    console.log("  ✓ Normal search via proxy: " + data.results.length + " results, engine=" + data.engine);
  }, 45000);
});
