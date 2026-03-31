#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║   attar-code search-proxy — localhost:3001                        ║
// ║   Web search + fetch + KB engine (Qdrant vector search)          ║
// ║   npm install express axios cheerio pdf-parse                    ║
// ║   KB engine: Qdrant + Ollama embedding models                    ║
// ╚══════════════════════════════════════════════════════════════════╝

const express  = require("express");
const axios    = require("axios");
const cheerio  = require("cheerio");
const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const { execFileSync } = require("child_process");

const app  = express();
const PORT = 3001;
const PROXY_START_TIME = Date.now();
app.use(express.json());

// ─── Knowledge base folders ───────────────────────────────────────────────────
const KB_DIR    = path.join(os.homedir(), ".attar-code", "knowledge");
const DOCS_DIR  = path.join(KB_DIR, "docs");
const BOOKS_DIR = path.join(KB_DIR, "books");
const CODE_DIR  = path.join(KB_DIR, "code");
const INDEX_DIR = path.join(KB_DIR, ".index");

for (const d of [DOCS_DIR, BOOKS_DIR, CODE_DIR, INDEX_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Write README if not exists
const readmePath = path.join(KB_DIR, "README.md");
if (!fs.existsSync(readmePath)) {
  fs.writeFileSync(readmePath, `# attar-code Knowledge Base\n\nDrop files here and attar-code will search them.\n\n## Folders:\n- docs/   — .md .txt files\n- books/  — .pdf files\n- code/   — .py .js etc\n`);
}

// ─── KB Engine (Qdrant-based) ────────────────────────────────────────────────

let kbEngine = null;       // KBEngine instance (if available)
let kbReady  = false;      // true once engine.start() succeeds
let kbError  = null;       // initialization error message (if any)

// ─── PDF extractor ────────────────────────────────────────────────────────────
async function extractPdf(filepath) {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(fs.readFileSync(filepath));
    return data.text;
  } catch (_) {
    try { return execFileSync("pdftotext", [filepath, "-"], { encoding:"utf-8", timeout:30000 }); }
    catch (e) { return `[PDF extraction failed: ${e.message}]`; }
  }
}

// ─── Web search (DuckDuckGo HTML scrape — no API key) ────────────────────────
const SEARX_URL = process.env.SEARX_URL || null;

async function webSearch(query, num = 5) {
  if (SEARX_URL) {
    try {
      const res = await axios.get(`${SEARX_URL}/search`, {
        params: { q: query, format: "json", categories: "general" },
        timeout: 8000,
      });
      return (res.data.results || []).slice(0, num).map(r => ({ title: r.title, url: r.url, snippet: r.content || "", source: "searxng" }));
    } catch (_) {}
  }

  // DuckDuckGo Lite fallback
  try {
    const res = await axios.get("https://html.duckduckgo.com/html/", {
      params: { q: query },
      headers: { "User-Agent": "Mozilla/5.0 (compatible; attar-code/2.0)", "Accept": "text/html" },
      timeout: 10000,
    });
    const $ = cheerio.load(res.data);
    const results = [];
    $(".result").each((i, el) => {
      if (i >= num) return false;
      const title   = $(el).find(".result__title").text().trim();
      const url     = $(el).find(".result__url").text().trim();
      const snippet = $(el).find(".result__snippet").text().trim();
      if (title) results.push({ title, url: "https://" + url, snippet, source: "duckduckgo" });
    });
    return results;
  } catch (e) { return [{ error: `Search failed: ${e.message}` }]; }
}

// ─── Web fetch + clean ────────────────────────────────────────────────────────
async function webFetch(url, maxChars = 8000) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; attar-code/2.0)" },
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024,
    });
    const ct = res.headers["content-type"] || "";

    if (ct.includes("text/plain")) return { url, text: String(res.data).slice(0, maxChars), type: "text" };

    if (ct.includes("text/html")) {
      const $ = cheerio.load(res.data);
      $("script,style,nav,header,footer,iframe,noscript,.nav,.menu,.sidebar,.ad,.cookie").remove();
      const main = $("article,main,[role=main],.content,.post,.entry").first();
      let text = main.length ? main.text() : $("body").text();
      text = text.replace(/\n{3,}/g, "\n\n").replace(/\t/g, " ").replace(/ {3,}/g, " ").trim();
      return { url, text: text.slice(0, maxChars), type: "html" };
    }

    if (ct.includes("application/json")) {
      const json = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
      return { url, text: json.slice(0, maxChars), type: "json" };
    }

    return { url, text: String(res.data).slice(0, maxChars), type: "raw" };
  } catch (e) { return { url, error: e.message }; }
}

// ─── GitHub search (no API key for public repos) ──────────────────────────────
async function githubSearch(query, type = "repositories", num = 5) {
  try {
    const res = await axios.get(`https://api.github.com/search/${type}`, {
      params: { q: query, per_page: num, sort: "stars", order: "desc" },
      headers: {
        "User-Agent": "attar-code/2.0",
        "Accept": "application/vnd.github.v3+json",
        ...(process.env.GITHUB_TOKEN ? { "Authorization": `token ${process.env.GITHUB_TOKEN}` } : {})
      },
      timeout: 10000,
    });

    if (type === "repositories") {
      return (res.data.items || []).map(r => ({
        name: r.full_name,
        description: r.description || "",
        url: r.html_url,
        stars: r.stargazers_count,
        language: r.language || "unknown",
        updated: r.updated_at?.slice(0, 10),
        source: "github"
      }));
    }
    if (type === "code") {
      return (res.data.items || []).map(r => ({
        name: r.name,
        path: r.path,
        repo: r.repository?.full_name,
        url: r.html_url,
        snippet: r.text_matches?.[0]?.fragment || "",
        source: "github"
      }));
    }
    return (res.data.items || []).slice(0, num);
  } catch (e) {
    return [{ error: `GitHub search failed: ${e.message}` }];
  }
}

// ─── Smart web fetch with code extraction ─────────────────────────────────────
async function smartFetch(url, maxChars = 12000) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; attar-code/2.0)" },
      timeout: 15000,
      maxContentLength: 3 * 1024 * 1024,
    });
    const ct = res.headers["content-type"] || "";

    if (!ct.includes("text/html")) {
      return { url, text: String(res.data).slice(0, maxChars), type: "raw", codeBlocks: [] };
    }

    const $ = cheerio.load(res.data);
    $("script,style,nav,header,footer,iframe,noscript,.nav,.menu,.sidebar,.ad,.cookie,.banner").remove();

    // Extract code blocks separately
    const codeBlocks = [];
    $("pre code, pre, code").each((i, el) => {
      const code = $(el).text().trim();
      if (code.length > 20 && code.length < 5000) {
        const lang = $(el).attr("class")?.match(/language-(\w+)/)?.[1] || "";
        codeBlocks.push({ language: lang, code: code.slice(0, 2000) });
      }
    });

    // Extract main content
    const main = $("article,main,[role=main],.content,.post,.entry,.documentation,.docs-content,.markdown-body").first();
    let text = main.length ? main.text() : $("body").text();
    text = text.replace(/\n{3,}/g, "\n\n").replace(/\t/g, " ").replace(/ {3,}/g, " ").trim();

    return {
      url,
      text: text.slice(0, maxChars),
      type: "html",
      codeBlocks: codeBlocks.slice(0, 10),
      title: $("title").text().trim() || $("h1").first().text().trim(),
    };
  } catch (e) { return { url, error: e.message, codeBlocks: [] }; }
}

// ─── Deep research — search -> fetch top results -> extract ─────────────────────
async function deepResearch(query, numSearch = 5, numFetch = 2) {
  // Step 1: Search the web
  const searchResults = await webSearch(query, numSearch);
  if (!searchResults.length || searchResults[0]?.error) {
    return { query, error: "Search failed", results: [] };
  }

  // Step 2: Fetch the top N results for deeper content
  const fetchPromises = searchResults.slice(0, numFetch).map(r => {
    const url = r.url?.startsWith("http") ? r.url : `https://${r.url}`;
    return smartFetch(url, 6000).catch(() => null);
  });
  const fetched = (await Promise.all(fetchPromises)).filter(Boolean);

  // Step 3: Combine everything
  return {
    query,
    searchResults: searchResults.map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
    deepResults: fetched.map(f => ({
      url: f.url,
      title: f.title || "",
      summary: f.text?.slice(0, 2000) || "",
      codeExamples: (f.codeBlocks || []).slice(0, 3),
    })),
  };
}

// ══════════════════════════════════════════════════════════════════
// KB ENGINE HELPER
// ══════════════════════════════════════════════════════════════════

/**
 * Search the knowledge base using Qdrant via kb-engine.
 *
 * @param {string} query
 * @param {number} num   Max results
 * @returns {Promise<{ results: Array, engine: string }>}
 */
async function kbSearch(query, num = 5) {
  if (kbReady && kbEngine && kbEngine.retrieval) {
    try {
      const result = await kbEngine.retrieval.search(query, {}, { maxChunks: num });
      // Normalize to the same shape the CLI expects
      const results = (result.chunks || []).map((c, i) => ({
        rank:     i + 1,
        text:     c.content || "",
        source:   c.metadata?.source || "?",
        filename: c.metadata?.filename || "",
        score:    c.score != null ? Math.round(c.score * 1000) / 1000 : 0,
        collection: c.collection || "",
      }));
      return { results, engine: "qdrant" };
    } catch (e) {
      return { results: [], engine: "qdrant-error", error: e.message };
    }
  }

  return { results: [], engine: "unavailable", error: "KB engine not available. Ensure Qdrant is running." };
}


// ══════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════

// ─── Health ──────────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  const health = { ok: true, kb: KB_DIR, port: PORT, startTime: PROXY_START_TIME };

  if (kbReady && kbEngine) {
    try {
      const status = await kbEngine.getStatus();
      health.kb_engine = {
        ready: true,
        qdrant: status.qdrant,
        models: status.models,
        collections_count: (status.collections || []).length,
      };
    } catch (_) {
      health.kb_engine = { ready: true, error: "status check failed" };
    }
  } else {
    health.kb_engine = { ready: false, error: kbError || "not initialized" };
  }

  res.json(health);
});

// ─── Web search ──────────────────────────────────────────────────────────────
app.post("/search", async (req, res) => {
  const { query, num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const results = await webSearch(query, num);
  res.json({ query, results });
});

// ─── Web fetch ───────────────────────────────────────────────────────────────
app.post("/fetch", async (req, res) => {
  const { url, max_chars = 8000 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const result = await webFetch(url, max_chars);
  res.json(result);
});

// ─── KB search (backward compatible) ─────────────────────────────────────────
app.post("/kb/search", async (req, res) => {
  const { query, num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const result = await kbSearch(query, num);
  if (result.error && result.results.length === 0) {
    return res.status(500).json({ error: result.error });
  }
  res.json({ results: result.results, engine: result.engine });
});

// ─── KB add file (backward compatible) ───────────────────────────────────────
app.post("/kb/add", async (req, res) => {
  const { filepath } = req.body;
  if (!filepath) return res.status(400).json({ error: "filepath required" });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: `Not found: ${filepath}` });

  // Copy to KB directory structure
  const ext = path.extname(filepath).toLowerCase();
  const fname = path.basename(filepath);
  let dest = path.join(DOCS_DIR, fname);
  if (ext === ".pdf") dest = path.join(BOOKS_DIR, fname);
  else if ([".py",".js",".ts",".java",".go"].includes(ext)) dest = path.join(CODE_DIR, fname);
  if (path.resolve(filepath) !== path.resolve(dest)) fs.copyFileSync(filepath, dest);

  if (kbReady && kbEngine && kbEngine.ingestion) {
    try {
      const result = await kbEngine.ingestion.ingestFile(dest);
      return res.json({ filepath: dest, indexed: true, engine: "qdrant", data: result });
    } catch (e) {
      return res.status(500).json({ filepath: dest, indexed: false, error: e.message });
    }
  } else {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
});

// ─── KB add text (backward compatible) ───────────────────────────────────────
app.post("/kb/add-text", async (req, res) => {
  const { filename, content, type = "text" } = req.body;
  if (!filename || !content) return res.status(400).json({ error: "filename and content required" });
  const dest = path.join(DOCS_DIR, filename);
  fs.writeFileSync(dest, content, "utf-8");

  if (kbReady && kbEngine && kbEngine.ingestion) {
    try {
      const result = await kbEngine.ingestion.ingestFile(dest);
      return res.json({ filepath: dest, indexed: true, engine: "qdrant", data: result });
    } catch (e) {
      return res.status(500).json({ filepath: dest, indexed: false, error: e.message });
    }
  } else {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
});

// ─── KB list (backward compatible) ───────────────────────────────────────────
app.get("/kb/list", async (req, res) => {
  if (kbReady && kbEngine) {
    try {
      const stats = await kbEngine.collectionMgr.getAllStats();
      return res.json({
        engine: "qdrant",
        collections: stats,
        total_chunks: stats.reduce((sum, s) => sum + (s.points_count || 0), 0),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  } else {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
});

// ─── KB delete (backward compatible) ─────────────────────────────────────────
app.delete("/kb/delete/:docId", async (req, res) => {
  // Qdrant doesn't use doc IDs the same way — search and delete matching points
  if (kbReady && kbEngine) {
    try {
      const docId = req.params.docId;
      const { QdrantClient } = require("@qdrant/js-client-rest");
      const client = new QdrantClient({ url: kbEngine.config.QDRANT_URL, checkCompatibility: false });
      const collections = await kbEngine.collectionMgr.listCollections();
      let totalDeleted = 0;

      for (const col of collections) {
        try {
          // Delete points where filename matches the docId pattern
          const result = await client.delete(col, {
            filter: {
              should: [
                { key: "filename", match: { text: docId } },
                { key: "source", match: { text: docId } },
              ]
            },
            wait: true,
          });
          if (result && result.status === "completed") totalDeleted++;
        } catch (_) {}
      }

      return res.json({ deleted: totalDeleted, engine: "qdrant", doc_id: docId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  } else {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
});

// ─── KB delete collection ────────────────────────────────────────────────────
app.delete("/kb/collections/:name", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
  const name = req.params.name;
  try {
    await kbEngine.collectionMgr.deleteCollection(name);
    // Re-create it empty (so it's ready for new data)
    await kbEngine.collectionMgr.ensureCollection(name);
    return res.json({ deleted: true, collection: name, message: `Collection "${name}" cleared and re-created empty.` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── KB count (backward compatible) ──────────────────────────────────────────
app.get("/kb/count", async (req, res) => {
  if (kbReady && kbEngine) {
    try {
      const stats = await kbEngine.collectionMgr.getAllStats();
      const count = stats.reduce((sum, s) => sum + (s.points_count || 0), 0);
      return res.json({ count, engine: "qdrant", by_collection: stats.map(s => ({ name: s.name, count: s.points_count })) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  } else {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
});

// ─── KB reindex (backward compatible) ────────────────────────────────────────
app.post("/kb/reindex", async (req, res) => {
  if (kbReady && kbEngine && kbEngine.ingestion) {
    try {
      const results = [];
      for (const dir of [DOCS_DIR, BOOKS_DIR, CODE_DIR]) {
        const dirResults = await kbEngine.ingestion.ingestDirectory(dir);
        results.push(...dirResults);
      }
      const indexed = results.filter(r => !r.error).length;
      const failed  = results.filter(r => r.error).length;
      return res.json({ indexed, failed, engine: "qdrant", details: results });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  } else {
    return res.status(503).json({ error: "KB engine not available. Ensure Qdrant is running." });
  }
});

// ══════════════════════════════════════════════════════════════════
// NEW KB ENGINE ENDPOINTS
// ══════════════════════════════════════════════════════════════════

// ─── KB ingest file ──────────────────────────────────────────────────────────
app.post("/kb/ingest", async (req, res) => {
  if (!kbReady || !kbEngine || !kbEngine.ingestion) {
    return res.status(503).json({ error: "KB engine not available", fallback: "use POST /kb/add instead" });
  }

  const { filepath, collection, language, deep } = req.body;
  if (!filepath) return res.status(400).json({ error: "filepath required" });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: `Not found: ${filepath}` });

  // Keep-alive for long deep enrichment operations
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  const keepAlive = setInterval(() => {
    try { res.write(' '); } catch (_) { clearInterval(keepAlive); }
  }, 30000);

  try {
    const options = {};
    if (collection) options.collection = collection;
    if (language)   options.language = language;
    if (deep)       options.deep = true;
    const result = await kbEngine.ingestion.ingestFile(filepath, options);
    clearInterval(keepAlive);
    res.end(JSON.stringify({ ...result, engine: "qdrant", deep: !!deep }));
  } catch (e) {
    clearInterval(keepAlive);
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ─── KB ingest directory ─────────────────────────────────────────────────────
app.post("/kb/ingest-dir", async (req, res) => {
  if (!kbReady || !kbEngine || !kbEngine.ingestion) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  const { dirpath, collection, language, deep } = req.body;
  if (!dirpath) return res.status(400).json({ error: "dirpath required" });
  if (!fs.existsSync(dirpath)) return res.status(404).json({ error: `Not found: ${dirpath}` });

  // Keep-alive: send periodic newlines to prevent TCP connection reset
  // during long deep enrichment operations (can take 5-30 minutes)
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  const keepAlive = setInterval(() => {
    try { res.write(' '); } catch (_) { clearInterval(keepAlive); }
  }, 30000); // Every 30 seconds

  try {
    const options = {};
    if (collection) options.collection = collection;
    if (language)   options.language = language;
    if (deep)       options.deep = true;
    const results = await kbEngine.ingestion.ingestDirectory(dirpath, options);
    const indexed = results.filter(r => !r.error).length;
    const failed  = results.filter(r => r.error).length;
    clearInterval(keepAlive);
    res.end(JSON.stringify({ indexed, failed, engine: "qdrant", details: results }));
  } catch (e) {
    clearInterval(keepAlive);
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ─── KB ingest URL ───────────────────────────────────────────────────────────
app.post("/kb/ingest-url", async (req, res) => {
  if (!kbReady || !kbEngine || !kbEngine.ingestion) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  const { url, collection, filename, deep } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    // Fetch URL content
    const fetched = await smartFetch(url, 50000);
    if (fetched.error) return res.status(502).json({ error: `Failed to fetch URL: ${fetched.error}` });

    // Write to temp file
    const tmpName = filename || `url_${Date.now()}_${path.basename(url).replace(/[^a-zA-Z0-9._-]/g, "_") || "page"}.md`;
    const tmpPath = path.join(os.tmpdir(), tmpName);

    // Build markdown content from fetched data
    let content = "";
    if (fetched.title) content += `# ${fetched.title}\n\nSource: ${url}\n\n`;
    content += fetched.text || "";
    if (fetched.codeBlocks && fetched.codeBlocks.length > 0) {
      content += "\n\n## Code Examples\n\n";
      for (const block of fetched.codeBlocks) {
        content += "```" + (block.language || "") + "\n" + block.code + "\n```\n\n";
      }
    }

    fs.writeFileSync(tmpPath, content, "utf-8");

    const options = {};
    if (collection) options.collection = collection;
    if (deep)       options.deep = true;
    const result = await kbEngine.ingestion.ingestFile(tmpPath, options);

    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch (_) {}

    res.json({ ...result, url, engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KB recipe store ─────────────────────────────────────────────────────────
app.post("/kb/recipe/store", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  const { error_message, fix_description, code_before, code_after, language, framework, tags } = req.body;
  if (!error_message || !fix_description) {
    return res.status(400).json({ error: "error_message and fix_description required" });
  }

  try {
    // Build the recipe content for embedding
    let recipeContent = `Error: ${error_message}\n\nFix: ${fix_description}`;
    if (code_before) recipeContent += `\n\nBefore:\n${code_before}`;
    if (code_after)  recipeContent += `\n\nAfter:\n${code_after}`;

    const metadata = {
      error_message,
      fix_description,
      language:  language  || "unknown",
      framework: framework || "",
      doc_type:  "fix_recipe",
      source:    "user",
      tags:      Array.isArray(tags) ? tags.join(",") : (tags || ""),
      created:   new Date().toISOString(),
    };

    await kbEngine.store.ensureCollection("fix_recipes");
    const ids = await kbEngine.store.addChunks("fix_recipes", [{ content: recipeContent, metadata }]);

    res.json({ stored: true, id: ids[0], engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KB recipe search ────────────────────────────────────────────────────────
app.post("/kb/recipe/search", async (req, res) => {
  if (!kbReady || !kbEngine || !kbEngine.retrieval) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  const { query, num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  try {
    const result = await kbEngine.retrieval.searchFixRecipes(query);
    const results = (result.chunks || []).slice(0, num).map((c, i) => ({
      rank:     i + 1,
      text:     c.content || "",
      source:   c.metadata?.source || "user",
      error:    c.metadata?.error_message || "",
      fix:      c.metadata?.fix_description || "",
      language: c.metadata?.language || "",
      score:    c.score != null ? Math.round(c.score * 1000) / 1000 : 0,
    }));
    res.json({ results, engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// MEMORY ENDPOINTS — sync flat files to Qdrant, search memory archive
// ══════════════════════════════════════════════════════════════════

// ─── Memory sync (flush working.json extractions to Qdrant) ─────────────────
app.post("/memory/sync", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  const { extractions, sessionId, projectRoot } = req.body;
  if (!Array.isArray(extractions) || extractions.length === 0) {
    return res.status(400).json({ error: "extractions array required (non-empty)" });
  }

  try {
    await kbEngine.store.ensureCollection("memories");

    const chunks = extractions.map(e => ({
      content: e.content || "",
      metadata: {
        memory_type:    e.type || "project_fact",
        scope:          e.scope || "project",
        project:        projectRoot || "",
        source_session: sessionId || "",
        confidence:     1.0,
        created:        e.timestamp || new Date().toISOString(),
        last_validated: new Date().toISOString(),
        chunk_type:     "memory",
      },
    }));

    const ids = await kbEngine.store.addChunks("memories", chunks);
    res.json({ synced: ids.length, ids, engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Memory search (semantic search over archived memories) ─────────────────
app.post("/memory/search", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  const { query, num = 5, scope, project } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  try {
    // Build filter conditions
    const filter = [];
    filter.push({ key: "chunk_type", value: "memory" });
    if (scope)   filter.push({ key: "scope", value: scope });
    if (project) filter.push({ key: "project", value: project });

    const exists = await kbEngine.collectionMgr.collectionExists("memories");
    if (!exists) {
      return res.json({ results: [], engine: "qdrant", message: "No memories archived yet" });
    }

    const results = await kbEngine.store.hybridSearch("memories", query, {
      limit: num,
      filter,
    });

    const formatted = results.map((r, i) => ({
      rank:        i + 1,
      content:     r.content || "",
      type:        r.metadata?.memory_type || "unknown",
      scope:       r.metadata?.scope || "project",
      project:     r.metadata?.project || "",
      session:     r.metadata?.source_session || "",
      confidence:  r.metadata?.confidence || 0,
      created:     r.metadata?.created || "",
      score:       r.score != null ? Math.round(r.score * 1000) / 1000 : 0,
    }));

    res.json({ results: formatted, engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Memory list (get all memories for a project) ───────────────────────────
app.get("/memory/list", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.status(503).json({ error: "KB engine not available" });
  }

  try {
    const exists = await kbEngine.collectionMgr.collectionExists("memories");
    if (!exists) {
      return res.json({ memories: [], count: 0, engine: "qdrant" });
    }

    const info = await kbEngine.store.getChunkCount("memories");
    res.json({ count: info, engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KB collections ──────────────────────────────────────────────────────────
app.get("/kb/collections", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.status(503).json({ error: "KB engine not available", fallback: "use GET /kb/list instead" });
  }

  try {
    const stats = await kbEngine.collectionMgr.getAllStats();
    res.json({ collections: stats, engine: "qdrant" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KB status ───────────────────────────────────────────────────────────────
app.get("/kb/status", async (req, res) => {
  if (!kbReady || !kbEngine) {
    return res.json({
      ready: false,
      error: kbError || "KB engine not initialized",
    });
  }

  try {
    const status = await kbEngine.getStatus();
    res.json({
      ready: true,
      engine: "qdrant",
      qdrant: status.qdrant,
      models: status.models,
      collections: status.collections,
    });
  } catch (e) {
    res.json({ ready: true, error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════
// EXISTING NON-KB ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════

// Combined: search web + knowledge base simultaneously
app.post("/search-all", async (req, res) => {
  const { query, web_num = 3, kb_num = 3 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const [webResults, kbResult] = await Promise.all([
    webSearch(query, web_num),
    kbSearch(query, kb_num),
  ]);

  res.json({
    query,
    web:       webResults,
    knowledge: kbResult.results || [],
    kb_engine: kbResult.engine,
  });
});

// GitHub search
app.post("/github/search", async (req, res) => {
  const { query, type = "repositories", num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const results = await githubSearch(query, type, num);
  res.json({ query, type, results });
});

// GitHub code search (alias for type=code)
app.post("/github/code-search", async (req, res) => {
  const { query, num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const results = await githubSearch(query, "code", num);
  res.json({ query, type: "code", results });
});

// Smart fetch with code extraction
app.post("/smart-fetch", async (req, res) => {
  const { url, max_chars = 12000 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const result = await smartFetch(url, max_chars);
  res.json(result);
});

// Deep research — search + fetch + extract
app.post("/research", async (req, res) => {
  const { query, num_search = 5, num_fetch = 2 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const result = await deepResearch(query, num_search, num_fetch);
  res.json(result);
});

// Comprehensive multi-source search
app.post("/search-multi", async (req, res) => {
  const { query, sources = ["web", "kb", "github"], web_num = 3, kb_num = 3, github_num = 3 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const promises = [];
  if (sources.includes("web"))    promises.push(webSearch(query, web_num).then(r => ({ source: "web", results: r })));
  if (sources.includes("kb"))     promises.push(kbSearch(query, kb_num).then(r => ({ source: "kb", results: r.results || [] })));
  if (sources.includes("github")) promises.push(githubSearch(query, "repositories", github_num).then(r => ({ source: "github", results: r })));

  const results = await Promise.all(promises);
  const combined = {};
  for (const r of results) combined[r.source] = r.results;
  res.json({ query, ...combined });
});

// ─── Environment Version Resolution ──────────────────────────────────────────

let _versionResolver;
try {
  const { VersionResolver } = require("./plugins/version-resolver");
  _versionResolver = new VersionResolver({ proxyUrl: null }); // proxy IS this server, use direct fetch
} catch { _versionResolver = null; }

// POST /env/versions — Batch resolve package versions from registries
app.post("/env/versions", async (req, res) => {
  if (!_versionResolver) return res.status(503).json({ error: "Version resolver not available" });
  const { packages } = req.body; // [{ registry: 'npm', pkg: 'express' }, ...]
  if (!Array.isArray(packages)) return res.status(400).json({ error: "packages must be an array" });
  try {
    const results = await _versionResolver.resolveAll(packages);
    res.json({ versions: results, cached: Object.keys(_versionResolver.getAllCached()).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /env/versions/cache — Return current version cache
app.get("/env/versions/cache", (req, res) => {
  if (!_versionResolver) return res.status(503).json({ error: "Version resolver not available" });
  const cached = _versionResolver.getAllCached();
  const entries = {};
  for (const [key, val] of Object.entries(cached)) {
    entries[key] = { version: val.version, age: Math.round((Date.now() - val.timestamp) / 60000) + "m" };
  }
  res.json({ entries, count: Object.keys(entries).length });
});

// POST /env/versions/refresh — Force refresh cached entries
app.post("/env/versions/refresh", async (req, res) => {
  if (!_versionResolver) return res.status(503).json({ error: "Version resolver not available" });
  try {
    const count = await _versionResolver.refreshAll();
    res.json({ refreshed: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551   * attar-code search-proxy  :${PORT}               \u2551
\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d

Knowledge base: ${KB_DIR}
  docs/   -> ${DOCS_DIR}
  books/  -> ${BOOKS_DIR}
  code/   -> ${CODE_DIR}

Routes (existing):
  POST /search           -- web search (DuckDuckGo)
  POST /fetch            -- fetch & clean any URL
  POST /kb/search        -- semantic search in knowledge base
  POST /kb/add           -- add file to knowledge base
  POST /kb/add-text      -- add text content to knowledge base
  GET  /kb/list          -- list indexed documents / collections
  GET  /kb/count         -- total chunk count
  DELETE /kb/delete/:id  -- delete document from KB
  POST /kb/reindex       -- re-index all files in kb folders
  POST /search-all       -- web + knowledge base combined
  POST /search-multi     -- multi-source search (web + kb + github)
  POST /github/search    -- search GitHub repos
  POST /github/code-search -- search GitHub code
  POST /smart-fetch      -- fetch URL with code extraction
  POST /research         -- deep research (search + fetch + extract)
  GET  /health           -- health check

Routes (new -- kb-engine):
  POST /kb/ingest        -- ingest file via kb-engine
  POST /kb/ingest-dir    -- ingest directory recursively
  POST /kb/ingest-url    -- fetch URL and ingest content
  POST /kb/recipe/store  -- store a fix recipe
  POST /kb/recipe/search -- search fix recipes
  GET  /kb/collections   -- list all Qdrant collections + stats
  GET  /kb/status        -- KB engine status (Qdrant + models)

Set SEARX_URL env var to use your own SearXNG instance.
`);

  // ─── Initialize KB Engine ──────────────────────────────────────────────────
  try {
    const { KBEngine } = require("./kb-engine");
    kbEngine = new KBEngine();
    console.log("  Starting KB engine (Qdrant)...");
    const status = await kbEngine.start();
    kbReady = true;
    console.log("  KB engine ready!");
    console.log(`    Qdrant: ${status.qdrant?.running ? "running" : "not running"} (managed: ${status.qdrant?.managedByUs || false})`);
    console.log(`    Models: code=${status.models?.codeModel || false}, text=${status.models?.textModel || false}`);
    console.log(`    Collections: ${(status.collections || []).length}`);
  } catch (e) {
    kbError = e.message;
    kbReady = false;
    console.log(`  KB engine failed to start: ${e.message}`);
    console.log("  KB features will be unavailable. Ensure Qdrant is running.");
  }

  // ─── Index existing KB files ─────────────────────────────────────────────
  if (kbReady && kbEngine && kbEngine.ingestion) {
    // Check if there are already points in any collection
    try {
      const stats = await kbEngine.collectionMgr.getAllStats();
      const totalPoints = stats.reduce((sum, s) => sum + (s.points_count || 0), 0);
      if (totalPoints === 0) {
        console.log("  Indexing knowledge base files with kb-engine...");
        let totalIndexed = 0, totalFailed = 0;
        for (const dir of [DOCS_DIR, BOOKS_DIR, CODE_DIR]) {
          try {
            const results = await kbEngine.ingestion.ingestDirectory(dir);
            totalIndexed += results.filter(r => !r.error).length;
            totalFailed  += results.filter(r => r.error).length;
          } catch (_) {}
        }
        console.log(`  Indexed: ${totalIndexed} files, Failed: ${totalFailed}`);
      } else {
        console.log(`  Knowledge base: ${totalPoints} chunks across ${stats.length} collections`);
      }
    } catch (e) {
      console.log(`  Auto-index check failed: ${e.message}`);
    }
  }
});
