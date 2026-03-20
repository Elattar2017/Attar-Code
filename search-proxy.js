#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║   attar-code search-proxy — localhost:3001                        ║
// ║   Web search + fetch + local knowledge base (vector search)      ║
// ║   npm install express axios cheerio pdf-parse                    ║
// ║   pip install chromadb sentence-transformers                     ║
// ╚══════════════════════════════════════════════════════════════════╝

const express  = require("express");
const axios    = require("axios");
const cheerio  = require("cheerio");
const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const { execSync, spawn } = require("child_process");

const app  = express();
const PORT = 3001;
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

// ─── Chroma Python bridge ─────────────────────────────────────────────────────
const CHROMA_SCRIPT = path.join(__dirname, "chroma_bridge.py");

const chromaPy = `
import sys, json, os
try:
    import chromadb
    from chromadb.utils import embedding_functions
except ImportError:
    print(json.dumps({"error": "chromadb not installed. Run: pip install chromadb sentence-transformers"}))
    sys.exit(1)

KB_DIR    = os.path.expanduser("~/.attar-code/knowledge")
INDEX_DIR = os.path.join(KB_DIR, ".index")
os.makedirs(INDEX_DIR, exist_ok=True)

try:
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
except Exception:
    ef = embedding_functions.DefaultEmbeddingFunction()

client = chromadb.PersistentClient(path=INDEX_DIR)
try:
    col = client.get_or_create_collection("knowledge", embedding_function=ef)
except ValueError:
    client.delete_collection("knowledge")
    col = client.get_or_create_collection("knowledge", embedding_function=ef)
cmd    = sys.argv[1] if len(sys.argv) > 1 else ""

if cmd == "add":
    doc_id  = sys.argv[2]
    content = sys.stdin.read()
    meta    = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    words   = content.split()
    size    = 256
    overlap = 50
    step    = size - overlap
    chunks  = [" ".join(words[i:i+size]) for i in range(0, len(words), step) if " ".join(words[i:i+size]).strip()]
    if not chunks:
        print(json.dumps({"added": 0}))
        sys.exit(0)
    ids   = [f"{doc_id}_chunk_{i}" for i in range(len(chunks))]
    metas = [{**meta, "chunk": i, "doc_id": doc_id} for i in range(len(chunks))]
    col.upsert(documents=chunks, ids=ids, metadatas=metas)
    print(json.dumps({"added": len(chunks), "doc_id": doc_id}))

elif cmd == "search":
    query   = sys.argv[2]
    n       = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    cnt     = col.count()
    if cnt == 0:
        print(json.dumps({"results": [], "note": "knowledge base is empty"}))
        sys.exit(0)
    results = col.query(query_texts=[query], n_results=min(n, cnt))
    docs    = results.get("documents", [[]])[0]
    metas   = results.get("metadatas", [[]])[0]
    dists   = results.get("distances",  [[]])[0]
    out     = [{"rank": i+1, "text": d, "source": m.get("source","?"), "filename": m.get("filename",""), "score": round(1-dist,3)} for i,(d,m,dist) in enumerate(zip(docs,metas,dists))]
    print(json.dumps({"results": out}))

elif cmd == "list":
    all_items = col.get()
    metas     = all_items.get("metadatas", [])
    seen, out = set(), []
    for m in metas:
        did = m.get("doc_id","")
        if did not in seen:
            seen.add(did)
            out.append({"doc_id": did, "filename": m.get("filename",""), "source": m.get("source",""), "type": m.get("type","")})
    print(json.dumps({"docs": out, "total_chunks": len(metas)}))

elif cmd == "delete":
    doc_id  = sys.argv[2]
    all_ids = col.get()["ids"]
    to_del  = [i for i in all_ids if i.startswith(doc_id + "_chunk_")]
    if to_del:
        col.delete(ids=to_del)
    print(json.dumps({"deleted": len(to_del)}))

elif cmd == "count":
    print(json.dumps({"count": col.count()}))

else:
    print(json.dumps({"error": "unknown command: " + cmd}))
`;

fs.writeFileSync(CHROMA_SCRIPT, chromaPy);

function runChroma(args, stdin = "") {
  return new Promise((resolve) => {
    try {
      const proc = spawn("python3", [CHROMA_SCRIPT, ...args], { stdio: ["pipe","pipe","pipe"] });
      let out = "", err = "";
      if (stdin) proc.stdin.write(stdin);
      proc.stdin.end();
      proc.stdout.on("data", d => out += d);
      proc.stderr.on("data", d => err += d);
      proc.on("close", () => {
        try { resolve({ ok: true, data: JSON.parse(out) }); }
        catch (_) { resolve({ ok: false, error: err || out || "no output" }); }
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// ─── PDF extractor ────────────────────────────────────────────────────────────
async function extractPdf(filepath) {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(fs.readFileSync(filepath));
    return data.text;
  } catch (_) {
    try { return execSync(`pdftotext "${filepath}" -`, { encoding:"utf-8", timeout:30000 }); }
    catch (e) { return `[PDF extraction failed: ${e.message}]`; }
  }
}

// ─── Index file ───────────────────────────────────────────────────────────────
async function indexFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const filename = path.basename(filepath);
  const docId = filename.replace(/[^a-zA-Z0-9_-]/g, "_");
  let content = "", type = "text";

  if (ext === ".pdf") { content = await extractPdf(filepath); type = "pdf"; }
  else { content = fs.readFileSync(filepath, "utf-8"); type = ext.slice(1) || "text"; }

  if (!content.trim()) return { skipped: true, reason: "empty" };

  const meta = JSON.stringify({ source: filepath, filename, type, indexed: new Date().toISOString() });
  return runChroma(["add", docId, meta], content);
}

// ─── Index all ────────────────────────────────────────────────────────────────
async function indexAll() {
  const supported = [".md",".txt",".rst",".pdf",".py",".js",".ts",".java",".go",".rb",".cpp",".c",".html"];
  let indexed = 0, failed = 0;
  for (const dir of [DOCS_DIR, BOOKS_DIR, CODE_DIR]) {
    for (const file of fs.readdirSync(dir).filter(f => supported.includes(path.extname(f).toLowerCase()))) {
      try { await indexFile(path.join(dir, file)); indexed++; }
      catch (e) { console.error(`  Failed: ${file}: ${e.message}`); failed++; }
    }
  }
  return { indexed, failed };
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

// ─── Deep research — search → fetch top results → extract ─────────────────────
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
// ROUTES
// ══════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => res.json({ ok: true, kb: KB_DIR, port: PORT }));

app.post("/search", async (req, res) => {
  const { query, num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const results = await webSearch(query, num);
  res.json({ query, results });
});

app.post("/fetch", async (req, res) => {
  const { url, max_chars = 8000 } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const result = await webFetch(url, max_chars);
  res.json(result);
});

app.post("/kb/search", async (req, res) => {
  const { query, num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const result = await runChroma(["search", query, String(num)]);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json(result.data);
});

app.post("/kb/add", async (req, res) => {
  const { filepath } = req.body;
  if (!filepath) return res.status(400).json({ error: "filepath required" });
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: `Not found: ${filepath}` });

  const ext = path.extname(filepath).toLowerCase();
  const fname = path.basename(filepath);
  let dest = path.join(DOCS_DIR, fname);
  if (ext === ".pdf") dest = path.join(BOOKS_DIR, fname);
  else if ([".py",".js",".ts",".java",".go"].includes(ext)) dest = path.join(CODE_DIR, fname);

  if (path.resolve(filepath) !== path.resolve(dest)) fs.copyFileSync(filepath, dest);

  const result = await indexFile(dest);
  res.json({ filepath: dest, indexed: result.ok, data: result.data });
});

app.post("/kb/add-text", async (req, res) => {
  const { filename, content, type = "text" } = req.body;
  if (!filename || !content) return res.status(400).json({ error: "filename and content required" });
  const dest = path.join(DOCS_DIR, filename);
  fs.writeFileSync(dest, content, "utf-8");
  const result = await indexFile(dest);
  res.json({ filepath: dest, indexed: result.ok });
});

app.get("/kb/list", async (req, res) => {
  const result = await runChroma(["list"]);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json(result.data);
});

app.delete("/kb/delete/:docId", async (req, res) => {
  const result = await runChroma(["delete", req.params.docId]);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json(result.data);
});

app.get("/kb/count", async (req, res) => {
  const result = await runChroma(["count"]);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json(result.data);
});

app.post("/kb/reindex", async (req, res) => {
  const result = await indexAll();
  res.json(result);
});

// Combined: search web + knowledge base simultaneously
app.post("/search-all", async (req, res) => {
  const { query, web_num = 3, kb_num = 3 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const [webResults, kbResult] = await Promise.all([
    webSearch(query, web_num),
    runChroma(["search", query, String(kb_num)]),
  ]);

  res.json({
    query,
    web:  webResults,
    knowledge: kbResult.ok ? (kbResult.data.results || []) : [],
  });
});

// GitHub search
app.post("/github/search", async (req, res) => {
  const { query, type = "repositories", num = 5 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  const results = await githubSearch(query, type, num);
  res.json({ query, type, results });
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
  if (sources.includes("kb"))     promises.push(runChroma(["search", query, String(kb_num)]).then(r => ({ source: "kb", results: r.ok ? (r.data.results || []) : [] })));
  if (sources.includes("github")) promises.push(githubSearch(query, "repositories", github_num).then(r => ({ source: "github", results: r })));

  const results = await Promise.all(promises);
  const combined = {};
  for (const r of results) combined[r.source] = r.results;
  res.json({ query, ...combined });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║   ✦ attar-code search-proxy  :${PORT}               ║
╚═══════════════════════════════════════════════════╝

Knowledge base: ${KB_DIR}
  📄 docs/   → ${DOCS_DIR}
  📕 books/  → ${BOOKS_DIR}
  💻 code/   → ${CODE_DIR}

Routes:
  POST /search         — web search (DuckDuckGo)
  POST /fetch          — fetch & clean any URL
  POST /kb/search      — semantic search in knowledge base
  POST /kb/add         — add file to knowledge base
  POST /search-all     — web + knowledge base combined
  POST /github/search    — search GitHub repos & code
  POST /smart-fetch      — fetch URL with code extraction
  POST /research         — deep research (search + fetch + extract)
  POST /search-multi     — multi-source search (web + kb + github)
  GET  /kb/list        — list indexed documents
  POST /kb/reindex     — re-index all files in kb folders
  GET  /health         — health check

Set SEARX_URL env var to use your own SearXNG instance.
`);

  // Index any files already in the knowledge base
  const count = await runChroma(["count"]);
  const n = count.ok ? count.data.count : 0;

  if (n === 0) {
    console.log("  Indexing knowledge base files...");
    const res = await indexAll();
    console.log(`  Indexed: ${res.indexed} files, Failed: ${res.failed}`);
  } else {
    console.log(`  Knowledge base: ${n} chunks indexed`);
  }
});
