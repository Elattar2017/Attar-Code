// kb-engine/embedder.js — UnifiedEmbedder: Qwen3-Embedding-4B (2560-dim, asymmetric prefixes)
"use strict";

const {
  OLLAMA_URL,
  EMBED_MODEL,
  EMBED_DIM,
  EMBED_QUERY_PREFIX,
  EMBED_ERROR_PREFIX,
  EMBED_CODE_PREFIX,
  EMBED_STRUCTURAL_PREFIX,
} = require("./config");

// ─── Query-type → instruction prefix map ─────────────────────────────────────

const QUERY_PREFIX_MAP = {
  general:    EMBED_QUERY_PREFIX,
  error:      EMBED_ERROR_PREFIX,
  code:       EMBED_CODE_PREFIX,
  structural: EMBED_STRUCTURAL_PREFIX,
};

// ─── HTTP helper (no external deps — uses Node.js built-ins) ──────────────────

/**
 * POST JSON to a URL. Returns parsed response body.
 * @param {string} url
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function postJSON(url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const http = url.startsWith("https") ? require("https") : require("http");
    const payload = JSON.stringify(body);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith("https") ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message} — body: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

// ─── Vector utilities ─────────────────────────────────────────────────────────

/**
 * Pad a vector with zeros to reach targetDim, or truncate if longer.
 * @param {number[]} vec
 * @param {number} targetDim
 * @returns {number[]}
 */
function resizeVector(vec, targetDim) {
  if (vec.length === targetDim) return vec;
  if (vec.length > targetDim) return vec.slice(0, targetDim);
  // pad with zeros
  const padded = new Array(targetDim).fill(0);
  for (let i = 0; i < vec.length; i++) padded[i] = vec[i];
  return padded;
}

/**
 * Returns a zero vector of the specified dimension.
 * @param {number} dim
 * @returns {number[]}
 */
function zeroVector(dim) {
  return new Array(dim).fill(0);
}

// ─── UnifiedEmbedder ─────────────────────────────────────────────────────────

class UnifiedEmbedder {
  constructor() {
    // Cache: null = not yet checked, true/false = known state
    this._modelAvailable = null;
  }

  // ── Cache management ───────────────────────────────────────────────────────

  /**
   * Clear cached model availability so next call re-probes Ollama.
   */
  resetCache() {
    this._modelAvailable = null;
  }

  // ── Model availability ─────────────────────────────────────────────────────

  /**
   * Probe Ollama to see if the embedding model is installed.
   * Results are cached after the first call (reset with resetCache()).
   * @returns {Promise<{ model: boolean, codeModel: boolean, textModel: boolean }>}
   */
  async getAvailableModels() {
    if (this._modelAvailable === null) {
      await this._probeModel();
    }
    return {
      model: this._modelAvailable,
      // Backward compat aliases
      codeModel: this._modelAvailable,
      textModel: this._modelAvailable,
    };
  }

  /**
   * Probe the unified model by sending a minimal embed request.
   */
  async _probeModel() {
    try {
      const result = await postJSON(
        `${OLLAMA_URL}/api/embed`,
        { model: EMBED_MODEL, input: "ping" },
        10000 // shorter timeout for probing
      );
      this._modelAvailable = Array.isArray(result.embeddings) && result.embeddings.length > 0;
    } catch {
      this._modelAvailable = false;
    }
  }

  // ── Core embedding call ────────────────────────────────────────────────────

  /**
   * Call Ollama /api/embed for one or more inputs.
   * @param {string | string[]} input
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async _callEmbed(input) {
    const body = { model: EMBED_MODEL, input };
    const result = await postJSON(`${OLLAMA_URL}/api/embed`, body, 60000);

    if (!result.embeddings || !Array.isArray(result.embeddings)) {
      throw new Error(
        `Ollama returned unexpected response for model "${EMBED_MODEL}": ${JSON.stringify(result).slice(0, 200)}`
      );
    }
    return result.embeddings; // array of float arrays
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Embed raw text for storage (no instruction prefix).
   * Used when indexing documents into Qdrant.
   * @param {string} text
   * @returns {Promise<number[]>} 2560-dim vector
   */
  async embedForStorage(text) {
    await this.getAvailableModels();

    if (!this._modelAvailable) {
      this._throwNoModel();
    }

    try {
      const vecs = await this._callEmbed(text);
      return resizeVector(vecs[0], EMBED_DIM);
    } catch (err) {
      console.error(`[UnifiedEmbedder] embedForStorage failed: ${err.message}`);
      return zeroVector(EMBED_DIM);
    }
  }

  /**
   * Embed text for querying (with instruction prefix based on queryType).
   * Used when searching — the asymmetric prefix improves retrieval quality.
   *
   * @param {string} text
   * @param {string} [queryType='general']  One of: 'general', 'error', 'code', 'structural'
   * @returns {Promise<number[]>} 2560-dim vector
   */
  async embedForQuery(text, queryType = "general") {
    await this.getAvailableModels();

    if (!this._modelAvailable) {
      this._throwNoModel();
    }

    const prefix = QUERY_PREFIX_MAP[queryType] || QUERY_PREFIX_MAP.general;
    const prefixedText = prefix + text;

    try {
      const vecs = await this._callEmbed(prefixedText);
      return resizeVector(vecs[0], EMBED_DIM);
    } catch (err) {
      console.error(`[UnifiedEmbedder] embedForQuery failed: ${err.message}`);
      return zeroVector(EMBED_DIM);
    }
  }

  /**
   * Batch embed for storage (no prefix). Returns array of 2560-dim vectors.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    await this.getAvailableModels();

    if (!this._modelAvailable) {
      this._throwNoModel();
    }

    try {
      const vecs = await this._callEmbed(texts);
      return vecs.map((v) => resizeVector(v, EMBED_DIM));
    } catch (err) {
      console.error(`[UnifiedEmbedder] embedBatch failed, falling back to sequential: ${err.message}`);
      // Fallback: embed one-by-one
      const results = [];
      for (const text of texts) {
        try {
          const vecs = await this._callEmbed(text);
          results.push(resizeVector(vecs[0], EMBED_DIM));
        } catch {
          results.push(zeroVector(EMBED_DIM));
        }
      }
      return results;
    }
  }

  /**
   * Batch embed for queries (with instruction prefix). Returns array of 2560-dim vectors.
   * @param {string[]} texts
   * @param {string} [queryType='general']  One of: 'general', 'error', 'code', 'structural'
   * @returns {Promise<number[][]>}
   */
  async embedBatchForQuery(texts, queryType = "general") {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const prefix = QUERY_PREFIX_MAP[queryType] || QUERY_PREFIX_MAP.general;
    const prefixedTexts = texts.map((t) => prefix + t);

    await this.getAvailableModels();

    if (!this._modelAvailable) {
      this._throwNoModel();
    }

    try {
      const vecs = await this._callEmbed(prefixedTexts);
      return vecs.map((v) => resizeVector(v, EMBED_DIM));
    } catch (err) {
      console.error(`[UnifiedEmbedder] embedBatchForQuery failed, falling back to sequential: ${err.message}`);
      const results = [];
      for (const text of prefixedTexts) {
        try {
          const vecs = await this._callEmbed(text);
          results.push(resizeVector(vecs[0], EMBED_DIM));
        } catch {
          results.push(zeroVector(EMBED_DIM));
        }
      }
      return results;
    }
  }

  // ── Error helpers ──────────────────────────────────────────────────────────

  _throwNoModel() {
    throw new Error(
      `Embedding model not available. Install it with:\n` +
      `  ollama pull ${EMBED_MODEL}\n` +
      `Then ensure Ollama is running: ollama serve`
    );
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

// Backward compat: DualEmbedder is an alias for UnifiedEmbedder
const DualEmbedder = UnifiedEmbedder;

module.exports = { UnifiedEmbedder, DualEmbedder };
