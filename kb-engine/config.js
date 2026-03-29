// kb-engine/config.js — KB Engine configuration constants
const path = require("path");
const os = require("os");

const ATTAR_HOME = path.join(os.homedir(), ".attar-code");

module.exports = {
  // Qdrant
  QDRANT_PORT: 6333,
  QDRANT_HOST: "127.0.0.1",
  QDRANT_URL: "http://127.0.0.1:6333",
  QDRANT_BIN_DIR: path.join(ATTAR_HOME, "bin"),
  QDRANT_STORAGE: path.join(ATTAR_HOME, "qdrant_storage"),
  QDRANT_DOWNLOAD_URLS: {
    "win32-x64": "https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-pc-windows-msvc.zip",
    "darwin-x64": "https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-apple-darwin.tar.gz",
    "darwin-arm64": "https://github.com/qdrant/qdrant/releases/latest/download/qdrant-aarch64-apple-darwin.tar.gz",
    "linux-x64": "https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-unknown-linux-musl.tar.gz",
    "linux-arm64": "https://github.com/qdrant/qdrant/releases/latest/download/qdrant-aarch64-unknown-linux-musl.tar.gz",
  },

  // Ollama Embedding Models
  OLLAMA_URL: "http://127.0.0.1:11434",

  // Unified embedding model (Qwen3-Embedding-4B — 2560-dim, 32K context)
  EMBED_MODEL: "dengcao/Qwen3-Embedding-4B:Q4_K_M",
  EMBED_DIM: 2560,

  // Asymmetric instruction prefixes (Qwen3-Embedding requires these for queries, NOT for documents)
  EMBED_QUERY_PREFIX: "Instruct: Given a search query, retrieve relevant documentation passages that answer the query\nQuery: ",
  EMBED_ERROR_PREFIX: "Instruct: Given an error message, retrieve relevant fix recipes and solutions\nQuery: ",
  EMBED_CODE_PREFIX: "Instruct: Given a code-related query, retrieve relevant code examples and documentation\nQuery: ",
  EMBED_STRUCTURAL_PREFIX: "Instruct: Given a question about document structure, retrieve relevant table of contents and chapter information\nQuery: ",

  // Legacy dual-model constants (kept for migration reference — do NOT use in new code)
  // CODE_EMBED_MODEL: "mxbai-embed-large",     // 335M, 1024-dim, code + technical text
  // TEXT_EMBED_MODEL: "nomic-embed-text",       // 137M, 768-dim, prose + books + tutorials
  // CODE_EMBED_DIM: 1024,
  // TEXT_EMBED_DIM: 768,

  // Collections
  COLLECTIONS: [
    "fix_recipes", "nodejs", "python", "go", "rust", "java",
    "csharp", "php", "ruby", "swift", "css_html", "devops",
    "databases", "general", "personal",
  ],

  // Search
  DEFAULT_SEARCH_LIMIT: 20,
  RERANK_TOP_N: 5,
  MIN_SCORE_THRESHOLD: 0.2, // low threshold — let term-boosting and reranking do the quality filtering
  RRF_K: 60,

  // Ingestion
  BATCH_SIZE: 100,
  MAX_CHUNK_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 80,

  // Paths
  INGESTION_STATE_FILE: path.join(ATTAR_HOME, "kb-ingestion-state.json"),
  KB_KNOWLEDGE_DIR: path.join(ATTAR_HOME, "knowledge"),

  // Structural indexing
  STRUCTURAL_CHUNK_TYPE: 'structural',
  CONTENT_CHUNK_TYPE: 'content',
};
