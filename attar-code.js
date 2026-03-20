#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║   attar-code v2 — Local AI CLI (Claude Code Edition)             ║
// ║   Works with any Ollama model                                    ║
// ║   node attar-code.js                                              ║
// ╚══════════════════════════════════════════════════════════════════╝

const readline = require("readline");
const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const crypto   = require("crypto");
const { execSync, spawn } = require("child_process");

// ══════════════════════════════════════════════════════════════════
// ANSI
// ══════════════════════════════════════════════════════════════════
const C = {
  reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m", italic:"\x1b[3m",
  under:"\x1b[4m",
  black:"\x1b[30m", red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m",
  blue:"\x1b[34m", magenta:"\x1b[35m", cyan:"\x1b[36m", white:"\x1b[37m",
  gray:"\x1b[90m",
  bRed:"\x1b[91m", bGreen:"\x1b[92m", bYellow:"\x1b[93m", bBlue:"\x1b[94m",
  bMagenta:"\x1b[95m", bCyan:"\x1b[96m", bWhite:"\x1b[97m",
  bgBlack:"\x1b[40m", bgRed:"\x1b[41m", bgGreen:"\x1b[42m", bgBlue:"\x1b[44m",
};
const W = () => process.stdout.columns || 80;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad   = (s, n) => s + " ".repeat(Math.max(0, n - strip(s).length));
const hr    = (ch="─", col=C.gray) => col + ch.repeat(W()) + C.reset;
const co    = (...p) => p.join("") + C.reset;

// ══════════════════════════════════════════════════════════════════
// CONFIG & PATHS
// ══════════════════════════════════════════════════════════════════
const HOME_DIR      = path.join(os.homedir(), ".attar-code");
const CONFIG_FILE   = path.join(HOME_DIR, "config.json");
const SESSIONS_DIR  = path.join(HOME_DIR, "sessions");
const CHECKPOINTS_DIR = path.join(HOME_DIR, "checkpoints");
const CMDS_DIR      = path.join(HOME_DIR, "commands");
const MEMORY_FILE   = path.join(HOME_DIR, "MEMORY.md");

for (const d of [HOME_DIR, SESSIONS_DIR, CHECKPOINTS_DIR, CMDS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const DEBUG = process.env.ATTAR_CODE_DEBUG === "1";
function debugLog(...args) { if (DEBUG) console.error("[DEBUG]", ...args); }

const DEFAULT_CONFIG = {
  model:        null,  // auto-detect from Ollama on first run
  ollamaUrl:    "http://localhost:11434",
  temperature:  0.7,
  numCtx:       32768,
  systemPrompt: `You are a powerful local AI coding assistant with tools. You complete tasks by calling tools — don't just describe what you would do, DO it.

TOOL SELECTION — always use the RIGHT tool:
- Reading files: use read_file (NOT run_bash with cat/head/tail)
- Editing existing files: use edit_file (NOT write_file to overwrite everything)
- Creating new files: use write_file
- Searching file contents: use grep_search (NOT run_bash with grep)
- Finding files by name: use find_files
- Shell commands (git, npm, tests, install, mkdir, rm, curl): use run_bash
- Starting servers: use start_server (NOT run_bash for long-running processes)
- Web research: use web_search to find results, then web_fetch to read specific pages
- Local documents/books/notes: use kb_search
- Creating PDF/Word/Excel/PowerPoint: use the create_* tools

WORKFLOW RULES:
1. ALWAYS read a file BEFORE editing it with edit_file — you need the exact text to match.
2. When building a project with multiple files: create ALL files one by one. Do NOT stop after one or two files.
3. After an error: read the error, understand what went wrong, try a DIFFERENT approach. Never retry the exact same failed command.
4. When given a file as input (in [FILE:] tags): use its content as context. If asked to summarize it, read it and write the summary.
5. Prefer edit_file over write_file for modifying existing files.
6. For web research: web_search first, then web_fetch on the best 1-2 URLs.
7. For local documents: kb_search when user says "my docs/notes/books". web_search for general internet info.

RESPONSE STYLE:
- Keep text responses concise (1-3 sentences)
- Greetings/simple questions: text only, no tools
- Coding tasks: call tools immediately, don't explain first
- After completing work: briefly summarize what was done

ERROR HANDLING:
- run_bash fails: read error, adjust command or approach
- edit_file fails: read_file to see actual content, retry with correct text
- File not found: use find_files to locate it
- Never retry the same failed command — try something different`,
  autoApprove:  false,
  theme:        "dark",
  historySize:  50,
  proxyUrl:     "http://localhost:3001",   // search-proxy server
};

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) }; }
  catch (_) { return { ...DEFAULT_CONFIG }; }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
}

let CONFIG = loadConfig();

// ══════════════════════════════════════════════════════════════════
// SESSION STATE
// ══════════════════════════════════════════════════════════════════
let SESSION = {
  id:          crypto.randomBytes(4).toString("hex"),
  name:        null,
  messages:    [],
  cwd:         process.cwd(),
  startTime:   Date.now(),
  toolCount:   0,
  checkpoints: [],        // array of { id, label, files: {path: content} }
  todoList:    [],        // [{id, text, done}]
  planMode:    false,
  plan:        null,
};

// ══════════════════════════════════════════════════════════════════
// PERMISSION SYSTEM
// ══════════════════════════════════════════════════════════════════
// Commands that are always safe (auto-approved)
const SAFE_CMDS = new Set([
  "ls","cat","pwd","echo","which","whoami","date","uname","df","du",
  "git status","git log","git diff","git branch","grep","find","head",
  "tail","wc","tree","lsof","ps","env","printenv","node --version",
  "python3 --version","npm --version","git --version",
]);

function isSafeCommand(cmd) {
  const base = cmd.trim().split(/\s+/).slice(0,2).join(" ");
  if (SAFE_CMDS.has(base)) return true;
  if (SAFE_CMDS.has(cmd.trim().split(" ")[0])) return true;
  // read-only git commands
  if (/^git (status|log|diff|show|branch|tag|remote -v)/.test(cmd)) return true;
  return false;
}

let pendingApproval = null; // resolves when user types y/n

async function askPermission(toolName, detail) {
  return new Promise((resolve) => {
    if (CONFIG.autoApprove || isSafeCommand(detail)) { resolve(true); return; }
    console.log();
    console.log(co(C.bgRed, C.bWhite, " ⚠ PERMISSION REQUEST ") + co(C.dim, " Tool: ") + co(C.bold, toolName));
    console.log(co(C.dim, "  Command: ") + co(C.yellow, String(detail).slice(0, 120)));
    process.stdout.write(co(C.bYellow, "  Allow? [y/N/always] ") + C.reset);
    pendingApproval = resolve;
  });
}

// ══════════════════════════════════════════════════════════════════
// CHECKPOINT SYSTEM (like Claude Code's /rewind)
// ══════════════════════════════════════════════════════════════════
function createCheckpoint(label) {
  const id    = `cp_${Date.now()}`;
  const files = {};

  // Snapshot all recently touched files
  const recentFiles = getRecentFiles();
  for (const fp of recentFiles) {
    try { files[fp] = fs.readFileSync(fp, "utf-8"); } catch (_) {}
  }

  const cp = {
    id, label: label || `checkpoint-${SESSION.checkpoints.length + 1}`,
    time: new Date().toISOString(), files,
    messageCount: SESSION.messages.length,
    cwd: SESSION.cwd,
  };

  SESSION.checkpoints.push(cp);

  // Save to disk
  const cpFile = path.join(CHECKPOINTS_DIR, `${id}.json`);
  fs.writeFileSync(cpFile, JSON.stringify(cp, null, 2));

  return cp;
}

function rewindToCheckpoint(indexOrId) {
  if (SESSION.checkpoints.length === 0) return null;

  let cp;
  if (typeof indexOrId === "number") {
    cp = SESSION.checkpoints[SESSION.checkpoints.length - 1 - indexOrId];
  } else {
    cp = SESSION.checkpoints.find(c => c.id === indexOrId);
  }
  if (!cp) return null;

  // Restore files
  for (const [fp, content] of Object.entries(cp.files)) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, "utf-8");
    } catch (_) {}
  }

  // Restore conversation
  SESSION.messages = SESSION.messages.slice(0, cp.messageCount);
  SESSION.cwd = cp.cwd;

  return cp;
}

// Track which files Claude has touched in this session
const touchedFiles = new Set();
function getRecentFiles() { return [...touchedFiles].slice(-20); }
function trackFile(fp) { touchedFiles.add(fp); }

// ══════════════════════════════════════════════════════════════════
// TODO / TASK SYSTEM (like Claude Code's TodoWrite/TodoRead)
// ══════════════════════════════════════════════════════════════════
function addTodo(text) {
  const id = SESSION.todoList.length + 1;
  SESSION.todoList.push({ id, text, done: false, created: new Date().toISOString() });
  return id;
}
function doneTodo(id) {
  const t = SESSION.todoList.find(t => t.id === id);
  if (t) t.done = true;
  return t;
}
function printTodos() {
  if (SESSION.todoList.length === 0) { console.log(co(C.dim, "  No tasks.")); return; }
  for (const t of SESSION.todoList) {
    const check = t.done ? co(C.bGreen, "✓") : co(C.dim, "○");
    const text  = t.done ? co(C.dim, t.text) : t.text;
    console.log(`  ${check} ${co(C.dim, String(t.id).padStart(2))}  ${text}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// MEMORY SYSTEM (like Claude Code's CLAUDE.md)
// ══════════════════════════════════════════════════════════════════
function readMemory() {
  // Global memory
  let mem = "";
  try { mem += fs.readFileSync(MEMORY_FILE, "utf-8") + "\n"; } catch (_) {}
  // Project memory (LAMA.md in cwd)
  const localMem = path.join(SESSION.cwd, "LAMA.md");
  try { mem += fs.readFileSync(localMem, "utf-8"); } catch (_) {}
  return mem.trim();
}

function writeMemory(content, scope = "global") {
  if (scope === "global") {
    fs.writeFileSync(MEMORY_FILE, content, "utf-8");
  } else {
    fs.writeFileSync(path.join(SESSION.cwd, "LAMA.md"), content, "utf-8");
  }
}

// ══════════════════════════════════════════════════════════════════
// CUSTOM SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════
function loadCustomCommands() {
  const cmds = {};
  // Global commands
  try {
    for (const f of fs.readdirSync(CMDS_DIR)) {
      if (f.endsWith(".md")) {
        const name = "/" + f.replace(".md","");
        cmds[name] = fs.readFileSync(path.join(CMDS_DIR, f), "utf-8");
      }
    }
  } catch (_) {}
  // Project commands (.lama/commands/)
  const localCmdsDir = path.join(SESSION.cwd, ".lama", "commands");
  try {
    for (const f of fs.readdirSync(localCmdsDir)) {
      if (f.endsWith(".md")) {
        const name = "/" + f.replace(".md","");
        cmds[name] = fs.readFileSync(path.join(localCmdsDir, f), "utf-8");
      }
    }
  } catch (_) {}
  return cmds;
}

// ══════════════════════════════════════════════════════════════════
// TOOLS
// ══════════════════════════════════════════════════════════════════
const TOOLS = [
  // ── Core Primitives ──────────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "run_bash",
      description: `Run any shell command. This is your most versatile tool — use it for everything that doesn't have a dedicated tool.

USE FOR: git (status, add, commit, push, log, diff, branch, checkout), package management (npm install, pip install, yarn add, cargo add), running tests (npm test, pytest, go test, jest), running scripts (python3 script.py, node script.js), creating directories (mkdir -p), deleting files (rm), checking ports (lsof -i :PORT), installing dependencies, running builds (npm run build, tsc), docker, testing APIs with curl.

DO NOT USE FOR: reading files (use read_file), editing files (use edit_file), creating files with content (use write_file), searching inside files (use grep_search), finding files (use find_files), fetching web pages (use web_fetch).

RULES: Use absolute paths. Quote paths with spaces. Chain commands with &&. If a command fails, try a DIFFERENT approach. For long-running servers, use start_server instead.`,
      parameters: { type:"object", properties: {
        command: { type:"string", description:"Shell command to execute" },
        cwd:     { type:"string", description:"Override working directory (optional)" }
      }, required:["command"] }
    }
  },
  {
    type: "function", function: {
      name: "read_file",
      description: `Read the contents of any file. Automatically handles different formats: source code, plain text, PDF (.pdf), Word (.docx), and Excel (.xlsx/.xls).

USE FOR: reading source code before editing (REQUIRED before edit_file), reading config files, reading PDFs, reading Word docs, reading Excel spreadsheets, examining any file.

DO NOT USE FOR: searching across many files (use grep_search), finding files by name (use find_files).

RULES: You MUST read a file BEFORE editing it with edit_file. For large files (1000+ lines), use offset and limit. Results include line numbers.`,
      parameters: { type:"object", properties: {
        filepath:  { type:"string", description:"Path to the file to read" },
        offset: { type:"number", description:"Line number to start reading from (for large files)" },
        limit:   { type:"number", description:"Number of lines to read (for large files)" }
      }, required:["filepath"] }
    }
  },
  {
    type: "function", function: {
      name: "write_file",
      description: `Create a new file or completely overwrite an existing file with new content.

USE FOR: creating new source code files, config files, any new file that doesn't exist yet, or completely rewriting a file.

DO NOT USE FOR: making small changes to existing files (use edit_file instead — it's safer, preserves the rest of the file).

RULES: PREFER edit_file for existing files. Include complete working content, not placeholders. Create parent directories first with run_bash mkdir -p if needed.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Path for the new file" },
        content:  { type:"string", description:"Complete file content" }
      }, required:["filepath","content"] }
    }
  },
  {
    type: "function", function: {
      name: "edit_file",
      description: `Replace a specific text string in an existing file. This is the PREFERRED way to modify files — only changes what you specify, preserves everything else.

USE FOR: fixing bugs, adding code, changing imports, updating config values, any change to an existing file.

DO NOT USE FOR: creating new files (use write_file), complete rewrites (use write_file).

RULES: MUST read_file FIRST to see actual content. old_str must match EXACTLY including whitespace/indentation. old_str must be UNIQUE in the file — include more context if not. If it fails, read_file again and retry with correct text.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Path to the file to edit" },
        old_str:  { type:"string", description:"Exact text currently in the file to replace (must be unique)" },
        new_str:  { type:"string", description:"New text to replace old_str with (must be different)" }
      }, required:["filepath","old_str","new_str"] }
    }
  },
  {
    type: "function", function: {
      name: "grep_search",
      description: `Search file contents using regex patterns. Returns matching lines with file paths and line numbers.

USE FOR: finding where functions/variables are defined, finding all usages across the project, searching for error messages, finding TODOs, locating imports.

DO NOT USE FOR: finding files by name (use find_files), reading a known file (use read_file), searching the web (use web_search).

RULES: Use simple patterns first. After finding a match, use read_file to see full context around the line.`,
      parameters: { type:"object", properties: {
        pattern:     { type:"string", description:"Regex pattern to search for" },
        dirpath:     { type:"string", description:"Directory to search in (default: cwd)" },
        include:     { type:"string", description:"File extension filter e.g. '*.js' or '*.py'" },
        max_results: { type:"number", description:"Max results (default 20)" }
      }, required:["pattern"] }
    }
  },
  {
    type: "function", function: {
      name: "find_files",
      description: `Find files matching a glob pattern. Returns file paths sorted by modification time.

USE FOR: finding all JS files (**/*.js), test files (**/*.test.js), config files (**/package.json), files by name (**/server.js).

DO NOT USE FOR: searching inside files (use grep_search), reading files (use read_file).`,
      parameters: { type:"object", properties: {
        pattern:  { type:"string", description:"Glob pattern e.g. '**/*.js' or 'src/**/*.ts'" },
        dirpath:  { type:"string", description:"Directory to search in (default: cwd)" }
      }, required:["pattern"] }
    }
  },
  {
    type: "function", function: {
      name: "get_project_structure",
      description: `Get the complete file/directory tree of the current project. Skips node_modules, .git, dist, build, __pycache__, etc.

USE FOR: understanding project layout, finding where files are organized, getting an overview before making changes. Use as FIRST step in unfamiliar projects.`,
      parameters: { type:"object", properties: {
        dirpath: { type:"string", description:"Directory (default: cwd)" },
        depth:   { type:"number", description:"Max depth (default 4)" }
      }}
    }
  },

  // ── Process Management ──────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "start_server",
      description: `Start a long-running process in the background (dev servers, Docker containers). The process continues running after the tool returns.

USE FOR: starting dev servers (npm run dev, python app.py, go run main.go), Docker containers.

DO NOT USE FOR: commands that finish quickly (builds, tests, installs) — use run_bash instead.

RULES: After starting, test with run_bash: curl http://localhost:PORT. If port is in use, check with run_bash: lsof -i :PORT.`,
      parameters: { type:"object", properties: {
        command: { type:"string", description:"Command to start server" },
        port:    { type:"number", description:"Port the server will listen on" },
        cwd:     { type:"string", description:"Working directory" }
      }, required:["command"] }
    }
  },

  // ── Web & Research ──────────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "web_search",
      description: `Search the web using DuckDuckGo. Returns titles, URLs, and text snippets. No API key needed.

USE FOR: finding documentation/tutorials, researching libraries/APIs, looking up error messages, finding implementation examples, getting current information.

DO NOT USE FOR: searching LOCAL documents/knowledge base (use kb_search), reading a URL you already have (use web_fetch), searching project files (use grep_search).

WORKFLOW: After getting results, use web_fetch on the most relevant 1-2 URLs to read full content. Don't fetch all results. If results aren't good, try different keywords.`,
      parameters: { type:"object", properties: {
        query: { type:"string", description:"Search query — be specific" },
        num:   { type:"number", description:"Number of results (default 5)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "web_fetch",
      description: `Fetch a URL and return clean readable text plus code examples. Strips HTML noise (nav, ads, sidebars). Extracts code blocks with language detection.

USE FOR: reading docs found via web_search, reading GitHub READMEs, StackOverflow answers, blog posts, tutorials, any web page.

DO NOT USE FOR: searching the web (use web_search first to find URLs), testing APIs with POST/PUT (use run_bash with curl), reading local files (use read_file).

RULES: Response includes cleaned text AND code examples in markdown blocks. Use after web_search to read full content of relevant results.`,
      parameters: { type:"object", properties: {
        url:       { type:"string", description:"Full URL to fetch (http:// or https://)" },
        max_chars: { type:"number", description:"Max chars to return (default 12000)" }
      }, required:["url"] }
    }
  },

  // ── Knowledge Base ──────────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "kb_search",
      description: `Search your LOCAL knowledge base using semantic (meaning-based) search. The KB contains documents YOU have indexed — PDFs, books, notes, code files added with kb_add.

USE FOR: when user asks about "my documents", "my notes", "my books", "that PDF I added", or references a specific document they've previously added.

DO NOT USE FOR: searching the web for general info (use web_search), searching project source code (use grep_search), reading a file by path (use read_file).

RULES: Results include relevance score (0-1) and source filename. If no results, suggest adding documents with kb_add. Check kb_list first to see what's available.`,
      parameters: { type:"object", properties: {
        query: { type:"string", description:"What to search for (natural language)" },
        num:   { type:"number", description:"Number of results (default 5)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "kb_add",
      description: "Add a file to the local knowledge base for semantic search with kb_search. Supports: PDF, TXT, MD, source code (.py, .js, .ts, .java, .go). The file is chunked, embedded, and stored.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Absolute path to file to add" }
      }, required:["filepath"] }
    }
  },
  {
    type: "function", function: {
      name: "kb_list",
      description: "List all documents indexed in the local knowledge base. Shows filenames, types, source paths, and total chunk count. Use to check what's in the KB before searching.",
      parameters: { type:"object", properties: {} }
    }
  },

  // ── Document Creation ──────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "create_pdf",
      description: `Create a PDF document from markdown-formatted content. Supports headings, paragraphs, lists, code blocks.

USE FOR: creating reports, summaries, documentation, invoices. DO NOT USE FOR: creating source code files (use write_file).

RULES: filepath is REQUIRED. content must be the ACTUAL text in markdown format, NOT instructions like "write a summary". For summarizing a file: first read_file, then compose summary text, then create_pdf with the summary as content.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output PDF path (must end in .pdf)" },
        content:  { type:"string", description:"Actual text content in markdown format" },
        title:    { type:"string", description:"Document title (optional)" },
        author:   { type:"string", description:"Author name (optional)" }
      }, required:["filepath","content"] }
    }
  },
  {
    type: "function", function: {
      name: "create_docx",
      description: "Create a Word document (.docx) from markdown content. Supports headings, paragraphs, bold, bullet/numbered lists, code blocks, page breaks (---). RULES: filepath REQUIRED, content must be actual text not instructions.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output path (must end in .docx)" },
        content:  { type:"string", description:"Actual text content in markdown format" },
        title:    { type:"string", description:"Document title (optional)" }
      }, required:["filepath","content"] }
    }
  },
  {
    type: "function", function: {
      name: "create_excel",
      description: `Create an Excel spreadsheet (.xlsx). Accepts data as array of objects OR sheets format.

SIMPLE FORMAT: data as array of objects — [{"Name":"Alice","Age":30},{"Name":"Bob","Age":25}] — headers auto-extracted from keys.
ADVANCED FORMAT: sheets as JSON — [{"name":"Sheet1","headers":["Name","Age"],"rows":[["Alice",30],["Bob",25]]}].

RULES: filepath REQUIRED. Use simple format when possible.`,
      parameters: { type:"object", properties: {
        filepath:   { type:"string", description:"Output path (must end in .xlsx)" },
        data:       { type:"string", description:"JSON array of objects e.g. [{\"Name\":\"Alice\",\"Age\":30}]" },
        sheets:     { type:"string", description:"JSON array of sheets (advanced format)" },
        sheet_name: { type:"string", description:"Sheet name (default: Sheet1)" }
      }, required:["filepath"] }
    }
  },
  {
    type: "function", function: {
      name: "create_pptx",
      description: "Create a PowerPoint presentation (.pptx). Each slide has a title and bullet points. RULES: filepath REQUIRED, slides is JSON array of {title, bullets:[...]}.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output path (must end in .pptx)" },
        slides:   { type:"string", description:"JSON array: [{\"title\":\"Welcome\",\"bullets\":[\"Point 1\",\"Point 2\"]}]" },
        title:    { type:"string", description:"Presentation title (optional)" },
        author:   { type:"string", description:"Author (optional)" }
      }, required:["filepath","slides"] }
    }
  },
  {
    type: "function", function: {
      name: "create_chart",
      description: "Create a chart/graph as PNG image. Types: bar, line, pie, scatter. Supports multi-series. RULES: filepath REQUIRED, labels and values are JSON arrays.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output path (must end in .png)" },
        type:     { type:"string", description:"Chart type: bar, line, pie, scatter" },
        title:    { type:"string", description:"Chart title" },
        labels:   { type:"string", description:"JSON array of labels" },
        values:   { type:"string", description:"JSON array of values or [[series1],[series2]] for multi-series" },
        xlabel:   { type:"string", description:"X-axis label (optional)" },
        ylabel:   { type:"string", description:"Y-axis label (optional)" },
        legend:   { type:"string", description:"JSON array of series names (optional)" }
      }, required:["filepath","type","labels","values"] }
    }
  },
];

// Scan directory tree recursively (any technology)
function scanDirectory(dir, prefix, depth, maxDepth) {
  if (depth > maxDepth) return "";
  const skipDirs = new Set(["node_modules",".git","dist","build","__pycache__","target",
    "venv",".venv","env",".next",".nuxt",".svelte-kit","vendor","Pods",
    ".gradle",".idea",".vscode",".DS_Store","coverage",".cache","tmp","temp","logs"]);

  let tree = depth === 0 ? "\n## Project Structure:\n" : "";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !skipDirs.has(e.name) && !e.name.startsWith('.'));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        tree += `${prefix}📂 ${entry.name}/\n`;
        tree += scanDirectory(path.join(dir, entry.name), prefix + "  ", depth + 1, maxDepth);
      } else {
        const size = fs.statSync(path.join(dir, entry.name)).size;
        const sizeStr = size < 1024 ? `${size}B` : `${(size/1024).toFixed(1)}KB`;
        tree += `${prefix}📄 ${entry.name} (${sizeStr})\n`;
      }
    }
  } catch(_) {}
  return tree;
}

// ══════════════════════════════════════════════════════════════════
// PRE-EXECUTION MIDDLEWARE — catches bad tool calls before running
// ══════════════════════════════════════════════════════════════════
function validateToolCall(name, args) {
  const fixes = [];

  switch (name) {
    case "edit_file": {
      // Check old_str is not empty
      if (!args.old_str || !args.old_str.trim()) {
        return { blocked: true, reason: "old_str cannot be empty. Read the file first to find the exact string to replace." };
      }
      // Check file exists
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) {
        return { blocked: true, reason: `File not found: ${fp}. Use write_file to create it first.` };
      }
      // Check old_str exists in file
      const content = fs.readFileSync(fp, "utf-8");
      if (!content.includes(args.old_str)) {
        // Try to find a close match
        const lines = args.old_str.split('\n');
        if (lines.length > 0) {
          const firstLine = lines[0].trim();
          if (firstLine && content.includes(firstLine)) {
            return { blocked: true, reason: `old_str not found exactly, but "${firstLine}" exists in the file. Read the file first to get the exact text, including whitespace.` };
          }
        }
        return { blocked: true, reason: `old_str not found in ${args.filepath}. Read the file first to see its exact content.` };
      }
      break;
    }

    case "run_bash": {
      // Block obviously dangerous commands
      const cmd = (args.command || "").trim();
      if (/^(rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|:\(\)\{|fork\s+bomb)/i.test(cmd)) {
        return { blocked: true, reason: "Blocked dangerous command. This could damage the system." };
      }
      break;
    }
  }

  return { ok: true, args, fixes };
}

// ══════════════════════════════════════════════════════════════════
// TOOL RESULT FORMATTER — clear labels so model never confuses
// tool output with user messages
// ══════════════════════════════════════════════════════════════════
function formatToolResult(toolName, result) {
  const maxLen = 3000; // Keep results concise for small model context
  let text = String(result);

  // Truncate very long results
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n... (truncated ${text.length - maxLen} chars)`;
  }

  // Remove ANSI escape codes that confuse the model
  text = text.replace(/\x1b\[[0-9;]*m/g, '');

  return `[TOOL RESULT: ${toolName}]\n${text}\n[END TOOL RESULT]`;
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT BUDGET — prevents overflowing the model's context window.
// 4B models have 8192 token context. We need to leave room for response.
// ══════════════════════════════════════════════════════════════════
// Dynamic: use ~75% of context for input, leave ~25% for model response
function getMaxInputTokens() { return Math.floor(CONFIG.numCtx * 0.75); }

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4); // ~4 chars per token for English
}

function enforceContextBudget(sysPrompt, messages, tools) {
  let sysTokens  = estimateTokens(sysPrompt);
  let toolTokens = estimateTokens(JSON.stringify(tools));
  let msgTokens  = messages.reduce((s, m) => s + estimateTokens(m.content || "") + 10, 0);
  let total      = sysTokens + toolTokens + msgTokens;

  if (total <= getMaxInputTokens()) return; // fits fine

  debugLog(`Context budget: ${total} tokens (limit ${getMaxInputTokens()}), trimming...`);

  // Strategy 1: Trim the last user message's auto-loaded context (biggest offender)
  const lastUserIdx = messages.findLastIndex(m => m.role === "user");
  if (lastUserIdx >= 0) {
    const msg = messages[lastUserIdx];
    if (msg.content?.includes("═══")) {
      // Keep user's original text, trim auto-loaded context
      const parts = msg.content.split("═══");
      const userPart = parts[0];
      const budget = (getMaxInputTokens() - sysTokens - toolTokens - (msgTokens - estimateTokens(msg.content))) * 4;
      msg.content = userPart.slice(0, Math.max(budget, 2000));
      debugLog(`Trimmed auto-context to ${msg.content.length} chars`);
      return;
    }
    // Trim file paste content if too large
    if (msg.content?.includes("[FILE:")) {
      const beforeFile = msg.content.split("[FILE:")[0];
      const afterFile = msg.content.split("[END FILE]").pop() || "";
      const fileMatch = msg.content.match(/\[FILE:[\s\S]*?\[END FILE\]/);
      if (fileMatch && fileMatch[0].length > 4000) {
        const trimmedFile = fileMatch[0].slice(0, 3000) + "\n...(file truncated to fit context)\n[END FILE]";
        msg.content = beforeFile + trimmedFile + afterFile;
        debugLog(`Trimmed file paste to 3000 chars`);
      }
    }
  }

  // Strategy 2: Reduce conversation history
  if (messages.length > 6) {
    const keep = [messages[0], ...messages.slice(-4)];
    messages.length = 0;
    messages.push(...keep);
    debugLog(`Reduced history to ${messages.length} messages`);
  }
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT COMPRESSOR — summarizes old messages to keep context fresh
// ══════════════════════════════════════════════════════════════════
function compressContext(messages, maxMessages = 20) {
  if (messages.length <= maxMessages) return messages;

  // Keep first message (original request) and last N messages
  const first = messages[0];
  const recent = messages.slice(-maxMessages);

  // Summarize what was trimmed
  const trimmed = messages.slice(1, -maxMessages);
  let toolSummary = [];
  let errorCount = 0;
  let successCount = 0;

  for (const msg of trimmed) {
    if (msg.role === "tool" || (msg.role === "assistant" && msg.tool_calls?.length)) {
      const content = msg.content || "";
      if (content.includes("\u2705") || content.includes("\u2713")) successCount++;
      if (content.includes("\u274C") || content.includes("STDERR") || content.includes("Error")) errorCount++;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        toolSummary.push(fn.name);
      }
    }
  }

  const summary = {
    role: "user",
    content: `[CONTEXT SUMMARY: Previous conversation had ${trimmed.length} messages. Tools used: ${[...new Set(toolSummary)].join(", ") || "none"}. Results: ${successCount} successes, ${errorCount} errors. Now continuing from the latest state.]`
  };

  return [first, summary, ...recent];
}

// ══════════════════════════════════════════════════════════════════
// TOOL EXECUTOR
// ══════════════════════════════════════════════════════════════════
let lastError = null;

async function executeTool(name, args) {
  SESSION.toolCount++;

  // Guard: fix missing required args that would crash with TypeError
  // Small models often omit args — catch it here instead of crashing
  const needsFilepath = new Set(["read_file","write_file","edit_file","create_pdf",
    "create_docx","create_excel","create_pptx","create_chart","kb_add"]);
  if (needsFilepath.has(name) && !args.filepath) {
    // Try to find filepath in other args (model sometimes puts it in wrong field)
    const guessed = args.file || args.path || args.filename || args.name || args.output;
    if (guessed) {
      args.filepath = String(guessed);
    } else {
      return `❌ Missing required argument: filepath. Call ${name} with filepath="<path>".`;
    }
  }
  // Guard other required string args
  if (name === "run_bash" && !args.command) {
    args.command = args.cmd || args.bash || args.shell;
    if (!args.command) return `❌ Missing required argument: command. Call run_bash with command="<cmd>".`;
  }
  if ((name === "web_search" || name === "kb_search") && !args.query) {
    args.query = args.q || args.search || args.text;
    if (!args.query) return `❌ Missing required argument: query. Call ${name} with query="<search terms>".`;
  }
  if (name === "edit_file" && !args.old_str) {
    return `❌ Missing required argument: old_str. Read the file first, then call edit_file with old_str="<text to find>".`;
  }

  // Pre-execution validation
  const validation = validateToolCall(name, args);
  if (validation.blocked) {
    printToolError(validation.reason);
    return `❌ BLOCKED: ${validation.reason}`;
  }
  if (validation.fixes?.length) {
    for (const fix of validation.fixes) {
      console.log(co(C.bYellow, `  ⚡ ${fix}`));
    }
    if (validation.args) args = validation.args;
  }

  // Auto checkpoint before destructive operations
  if (["write_file","edit_file","run_bash"].includes(name)) {
    if (SESSION.toolCount % 5 === 0) createCheckpoint(`auto-${SESSION.toolCount}`);
  }

  switch (name) {

    case "run_bash": {
      const cwd  = args.cwd ? path.resolve(SESSION.cwd, args.cwd) : SESSION.cwd;
      const approved = await askPermission("run_bash", args.command);
      if (!approved) return "Permission denied by user.";
      printToolRunning("bash", args.command);
      try {
        const out = execSync(args.command, { cwd, encoding:"utf-8", timeout:30000, shell:"/bin/bash" });
        printToolDone(out);
        return out || "(no output)";
      } catch (e) {
        lastError = e.stderr || e.message;
        printToolError(e.stderr || e.stdout || e.message);
        return `STDERR:\n${e.stderr||""}\nSTDOUT:\n${e.stdout||""}`;
      }
    }

    case "read_file": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) return `Error: Not found: ${fp}`;
      trackFile(fp);
      const ext = path.extname(fp).toLowerCase();

      // ── PDF reading ──
      if (ext === ".pdf") {
        printToolRunning("read_file", `[PDF] ${fp}`);
        const pyCode = `
import sys, json
try:
    import fitz
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "PyMuPDF", "-q"])
    import fitz
filepath = ${JSON.stringify(fp)}
doc = fitz.open(filepath)
text = []
for page in doc:
    text.append(page.get_text())
result = "\\n\\n---PAGE BREAK---\\n\\n".join(text)
print(json.dumps({"text": result[:15000], "total_pages": len(doc)}))
`;
        const tmp = path.join(os.tmpdir(), `ml_rpdf_${Date.now()}.py`);
        fs.writeFileSync(tmp, pyCode);
        try {
          const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
          try { fs.unlinkSync(tmp); } catch(_) {}
          const result = JSON.parse(out);
          printToolDone(`${result.total_pages} pages`);
          return `PDF: ${result.total_pages} pages\n\n${result.text}`;
        } catch(e) {
          try { fs.unlinkSync(tmp); } catch(_) {}
          return `❌ PDF read failed: ${(e.stderr || e.message).slice(0, 500)}`;
        }
      }

      // ── DOCX reading ──
      if (ext === ".docx") {
        printToolRunning("read_file", `[DOCX] ${fp}`);
        const pyCode = `
import sys, json
try:
    from docx import Document
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx", "-q"])
    from docx import Document
filepath = ${JSON.stringify(fp)}
doc = Document(filepath)
text = []
for para in doc.paragraphs:
    style = para.style.name if para.style else ""
    prefix = ""
    if "Heading 1" in style: prefix = "# "
    elif "Heading 2" in style: prefix = "## "
    elif "Heading 3" in style: prefix = "### "
    elif "List Bullet" in style: prefix = "- "
    elif "List Number" in style: prefix = "1. "
    text.append(prefix + para.text)
for table in doc.tables:
    text.append("")
    for i, row in enumerate(table.rows):
        cells = [cell.text.strip() for cell in row.cells]
        text.append("| " + " | ".join(cells) + " |")
        if i == 0:
            text.append("| " + " | ".join(["---"] * len(cells)) + " |")
result = "\\n".join(text)
print(json.dumps({"text": result[:15000], "paragraphs": len(doc.paragraphs), "tables": len(doc.tables)}))
`;
        const tmp = path.join(os.tmpdir(), `ml_rdocx_${Date.now()}.py`);
        fs.writeFileSync(tmp, pyCode);
        try {
          const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
          try { fs.unlinkSync(tmp); } catch(_) {}
          const result = JSON.parse(out);
          printToolDone(`${result.paragraphs} paragraphs, ${result.tables} tables`);
          return `Word Document (${result.paragraphs} paragraphs, ${result.tables} tables):\n\n${result.text}`;
        } catch(e) {
          try { fs.unlinkSync(tmp); } catch(_) {}
          return `❌ DOCX read failed: ${(e.stderr || e.message).slice(0, 500)}`;
        }
      }

      // ── Excel reading ──
      if (ext === ".xlsx" || ext === ".xls") {
        printToolRunning("read_file", `[Excel] ${fp}`);
        const pyCode = `
import sys, json
try:
    import openpyxl
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q"])
    import openpyxl
filepath = ${JSON.stringify(fp)}
wb = openpyxl.load_workbook(filepath, data_only=True)
ws = wb.active
headers = [str(c.value or "") for c in ws[1]]
rows = []
for row in ws.iter_rows(min_row=2, values_only=True):
    rows.append([str(v) if v is not None else "" for v in row])
print(json.dumps({"sheet": ws.title, "headers": headers, "rows": rows[:200], "total_rows": ws.max_row - 1, "sheets": wb.sheetnames}))
`;
        const tmp = path.join(os.tmpdir(), `ml_rxl_${Date.now()}.py`);
        fs.writeFileSync(tmp, pyCode);
        try {
          const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
          try { fs.unlinkSync(tmp); } catch(_) {}
          const result = JSON.parse(out);
          let text = `Sheet: ${result.sheet} | ${result.total_rows} rows | Sheets: ${result.sheets.join(", ")}\n\n`;
          text += result.headers.join(" | ") + "\n" + result.headers.map(() => "---").join(" | ") + "\n";
          for (const row of result.rows.slice(0, 50)) {
            text += row.join(" | ") + "\n";
          }
          if (result.rows.length > 50) text += `\n... and ${result.total_rows - 50} more rows`;
          printToolDone(`${result.total_rows} rows`);
          return text;
        } catch(e) {
          try { fs.unlinkSync(tmp); } catch(_) {}
          return `❌ Excel read failed: ${(e.stderr || e.message).slice(0, 500)}`;
        }
      }

      // ── Default: plain text / source code ──
      let content = fs.readFileSync(fp, "utf-8");
      if (args.offset || args.limit) {
        const lines = content.split("\n");
        const from  = (args.offset || 1) - 1;
        const to    = args.limit ? from + args.limit : lines.length;
        content = lines.slice(from, to).map((l, i) => `${from+i+1}\t${l}`).join("\n");
      }
      printToolRunning("read_file", fp);
      printToolDone(content.slice(0,150) + (content.length>150?"...":""));
      return content.slice(0, 10000);
    }

    case "write_file": {
      let fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      const fileDir = path.resolve(path.dirname(fp));
      const installDir = path.resolve(__dirname);

      // Block writing ANY file directly into attar-code's install directory
      if (fileDir === installDir) {
        const basename = path.basename(fp);
        // Only allow editing attar-code's own files if they already exist AND are attar-code files
        const attarCodeFiles = ["attar-code.js", "search-proxy.js", "search-proxy-package.json", "chroma_bridge.py"];
        if (attarCodeFiles.includes(basename)) {
          return `❌ Cannot overwrite ${basename} — this is an attar-code system file.`;
        }
        // For any other file, auto-redirect into a subdirectory
        const projectName = basename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-]/g, "-") || "project";
        return `❌ Cannot write ${basename} directly into attar-code's directory. You MUST create a subdirectory first. Example: write to "${projectName}/${basename}" instead. Use run_bash with "mkdir -p ${projectName}" first, then write files inside it.`;
      }

      const approved = await askPermission("write_file", fp);
      if (!approved) return "Permission denied.";
      fs.mkdirSync(path.dirname(fp), { recursive:true });
      fs.writeFileSync(fp, args.content, "utf-8");
      trackFile(fp);
      printToolRunning("write_file", fp);
      printToolDone(`Written ${(args.content.length/1024).toFixed(1)}KB`);
      return `✓ Written: ${fp}`;
    }

    case "edit_file": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) return `Error: Not found: ${fp}`;
      const approved = await askPermission("edit_file", fp);
      if (!approved) return "Permission denied.";

      // Auto checkpoint before editing
      createCheckpoint(`before-edit-${path.basename(fp)}`);

      const original = fs.readFileSync(fp, "utf-8");
      const count    = original.split(args.old_str).length - 1;
      if (count === 0) return `Error: old_str not found. Make sure it matches exactly (newlines, spaces, etc.)`;
      if (count > 1)   return `Error: old_str found ${count} times — make it more unique.`;
      fs.writeFileSync(fp, original.replace(args.old_str, args.new_str), "utf-8");
      trackFile(fp);
      printToolRunning("edit_file", fp);
      printToolDone("1 replacement made");
      return `✓ Edited: ${fp}`;
    }

    case "get_project_structure": {
      const dir   = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      const depth = args.depth || 4;
      const SKIP  = new Set(["node_modules",".git",".next","dist","build","__pycache__",".gradle",".idea","venv","target","coverage",".lama"]);

      function walk(d, indent=0) {
        if (indent >= depth) return "";
        let out = "";
        try {
          const entries = fs.readdirSync(d, { withFileTypes:true })
            .sort((a,b) => b.isDirectory()-a.isDirectory() || a.name.localeCompare(b.name));
          for (const e of entries) {
            if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
            const p = "  ".repeat(indent);
            if (e.isDirectory()) {
              out += `${p}📁 ${e.name}/\n` + walk(path.join(d,e.name), indent+1);
            } else {
              const sz = fs.statSync(path.join(d,e.name)).size;
              out += `${p}📄 ${e.name} (${sz>1024?(sz/1024).toFixed(0)+"KB":sz+"B"})\n`;
            }
          }
        } catch (_) {}
        return out;
      }

      printToolRunning("project_structure", dir);
      const tree = `📂 ${dir}\n\n${walk(dir)||"(empty)"}`;
      printToolDone(tree.split("\n").slice(0,5).join("\n") + "...");
      return tree;
    }

    case "todo_write": {
      const id = addTodo(args.text);
      printToolRunning("todo_write", args.text);
      printToolDone(`Task #${id} added`);
      return `✓ Task #${id} added: "${args.text}"`;
    }

    case "todo_done": {
      const t = doneTodo(args.id);
      if (!t) return `Task #${args.id} not found`;
      printToolRunning("todo_done", `#${args.id} ${t.text}`);
      printToolDone("Done");
      return `✓ Task #${args.id} marked done`;
    }

    case "memory_write": {
      writeMemory(args.content, args.scope || "global");
      return `✓ Memory saved (${args.scope || "global"})`;
    }

    case "memory_read": {
      const mem = readMemory();
      return mem || "(no memory yet)";
    }

    // ── Search & Knowledge tools ──────────────────────────────────────────────

    case "web_search": {
      printToolRunning("web_search", args.query);
      const res = await proxyPost("/search", { query: args.query, num: args.num || 5 });
      if (res.error) return `Search proxy error: ${res.error}\nMake sure search-proxy is running: node search-proxy.js`;
      const lines = (res.results || []).map((r, i) =>
        `${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`
      ).join("\n\n");
      printToolDone(lines.slice(0, 150) + "...");
      return lines || "No results found.";
    }

    case "web_fetch": {
      printToolRunning("web_fetch", args.url);
      // Use smart-fetch to get BOTH text AND code blocks
      const res = await proxyPost("/smart-fetch", { url: args.url, max_chars: args.max_chars || 12000 });
      if (res.error) return `Fetch error: ${res.error}`;
      let out = res.text || "(empty page)";
      if (res.codeBlocks?.length) {
        out += "\n\n## Code Examples:\n";
        for (const cb of res.codeBlocks.slice(0, 5)) {
          out += `\n\`\`\`${cb.language}\n${cb.code.slice(0, 1500)}\n\`\`\`\n`;
        }
      }
      printToolDone(`${(out.length / 1024).toFixed(1)}KB + ${res.codeBlocks?.length || 0} code blocks`);
      return out.slice(0, 8000);
    }

    case "kb_search": {
      printToolRunning("kb_search", args.query);
      const res = await proxyPost("/kb/search", { query: args.query, num: args.num || 5 });
      if (res.error) return `KB search error: ${res.error}\nMake sure search-proxy is running: node search-proxy.js`;
      if (!res.results?.length) return "No results in knowledge base. Add files with /kb add <file> or kb_add tool.";
      const lines = res.results.map((r, i) =>
        `[${i+1}] Score: ${r.score} | Source: ${r.filename}\n${r.text}`
      ).join("\n\n---\n\n");
      printToolDone(`Found ${res.results.length} chunks from knowledge base`);
      return lines;
    }

    case "kb_add": {
      printToolRunning("kb_add", args.filepath);
      const res = await proxyPost("/kb/add", { filepath: args.filepath });
      if (res.error) return `KB add error: ${res.error}`;
      printToolDone(`Indexed: ${res.filepath}`);
      return `✓ Added to knowledge base: ${res.filepath}\nChunks indexed: ${res.data?.added || "?"}`;
    }

    case "kb_list": {
      printToolRunning("kb_list", "listing...");
      const res = await proxyPost("/kb/list", {});
      // kb/list is GET but proxyPost sends POST — use fetch directly
      let data = res;
      if (res.error) {
        try {
          const r = await fetch(`${CONFIG.proxyUrl}/kb/list`);
          data = await r.json();
        } catch(e) {
          return `KB list error: Cannot connect to search-proxy. Start it with: node search-proxy.js`;
        }
      }
      const docs = data.docs || [];
      if (!docs.length) return "Knowledge base is empty. Add files with: kb_add or /kb add <filepath>";
      const lines = docs.map((d, i) =>
        `${i+1}. ${d.filename || d.doc_id} [${d.type || "?"}] — source: ${d.source || "?"}`
      );
      printToolDone(`${docs.length} documents, ${data.total_chunks || "?"} chunks`);
      return `📚 Knowledge Base Contents (${docs.length} documents, ${data.total_chunks || "?"} chunks):\n\n${lines.join("\n")}`;
    }

    case "start_server": {
      const cwd  = args.cwd ? path.resolve(SESSION.cwd, args.cwd) : SESSION.cwd;
      const port = args.port || 3000;
      const approved = await askPermission("start_server", args.command);
      if (!approved) return "Permission denied.";

      // Check if port is already in use
      try {
        const lsof = execSync(`lsof -ti:${port}`, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }).trim();
        if (lsof) {
          // Kill existing process on that port
          printToolRunning("start_server", `Killing existing process on port ${port}`);
          execSync(`kill -9 ${lsof}`, { stdio: ["pipe","pipe","pipe"] });
          // Wait a moment for port to free up
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (_) { /* port is free */ }

      printToolRunning("start_server", `${args.command} (port ${port})`);

      return new Promise((resolve) => {
        const proc = spawn(args.command, [], { cwd, shell: true, env: process.env, detached: true, stdio: ["ignore","pipe","pipe"] });
        let output = "";

        // Track background server so we can stop it later
        if (!SESSION._servers) SESSION._servers = {};
        SESSION._servers[port] = proc;

        const done = (msg) => {
          proc.stdout.removeAllListeners();
          proc.stderr.removeAllListeners();
          proc.unref();
          resolve(msg);
        };

        proc.stdout.on("data", d => { output += d.toString(); });
        proc.stderr.on("data", d => { output += d.toString(); });

        proc.on("error", (e) => {
          printToolError(e.message);
          done(`❌ Failed to start server: ${e.message}`);
        });

        // Wait for server to start (check port every 300ms, max 10s)
        let checks = 0;
        const checkReady = setInterval(async () => {
          checks++;
          try {
            const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
            clearInterval(checkReady);
            printToolDone(`Server running on port ${port}`);
            done(`✅ Server started on port ${port}!\nOutput: ${output.slice(0, 500)}`);
          } catch (_) {
            if (checks > 30) { // 9 seconds
              clearInterval(checkReady);
              if (output.toLowerCase().includes("listening") || output.toLowerCase().includes("running") || output.toLowerCase().includes("started")) {
                printToolDone(`Server appears running on port ${port}`);
                done(`✅ Server started on port ${port}!\nOutput: ${output.slice(0, 500)}`);
              } else {
                printToolError(`Server may not have started. Output: ${output.slice(0, 300)}`);
                done(`⚠️ Server process started but port ${port} not responding after 9s.\nOutput: ${output.slice(0, 500)}`);
              }
            }
          }
        }, 300);
      });
    }

    case "find_files": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      const pattern = args.pattern || "*";
      printToolRunning("find_files", pattern);
      try {
        // Use find command with name pattern
        const globToFind = pattern.includes("**")
          ? `-name "${pattern.replace(/\*\*\//g, '')}"`
          : `-name "${pattern}" -maxdepth 3`;
        const out = execSync(
          `find "${dir}" ${globToFind} -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" 2>/dev/null | head -50`,
          { encoding:"utf-8", timeout:10000, stdio:["pipe","pipe","pipe"] }
        ).trim();
        const files = out ? out.split("\n").map(f => f.replace(dir + "/", "")) : [];
        printToolDone(`Found ${files.length} files`);
        return files.length ? files.join("\n") : "No files found matching: " + pattern;
      } catch (e) {
        return `No files found matching: ${pattern}`;
      }
    }

    case "grep_search": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      const maxResults = args.max_results || 20;
      printToolRunning("grep_search", args.pattern);
      try {
        let cmd = `grep -rn --include="${args.include || '*'}" "${args.pattern}" "${dir}" 2>/dev/null | head -${maxResults}`;
        const out = execSync(cmd, { encoding:"utf-8", timeout:10000, stdio:["pipe","pipe","pipe"] }).trim();
        const lines = out ? out.split("\n").map(l => l.replace(dir + "/", "")) : [];
        printToolDone(`Found ${lines.length} matches`);
        return lines.length ? lines.join("\n") : "No matches found for: " + args.pattern;
      } catch (_) {
        return `No matches found for: ${args.pattern}`;
      }
    }

    case "create_pdf": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_pdf", fp);

      // Write content and metadata to temp files (avoids string escaping issues)
      const tmpContent = path.join(os.tmpdir(), `ml_pdf_content_${Date.now()}.txt`);
      const tmpMeta = path.join(os.tmpdir(), `ml_pdf_meta_${Date.now()}.json`);
      fs.writeFileSync(tmpContent, args.content || "", "utf-8");
      fs.writeFileSync(tmpMeta, JSON.stringify({ title: args.title || "", author: args.author || "", filepath: fp }));

      const pyCode = `
import sys, json, os

try:
    from fpdf import FPDF
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "fpdf2", "-q"])
    from fpdf import FPDF

with open(${JSON.stringify(tmpMeta)}, "r") as f:
    meta = json.load(f)
with open(${JSON.stringify(tmpContent)}, "r", encoding="utf-8") as f:
    content = f.read()

pdf = FPDF()
pdf.set_auto_page_break(auto=True, margin=15)
pdf.add_page()

if meta["title"]:
    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 12, meta["title"], new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(5)
if meta["author"]:
    pdf.set_font("Helvetica", "I", 10)
    pdf.cell(0, 6, "By " + meta["author"], new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(8)

pdf.set_font("Helvetica", "", 11)
in_code = False
for line in content.split("\\n"):
    stripped = line.strip()
    if stripped.startswith("\`\`\`") or stripped == "\`\`\`":
        in_code = not in_code
        if in_code:
            pdf.set_font("Courier", "", 9)
            pdf.set_fill_color(240, 240, 240)
        else:
            pdf.set_font("Helvetica", "", 11)
        continue
    if in_code:
        safe = line.encode("latin-1", "replace").decode("latin-1")
        pdf.cell(0, 5, "  " + safe, new_x="LMARGIN", new_y="NEXT", fill=True)
        continue
    if stripped.startswith("# "):
        pdf.ln(4)
        pdf.set_font("Helvetica", "B", 16)
        pdf.cell(0, 10, stripped[2:], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped.startswith("## "):
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 14)
        pdf.cell(0, 8, stripped[3:], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped.startswith("### "):
        pdf.ln(2)
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 7, stripped[4:], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped.startswith("- ") or stripped.startswith("* "):
        safe = ("    " + stripped[2:]).encode("latin-1", "replace").decode("latin-1")
        pdf.cell(0, 6, safe, new_x="LMARGIN", new_y="NEXT")
    elif stripped.startswith("**") and stripped.endswith("**"):
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 6, stripped[2:-2], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped == "":
        pdf.ln(3)
    else:
        try:
            safe = stripped.encode("latin-1", "replace").decode("latin-1")
            pdf.multi_cell(0, 6, safe)
        except Exception:
            pdf.cell(0, 6, stripped[:80], new_x="LMARGIN", new_y="NEXT")

pdf.output(meta["filepath"])
print(json.dumps({"ok": True, "pages": pdf.page}))
`;
      const tmp = path.join(os.tmpdir(), `ml_pdf_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); fs.unlinkSync(tmpContent); fs.unlinkSync(tmpMeta); } catch(_) {}
        const result = JSON.parse(out);
        printToolDone(`${result.pages} pages`);
        return `✅ PDF created: ${fp} (${result.pages} pages)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); fs.unlinkSync(tmpContent); fs.unlinkSync(tmpMeta); } catch(_) {}
        return `❌ PDF creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_excel": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_excel", fp);

      // Auto-detect data format: array of objects → convert to sheets format
      let sheets;
      if (args.data) {
        try {
          const data = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
          if (Array.isArray(data) && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
            const headers = Object.keys(data[0]);
            const rows = data.map(obj => headers.map(h => obj[h] ?? ""));
            sheets = [{ name: args.sheet_name || "Sheet1", headers, rows }];
          } else {
            sheets = data;
          }
        } catch(e) { return `❌ Invalid data JSON: ${e.message}`; }
      } else if (args.sheets) {
        try { sheets = typeof args.sheets === "string" ? JSON.parse(args.sheets) : args.sheets; } catch(e) { return `❌ Invalid sheets JSON: ${e.message}`; }
      } else {
        return `❌ Missing required: either data (array of objects) or sheets (array of sheet definitions)`;
      }

      const pyCode = `
import sys, json
try:
    import openpyxl
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q"])
    import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

sheets = ${JSON.stringify(sheets)}
filepath = ${JSON.stringify(fp)}
wb = openpyxl.Workbook()
wb.remove(wb.active)

for s in sheets:
    ws = wb.create_sheet(title=s.get("name", "Sheet"))
    headers = s.get("headers", [])
    rows = s.get("rows", [])
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")
        ws.column_dimensions[cell.column_letter].width = max(len(str(h)) + 4, 12)
    for r, row in enumerate(rows, 2):
        for c, val in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=val)
            if isinstance(val, str) and val.startswith("="):
                cell.value = val

wb.save(filepath)
print(json.dumps({"ok": True, "sheets": len(sheets)}))
`;
      const tmp = path.join(os.tmpdir(), `ml_xlsx_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch(_) {}
        const result = JSON.parse(out);
        printToolDone(`${result.sheets} sheets`);
        return `✅ Excel created: ${fp} (${result.sheets} sheets)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
        return `❌ Excel creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_docx": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_docx", fp);
      const pyCode = `
import sys, json
try:
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx", "-q"])
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

content = ${JSON.stringify(args.content)}
title = ${JSON.stringify(args.title || "")}
filepath = ${JSON.stringify(fp)}

doc = Document()

if title:
    t = doc.add_heading(title, level=0)
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER

in_code = False
in_list = False
for line in content.split("\\n"):
    stripped = line.strip()
    if stripped.startswith("\`\`\`"):
        in_code = not in_code
        continue
    if in_code:
        p = doc.add_paragraph(line)
        p.style.font.name = "Courier New"
        p.style.font.size = Pt(9)
        continue
    if stripped.startswith("# "):
        doc.add_heading(stripped[2:], level=1)
    elif stripped.startswith("## "):
        doc.add_heading(stripped[3:], level=2)
    elif stripped.startswith("### "):
        doc.add_heading(stripped[4:], level=3)
    elif stripped.startswith("- ") or stripped.startswith("* "):
        doc.add_paragraph(stripped[2:], style="List Bullet")
    elif stripped and stripped[0].isdigit() and ". " in stripped[:4]:
        doc.add_paragraph(stripped.split(". ", 1)[1], style="List Number")
    elif stripped == "---":
        doc.add_page_break()
    elif stripped == "":
        doc.add_paragraph("")
    else:
        p = doc.add_paragraph()
        # Handle bold
        parts = stripped.split("**")
        for i, part in enumerate(parts):
            run = p.add_run(part)
            if i % 2 == 1:
                run.bold = True

doc.save(filepath)
paras = len(doc.paragraphs)
print(json.dumps({"ok": True, "paragraphs": paras}))
`;
      const tmp = path.join(os.tmpdir(), `ml_docx_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch(_) {}
        const result = JSON.parse(out);
        printToolDone(`${result.paragraphs} paragraphs`);
        return `✅ Word document created: ${fp} (${result.paragraphs} paragraphs)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
        return `❌ DOCX creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_pptx": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_pptx", fp);
      let slides;
      try { slides = JSON.parse(args.slides); } catch(e) { return `❌ Invalid slides JSON: ${e.message}`; }

      const pyCode = `
import sys, json
try:
    from pptx import Presentation
    from pptx.util import Inches, Pt
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-pptx", "-q"])
    from pptx import Presentation
    from pptx.util import Inches, Pt

slides_data = ${JSON.stringify(slides)}
title_text = ${JSON.stringify(args.title || "")}
author = ${JSON.stringify(args.author || "")}
filepath = ${JSON.stringify(fp)}

prs = Presentation()

# Title slide
if title_text:
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = title_text
    if author and slide.placeholders[1]:
        slide.placeholders[1].text = author

# Content slides
for s in slides_data:
    slide_title = s.get("title", "")
    bullets = s.get("bullets", [])
    layout = prs.slide_layouts[1]  # Title + Content
    slide = prs.slides.add_slide(layout)
    if slide_title:
        slide.shapes.title.text = slide_title
    if bullets and slide.placeholders[1]:
        tf = slide.placeholders[1].text_frame
        tf.clear()
        for i, bullet in enumerate(bullets):
            if i == 0:
                tf.text = bullet
            else:
                p = tf.add_paragraph()
                p.text = bullet
                p.level = 0

prs.save(filepath)
print(json.dumps({"ok": True, "slides": len(slides_data) + (1 if title_text else 0)}))
`;
      const tmp = path.join(os.tmpdir(), `ml_pptx_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch(_) {}
        const result = JSON.parse(out);
        printToolDone(`${result.slides} slides`);
        return `✅ PowerPoint created: ${fp} (${result.slides} slides)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
        return `❌ PPTX creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_chart": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_chart", `${args.type} chart`);
      let labels, values, legend;
      try { labels = JSON.parse(args.labels); } catch(e) { return `❌ Invalid labels JSON: ${e.message}`; }
      try { values = JSON.parse(args.values); } catch(e) { return `❌ Invalid values JSON: ${e.message}`; }
      try { legend = args.legend ? JSON.parse(args.legend) : null; } catch(_) { legend = null; }

      const pyCode = `
import sys, json
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "matplotlib", "-q"])
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
import numpy as np

chart_type = ${JSON.stringify(args.type)}
labels = ${JSON.stringify(labels)}
values = ${JSON.stringify(values)}
title = ${JSON.stringify(args.title || "")}
xlabel = ${JSON.stringify(args.xlabel || "")}
ylabel = ${JSON.stringify(args.ylabel || "")}
legend_names = ${JSON.stringify(legend)}
filepath = ${JSON.stringify(fp)}

plt.figure(figsize=(10, 6))
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'ggplot')

multi = isinstance(values[0], list) if values else False

if chart_type == "bar":
    if multi:
        x = np.arange(len(labels))
        width = 0.8 / len(values)
        for i, series in enumerate(values):
            plt.bar(x + i * width, series, width, label=legend_names[i] if legend_names else f"Series {i+1}")
        plt.xticks(x + width * (len(values)-1) / 2, labels)
    else:
        colors = plt.cm.Set2(np.linspace(0, 1, len(labels)))
        plt.bar(labels, values, color=colors)
elif chart_type == "line":
    if multi:
        for i, series in enumerate(values):
            plt.plot(labels, series, marker='o', label=legend_names[i] if legend_names else f"Series {i+1}")
    else:
        plt.plot(labels, values, marker='o', linewidth=2, markersize=8)
elif chart_type == "pie":
    plt.pie(values, labels=labels, autopct='%1.1f%%', startangle=90)
elif chart_type == "scatter":
    if multi and len(values) == 2:
        plt.scatter(values[0], values[1], s=100, alpha=0.7)
    else:
        plt.scatter(range(len(values)), values, s=100, alpha=0.7)

if title: plt.title(title, fontsize=14, fontweight='bold')
if xlabel: plt.xlabel(xlabel)
if ylabel: plt.ylabel(ylabel)
if (multi or legend_names) and chart_type != "pie": plt.legend()
plt.tight_layout()
plt.savefig(filepath, dpi=150, bbox_inches='tight')
plt.close()
print(json.dumps({"ok": True}))
`;
      const tmp = path.join(os.tmpdir(), `ml_chart_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`python3 "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch(_) {}
        printToolDone("Chart saved!");
        return `✅ Chart created: ${fp}`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
        return `❌ Chart creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    default: {
      // Minimal aliases — only the most common mistakes
      const aliases = {
        "create_file": "write_file", "save_file": "write_file",
        "grep": "grep_search", "search": "grep_search",
        "bash": "run_bash", "run_command": "run_bash", "exec": "run_bash", "shell": "run_bash",
        "cat": "read_file", "read": "read_file",
        "find": "find_files",
        "search_kb": "kb_search", "list_kb": "kb_list", "add_kb": "kb_add",
      };

      if (aliases[name]) {
        console.log(co(C.bYellow, `  ⚡ Auto-corrected: ${name} → ${aliases[name]}`));
        return executeTool(aliases[name], args);
      }

      const allToolNames = TOOLS.map(t => t.function.name);
      return `❌ Unknown tool: "${name}". Available tools: ${allToolNames.join(", ")}`;
    }
  }
}

function tryCmd(cmd) {
  try { return execSync(cmd, { encoding:"utf-8", timeout:3000, stdio:["pipe","pipe","pipe"] }).trim().split("\n")[0]; }
  catch (_) { return "not found"; }
}
// Note: execSync here runs trusted, hardcoded version-check commands only (e.g. "python3 --version"), not user input.

// ─── Proxy helper ─────────────────────────────────────────────────────────────
async function proxyPost(endpoint, body) {
  try {
    const res = await fetch(`${CONFIG.proxyUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return { error: `Cannot connect to search-proxy at ${CONFIG.proxyUrl}. Start it with: node search-proxy.js` };
  }
}

async function proxyGet(endpoint) {
  try {
    const res = await fetch(`${CONFIG.proxyUrl}${endpoint}`);
    return await res.json();
  } catch (e) {
    return { error: `Cannot connect to search-proxy at ${CONFIG.proxyUrl}` };
  }
}

// ══════════════════════════════════════════════════════════════════
// TOOL UI
// ══════════════════════════════════════════════════════════════════
function printToolRunning(name, detail) {
  const icons = { run_bash:"💻", read_file:"📄", write_file:"💾", edit_file:"✏️",
    grep_search:"🔍", find_files:"📁", get_project_structure:"📁", start_server:"🚀",
    web_search:"🔎", web_fetch:"🌐", kb_search:"📚", kb_add:"📥", kb_list:"📚",
    create_pdf:"📝", create_docx:"📝", create_excel:"📊", create_pptx:"📝", create_chart:"📊",
    todo_write:"📋", todo_done:"✅", memory_write:"🧠", memory_read:"🧠" };
  const icon = icons[name] || "⚙";
  process.stdout.write(`\n  ${icon} ` + co(C.yellow, name) + co(C.dim, `  ${String(detail).slice(0,W()-20)}\n`));
}

function printToolDone(result) {
  const lines = String(result).split("\n").filter(Boolean).slice(0, 5);
  for (const l of lines) console.log(co(C.dim, "     ") + co(C.gray, l.slice(0, W()-6)));
}

function printToolError(err) {
  const lines = String(err).split("\n").filter(Boolean).slice(0, 4);
  for (const l of lines) console.log(co(C.bRed, "  ✗ ") + co(C.dim, l.slice(0, W()-6)));
}

// ══════════════════════════════════════════════════════════════════
// OLLAMA CHAT
// ══════════════════════════════════════════════════════════════════
const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
let spinnerInterval = null;

function startSpinner(label="thinking") {
  let i = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r  ${co(C.cyan, SPINNER[i++%SPINNER.length])} ${co(C.dim, label+"...")}`);
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; process.stdout.write("\r\x1b[K"); }
}

// ══════════════════════════════════════════════════════════════════
// ERROR ANALYZER — understands WHAT went wrong and HOW to fix it
// ══════════════════════════════════════════════════════════════════
function analyzeError(errorText) {
  const e = errorText.toLowerCase();

  // Missing library
  if (/modulenotfounderror|importerror|no module named|cannot find module|is not recognized/.test(e)) {
    const match = errorText.match(/No module named ['"]([^'"]+)['"]/) ||
                  errorText.match(/ModuleNotFoundError: ([^\n]+)/) ||
                  errorText.match(/Cannot find module ['"]([^'"]+)['"]/);
    const pkg = match?.[1]?.split(".")[0] || "the missing package";
    return {
      type: "missing_library",
      fix:  `use run_bash to install "${pkg}" first, then retry`,
      nudge: `Missing library: "${pkg}". Use run_bash to install it (e.g., npm install ${pkg} or pip install ${pkg}), then retry.`
    };
  }

  // Syntax error
  if (/syntaxerror|unexpected (token|indent)|invalid syntax/.test(e)) {
    const line = errorText.match(/line (\d+)/i)?.[1];
    return {
      type: "syntax_error",
      fix:  `fix the syntax error${line ? ` at line ${line}` : ""} — rewrite only the broken part`,
      nudge: `Syntax error${line ? ` at line ${line}` : ""}. Read the error carefully, rewrite the broken code, and run again.`
    };
  }

  // Permission denied
  if (/permission denied|eacces|access is denied/.test(e)) {
    return {
      type: "permission",
      fix:  "try adding sudo, or change the file path to a writable location like /tmp",
      nudge: `Permission denied. Try using sudo, or write to /tmp instead, then retry.`
    };
  }

  // Command not found
  if (/command not found|not found|no such file or directory/.test(e)) {
    const cmd = errorText.match(/([a-zA-Z0-9_-]+): command not found/)?.[1] ||
                errorText.match(/([a-zA-Z0-9_-]+): not found/)?.[1];
    return {
      type: "command_not_found",
      fix:  cmd ? `install "${cmd}" first using run_bash (apt/brew/npm install)` : "check the command path",
      nudge: `Command not found${cmd ? `: "${cmd}"` : ""}. Install it or use an alternative approach.`
    };
  }

  // Type / attribute error
  if (/typeerror|attributeerror|nameerror/.test(e)) {
    return {
      type: "code_error",
      fix:  "fix the variable/type error — read the traceback line numbers carefully",
      nudge: `Code error in your logic. Read the traceback, identify the exact line, fix it, and run again.`
    };
  }

  // Network error
  if (/connection refused|network|timeout|econnrefused|ssl/.test(e)) {
    return {
      type: "network",
      fix:  "check network, try a different URL or approach, or use a fallback",
      nudge: `Network error. Try a different URL, add error handling, or use an alternative approach.`
    };
  }

  // Build failed
  if (/build failed|compilation error|error:|warning.*error/.test(e)) {
    return {
      type: "build_error",
      fix:  "read the build errors carefully, fix the specific files mentioned, then rebuild",
      nudge: `Build failed. Read the exact error lines, find the files, fix them, and rebuild.`
    };
  }

  // Generic
  return {
    type: "unknown",
    fix:  "read the full error carefully, understand what went wrong, and try a completely different approach",
    nudge: `Something went wrong. Read the full error carefully and try a different approach.`
  };
}

// ── Strategy escalation — each retry uses a stronger approach ────────────────
function buildRetryNudge(errorText, retryCount, errorHistory) {
  const analysis = analyzeError(errorText);

  // Track what the model already tried to avoid repeating
  const triedApproaches = errorHistory.map(e => analyzeError(e).type);
  const sameErrorCount = triedApproaches.filter(t => t === analysis.type).length;

  let nudge = "";

  if (retryCount === 1) {
    nudge = `Error occurred: ${analysis.type}
${analysis.fix}

IMPORTANT: Read the error carefully. Fix the SPECIFIC issue. Do NOT repeat what you just tried.`;

  } else if (retryCount === 2) {
    nudge = `Same type of error (${analysis.type}) happened ${sameErrorCount} times.
Previous fix didn't work. Try a COMPLETELY DIFFERENT approach:
- If writing files failed → rewrite the entire file with write_file
- If a port is busy → use run_bash: lsof -i :PORT to find what's using it
- If a command failed → use run_bash with a different command
- If code has syntax errors → read the file first, then fix with edit_file

${analysis.fix}`;

  } else if (retryCount === 3) {
    nudge = `3 retries failed. STOP and think differently:
1. What is the user's ACTUAL goal?
2. What is the SIMPLEST way to achieve it?
3. Can you use run_bash to scaffold with npm init, go mod init, etc.?
4. Can you break this into smaller steps?

Do NOT repeat any previous approach. Try something completely new.
Previous errors: ${[...new Set(triedApproaches)].join(", ")}`;

  } else if (retryCount === 4) {
    nudge = `4 retries. Last chance before giving up.
RULES:
- Do NOT call any tool you already called with similar arguments
- Explain to the user what's going wrong and what you've tried
- Ask the user if they want you to try a different approach
- If you can partially complete the task, do that and explain what's left`;

  } else {
    // 5+ retries — stop and report to user
    nudge = `STOP. You have retried ${retryCount} times. Do NOT call any more tools.
Instead, respond with:
1. What you were trying to do
2. What errors occurred
3. What you think the root cause is
4. Ask the user how they'd like to proceed`;
  }

  return nudge;
}

// ══════════════════════════════════════════════════════════════════
// MAIN CHAT FUNCTION — Never Give Up Loop
// ══════════════════════════════════════════════════════════════════
async function chat(userMessage) {
  const memory = readMemory();
  let sysPrompt = CONFIG.systemPrompt;

  // ── No middleware: all 18 tools always available, model decides ──

  if (memory) sysPrompt += `\n\n## Project Memory (LAMA.md):\n${memory}`;
  const pending = SESSION.todoList.filter(t => !t.done);
  if (pending.length > 0) {
    sysPrompt += `\n\n## Current TODO list:\n` + pending.map(t => `- [ ] #${t.id} ${t.text}`).join("\n");
  }

  SESSION.messages.push({ role:"user", content: userMessage });
  startSpinner("thinking");

  // ── State ─────────────────────────────────────────────────────────
  let retryCount    = 0;
  let lastError     = null;
  let errorHistory  = [];   // track all errors this turn
  let successStreak = 0;    // consecutive successful tool calls
  let totalSteps    = 0;

  // ── Never-Give-Up Loop ────────────────────────────────────────────
  while (true) {
    totalSteps++;

    // Safety valve — after 50 steps ask user if they want to continue
    if (totalSteps === 50) {
      stopSpinner();
      console.log();
      console.log(co(C.bYellow, "  ⚠ 50 steps reached. Continue? [y/N] "));
      const cont = await new Promise(r => { pendingApproval = r; });
      if (!cont) { console.log(co(C.dim, "\n  Stopped.\n")); return; }
      startSpinner("continuing");
    }

    let responseText = "";
    let toolCalls    = [];
    let started      = false;
    let thinkingShown = false;
    let thinkingChars = 0;
    const THINKING_MAX = 500; // cap thinking display at 500 chars

    // ── Inject nudge if AI gave up last step ──────────────────────────
    if (lastError) {
      const lastMsg = SESSION.messages[SESSION.messages.length - 1];
      const aiGaveUp = lastMsg?.role === "assistant" &&
                       !(lastMsg?.tool_calls?.length) &&
                       /error|fail|cannot|sorry|unable|unfortunately|apologize/i.test(lastMsg?.content || "");

      if (aiGaveUp || (lastMsg?.role === "tool" && String(lastMsg?.content || "").includes("Error"))) {
        retryCount++;
        errorHistory.push(lastError);

        // Remove the give-up response
        if (aiGaveUp) SESSION.messages.pop();

        const nudge = buildRetryNudge(lastError, retryCount, errorHistory);

        SESSION.messages.push({ role:"user", content: nudge });

        console.log();
        const retryLabel = retryCount <= 2 ? C.bYellow : retryCount <= 4 ? C.bRed : C.bgRed + C.bWhite;
        console.log(co(retryLabel, ` ↺ RETRY #${retryCount} — ${analyzeError(lastError).type} `));
        lastError = null;
      }
    }

    // ── Call Ollama ───────────────────────────────────────────────────
    try {
      // All tools always available — model selects from descriptions
      const selectedTools = TOOLS;
      const compressedMessages = compressContext(SESSION.messages);

      // Enforce context budget — prevent model crash from oversized input
      enforceContextBudget(sysPrompt, compressedMessages, selectedTools);

      debugLog(`Sending: ${estimateTokens(sysPrompt)} sys + ${compressedMessages.length} msgs + ${selectedTools.length} tools`);

      const reqBody = {
        model:    CONFIG.model,
        messages: [{ role:"system", content: sysPrompt }, ...compressedMessages],
        ...(selectedTools.length > 0 ? { tools: selectedTools } : {}),
        options:  {
          temperature: retryCount > 2
            ? Math.min(CONFIG.temperature + (retryCount * 0.1), 1.2)
            : CONFIG.temperature,
          num_ctx: retryCount > 3 ? CONFIG.numCtx * 2 : CONFIG.numCtx,
        },
        stream: true,
      };

      debugLog("→ POST /api/chat model=" + CONFIG.model, "msgs=" + reqBody.messages.length, "tools=" + selectedTools.length);

      const res = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });

      debugLog("← status:", res.status, res.statusText);

      if (!res.ok) {
        stopSpinner();
        const errText = await res.text();
        debugLog("← error body:", errText);
        console.log(co(C.bRed, "\n  ✗ Ollama error: ") + errText);
        SESSION.messages.pop();
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";
      let   chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream:true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const rawLine of lines) {
          if (!rawLine.trim()) continue;
          chunkCount++;
          try {
            const chunk = JSON.parse(rawLine);
            const msg   = chunk.message || {};
            debugLog("chunk#" + chunkCount, JSON.stringify(msg).slice(0, 200));

            // Handle thinking/reasoning tokens (nemotron, deepseek, etc.)
            if (msg.thinking) {
              if (!started) { stopSpinner(); printAiStart(); started = true; }
              if (!thinkingShown) { process.stdout.write(co(C.dim, C.italic, "  \u{1F4AD} ")); thinkingShown = true; }
              thinkingChars += msg.thinking.length;
              if (thinkingChars <= THINKING_MAX) {
                process.stdout.write(co(C.dim, C.italic, msg.thinking));
              } else if (thinkingChars - msg.thinking.length < THINKING_MAX) {
                process.stdout.write(co(C.dim, C.italic, "...\n"));
              }
            }

            if (msg.tool_calls?.length > 0) {
              debugLog("tool_calls:", JSON.stringify(msg.tool_calls).slice(0, 300));
              toolCalls = [...toolCalls, ...msg.tool_calls];
            }
            if (msg.content) {
              if (thinkingShown) { process.stdout.write(C.reset + "\n\n"); thinkingShown = false; }
              if (!started) { stopSpinner(); printAiStart(); started = true; }
              renderStreamToken(msg.content);
              responseText += msg.content;
            }
          } catch (parseErr) {
            debugLog("parse error:", parseErr.message, "raw:", rawLine.slice(0, 200));
          }
        }
      }

      debugLog("stream done. chunks=" + chunkCount, "response=" + responseText.length + "chars", "toolCalls=" + toolCalls.length);
      // Flush any remaining buffered content (model may not end with newline)
      if (renderState.lineBuffer) {
        if (thinkingShown) { process.stdout.write(C.reset + "\n\n"); thinkingShown = false; }
        if (!started) { stopSpinner(); printAiStart(); started = true; }
        process.stdout.write(renderState.lineBuffer + C.reset);
        responseText += renderState.lineBuffer;
        renderState.lineBuffer = "";
      }

      if (!started) stopSpinner();

    } catch (err) {
      stopSpinner();
      if (err.message.includes("ECONNREFUSED")) {
        console.log(co(C.bRed, "\n  ✗ Cannot connect to Ollama. Run: ") + co(C.yellow, "ollama serve"));
      } else {
        console.log(co(C.bRed, "\n  ✗ ") + err.message);
      }
      SESSION.messages.pop();
      return;
    }

    // ── No tool calls → check if done or gave up ──────────────────────
    if (toolCalls.length === 0) {
      SESSION.messages.push({ role:"assistant", content: responseText });

      // Response validation — catch empty/garbage responses
      const cleanResponse = responseText.replace(/[·•…\s\n]/g, '').trim();
      if (cleanResponse.length < 3 && retryCount < 3) {
        SESSION.messages.pop(); // remove the empty response
        retryCount++;
        // Check if the user's message implies a task needing tools
        const lastUserMsg = SESSION.messages.filter(m => m.role === "user").pop()?.content || "";
        const hasAction = /\b(create|build|fix|test|deploy|add|install|run|start|make|generate|search|find|write|edit|delete|summarize|read)\b/i.test(lastUserMsg);
        if (hasAction) {
          SESSION.messages.push({ role:"user", content: "Your last response was empty. You need to USE A TOOL to complete this task. Look at the available tools and call the right one. Do NOT just respond with text — take ACTION." });
        } else {
          SESSION.messages.push({ role:"user", content: "Your last response was empty. Please respond with actual text answering the question." });
        }
        console.log(co(C.bYellow, "\n  ⚡ Empty response detected — regenerating..."));
        startSpinner("regenerating");
        continue;
      }

      // Trim history if too long
      if (SESSION.messages.length > CONFIG.historySize * 2) {
        // Keep first message (original request) + last N messages
        const first = SESSION.messages[0];
        SESSION.messages = [first, ...SESSION.messages.slice(-CONFIG.historySize)];
      }

      // If there's still a pending error → loop will inject nudge next iteration
      if (lastError) continue;

      // ── Detect: model is PLANNING but not ACTING ──────────────
      // 4B models often spiral in thinking ("let me create X, then Y, then Z...")
      // consuming all output tokens without producing a tool call.
      // If the response mentions future actions, nudge it to act.
      const planningWords = /\b(let me|i need to|i'll|i will|now i|next i|let's|going to|should|create|write|install|implement|set up)\b/i;
      const isStillPlanning = planningWords.test(responseText) && totalSteps < 40 && retryCount < 4;
      const hasToolHistory = SESSION.messages.some(m => m.tool_calls?.length > 0);

      if (isStillPlanning && hasToolHistory) {
        // Model was working on a multi-step task but stopped mid-plan
        SESSION.messages.pop(); // remove the thinking-only response
        retryCount++;
        SESSION.messages.push({
          role: "user",
          content: "You were thinking but didn't call a tool. STOP THINKING and CALL THE NEXT TOOL NOW. Pick the single most important next step and execute it."
        });
        console.log(co(C.bYellow, "\n  ⚡ Model thinking without acting — nudging to continue..."));
        startSpinner("continuing");
        continue;
      }

      // Genuinely done ✅
      process.stdout.write("\n\n");
      if (retryCount > 0) {
        console.log(co(C.bGreen, `  ✓ Solved after ${retryCount} retries and ${totalSteps} steps`));
      }
      printDivider();
      return;
    }

    // ── Execute tools ─────────────────────────────────────────────────
    process.stdout.write("\n");
    SESSION.messages.push({ role:"assistant", content: responseText, tool_calls: toolCalls });

    const toolResults = [];
    for (const tc of toolCalls) {
      const fn   = tc.function || tc;
      const name = fn.name;
      let   args;
      try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments; }
      catch (_) { args = {}; }

      const result    = await executeTool(name, args || {});
      let   resultStr = String(result);

      toolResults.push({ role:"tool", content: formatToolResult(name, resultStr) });

      // ── Error detection ─────────────────────────────────────────────
      const isError = (
        resultStr.startsWith("STDERR:") ||
        resultStr.startsWith("❌") ||
        resultStr.startsWith("ERROR") ||
        resultStr.startsWith("Error") ||
        resultStr.includes("Traceback (most recent call last)") ||
        resultStr.includes("SyntaxError:") ||
        resultStr.includes("ModuleNotFoundError:") ||
        resultStr.includes("ImportError:") ||
        resultStr.includes("TypeError:") ||
        resultStr.includes("NameError:") ||
        resultStr.includes("AttributeError:") ||
        resultStr.includes("Build failed") ||
        resultStr.includes("FAILED") ||
        (/^error:/im).test(resultStr)
      ) && !resultStr.includes("✓"); // don't flag success messages

      if (isError) {
        lastError = resultStr.slice(0, 1000);
        successStreak = 0;
        const analysis = analyzeError(lastError);
        console.log(co(C.bYellow, `  ⚠ `) +
          co(C.yellow, analysis.type) +
          co(C.dim, ` — retry #${retryCount + 1} coming up`));
      } else {
        lastError = null;
        successStreak++;
      }
    }

    SESSION.messages.push(...toolResults);

    const spinLabel = lastError
      ? `fixing (attempt ${retryCount + 1})`
      : successStreak > 1 ? "making progress..." : "processing";

    startSpinner(spinLabel);
  }
}

// ══════════════════════════════════════════════════════════════════
// AI RESPONSE RENDERER  (streams tokens as they arrive)
// ══════════════════════════════════════════════════════════════════
let renderState = { inCode: false, lang: "", lineBuffer: "" };

function printAiStart() {
  renderState = { inCode: false, lang: "", lineBuffer: "", firstLine: true };
  console.log();
  const name = SESSION.name ? `${CONFIG.model} (${SESSION.name})` : CONFIG.model;
  console.log(co(C.bCyan, "  ✦ ") + co(C.bold, C.bCyan, name));
  process.stdout.write(co(C.cyan, "  ╰─ "));
}

function renderStreamToken(token) {
  // Buffer by line for code block detection
  renderState.lineBuffer += token;
  const lines = renderState.lineBuffer.split("\n");
  renderState.lineBuffer = lines.pop() || "";

  for (const line of lines) renderLine(line);
}

function renderLine(line) {
  const prefix = co(C.gray, "  │  ");

  if (line.startsWith("```")) {
    renderState.inCode = !renderState.inCode;
    if (renderState.inCode) {
      renderState.lang = line.slice(3).trim() || "code";
      process.stdout.write("\n" + co(C.gray, "  │  ┌─ ") + co(C.yellow, renderState.lang) + "\n");
    } else {
      process.stdout.write(co(C.gray, "  │  └" + "─".repeat(Math.min(38,W()-10))) + "\n");
    }
    return;
  }

  if (renderState.inCode) {
    process.stdout.write(co(C.gray, "  │  │ ") + co(C.bGreen, line) + "\n");
    return;
  }

  // Format prose
  let out = line
    .replace(/\*\*(.*?)\*\*/g, C.bold + "$1" + C.reset)
    .replace(/`([^`]+)`/g, co(C.bgBlack, C.bYellow, " $1 "))
    .replace(/^### (.+)/, co(C.bold, C.bMagenta, "$1"))
    .replace(/^## (.+)/,  co(C.bold, C.bCyan,    "$1"))
    .replace(/^# (.+)/,   co(C.bold, C.bWhite,   "$1"))
    .replace(/^[-•] /,    co(C.bCyan, "• "))
    .replace(/^(\d+)\. /, co(C.bMagenta, "$1. "));

  process.stdout.write(prefix + out + C.reset + "\n");
}

// ══════════════════════════════════════════════════════════════════
// UI
// ══════════════════════════════════════════════════════════════════
function printBanner() {
  console.clear();
  const w = W();
  console.log();
  console.log(co(C.bCyan, "  " + "╔" + "═".repeat(w-4) + "╗"));
  const t1 = "  ✦  attar-code  v2  —  Claude Code Edition  ";
  const t2 = "  Local AI CLI • Any Ollama Model • Full Tool Suite  ";
  console.log(co(C.bCyan, "  ║") + co(C.bold, C.bWhite, pad("", Math.floor((w-4-t1.length)/2)) + t1 + pad("", Math.ceil((w-4-t1.length)/2))) + co(C.bCyan, "║"));
  console.log(co(C.bCyan, "  ║") + co(C.dim, pad("", Math.floor((w-4-t2.length)/2)) + t2 + pad("", Math.ceil((w-4-t2.length)/2))) + co(C.bCyan, "║"));
  console.log(co(C.bCyan, "  " + "╚" + "═".repeat(w-4) + "╝"));
  console.log();
  printStatusBar();
  console.log();
  console.log(co(C.dim, "  /help  /model  /models  /cp  /rewind  /todo  /memory  /plan  /save  /exit"));
  console.log(co(C.dim, "  !command  — run shell directly  |  Type naturally to chat"));
  console.log(co(C.gray, "  " + "─".repeat(w-4)));
  console.log();
}

function printStatusBar() {
  const model    = co(C.bGreen, " ✦ ", CONFIG.model, " ");
  const temp     = co(C.dim, "  🌡 ", String(CONFIG.temperature));
  const ctx      = co(C.dim, "  📐 ", String(CONFIG.numCtx));
  const cwd      = co(C.dim, "  📂 ", SESSION.cwd.replace(os.homedir(),"~").slice(0,40));
  const msgs     = co(C.dim, "  💬 ", String(SESSION.messages.length));
  const cps      = co(C.dim, "  📸 ", String(SESSION.checkpoints.length));
  const todos    = co(C.dim, "  📋 ", String(SESSION.todoList.filter(t=>!t.done).length), " pending");
  const autoA    = CONFIG.autoApprove ? co(C.bYellow, "  ⚡AUTO") : "";
  console.log("  " + model + temp + ctx + cwd + msgs + cps + todos + autoA);
}

function printDivider() {
  console.log(co(C.gray, "  └" + "─".repeat(Math.min(50,W()-6))));
  console.log();
}

function printHelp() {
  console.log();
  console.log(co(C.bold, C.bCyan, "  ╔═ Commands ══════════════════════════════════╗"));

  const sections = [
    ["Models", [
      ["/model <n>",    "Switch model e.g. /model mistral"],
      ["/models",          "List installed Ollama models"],
      ["/temp <0-2>",      "Set temperature"],
      ["/ctx <n>",          "Set context window size (tokens)"],
    ]],
    ["Session", [
      ["/clear",           "Clear conversation history"],
      ["/save [file]",     "Save session to JSON file"],
      ["/load <file>",     "Load session from file"],
      ["/name <name>",     "Name this session"],
      ["/status",          "Show session status"],
    ]],
    ["Checkpoints (like /rewind)", [
      ["/cp [label]",      "Create checkpoint"],
      ["/rewind [n]",      "Rewind to checkpoint (default: last)"],
      ["/checkpoints",     "List all checkpoints"],
    ]],
    ["Tasks", [
      ["/todo",            "Show todo list"],
      ["/todo add <text>", "Add a task"],
      ["/todo done <id>",  "Mark task done"],
    ]],
    ["Memory", [
      ["/memory",          "Show memory (LAMA.md)"],
      ["/memory set <txt>","Set global memory"],
    ]],
    ["Plan Mode", [
      ["/plan <goal>",     "Enter plan mode — AI makes a plan first"],
      ["/plan off",        "Exit plan mode"],
    ]],
    ["Permissions", [
      ["/auto on|off",     "Toggle auto-approve all commands"],
    ]],
    ["Tools", [
      ["/tools",           "List all tools"],
      ["/commands",        "List custom slash commands"],
    ]],
    ["Search & Knowledge", [
      ["/search <query>",   "Search the web directly"],
      ["/kb add <file>",    "Add file to knowledge base"],
      ["/kb search <q>",    "Search knowledge base"],
      ["/kb list",          "List indexed documents"],
      ["/kb reindex",       "Re-index all kb files"],
    ]],
    ["Shell", [
      ["!<command>",       "Run shell command directly e.g. !ls -la"],
    ]],
    ["Other", [
      ["/exit",            "Exit"],
    ]],
  ];

  for (const [section, cmds] of sections) {
    console.log(co(C.bYellow, `\n  ── ${section} `));
    for (const [cmd, desc] of cmds) {
      console.log("  " + co(C.bGreen, pad(cmd, 24)) + co(C.dim, desc));
    }
  }
  console.log();
}

// ══════════════════════════════════════════════════════════════════
// COMMAND HANDLER
// ══════════════════════════════════════════════════════════════════
async function handleCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const rest  = parts.slice(1).join(" ");

  // Check custom commands first
  const customs = loadCustomCommands();
  if (customs[cmd]) {
    console.log(co(C.dim, `\n  Running custom command: ${cmd}\n`));
    await chat(customs[cmd] + (rest ? "\n\nContext: " + rest : ""));
    return;
  }

  // !shell shortcut
  if (input.startsWith("!")) {
    const shellCmd = input.slice(1).trim();
    try {
      const out = execSync(shellCmd, { cwd:SESSION.cwd, encoding:"utf-8", shell:"/bin/bash" });
      console.log(co(C.dim, "\n" + out));
    } catch (e) {
      console.log(co(C.bRed, "\n  ✗ ") + (e.stderr || e.message));
    }
    return;
  }

  switch (cmd) {
    case "/help":     printHelp(); break;
    case "/status":   console.log(); printStatusBar(); console.log(); break;

    case "/model":
      if (!rest) { console.log(co(C.dim, "\n  Model: ") + co(C.bGreen, CONFIG.model) + "\n"); break; }
      CONFIG.model = rest; saveConfig();
      console.log(co(C.bGreen, "\n  ✓ ") + "Model: " + co(C.bold, rest) + "\n"); break;

    case "/models": {
      console.log(co(C.dim, "\n  Fetching models...\n"));
      try {
        const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
        const data = await res.json();
        const models = data.models || [];
        if (!models.length) { console.log(co(C.dim, "  No models. Try: ") + co(C.yellow,"ollama pull llama3") + "\n"); break; }
        console.log(co(C.bold, "  Installed Ollama Models:\n"));
        for (const m of models) {
          const active = m.name === CONFIG.model ? co(C.bGreen, " ← active") : "";
          const size   = m.size ? co(C.dim, ` (${(m.size/1e9).toFixed(1)}GB)`) : "";
          console.log("  " + co(C.bYellow, "  • ") + m.name + size + active);
        }
        console.log();
      } catch (_) { console.log(co(C.bRed, "  ✗ Cannot connect to Ollama.\n")); }
      break;
    }

    case "/temp":
      if (!rest || isNaN(parseFloat(rest))) { console.log(co(C.dim, "\n  Temp: ") + CONFIG.temperature + "\n"); break; }
      CONFIG.temperature = parseFloat(rest); saveConfig();
      console.log(co(C.bGreen, "\n  ✓ ") + "Temperature: " + CONFIG.temperature + "\n"); break;

    case "/ctx":
      if (!rest || isNaN(parseInt(rest))) { console.log(co(C.dim, "\n  Context window: ") + CONFIG.numCtx + " tokens\n"); break; }
      CONFIG.numCtx = parseInt(rest); saveConfig();
      console.log(co(C.bGreen, "\n  ✓ ") + "Context window: " + CONFIG.numCtx + " tokens\n"); break;

    case "/system":
      if (!rest) { console.log(co(C.dim, "\n  System prompt:\n  ") + CONFIG.systemPrompt + "\n"); break; }
      CONFIG.systemPrompt = rest; saveConfig();
      console.log(co(C.bGreen, "\n  ✓ ") + "System prompt updated.\n"); break;

    case "/name":
      if (!rest) { console.log(co(C.dim, "\n  Session name: ") + (SESSION.name || "(unnamed)") + "\n"); break; }
      SESSION.name = rest;
      console.log(co(C.bGreen, "\n  ✓ ") + "Session named: " + co(C.bold, rest) + "\n"); break;

    case "/cd": {
      if (!rest) { console.log(co(C.dim, "\n  CWD: ") + co(C.bGreen, SESSION.cwd) + "\n"); break; }
      const target = path.resolve(SESSION.cwd, rest);
      if (!fs.existsSync(target)) { console.log(co(C.bRed, "\n  ✗ Not found: ") + target + "\n"); break; }
      process.chdir(target); SESSION.cwd = process.cwd();
      console.log(co(C.bGreen, "\n  ✓ ") + "CWD: " + SESSION.cwd + "\n"); break;
    }

    case "/clear":
      SESSION.messages = [];
      console.log(co(C.bGreen, "\n  ✓ ") + "Conversation cleared.\n"); break;

    case "/save": {
      const file = rest || `session-${SESSION.id}.json`;
      fs.writeFileSync(file, JSON.stringify({ model:CONFIG.model, session:SESSION }, null, 2));
      console.log(co(C.bGreen, "\n  ✓ ") + "Saved: " + file + "\n"); break;
    }

    case "/load": {
      if (!rest) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /load <file>\n"); break; }
      if (!fs.existsSync(rest)) { console.log(co(C.bRed, "\n  ✗ ") + "Not found: " + rest + "\n"); break; }
      const data = JSON.parse(fs.readFileSync(rest, "utf-8"));
      SESSION.messages = data.session?.messages || [];
      CONFIG.model     = data.model || CONFIG.model;
      console.log(co(C.bGreen, "\n  ✓ ") + `Loaded ${SESSION.messages.length} messages.\n`); break;
    }

    case "/cp":
    case "/checkpoint": {
      const cp = createCheckpoint(rest || undefined);
      console.log(co(C.bGreen, "\n  ✓ ") + `Checkpoint: "${cp.label}" — ${Object.keys(cp.files).length} files\n`); break;
    }

    case "/rewind": {
      const n  = rest ? parseInt(rest) || 0 : 0;
      const cp = rewindToCheckpoint(n);
      if (!cp) { console.log(co(C.bRed, "\n  ✗ ") + "No checkpoints.\n"); break; }
      console.log(co(C.bGreen, "\n  ✓ ") + `Rewound to: "${cp.label}" — ${Object.keys(cp.files).length} files restored\n`); break;
    }

    case "/checkpoints": {
      if (!SESSION.checkpoints.length) { console.log(co(C.dim, "\n  No checkpoints yet.\n")); break; }
      console.log(co(C.bold, "\n  Checkpoints:\n"));
      for (const [i, cp] of SESSION.checkpoints.entries()) {
        console.log(`  ${co(C.dim, String(i))}  ${co(C.bYellow, cp.label)}  ${co(C.dim, cp.time.slice(0,19))}  ${co(C.gray, Object.keys(cp.files).length + " files")}`);
      }
      console.log(); break;
    }

    case "/todo": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "add") { const id = addTodo(parts.slice(2).join(" ")); console.log(co(C.bGreen, "\n  ✓ ") + `Task #${id} added.\n`); }
      else if (sub === "done") { doneTodo(parseInt(parts[2])); console.log(co(C.bGreen, "\n  ✓ ") + "Done.\n"); }
      else { console.log(co(C.bold, "\n  TODO List:\n")); printTodos(); console.log(); }
      break;
    }

    case "/memory": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "set") { writeMemory(parts.slice(2).join(" ")); console.log(co(C.bGreen, "\n  ✓ ") + "Memory saved.\n"); }
      else { const m = readMemory(); console.log("\n" + (m ? co(C.dim, m) : co(C.dim, "  (empty)")) + "\n"); }
      break;
    }

    case "/plan": {
      if (rest === "off") { SESSION.planMode = false; SESSION.plan = null; console.log(co(C.bGreen, "\n  ✓ ") + "Plan mode off.\n"); break; }
      SESSION.planMode = true;
      console.log(co(C.bCyan, "\n  🗺  Plan mode ON — AI will create a plan before acting.\n"));
      if (rest) {
        await chat(`/plan: ${rest}\n\nCreate a detailed step-by-step plan for this goal. Use todo_write for each step. Do NOT implement yet — just plan.`);
      }
      break;
    }

    case "/auto":
      if (rest === "on")  { CONFIG.autoApprove = true;  saveConfig(); console.log(co(C.bYellow, "\n  ⚡ Auto-approve ON\n")); }
      else if (rest === "off") { CONFIG.autoApprove = false; saveConfig(); console.log(co(C.bGreen, "\n  ✓ Auto-approve OFF\n")); }
      else { console.log(co(C.dim, "\n  Auto-approve: ") + (CONFIG.autoApprove ? co(C.bYellow,"ON") : co(C.dim,"off")) + "\n"); }
      break;

    case "/tools":
      console.log(co(C.bold, "\n  Tools:\n"));
      for (const t of TOOLS) {
        const fn = t.function;
        console.log("  " + co(C.bYellow, pad("  " + fn.name, 26)) + co(C.dim, fn.description.slice(0,50)));
      }
      console.log(); break;

    case "/commands": {
      const customs2 = loadCustomCommands();
      const keys = Object.keys(customs2);
      if (!keys.length) {
        console.log(co(C.dim, `\n  No custom commands. Add .md files to: ${CMDS_DIR}\n`));
      } else {
        console.log(co(C.bold, "\n  Custom Commands:\n"));
        for (const k of keys) console.log("  " + co(C.bGreen, pad(k, 20)) + co(C.dim, customs2[k].slice(0,50)));
        console.log();
      }
      break;
    }

    case "/kb": {
      const sub = parts[1]?.toLowerCase();

      if (sub === "add") {
        const fp = parts.slice(2).join(" ");
        if (!fp) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /kb add <filepath>\n"); break; }
        console.log(co(C.dim, "\n  Adding to knowledge base...\n"));
        const res = await proxyPost("/kb/add", { filepath: fp });
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        console.log(co(C.bGreen, "  ✓ ") + `Added: ${res.filepath}\n`);

      } else if (sub === "search") {
        const query = parts.slice(2).join(" ");
        if (!query) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /kb search <query>\n"); break; }
        console.log(co(C.dim, `\n  Searching knowledge base for "${query}"...\n`));
        const res = await proxyPost("/kb/search", { query, num: 5 });
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        if (!res.results?.length) { console.log(co(C.dim, "  No results found.\n")); break; }
        for (const r of res.results) {
          console.log(co(C.bYellow, `  [${r.rank}] `) + co(C.dim, r.filename) + co(C.gray, ` score:${r.score}`));
          console.log(co(C.dim, "     ") + r.text.slice(0, 200).replace(/\n/g, " ") + "\n");
        }

      } else if (sub === "list") {
        const res = await proxyGet("/kb/list");
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        const docs = res.docs || [];
        console.log(co(C.bold, `\n  Knowledge Base (${res.total_chunks || 0} chunks):\n`));
        if (!docs.length) { console.log(co(C.dim, "  Empty. Add files with /kb add <file>\n")); break; }
        for (const d of docs) {
          console.log("  " + co(C.bYellow, "  • ") + co(C.white, d.filename) + co(C.dim, ` [${d.type}]`));
        }
        console.log();

      } else if (sub === "reindex") {
        console.log(co(C.dim, "\n  Re-indexing all files...\n"));
        const res = await proxyPost("/kb/reindex", {});
        console.log(co(C.bGreen, "  ✓ ") + `Indexed: ${res.indexed}, Failed: ${res.failed}\n`);

      } else {
        console.log(co(C.bold, "\n  /kb commands:\n"));
        console.log("  " + co(C.bGreen, pad("/kb add <file>",      22)) + co(C.dim, "Add a file to knowledge base"));
        console.log("  " + co(C.bGreen, pad("/kb search <query>",  22)) + co(C.dim, "Semantic search"));
        console.log("  " + co(C.bGreen, pad("/kb list",            22)) + co(C.dim, "List indexed documents"));
        console.log("  " + co(C.bGreen, pad("/kb reindex",         22)) + co(C.dim, "Re-index all files in kb folder"));
        console.log(co(C.dim, `\n  Knowledge base folder: ${path.join(HOME_DIR, "knowledge")}\n`));
      }
      break;
    }

    case "/search": {
      const query = rest;
      if (!query) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /search <query>\n"); break; }
      console.log(co(C.dim, `\n  Searching web for "${query}"...\n`));
      const res = await proxyPost("/search", { query, num: 5 });
      if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
      for (const r of res.results || []) {
        console.log(co(C.bCyan, "  → ") + co(C.bold, r.title));
        console.log(co(C.dim,   "    ") + r.url);
        if (r.snippet) console.log(co(C.dim, "    ") + r.snippet.slice(0, 120));
        console.log();
      }
      break;
    }

    case "/exit":
    case "/quit":
    case "/q":
      saveSession();
      console.log("\n" + co(C.bCyan, "  ✦ ") + co(C.dim, "Goodbye bro. Stay 🔥\n"));
      process.exit(0);

    default:
      console.log(co(C.dim, `\n  Unknown command: ${cmd}. Type /help\n`));
  }
}

function saveSession() {
  const f = path.join(SESSIONS_DIR, `${SESSION.id}.json`);
  fs.writeFileSync(f, JSON.stringify({ config: CONFIG, session: SESSION }, null, 2));
}

// ══════════════════════════════════════════════════════════════════
// FILE PASTE DETECTION — extracted as reusable function
// Detects file paths in input, reads them, wraps content in [FILE:] tags.
// Used by both interactive mode and -p one-shot mode.
// ══════════════════════════════════════════════════════════════════
function processFilePaste(input) {
  let message = input;
  const filePatterns = input.match(/(?:^|\s)((?:\/|~\/|\.\/)[^\s]+\.[a-zA-Z0-9]+)/g);
  if (filePatterns) {
    for (let match of filePatterns) {
      match = match.trim();
      let filePath = match.startsWith("~") ? match.replace("~", os.homedir()) : match;
      filePath = path.isAbsolute(filePath) ? filePath : path.resolve(SESSION.cwd, filePath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const size = fs.statSync(filePath).size;
        if (size > 5 * 1024 * 1024) {
          message = message.replace(match, `[File: ${match} — too large (${(size/1048576).toFixed(1)}MB)]`);
          continue;
        }
        let fileContent = "";
        if ([".pdf"].includes(ext)) {
          try {
            const pyCode = `import sys,json\ntry:\n    import fitz\nexcept ImportError:\n    import subprocess;subprocess.check_call([sys.executable,"-m","pip","install","PyMuPDF","-q"]);import fitz\ndoc=fitz.open(${JSON.stringify(filePath)})\ntext="\\n".join([p.get_text() for p in doc])\nprint(json.dumps({"t":text[:4000]}))`;
            const tmp = path.join(os.tmpdir(), `ml_fp_${Date.now()}.py`);
            fs.writeFileSync(tmp, pyCode);
            const out = execSync(`python3 "${tmp}"`, { encoding:"utf-8", timeout:15000, stdio:["pipe","pipe","pipe"] });
            try { fs.unlinkSync(tmp); } catch(_) {}
            fileContent = JSON.parse(out).t;
          } catch(_) { fileContent = "[Could not read PDF]"; }
        } else if ([".docx"].includes(ext)) {
          try {
            const pyCode = `import sys,json\ntry:\n    from docx import Document\nexcept ImportError:\n    import subprocess;subprocess.check_call([sys.executable,"-m","pip","install","python-docx","-q"]);from docx import Document\ndoc=Document(${JSON.stringify(filePath)})\ntext="\\n".join([p.text for p in doc.paragraphs])\nprint(json.dumps({"t":text[:4000]}))`;
            const tmp = path.join(os.tmpdir(), `ml_fp_${Date.now()}.py`);
            fs.writeFileSync(tmp, pyCode);
            const out = execSync(`python3 "${tmp}"`, { encoding:"utf-8", timeout:15000, stdio:["pipe","pipe","pipe"] });
            try { fs.unlinkSync(tmp); } catch(_) {}
            fileContent = JSON.parse(out).t;
          } catch(_) { fileContent = "[Could not read DOCX]"; }
        } else if ([".xlsx",".xls"].includes(ext)) {
          try {
            const pyCode = `import sys,json\ntry:\n    import openpyxl\nexcept ImportError:\n    import subprocess;subprocess.check_call([sys.executable,"-m","pip","install","openpyxl","-q"]);import openpyxl\nwb=openpyxl.load_workbook(${JSON.stringify(filePath)},data_only=True)\nws=wb.active\nrows=[]\nfor row in ws.iter_rows(values_only=True):\n    rows.append([str(v) if v is not None else "" for v in row])\nprint(json.dumps({"t":"\\n".join([" | ".join(r) for r in rows[:100]])}))`;
            const tmp = path.join(os.tmpdir(), `ml_fp_${Date.now()}.py`);
            fs.writeFileSync(tmp, pyCode);
            const out = execSync(`python3 "${tmp}"`, { encoding:"utf-8", timeout:15000, stdio:["pipe","pipe","pipe"] });
            try { fs.unlinkSync(tmp); } catch(_) {}
            fileContent = JSON.parse(out).t;
          } catch(_) { fileContent = "[Could not read Excel]"; }
        } else if ([".png",".jpg",".jpeg",".gif",".webp",".svg",".bmp"].includes(ext)) {
          fileContent = `[Image file: ${path.basename(filePath)} (${(size/1024).toFixed(1)}KB)]`;
        } else {
          try { fileContent = fs.readFileSync(filePath, "utf-8").slice(0, 4000); }
          catch(_) { fileContent = "[Could not read file]"; }
        }
        if (fileContent) {
          console.log(co(C.bCyan, `  📎 Attached: `) + co(C.dim, `${path.basename(filePath)} (${ext}, ${(size/1024).toFixed(1)}KB)`));
          message = message.replace(match, `\n\n[FILE: ${path.basename(filePath)}]\n${fileContent}\n[END FILE]\n\n`);
        }
      }
    }
  }
  return message;
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" || args[i] === "-m") { CONFIG.model = args[++i]; }
    if (args[i] === "--name"  || args[i] === "-n") { SESSION.name = args[++i]; }
    if (args[i] === "--auto")  { CONFIG.autoApprove = true; }
    if (args[i] === "--temp")  { CONFIG.temperature = parseFloat(args[++i]); }
    if (args[i] === "--ctx")   { CONFIG.numCtx = parseInt(args[++i]); }
    if (args[i] === "--cwd"  || args[i] === "-d") {
      const target = args[++i];
      if (fs.existsSync(target)) { process.chdir(target); SESSION.cwd = process.cwd(); }
      else { console.log(`  ✗ Directory not found: ${target}`); process.exit(1); }
    }
    if (args[i] === "-p" || args[i] === "--prompt") {
      // One-shot mode — run file paste detection first (same as interactive)
      let prompt = args[++i];
      prompt = processFilePaste(prompt);
      await chat(prompt);
      process.exit(0);
    }
  }

  // Auto-detect model from Ollama if not set
  if (!CONFIG.model) {
    try {
      const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
      const data = await res.json();
      if (data.models?.length) {
        CONFIG.model = data.models[0].name;
        saveConfig();
        console.log(co(C.bGreen, `  ✓ Auto-detected model: ${CONFIG.model}`));
      } else {
        console.log(co(C.bRed, "  ✗ No models installed. Run: ollama pull llama3.2"));
        process.exit(1);
      }
    } catch (_) {
      console.log(co(C.bRed, "  ✗ Cannot connect to Ollama. Run: ollama serve"));
      process.exit(1);
    }
  }

  // Warn if CWD is attar-code's own install directory
  if (path.resolve(SESSION.cwd) === path.resolve(__dirname)) {
    console.log();
    console.log(co(C.bYellow, "  ⚠ You are running attar-code from its own directory."));
    console.log(co(C.dim,     "    Files created by the AI will go here. To work in a different project:"));
    console.log(co(C.cyan,    "    • Use /cd <path>  inside attar-code"));
    console.log(co(C.cyan,    "    • Or run: node attar-code.js --cwd /path/to/project"));
    console.log(co(C.cyan,    "    • Or: cd /your/project && node ~/Desktop/Attar-Cli/attar-code.js"));
    console.log();
  }

  printBanner();

  // Check Ollama
  try {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
    const data = await res.json();
    const models = (data.models||[]).map(m=>m.name);
    if (!models.includes(CONFIG.model)) {
      console.log(co(C.bYellow, `  ⚠ Model "${CONFIG.model}" not found locally.`));
      console.log(co(C.dim, `  Run: `) + co(C.yellow, `ollama pull ${CONFIG.model}\n`));
    }
  } catch (_) {
    console.log(co(C.bRed, "  ✗ Ollama not running. Start it: ") + co(C.yellow, "ollama serve\n"));
  }

  const rl = readline.createInterface({ input:process.stdin, output:process.stdout, terminal:true });

  const prompt = () => {
    const cwd  = SESSION.cwd.replace(os.homedir(),"~");
    const name = SESSION.name ? co(C.dim, `(${SESSION.name}) `) : "";
    rl.setPrompt(`\n${name}${co(C.bGreen,"  ❯ ")}${co(C.green, cwd)}${co(C.bGreen," ❯❯ ")}${C.bWhite}`);
    rl.prompt();
  };

  prompt();

  rl.on("line", async (input) => {
    input = input.trim();
    if (!input) { prompt(); return; }

    // Handle permission response
    if (pendingApproval) {
      const resolve = pendingApproval;
      pendingApproval = null;
      if (input.toLowerCase() === "always") { CONFIG.autoApprove = true; saveConfig(); resolve(true); }
      else { resolve(input.toLowerCase() === "y"); }
      prompt(); return;
    }

    if (input.startsWith("/") || input.startsWith("!")) {
      await handleCommand(input);
    } else {
      // ── Step 1: File paste detection FIRST ────────────────────────
      let message = processFilePaste(input);

      // No direct action handler — model handles everything via tools

      // ── Step 3: Full model chat ────────────────────────────────
      if (SESSION.planMode && SESSION.plan) {
        await chat(`[Plan mode] ${message}`);
      } else {
        await chat(message);
      }
    }

    prompt();
  });

  rl.on("close", () => {
    saveSession();
    console.log("\n" + co(C.bCyan,"  ✦ ") + co(C.dim,"Goodbye bro. 🔥\n"));
    process.exit(0);
  });
}

main().catch(console.error);
