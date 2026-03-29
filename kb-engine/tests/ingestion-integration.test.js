// kb-engine/tests/ingestion-integration.test.js
// Integration tests for the full IngestPipeline.
// Qdrant-dependent tests skip automatically if Qdrant is unreachable.
// Run: npx jest kb-engine/tests/ingestion-integration.test.js --no-coverage --testTimeout=30000

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

// ─── Service availability ─────────────────────────────────────────────────────

function isQdrantReachable() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:6333/healthz', (res) => {
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function isOllamaReachable() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:11434/api/tags', (res) => {
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// ─── Module-level state ───────────────────────────────────────────────────────

let qdrantAvailable   = false;
let ollamaAvailable   = false;
let servicesAvailable = false;

beforeAll(async () => {
  [qdrantAvailable, ollamaAvailable] = await Promise.all([
    isQdrantReachable(),
    isOllamaReachable(),
  ]);
  servicesAvailable = qdrantAvailable && ollamaAvailable;
}, 10000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory and return its path.
 * Files written inside it are cleaned up in afterEach.
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ingest-test-'));
}

/**
 * Write a file and return its absolute path.
 */
function writeTemp(dir, filename, content) {
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

/**
 * Recursively delete a directory.
 */
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// Sample Markdown document with headings and code blocks
const SAMPLE_MD = `# Express Guide

This is an introduction to Express.js middleware.

## Getting Started

Install dependencies:

\`\`\`bash
npm install express
\`\`\`

## Middleware

Middleware functions execute during the request–response cycle.

\`\`\`javascript
function logger(req, res, next) {
  console.log(req.method, req.url);
  next();
}
app.use(logger);
\`\`\`

## Error Handling

Express error handlers accept four arguments.

\`\`\`javascript
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});
\`\`\`
`;

// Sample JS file
const SAMPLE_JS = `const express = require('express');

function greet(name) {
  return 'Hello, ' + name;
}

function add(a, b) {
  return a + b;
}

module.exports = { greet, add };
`;

// ─── Pure-JS tests (no Qdrant / Ollama needed) ───────────────────────────────

// ---------------------------------------------------------------------------
// extractMetadata
// ---------------------------------------------------------------------------
describe('extractMetadata — language detection', () => {
  const { extractMetadata } = require('../ingestion/metadata');

  test('detects javascript from .js extension', () => {
    const m = extractMetadata('some content', 'app.js');
    expect(m.language).toBe('javascript');
  });

  test('detects typescript from .ts extension', () => {
    const m = extractMetadata('some content', 'index.ts');
    expect(m.language).toBe('typescript');
  });

  test('detects python from .py extension', () => {
    const m = extractMetadata('some content', 'main.py');
    expect(m.language).toBe('python');
  });

  test('detects go from .go extension', () => {
    const m = extractMetadata('some content', 'server.go');
    expect(m.language).toBe('go');
  });

  test('detects rust from .rs extension', () => {
    const m = extractMetadata('some content', 'lib.rs');
    expect(m.language).toBe('rust');
  });

  test('detects java from .java extension', () => {
    const m = extractMetadata('some content', 'Main.java');
    expect(m.language).toBe('java');
  });

  test('options.language overrides extension-based detection', () => {
    const m = extractMetadata('some content', 'unknown.txt', { language: 'python' });
    expect(m.language).toBe('python');
  });

  test('unknown extension returns null language', () => {
    const m = extractMetadata('some content', 'data.xyz');
    expect(m.language).toBeNull();
  });
});

describe('extractMetadata — framework detection', () => {
  const { extractMetadata } = require('../ingestion/metadata');

  test('detects express from filepath', () => {
    const m = extractMetadata('app.get("/", fn)', '/projects/express-app/routes.js');
    expect(m.framework).toBe('express');
  });

  test('detects django from filepath', () => {
    const m = extractMetadata('views content', '/projects/django-blog/views.py');
    expect(m.framework).toBe('django');
  });

  test('detects react from filepath', () => {
    const m = extractMetadata('component code', '/src/react-components/Button.tsx');
    expect(m.framework).toBe('react');
  });

  test('options.framework overrides filepath detection', () => {
    const m = extractMetadata('content', '/django-app/views.py', { framework: 'flask' });
    expect(m.framework).toBe('flask');
  });

  test('no framework match returns null', () => {
    const m = extractMetadata('some content', '/projects/generic-app/utils.js');
    expect(m.framework).toBeNull();
  });
});

describe('extractMetadata — content_type', () => {
  const { extractMetadata } = require('../ingestion/metadata');

  test('pure prose returns "prose"', () => {
    const content = 'This is a paragraph about web development. It covers many topics.';
    const m = extractMetadata(content, 'doc.md');
    expect(m.content_type).toBe('prose');
  });

  test('content with code blocks returns "mixed" or "code"', () => {
    const content = SAMPLE_MD;
    const m = extractMetadata(content, 'guide.md');
    expect(['mixed', 'code']).toContain(m.content_type);
  });

  test('has_code_block is true when fenced code blocks present', () => {
    const m = extractMetadata(SAMPLE_MD, 'guide.md');
    expect(m.has_code_block).toBe(true);
  });

  test('has_code_block is false for plain prose', () => {
    const m = extractMetadata('Just plain text, no code blocks here.', 'readme.txt');
    expect(m.has_code_block).toBe(false);
  });
});

describe('extractMetadata — doc_type', () => {
  const { extractMetadata } = require('../ingestion/metadata');

  test('tutorial keyword → doc_type "tutorial"', () => {
    const m = extractMetadata('Tutorial: Getting started with Express.js', 'guide.md');
    expect(m.doc_type).toBe('tutorial');
  });

  test('API keyword → doc_type "api"', () => {
    const m = extractMetadata('API Reference: method returns an object with parameters', 'api.md');
    expect(m.doc_type).toBe('api');
  });

  test('guide keyword → doc_type "guide"', () => {
    const m = extractMetadata('Guide: an overview and introduction to concepts', 'guide.md');
    expect(m.doc_type).toBe('guide');
  });

  test('neutral content defaults to "reference"', () => {
    const m = extractMetadata('The quick brown fox jumps over the lazy dog.', 'notes.txt');
    expect(m.doc_type).toBe('reference');
  });
});

describe('extractMetadata — keywords', () => {
  const { extractMetadata } = require('../ingestion/metadata');

  test('returns an array', () => {
    const m = extractMetadata('express middleware routing handler function', 'app.js');
    expect(Array.isArray(m.keywords)).toBe(true);
  });

  test('returns at most 10 keywords', () => {
    const m = extractMetadata(SAMPLE_MD, 'guide.md');
    expect(m.keywords.length).toBeLessThanOrEqual(10);
  });

  test('keywords do not contain stop words', () => {
    const STOP = new Set(['the', 'a', 'an', 'is', 'and', 'or', 'in', 'of', 'to']);
    const m = extractMetadata('the quick brown fox and the lazy dog', 'doc.txt');
    for (const kw of m.keywords) {
      expect(STOP.has(kw)).toBe(false);
    }
  });

  test('returns output shape with all required fields', () => {
    const m = extractMetadata('content here', 'file.js');
    expect(m).toHaveProperty('language');
    expect(m).toHaveProperty('framework');
    expect(m).toHaveProperty('content_type');
    expect(m).toHaveProperty('doc_type');
    expect(m).toHaveProperty('has_code_block');
    expect(m).toHaveProperty('keywords');
  });
});

// ---------------------------------------------------------------------------
// enrichChunkFast
// ---------------------------------------------------------------------------
describe('enrichChunkFast', () => {
  const { enrichChunkFast } = require('../ingestion/enrichment');

  test('prepends [docTitle > sectionPath] prefix', () => {
    const result = enrichChunkFast('chunk content', 'Express Guide', 'Middleware');
    expect(result).toMatch(/^\[Express Guide > Middleware\]/);
    expect(result).toContain('chunk content');
  });

  test('uses only docTitle when sectionPath is empty', () => {
    const result = enrichChunkFast('content', 'My Doc', '');
    expect(result).toMatch(/^\[My Doc\]/);
  });

  test('returns chunk unchanged when both are empty', () => {
    const result = enrichChunkFast('just content', '', '');
    expect(result).toBe('just content');
  });

  test('returns chunk unchanged when both are undefined', () => {
    const result = enrichChunkFast('just content');
    expect(result).toBe('just content');
  });

  test('separator between prefix and chunk is double newline', () => {
    const result = enrichChunkFast('body text', 'Title', 'Section');
    expect(result).toContain('\n\n');
    const [prefix, ...rest] = result.split('\n\n');
    expect(prefix).toBe('[Title > Section]');
    expect(rest.join('\n\n')).toBe('body text');
  });
});

// ---------------------------------------------------------------------------
// enrichChunk (LLM — graceful fallback test only)
// ---------------------------------------------------------------------------
describe('enrichChunk — fallback behavior (no Ollama required)', () => {
  test('returns original chunk when Ollama is unreachable', async () => {
    const { enrichChunk } = require('../ingestion/enrichment');
    // Use a definitely-not-running URL to trigger fallback
    const result = await enrichChunk('chunk content', 'Doc', 'Section', 'http://127.0.0.1:19999');
    expect(result).toBe('chunk content');
  }, 20000);
});

// ---------------------------------------------------------------------------
// IngestionTracker
// ---------------------------------------------------------------------------
describe('IngestionTracker', () => {
  const { IngestionTracker } = require('../ingestion/progress');

  let tmpDir;
  let stateFile;

  beforeEach(() => {
    tmpDir    = makeTempDir();
    stateFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('getState returns null for unknown docId', () => {
    const tracker = new IngestionTracker(stateFile);
    expect(tracker.getState('nonexistent')).toBeNull();
  });

  test('startIngestion records status in_progress', () => {
    const tracker = new IngestionTracker(stateFile);
    tracker.startIngestion('doc1', 10, 'general');
    const state = tracker.getState('doc1');
    expect(state).not.toBeNull();
    expect(state.status).toBe('in_progress');
    expect(state.total_chunks).toBe(10);
    expect(state.processed).toBe(0);
    expect(state.collection).toBe('general');
  });

  test('updateProgress updates the processed count', () => {
    const tracker = new IngestionTracker(stateFile);
    tracker.startIngestion('doc2', 20, 'nodejs');
    tracker.updateProgress('doc2', 7);
    expect(tracker.getState('doc2').processed).toBe(7);
  });

  test('markComplete sets status to complete', () => {
    const tracker = new IngestionTracker(stateFile);
    tracker.startIngestion('doc3', 5, 'python');
    tracker.markComplete('doc3');
    const state = tracker.getState('doc3');
    expect(state.status).toBe('complete');
    expect(state.completed_at).toBeDefined();
  });

  test('getIncomplete returns only in_progress entries', () => {
    const tracker = new IngestionTracker(stateFile);
    tracker.startIngestion('docA', 3, 'general');
    tracker.startIngestion('docB', 4, 'general');
    tracker.markComplete('docB');
    const incomplete = tracker.getIncomplete();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].docId).toBe('docA');
  });

  test('reset removes the entry', () => {
    const tracker = new IngestionTracker(stateFile);
    tracker.startIngestion('docX', 5, 'general');
    tracker.reset('docX');
    expect(tracker.getState('docX')).toBeNull();
  });

  test('state persists across new IngestionTracker instances', () => {
    const tracker1 = new IngestionTracker(stateFile);
    tracker1.startIngestion('persistent-doc', 8, 'nodejs');
    tracker1.markComplete('persistent-doc');

    const tracker2 = new IngestionTracker(stateFile);
    const state = tracker2.getState('persistent-doc');
    expect(state).not.toBeNull();
    expect(state.status).toBe('complete');
  });

  test('handles missing state file gracefully', () => {
    const tracker = new IngestionTracker(path.join(tmpDir, 'nonexistent', 'state.json'));
    expect(() => tracker.startIngestion('doc', 1, 'general')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// IngestPipeline — pure-JS shape tests (no Qdrant needed)
// ---------------------------------------------------------------------------
describe('IngestPipeline — class shape', () => {
  const { IngestPipeline } = require('../ingestion/index');

  test('can be constructed without arguments', () => {
    expect(() => new IngestPipeline()).not.toThrow();
  });

  test('exposes store property', () => {
    const p = new IngestPipeline();
    expect(p.store).toBeDefined();
  });

  test('exposes chunker property', () => {
    const p = new IngestPipeline();
    expect(p.chunker).toBeDefined();
  });

  test('exposes tracker property', () => {
    const p = new IngestPipeline();
    expect(p.tracker).toBeDefined();
  });

  test('has ingestFile method', () => {
    const p = new IngestPipeline();
    expect(typeof p.ingestFile).toBe('function');
  });

  test('has ingestDirectory method', () => {
    const p = new IngestPipeline();
    expect(typeof p.ingestDirectory).toBe('function');
  });

  test('ingestFile throws for missing file', async () => {
    const p = new IngestPipeline();
    await expect(p.ingestFile('/nonexistent/path/file.md')).rejects.toThrow('File not found');
  });
});

// ---------------------------------------------------------------------------
// IngestPipeline — mock store tests (no Qdrant needed)
// ---------------------------------------------------------------------------
describe('IngestPipeline — with mock store (no Qdrant)', () => {
  const { IngestPipeline }  = require('../ingestion/index');
  const { IngestionTracker } = require('../ingestion/progress');

  let tmpDir;
  let stateFile;

  beforeEach(() => {
    tmpDir    = makeTempDir();
    stateFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  /**
   * Build a mock ChunkStore that captures addChunks calls
   * and returns fake UUIDs without touching Qdrant.
   */
  function makeMockStore() {
    const calls = { ensureCollection: [], addChunks: [] };
    return {
      _calls: calls,
      async ensureCollection(name) { calls.ensureCollection.push(name); },
      async addChunks(collection, chunks) {
        calls.addChunks.push({ collection, count: chunks.length, chunks });
        return chunks.map((_, i) => `fake-uuid-${i}`);
      },
    };
  }

  test('ingestFile .md returns { collection, chunks_stored, format, title }', async () => {
    const store = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    const result = await pipeline.ingestFile(mdFile);

    expect(result).toHaveProperty('collection');
    expect(result).toHaveProperty('chunks_stored');
    expect(result).toHaveProperty('format');
    expect(result.chunks_stored).toBeGreaterThan(0);
    expect(result.format).toBe('markdown');
  });

  test('ingestFile .md stores > 0 chunks', async () => {
    const store = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    const result = await pipeline.ingestFile(mdFile);

    expect(result.chunks_stored).toBeGreaterThan(0);
  });

  test('ingestFile .md calls ensureCollection', async () => {
    const store = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    await pipeline.ingestFile(mdFile);

    expect(store._calls.ensureCollection.length).toBeGreaterThan(0);
  });

  test('ingestFile .js returns format "code"', async () => {
    const store = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const jsFile = writeTemp(tmpDir, 'utils.js', SAMPLE_JS);
    const result = await pipeline.ingestFile(jsFile);

    expect(result.format).toBe('code');
    expect(result.chunks_stored).toBeGreaterThan(0);
  });

  test('ingestFile .txt returns format "text"', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const txtFile = writeTemp(tmpDir, 'notes.txt', 'Plain text notes about Express.js middleware.\nSecond line here.');
    const result  = await pipeline.ingestFile(txtFile);

    expect(result.format).toBe('text');
    expect(result.chunks_stored).toBeGreaterThan(0);
  });

  test('ingestFile respects options.collection override', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    const result = await pipeline.ingestFile(mdFile, { collection: 'my-custom-collection' });

    expect(result.collection).toBe('my-custom-collection');
    expect(store._calls.ensureCollection).toContain('my-custom-collection');
  });

  test('ingestFile enriches chunks with fast enrichment prefix', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    await pipeline.ingestFile(mdFile);

    // All stored chunks should have the enrichment prefix pattern: [...]
    const allChunks = store._calls.addChunks.flatMap(c => c.chunks);
    const enriched  = allChunks.filter(c => c.content.startsWith('['));
    expect(enriched.length).toBeGreaterThan(0);
  });

  test('ingestFile stores metadata on each chunk', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    await pipeline.ingestFile(mdFile);

    const allChunks = store._calls.addChunks.flatMap(c => c.chunks);
    for (const chunk of allChunks) {
      expect(chunk.metadata).toBeDefined();
      expect(chunk.metadata).toHaveProperty('source');
      expect(chunk.metadata).toHaveProperty('filename');
      expect(chunk.metadata).toHaveProperty('chunk_index');
    }
  });

  test('ingestFile metadata contains language for .js files', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const jsFile   = writeTemp(tmpDir, 'utils.js', SAMPLE_JS);
    await pipeline.ingestFile(jsFile);

    const allChunks = store._calls.addChunks.flatMap(c => c.chunks);
    for (const chunk of allChunks) {
      expect(chunk.metadata.language).toBe('javascript');
    }
  });

  test('tracker marks doc as complete after ingestFile', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const mdFile = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    await pipeline.ingestFile(mdFile);

    const state = pipeline.tracker.getState('guide.md');
    expect(state).not.toBeNull();
    expect(state.status).toBe('complete');
  });

  test('ingestDirectory ingests .md and .js files', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const subDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(subDir);
    writeTemp(subDir, 'guide.md',  SAMPLE_MD);
    writeTemp(subDir, 'utils.js',  SAMPLE_JS);
    writeTemp(subDir, 'notes.txt', 'Some plain text notes.');

    const results = await pipeline.ingestDirectory(subDir);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(3);

    const formats = results.map(r => r.format);
    expect(formats).toContain('markdown');
    expect(formats).toContain('code');
    expect(formats).toContain('text');
  });

  test('ingestDirectory skips node_modules', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const subDir    = path.join(tmpDir, 'project');
    const nmDir     = path.join(subDir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    writeTemp(subDir, 'index.md', '# Index\nContent here.');
    writeTemp(nmDir,  'pkg.md',   '# Pkg\nShould be skipped.');

    const results = await pipeline.ingestDirectory(subDir);

    // Only the root index.md should be ingested
    expect(results.length).toBe(1);
    expect(results[0].file).toContain('index.md');
  });

  test('ingestDirectory handles errors per-file without throwing', async () => {
    const store = makeMockStore();
    // Override addChunks to throw on first call
    let callCount = 0;
    const originalAddChunks = store.addChunks.bind(store);
    store.addChunks = async (col, chunks) => {
      callCount++;
      if (callCount === 1) throw new Error('Simulated store error');
      return originalAddChunks(col, chunks);
    };

    const pipeline = new IngestPipeline({ store, stateFile });

    const subDir = path.join(tmpDir, 'mixed');
    fs.mkdirSync(subDir);
    writeTemp(subDir, 'doc1.md', '# Doc1\nContent one.');
    writeTemp(subDir, 'doc2.md', '# Doc2\nContent two.');

    const results = await pipeline.ingestDirectory(subDir);

    // Should not throw — one error, one success
    expect(results.length).toBe(2);
    const errors   = results.filter(r => r.error);
    const successes = results.filter(r => !r.error);
    expect(errors.length).toBe(1);
    expect(successes.length).toBe(1);
  });

  test('ingestDirectory returns empty array for empty directory', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir);

    const results = await pipeline.ingestDirectory(emptyDir);
    expect(results).toEqual([]);
  });

  test('ingestDirectory uses options.collection for all files', async () => {
    const store    = makeMockStore();
    const pipeline = new IngestPipeline({ store, stateFile });

    const subDir = path.join(tmpDir, 'docs2');
    fs.mkdirSync(subDir);
    writeTemp(subDir, 'a.md', '# A\nAlpha content.');
    writeTemp(subDir, 'b.md', '# B\nBeta content.');

    await pipeline.ingestDirectory(subDir, { collection: 'custom-coll' });

    const allCollections = store._calls.ensureCollection;
    expect(allCollections.every(c => c === 'custom-coll')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Format detection integration (no Qdrant needed)
// ---------------------------------------------------------------------------
describe('Format detection integration', () => {
  const { detectFormat } = require('../ingestion/format-detector');

  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { rmDir(tmpDir); });

  test('.md file detected as markdown', () => {
    const f = writeTemp(tmpDir, 'guide.md', SAMPLE_MD);
    const content = fs.readFileSync(f, 'utf-8');
    expect(detectFormat(f, content)).toMatchObject({ format: 'markdown' });
  });

  test('.js file detected as code/javascript', () => {
    const f = writeTemp(tmpDir, 'app.js', SAMPLE_JS);
    const content = fs.readFileSync(f, 'utf-8');
    expect(detectFormat(f, content)).toMatchObject({ format: 'code', language: 'javascript' });
  });

  test('.txt file detected as text', () => {
    const f = writeTemp(tmpDir, 'notes.txt', 'plain text');
    const content = fs.readFileSync(f, 'utf-8');
    expect(detectFormat(f, content)).toMatchObject({ format: 'text' });
  });

  test('.html file detected as html', () => {
    const f = writeTemp(tmpDir, 'page.html', '<html><body>Hello</body></html>');
    const content = fs.readFileSync(f, 'utf-8');
    expect(detectFormat(f, content)).toMatchObject({ format: 'html' });
  });
});

// ---------------------------------------------------------------------------
// Full pipeline — Qdrant-dependent (skipped if unavailable)
// ---------------------------------------------------------------------------
describe('Full IngestPipeline — Qdrant + Ollama required', () => {
  const { IngestPipeline } = require('../ingestion/index');
  const { ChunkStore }     = require('../store');

  const TEST_COLLECTION = 'kb_ingest_integration_test';
  let store;
  let pipeline;
  let tmpDir;
  let stateFile;

  beforeAll(async () => {
    if (!servicesAvailable) return;

    store    = new ChunkStore();
    tmpDir   = makeTempDir();
    stateFile = path.join(tmpDir, 'state.json');
    pipeline = new IngestPipeline({ store, stateFile });

    // Clean up any leftover collection
    try { await store.deleteCollection(TEST_COLLECTION); } catch (_) {}
  }, 15000);

  afterAll(async () => {
    if (tmpDir) rmDir(tmpDir);
    if (!servicesAvailable || !store) return;
    try { await store.deleteCollection(TEST_COLLECTION); } catch (_) {}
  }, 15000);

  test('ingestFile .md → collection + chunks_stored > 0', async () => {
    if (!servicesAvailable) return;

    const mdFile = writeTemp(tmpDir, 'express-guide.md', SAMPLE_MD);
    const result = await pipeline.ingestFile(mdFile, { collection: TEST_COLLECTION });

    expect(result.collection).toBe(TEST_COLLECTION);
    expect(result.chunks_stored).toBeGreaterThan(0);
    expect(result.format).toBe('markdown');
  }, 30000);

  test('ingestFile .js → chunks_stored > 0', async () => {
    if (!servicesAvailable) return;

    const jsFile = writeTemp(tmpDir, 'utils.js', SAMPLE_JS);
    const result = await pipeline.ingestFile(jsFile, { collection: TEST_COLLECTION });

    expect(result.chunks_stored).toBeGreaterThan(0);
    expect(result.format).toBe('code');
  }, 30000);

  test('ingested chunks are retrievable from Qdrant', async () => {
    if (!servicesAvailable) return;

    // Add a distinctive document
    const uniqueContent = [
      '# Qdrant Retrieval Test',
      '',
      'This document is uniquely identified for retrieval testing.',
      'It discusses the concept of xyzzy-retrieval-test-marker.',
      '',
      '## Code Sample',
      '',
      '```javascript',
      'function xyzzyTestMarker() { return 42; }',
      '```',
    ].join('\n');

    const mdFile = writeTemp(tmpDir, 'retrieval-test.md', uniqueContent);
    const result = await pipeline.ingestFile(mdFile, { collection: TEST_COLLECTION });

    expect(result.chunks_stored).toBeGreaterThan(0);

    const count = await store.getChunkCount(TEST_COLLECTION);
    expect(count).toBeGreaterThan(0);
  }, 30000);

  test('ingestDirectory processes multiple files', async () => {
    if (!servicesAvailable) return;

    const subDir = path.join(tmpDir, 'multi-ingest');
    fs.mkdirSync(subDir, { recursive: true });
    writeTemp(subDir, 'doc1.md', '# Doc1\nContent about express middleware routing.');
    writeTemp(subDir, 'doc2.md', '# Doc2\nContent about python django views.');

    const results = await pipeline.ingestDirectory(subDir, { collection: TEST_COLLECTION });

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.chunks_stored).toBeGreaterThan(0);
    }
  }, 30000);
});
