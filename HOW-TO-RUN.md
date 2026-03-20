# Attar Code — How to Run

## Prerequisites

1. **Node.js** (v18+)
   ```bash
   node --version
   ```

2. **Ollama** — local AI model runtime
   ```bash
   # Install: https://ollama.com
   # Start the server:
   ollama serve

   # Pull a model (pick one):
   ollama pull llama3.2          # 3B — fast, lightweight
   ollama pull qwen2.5:14b       # 14B — balanced
   ollama pull qwen2.5:32b       # 32B — powerful
   ollama pull glm-4.7-flash     # 9B — good tool calling
   ```

3. **Python 3** (for PDF/DOCX/Excel creation and knowledge base)
   ```bash
   python3 --version
   ```

---

## Quick Start

```bash
cd ~/Desktop/Attar-Cli

# 1. Start the search proxy (web search + KB — run in a separate terminal)
node search-proxy.js

# 2. Start attar-code
node attar-code.js
```

That's it. Attar Code auto-detects your first installed Ollama model.

---

## CLI Flags

```bash
node attar-code.js [flags]
```

| Flag | Short | Description | Example |
|------|-------|-------------|---------|
| `--model <name>` | `-m` | Use specific model | `--model qwen2.5:32b` |
| `--cwd <path>` | `-d` | Set working directory | `--cwd ~/projects/myapp` |
| `--auto` | | Auto-approve all tool calls | `--auto` |
| `--temp <0-2>` | | Set temperature | `--temp 0.3` |
| `--ctx <tokens>` | | Set context window size | `--ctx 65536` |
| `--prompt <text>` | `-p` | One-shot mode (run and exit) | `-p "create hello world"` |
| `--name <label>` | `-n` | Name this session | `--name my-project` |

### Examples

```bash
# Work on a specific project with a 32B model
node attar-code.js --model qwen2.5:32b --cwd ~/projects/myapp --auto

# One-shot: create a file and exit
node attar-code.js -p "create a node.js express server with 3 endpoints" --auto

# Large context for big codebases
node attar-code.js --ctx 131072 --model qwen2.5:32b

# Low temperature for precise code edits
node attar-code.js --temp 0.2

# Summarize a PDF into a docx (one-shot)
node attar-code.js -p "summarize /path/to/report.pdf into summary.docx" --auto
```

---

## Slash Commands (inside the CLI)

### Models & Config
| Command | Description |
|---------|-------------|
| `/model <name>` | Switch model (e.g., `/model mistral`) |
| `/models` | List all installed Ollama models |
| `/temp <0-2>` | Set temperature |
| `/ctx <tokens>` | Set context window size |

### Session
| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/save [file]` | Save session to JSON |
| `/load <file>` | Load session from file |
| `/cd <path>` | Change working directory |

### Tools
| Command | Description |
|---------|-------------|
| `/todo` | View TODO list |
| `/memory` | View/edit persistent memory |
| `/cp [label]` | Create checkpoint |
| `/rewind [n]` | Rewind to checkpoint |
| `/kb list` | List knowledge base documents |
| `/kb add <file>` | Add file to knowledge base |

### Other
| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/exit` | Quit |

---

## Search Proxy

The search proxy provides web search, URL fetching, and knowledge base functionality. Run it in a **separate terminal**:

```bash
cd ~/Desktop/Attar-Cli
node search-proxy.js
```

It runs on `http://localhost:3001` and provides:
- **Web search** — DuckDuckGo (no API key needed)
- **URL fetch** — clean text extraction from web pages
- **Knowledge base** — semantic search over your local documents

### Knowledge Base Setup (optional)

Requires Python packages for vector search:
```bash
pip3 install chromadb sentence-transformers
```

Add documents:
```bash
# Inside attar-code:
/kb add /path/to/document.pdf
/kb add /path/to/notes.md
/kb list
```

Or drop files directly into `~/.attar-code/knowledge/`:
- `books/` — PDFs
- `docs/` — markdown, text files
- `code/` — source code files

---

## File Structure

```
Attar-Cli/
  attar-code.js           # Main CLI (the AI assistant)
  search-proxy.js          # Web search + KB server (port 3001)
  search-proxy-package.json # Dependencies for search proxy
  chroma_bridge.py         # Python bridge for ChromaDB vector search
```

### Config & Data

```
~/.attar-code/
  config.json              # Saved settings (model, temp, ctx, etc.)
  MEMORY.md                # Persistent memory (project facts)
  sessions/                # Saved conversation sessions
  checkpoints/             # File snapshots for /rewind
  commands/                # Custom slash commands (.md files)
  knowledge/               # Knowledge base documents
    books/                 # PDFs
    docs/                  # Text/markdown files
    code/                  # Source code
    .index/                # ChromaDB vector index
```

---

## 18 Available Tools

| Tool | What it does |
|------|-------------|
| `run_bash` | Run any shell command (git, npm, tests, curl, etc.) |
| `read_file` | Read any file (code, PDF, docx, xlsx) |
| `write_file` | Create/overwrite files |
| `edit_file` | Replace text in existing files |
| `grep_search` | Search file contents by regex |
| `find_files` | Find files by glob pattern |
| `get_project_structure` | Directory tree view |
| `start_server` | Start background server process |
| `web_search` | Search the web (DuckDuckGo) |
| `web_fetch` | Fetch URL content + code examples |
| `kb_search` | Semantic search in local knowledge base |
| `kb_add` | Add document to knowledge base |
| `kb_list` | List knowledge base documents |
| `create_pdf` | Create PDF document |
| `create_docx` | Create Word document |
| `create_excel` | Create Excel spreadsheet |
| `create_pptx` | Create PowerPoint presentation |
| `create_chart` | Create chart/graph as PNG |

---

## Troubleshooting

**"Cannot connect to Ollama"**
```bash
ollama serve   # Start Ollama first
```

**"No models installed"**
```bash
ollama pull qwen2.5:14b   # Pull any model
```

**"fetch failed" or Ollama 500 error**
```bash
# Increase context window:
node attar-code.js --ctx 65536

# Or inside the CLI:
/ctx 65536
```

**Search/KB not working**
```bash
# Start the search proxy in another terminal:
node search-proxy.js

# Install dependencies if needed:
cd ~/Desktop/Attar-Cli
npm install --prefix . express axios cheerio pdf-parse
```

**KB search slow or not working**
```bash
pip3 install chromadb sentence-transformers
```
