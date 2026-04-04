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

  // LLM model for enrichment + summary generation (must be a working chat model)
  ENRICHMENT_MODEL: process.env.ENRICHMENT_MODEL || "glm-4.7-flash:latest",

  // Unified embedding model (Qwen3-Embedding-0.6B — 1024-dim, 32K context)
  // MTEB retrieval: 80.83 (vs 85.05 for 4B — reranker compensates the gap)
  // Partial GPU offload: num_gpu=10 uses ~3.4GB VRAM, leaves room for any chat model
  EMBED_MODEL: process.env.EMBED_MODEL || "qwen3-embedding:0.6b",
  EMBED_DIM: 1024,
  EMBED_GPU_LAYERS: parseInt(process.env.EMBED_GPU_LAYERS, 10) || 0, // 0=full CPU (default: leaves all VRAM for chat + reranker)

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

  // Reranker model (HuggingFace model ID for the Python sidecar)
  RERANKER_MODEL: process.env.RERANKER_MODEL || "Qwen/Qwen3-Reranker-0.6B",

  // Search
  DEFAULT_SEARCH_LIMIT: 20,
  RERANK_TOP_N: 5,
  RERANK_CANDIDATES: 40,  // candidates sent to reranker (more = better recall, +1-2s latency)

  // Query Understanding (pre-search rewriting + decomposition)
  QUERY_REWRITE_ENABLED: true,
  QUERY_REWRITE_TIMEOUT: 8000,    // 8s max for LLM rewrite/decompose

  // HyDE (Hypothetical Document Embedding)
  HYDE_ENABLED: true,
  HYDE_TIMEOUT: 10000,    // 10s max for hypothetical generation
  HYDE_MAX_TOKENS: 200,   // hypothetical answer length

  // MMR (Maximal Marginal Relevance) diversity selection
  MMR_ENABLED: true,
  MMR_LAMBDA: 0.7,  // 0.7 = 70% relevance, 30% diversity (0.5-0.9 range recommended)

  // Semantic query cache
  QUERY_CACHE_ENABLED: true,
  QUERY_CACHE_MAX: 500,            // max cached queries (LRU eviction)
  QUERY_CACHE_TTL: 30 * 60 * 1000, // 30 minutes
  QUERY_CACHE_THRESHOLD: 0.88,     // cosine similarity threshold (research: 0.88 optimal for technical KB)
  MIN_SCORE_THRESHOLD: 0.2, // low threshold — let term-boosting and reranking do the quality filtering
  RRF_K: 60,

  // Cross-KB structural aggregation
  CROSS_STRUCTURAL_LIMIT: 50,     // max results per collection for topic search
  CROSS_STRUCTURAL_MIN_CHUNKS: 2, // chapter must have 2+ matching chunks to be listed

  // Ingestion
  BATCH_SIZE: 100,
  MAX_CHUNK_TOKENS: 512,
  CHUNK_OVERLAP_TOKENS: 80,

  // Paths
  INGESTION_STATE_FILE: path.join(ATTAR_HOME, "kb-ingestion-state.json"),
  KB_KNOWLEDGE_DIR: path.join(ATTAR_HOME, "knowledge"),
  BM25_VOCAB_DIR: path.join(ATTAR_HOME, "bm25-vocab"),
  DNA_DIR: path.join(ATTAR_HOME, "knowledge", "dna"),

  // Document DNA scoring (multiplicative boosts — industry standard)
  DNA_AUTHORITY_MULT: {
    canonical: 1.15, "industry-standard": 1.10, "known-author": 1.05,
    community: 1.0, personal: 0.95,
  },
  DNA_FRESHNESS_MULT: { current: 1.05, dated: 1.0, legacy: 0.90 },
  DNA_TRUST_WEIGHT: 0.03,  // per-point above/below trust=3 baseline

  // Quality feedback loop
  FEEDBACK_ENABLED: false,  // disabled by default until stable
  FEEDBACK_FILE: path.join(ATTAR_HOME, "kb-feedback.jsonl"),
  FEEDBACK_DECAY: 0.95,
  FEEDBACK_DECAY_INTERVAL_DAYS: 7,

  // Structural indexing
  STRUCTURAL_CHUNK_TYPE: 'structural',
  CONTENT_CHUNK_TYPE: 'content',
};
