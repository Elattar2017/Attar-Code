'use strict';

/**
 * kb-engine/tests/retrieval.test.js
 *
 * Tests for query-analyzer.js and context-assembler.js
 *
 * Run: npx jest kb-engine/tests/retrieval.test.js --no-coverage
 */

const { analyzeQuery, detectTech } = require('../retrieval/query-analyzer');
const {
  assembleContext,
  deduplicateChunks,
  computeOverlap,
} = require('../retrieval/context-assembler');

// ============================================================================
// Query Analyzer
// ============================================================================

describe('analyzeQuery — type detection', () => {
  test('TypeError query → type=error, preferVector=dense, fix_recipes in collections', () => {
    const result = analyzeQuery('TypeError cannot read null');
    expect(result.type).toBe('error');
    expect(result.preferVector).toBe('dense');
    expect(result.collections).toContain('fix_recipes');
    expect(result.collections[0]).toBe('fix_recipes');
  });

  test('"cannot find module" → type=error', () => {
    const result = analyzeQuery('Cannot find module ./utils');
    expect(result.type).toBe('error');
    expect(result.collections[0]).toBe('fix_recipes');
  });

  test('"how to use express middleware" → type=conceptual, preferVector=dense, nodejs in collections', () => {
    const result = analyzeQuery('how to use express middleware');
    expect(result.type).toBe('conceptual');
    expect(result.preferVector).toBe('dense');
    expect(result.collections).toContain('nodejs');
  });

  test('"import useState react" → type=api, preferVector=dense', () => {
    const result = analyzeQuery('import useState react');
    expect(result.type).toBe('api');
    expect(result.preferVector).toBe('dense');
  });

  test('"what is a closure" → type=conceptual', () => {
    const result = analyzeQuery('what is a closure');
    expect(result.type).toBe('conceptual');
    expect(result.preferVector).toBe('dense');
  });

  test('"explain difference between let and const" → type=conceptual', () => {
    const result = analyzeQuery('explain difference between let and const');
    expect(result.type).toBe('conceptual');
  });

  test('"function signature parameters" → type=api', () => {
    const result = analyzeQuery('function signature parameters');
    expect(result.type).toBe('api');
  });

  test('"random question" → type=general', () => {
    const result = analyzeQuery('random question');
    expect(result.type).toBe('general');
    expect(result.preferVector).toBe('dense');
  });

  test('empty/null input → type=general, safe defaults', () => {
    expect(analyzeQuery('').type).toBe('general');
    expect(analyzeQuery(null).type).toBe('general');
    expect(analyzeQuery(undefined).type).toBe('general');
  });
});

describe('analyzeQuery — tech detection via context.detectedTech', () => {
  test('context.detectedTech="Python" → tech=python, python in collections', () => {
    const result = analyzeQuery('why does my loop fail', { detectedTech: 'Python' });
    expect(result.tech).toBe('python');
    expect(result.collections).toContain('python');
  });

  test('context.detectedTech="Node.js" → tech=nodejs', () => {
    const result = analyzeQuery('how to handle async errors', { detectedTech: 'Node.js' });
    expect(result.tech).toBe('nodejs');
    expect(result.collections).toContain('nodejs');
  });

  test('context.detectedTech="TypeScript" → tech=typescript', () => {
    const result = analyzeQuery('interface syntax', { detectedTech: 'TypeScript' });
    expect(result.tech).toBe('typescript');
  });

  test('context.detectedTech takes priority over query keywords', () => {
    // Query mentions "express" (nodejs keyword), but context says Python
    const result = analyzeQuery('express-like routing in python flask', { detectedTech: 'Python' });
    expect(result.tech).toBe('python');
  });
});

describe('analyzeQuery — tech detection via keywords', () => {
  test('"express middleware" → tech=nodejs', () => {
    const result = analyzeQuery('express middleware');
    expect(result.tech).toBe('nodejs');
    expect(result.collections).toContain('nodejs');
  });

  test('"django ORM query" → tech=python', () => {
    const result = analyzeQuery('django ORM query');
    expect(result.tech).toBe('python');
  });

  test('"React hooks useEffect" → tech=react', () => {
    const result = analyzeQuery('React hooks useEffect');
    expect(result.tech).toBe('react');
  });

  test('multiple techs in one query → first match wins (no crash)', () => {
    const result = analyzeQuery('express vs django comparison');
    // First match in TECH_KEYWORDS list wins — either nodejs or python, not null
    expect(result.tech).not.toBeNull();
    expect(['nodejs', 'python']).toContain(result.tech);
  });

  test('no tech keywords → tech=null', () => {
    const result = analyzeQuery('what is the best sorting algorithm');
    expect(result.tech).toBeNull();
  });
});

describe('analyzeQuery — collections ordering', () => {
  test('error query always has fix_recipes first', () => {
    const result = analyzeQuery('TypeError: undefined is not a function');
    expect(result.collections[0]).toBe('fix_recipes');
  });

  test('non-error query does not start with fix_recipes', () => {
    const result = analyzeQuery('how to write clean code');
    expect(result.collections[0]).not.toBe('fix_recipes');
  });

  test('always includes general as fallback', () => {
    const result = analyzeQuery('random unrelated thing');
    expect(result.collections).toContain('general');
  });

  test('error query with tech has fix_recipes, then tech, then general', () => {
    const result = analyzeQuery('express TypeError crash', {});
    expect(result.collections[0]).toBe('fix_recipes');
    expect(result.collections).toContain('nodejs');
    expect(result.collections).toContain('general');
  });
});

describe('detectTech', () => {
  test('context.detectedTech="Python" → python', () => {
    expect(detectTech('anything', { detectedTech: 'Python' })).toBe('python');
  });

  test('context.detectedTech="Node.js" → nodejs', () => {
    expect(detectTech('anything', { detectedTech: 'Node.js' })).toBe('nodejs');
  });

  test('no context, "django models" in query → python', () => {
    expect(detectTech('django models migration')).toBe('python');
  });

  test('no context, no keywords → null', () => {
    expect(detectTech('generic search query')).toBeNull();
  });

  test('empty query, no context → null', () => {
    expect(detectTech('')).toBeNull();
  });
});

// ============================================================================
// Context Assembler
// ============================================================================

// Helpers to build test chunks
function makeChunk(content, score, title = 'Docs', section = '') {
  return { content, score, metadata: { title, section } };
}

describe('computeOverlap', () => {
  test('identical text → 1.0', () => {
    expect(computeOverlap('hello world foo', 'hello world foo')).toBe(1.0);
  });

  test('completely different words → ~0.0', () => {
    expect(computeOverlap('alpha beta gamma', 'delta epsilon zeta')).toBeCloseTo(0.0);
  });

  test('partial overlap → between 0 and 1', () => {
    const overlap = computeOverlap('hello world', 'hello earth');
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });

  test('both empty strings → 1.0', () => {
    expect(computeOverlap('', '')).toBe(1.0);
  });

  test('one empty string → 0.0', () => {
    expect(computeOverlap('hello world', '')).toBe(0.0);
    expect(computeOverlap('', 'hello world')).toBe(0.0);
  });

  test('case-insensitive comparison', () => {
    expect(computeOverlap('Hello World', 'hello world')).toBe(1.0);
  });
});

describe('deduplicateChunks', () => {
  test('returns empty array for empty input', () => {
    expect(deduplicateChunks([])).toEqual([]);
  });

  test('keeps unique chunks', () => {
    const chunks = [
      makeChunk('first unique chunk about express routing', 0.9),
      makeChunk('second unique chunk about python pandas dataframe filtering', 0.8),
    ];
    const result = deduplicateChunks(chunks);
    expect(result).toHaveLength(2);
  });

  test('removes near-duplicate, keeps higher score', () => {
    const highScore = makeChunk('express middleware function for routing requests', 0.95);
    const lowScore = makeChunk('express middleware function for routing requests', 0.7);
    const result = deduplicateChunks([lowScore, highScore]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.95);
  });

  test('removes near-duplicate (>80% overlap), keeps higher score regardless of order', () => {
    const a = makeChunk('the quick brown fox jumps over the lazy dog sits there', 0.6);
    const b = makeChunk('the quick brown fox jumps over the lazy dog sits there', 0.85);
    const result = deduplicateChunks([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.85);
  });

  test('does not deduplicate sufficiently different chunks', () => {
    const a = makeChunk('express routing middleware pipeline configuration', 0.9);
    const b = makeChunk('python async await coroutine event loop gathering', 0.8);
    expect(deduplicateChunks([a, b])).toHaveLength(2);
  });
});

describe('assembleContext — filtering and limits', () => {
  test('filters chunks below default score threshold (0.5)', () => {
    const chunks = [
      makeChunk('good chunk', 0.9, 'API Docs', 'Methods'),
      makeChunk('below threshold chunk', 0.3, 'API Docs', 'Methods'),
      makeChunk('borderline chunk', 0.5, 'API Docs', 'Overview'),
    ];
    const { count } = assembleContext(chunks);
    // score 0.3 is filtered out; 0.9 and 0.5 survive
    expect(count).toBe(2);
  });

  test('respects custom minScore option', () => {
    const chunks = [
      makeChunk('high relevance', 0.95),
      makeChunk('medium relevance', 0.6),
      makeChunk('low relevance', 0.3),
    ];
    const { count } = assembleContext(chunks, { minScore: 0.7 });
    expect(count).toBe(1);
  });

  test('respects maxChunks limit', () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk(`chunk number ${i} with unique content word${i}`, 0.9 - i * 0.01)
    );
    const { count } = assembleContext(chunks, { maxChunks: 3 });
    expect(count).toBe(3);
  });

  test('returns highest-scored chunks when maxChunks is applied', () => {
    const chunks = [
      makeChunk('low score content abc', 0.6),
      makeChunk('high score content def', 0.95),
      makeChunk('medium score content ghi', 0.75),
    ];
    const { chunks: top } = assembleContext(chunks, { maxChunks: 2 });
    const scores = top.map((c) => c.score);
    expect(scores).toContain(0.95);
    expect(scores).toContain(0.75);
    expect(scores).not.toContain(0.6);
  });
});

describe('assembleContext — empty / no-result cases', () => {
  test('empty array → "No relevant documentation found."', () => {
    const { formatted, count } = assembleContext([]);
    expect(formatted).toBe('No relevant documentation found.');
    expect(count).toBe(0);
  });

  test('null/undefined input → "No relevant documentation found."', () => {
    expect(assembleContext(null).formatted).toBe('No relevant documentation found.');
    expect(assembleContext(undefined).formatted).toBe('No relevant documentation found.');
  });

  test('all chunks below minScore → "No relevant documentation found."', () => {
    const chunks = [makeChunk('low scored chunk', 0.1)];
    const { formatted } = assembleContext(chunks);
    expect(formatted).toBe('No relevant documentation found.');
  });
});

describe('assembleContext — formatted output', () => {
  test('includes source header with title and section', () => {
    const chunks = [makeChunk('Express app.use() registers middleware', 0.92, 'Express Docs', 'Middleware')];
    const { formatted } = assembleContext(chunks);
    expect(formatted).toContain('[Source: Express Docs > Middleware]');
    expect(formatted).toContain('[Score: 0.92]');
    expect(formatted).toContain('Express app.use() registers middleware');
  });

  test('source header without section shows title only (no >)', () => {
    const chunks = [makeChunk('some content', 0.8, 'Node Docs')];
    const { formatted } = assembleContext(chunks);
    expect(formatted).toContain('[Source: Node Docs]');
    expect(formatted).not.toMatch(/Source: Node Docs >/);
  });

  test('multiple chunks are joined with separator', () => {
    const chunks = [
      makeChunk('first result content here', 0.9, 'Docs', 'Section A'),
      makeChunk('second result content here with different words', 0.8, 'Docs', 'Section B'),
    ];
    const { formatted } = assembleContext(chunks);
    expect(formatted).toContain('\n\n---\n\n');
    expect(formatted).toContain('Section A');
    expect(formatted).toContain('Section B');
  });

  test('count matches number of returned chunks', () => {
    const chunks = [
      makeChunk('alpha beta gamma delta epsilon', 0.9, 'A'),
      makeChunk('zeta eta theta iota kappa lambda mu nu', 0.8, 'B'),
    ];
    const result = assembleContext(chunks);
    expect(result.count).toBe(result.chunks.length);
    expect(result.count).toBe(2);
  });

  test('deduplication works within assembleContext pipeline', () => {
    const chunks = [
      makeChunk('express routing middleware configuration pipeline', 0.7, 'Docs', 'Overview'),
      makeChunk('express routing middleware configuration pipeline', 0.9, 'Docs', 'Overview'),
    ];
    const { count, chunks: result } = assembleContext(chunks);
    expect(count).toBe(1);
    expect(result[0].score).toBe(0.9);
  });
});

// ─── Query Expander Tests ───────────────────────────────────
const { expandQuery } = require("../retrieval/query-expander");

describe("expandQuery", () => {
  test("returns array with original query as first element", async () => {
    const result = await expandQuery("test query", {}, "http://127.0.0.1:99999");
    expect(result[0]).toBe("test query");
  });

  test("returns [original] when Ollama unavailable", async () => {
    const result = await expandQuery("express middleware", {}, "http://127.0.0.1:99999");
    expect(result).toEqual(["express middleware"]);
  });

  test("all results are strings", async () => {
    const result = await expandQuery("test", {});
    for (const q of result) {
      expect(typeof q).toBe("string");
      expect(q.length).toBeGreaterThan(0);
    }
  });
});

// ─── Reranker Tests ─────────────────────────────────────────
const { Reranker } = require("../retrieval/reranker");

describe("Reranker", () => {
  test("isRunning returns false on unused port", async () => {
    const r = new Reranker({ port: 16334, url: "http://127.0.0.1:16334" });
    expect(await r.isRunning()).toBe(false);
  });

  test("rerank returns null when sidecar not running", async () => {
    const r = new Reranker({ port: 16334, url: "http://127.0.0.1:16334" });
    const scores = await r.rerank("query", ["doc1", "doc2"]);
    expect(scores).toBeNull();
  });

  test("constructor accepts port override", () => {
    const r = new Reranker(9999);
    expect(r._port).toBe(9999);
  });

  test("stop is safe when no process", () => {
    const r = new Reranker();
    expect(() => r.stop()).not.toThrow();
  });
});
