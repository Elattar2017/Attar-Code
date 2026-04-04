"use strict";

/**
 * kb-engine/sparse-vectors.js
 *
 * BM25 sparse vector computation for Qdrant keyword matching.
 *
 * Usage:
 *   const sv = new SparseVectorizer();
 *   sv.addDocument("id1", "some text here");
 *   sv.addDocument("id2", "more text content");
 *   sv.build();                                    // compute IDF weights
 *   const vec = sv.computeSparseVector("text");    // { indices, values }
 *   sv.getVocabularySize();                        // number of unique tokens
 *
 * BM25 parameters: k1=1.2, b=0.75
 * IDF formula:   log((N - df + 0.5) / (df + 0.5) + 1)
 * TF norm:       (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * docLen / avgDocLen))
 *
 * No external dependencies — pure JavaScript.
 */

// ---------------------------------------------------------------------------
// BM25 constants
// ---------------------------------------------------------------------------
const K1 = 1.2;
const B  = 0.75;

// Token length bounds (inclusive)
const MIN_TOKEN_LEN = 2;
const MAX_TOKEN_LEN = 50;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize text: lowercase, split on non-alphanumeric chars,
 * filter tokens outside [MIN_TOKEN_LEN, MAX_TOKEN_LEN].
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && t.length <= MAX_TOKEN_LEN);
}

// ---------------------------------------------------------------------------
// SparseVectorizer
// ---------------------------------------------------------------------------

class SparseVectorizer {
  constructor() {
    /**
     * Map<token, termId> — assigned in build().
     * @type {Map<string, number>}
     */
    this._vocab = new Map();

    /**
     * Map<token, df> — document frequency accumulated during addDocument.
     * @type {Map<string, number>}
     */
    this._df = new Map();

    /**
     * Map<token, idf> — computed in build().
     * @type {Map<string, number>}
     */
    this._idf = new Map();

    /**
     * Total number of documents added.
     * @type {number}
     */
    this._N = 0;

    /**
     * Sum of all document lengths (in tokens), used for avgDocLen.
     * @type {number}
     */
    this._totalDocLen = 0;

    /**
     * Average document length — computed in build().
     * @type {number}
     */
    this._avgDocLen = 0;

    /**
     * Whether build() has been called.
     * @type {boolean}
     */
    this._built = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add a document to the corpus.  Must be called before build().
   *
   * @param {string} id   — document identifier (not stored, for caller use)
   * @param {string} text — raw document text
   */
  addDocument(id, text) {
    const tokens = tokenize(text);
    this._N += 1;
    this._totalDocLen += tokens.length;

    // Count each unique token once per document (document frequency)
    const seen = new Set(tokens);
    for (const token of seen) {
      this._df.set(token, (this._df.get(token) || 0) + 1);
    }
  }

  /**
   * Compute IDF weights from the accumulated corpus.
   * Must be called after all addDocument() calls and before computeSparseVector().
   *
   * INCREMENTAL: Existing term→ID mappings are preserved across multiple build() calls.
   * Only NEW terms (not yet in _vocab) get fresh IDs starting after the current max.
   * This ensures previously stored Qdrant sparse vectors remain valid.
   */
  build() {
    const N = this._N;
    this._avgDocLen = N > 0 ? this._totalDocLen / N : 0;

    // Start new term IDs after existing vocabulary (preserves prior mappings)
    let nextTermId = this._vocab.size;

    for (const [token, df] of this._df.entries()) {
      // Only assign ID to terms not already in vocabulary
      if (!this._vocab.has(token)) {
        this._vocab.set(token, nextTermId++);
      }

      // Recompute IDF for ALL terms (corpus stats changed)
      // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      this._idf.set(token, idf);
    }

    this._built = true;
  }

  /**
   * Compute the BM25 sparse vector for a query/document text.
   *
   * The returned sparse vector is compatible with Qdrant's SparseVector format:
   *   { indices: number[], values: number[] }
   *
   * Only tokens present in the vocabulary (built corpus) produce entries.
   * Out-of-vocabulary tokens are silently ignored.
   *
   * @param {string} text
   * @returns {{ indices: number[], values: number[] }}
   */
  computeSparseVector(text) {
    const emptyResult = { indices: [], values: [] };
    if (!this._built) return emptyResult;

    const tokens = tokenize(text);
    if (tokens.length === 0) return emptyResult;

    // Count term frequencies in this text
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    const docLen    = tokens.length;
    const avgDocLen = this._avgDocLen || 1; // guard against zero-length corpus

    const indices = [];
    const values  = [];

    for (const [token, freq] of tf.entries()) {
      // Skip OOV tokens
      if (!this._vocab.has(token)) continue;

      const termId = this._vocab.get(token);
      const idf    = this._idf.get(token);

      // BM25 TF normalisation
      const tfNorm =
        (freq * (K1 + 1)) /
        (freq + K1 * (1 - B + B * (docLen / avgDocLen)));

      const score = idf * tfNorm;

      // Only add positive scores (IDF can theoretically be 0 for df = N with
      // N=1; in practice log(4/3) > 0, but guard defensively)
      if (score > 0) {
        indices.push(termId);
        values.push(score);
      }
    }

    // Sort by index for deterministic ordering (Qdrant requires sorted indices)
    if (indices.length > 1) {
      const order = indices
        .map((idx, i) => i)
        .sort((a, b) => indices[a] - indices[b]);

      const sortedIndices = order.map((i) => indices[i]);
      const sortedValues  = order.map((i) => values[i]);
      return { indices: sortedIndices, values: sortedValues };
    }

    return { indices, values };
  }

  /**
   * Return the number of unique tokens in the vocabulary.
   * Returns 0 if build() has not been called yet.
   *
   * @returns {number}
   */
  getVocabularySize() {
    return this._vocab.size;
  }

  // -------------------------------------------------------------------------
  // Serialization (for disk persistence)
  // -------------------------------------------------------------------------

  /**
   * Serialize vocabulary state to a plain object suitable for JSON.stringify.
   * Preserves exact term→ID mappings so deserialized vocab produces identical
   * sparse vectors for the same input text.
   *
   * @returns {object}
   */
  serialize() {
    return {
      schema_version: 1,
      vocab:       Array.from(this._vocab.entries()),
      df:          Array.from(this._df.entries()),
      idf:         Array.from(this._idf.entries()),
      N:           this._N,
      totalDocLen: this._totalDocLen,
      avgDocLen:   this._avgDocLen,
      built:       this._built,
    };
  }

  /**
   * Restore a SparseVectorizer from a serialized state.
   * The restored instance can accept new addDocument() + build() calls
   * and will preserve existing term→ID mappings (incremental build).
   *
   * @param {object} data - Output of serialize()
   * @returns {SparseVectorizer}
   */
  static deserialize(data) {
    if (!data || data.schema_version !== 1) return null;
    const sv = new SparseVectorizer();
    sv._vocab       = new Map(data.vocab);
    sv._df          = new Map(data.df);
    sv._idf         = new Map(data.idf);
    sv._N           = data.N;
    sv._totalDocLen  = data.totalDocLen;
    sv._avgDocLen    = data.avgDocLen;
    sv._built        = data.built;
    return sv;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { SparseVectorizer, tokenize };
