// kb-engine/retrieval/query-rewriter.js
// Pre-search query understanding: rewriting + decomposition.
//
// rewriteQuery:    "fix this error" → "Python TypeError handling async context manager"
// decomposeQuery:  "compare async in Python vs JavaScript" → ["async patterns Python", "async patterns JavaScript"]
//
// Both use the currently loaded Ollama chat model. Graceful fallback on failure.
"use strict";

const config = require("../config");

// Query types that benefit from rewriting (vague/messy queries)
const REWRITE_TYPES = new Set(["general", "conceptual", "error", "api"]);

// Patterns that suggest the query needs decomposition (comparisons, multi-topic)
const DECOMPOSE_PATTERNS = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\bcompare\b/i,
  /\bcomparison\b/i,
  /\bdifference\s+between\b/i,
  /\band\b.+\bor\b/i,
  /\bboth\b.+\band\b/i,
];

// Patterns that suggest the query is already clean (no rewriting needed)
const CLEAN_QUERY_PATTERNS = [
  /^[A-Z][a-z]+Error/,        // TypeError, SyntaxError
  /^[A-Z]{2,}/,               // ENOENT, ECONNREFUSED
  /\bfunction\b.*\(/,         // function signatures
  /\bclass\b\s+\w+/,          // class names
  /\bimport\b/,               // import statements
  /^\d+\.\d+/,                // version numbers (3.1.2)
];

/**
 * Detect if a query is vague/messy and would benefit from rewriting.
 * @param {string} query
 * @returns {boolean}
 */
function needsRewriting(query) {
  if (!query || query.length < 5) return false;
  // Already clean/specific — don't rewrite
  if (CLEAN_QUERY_PATTERNS.some(p => p.test(query))) return false;
  // Very short queries are likely vague
  if (query.split(/\s+/).length <= 3) return true;
  // Queries with pronouns/vague references
  if (/\b(this|that|it|these|those|my|the)\b/i.test(query) && query.length < 80) return true;
  // Queries that are just pasted error output (long, mixed case)
  if (query.length > 150) return true;
  return false;
}

/**
 * Detect if a query should be decomposed into sub-queries.
 * @param {string} query
 * @returns {boolean}
 */
function needsDecomposition(query) {
  return DECOMPOSE_PATTERNS.some(p => p.test(query));
}

/**
 * Rewrite a vague/messy query into an optimized search query using LLM.
 *
 * @param {string} query       Original user query
 * @param {string} [ollamaUrl] Ollama base URL
 * @param {string} [model]     Chat model name
 * @param {object} [context]   { tech, type } from query analysis
 * @returns {Promise<string>}  Rewritten query, or original on failure
 */
async function rewriteQuery(query, ollamaUrl, model, context = {}) {
  if (!needsRewriting(query)) return query;

  const url = ollamaUrl || config.OLLAMA_URL;
  const useModel = model || config.ENRICHMENT_MODEL || "glm-4.7-flash:latest";
  const timeout = config.QUERY_REWRITE_TIMEOUT || 8000;

  const techHint = context.tech ? ` (technology: ${context.tech})` : "";
  const prompt =
    `Rewrite this search query to be more specific and effective for searching technical documentation${techHint}. ` +
    `Output ONLY the rewritten query, nothing else. Keep it under 20 words.\n\n` +
    `Original: ${query}`;

  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: 60 },
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) return query;
    const data = await res.json();
    const rewritten = (data.message?.content || "").trim().replace(/^["']|["']$/g, "");

    // Validate: rewritten must be reasonable
    if (rewritten.length > 10 && rewritten.length < 200 && !rewritten.includes("\n")) {
      return rewritten;
    }
    return query;
  } catch (_) {
    return query;
  }
}

/**
 * Decompose a complex query into focused sub-queries using LLM.
 *
 * @param {string} query       Original query
 * @param {string} [ollamaUrl] Ollama base URL
 * @param {string} [model]     Chat model name
 * @returns {Promise<string[]>} Array of sub-queries (1-3), or [query] on failure
 */
async function decomposeQuery(query, ollamaUrl, model) {
  if (!needsDecomposition(query)) return [query];

  const url = ollamaUrl || config.OLLAMA_URL;
  const useModel = model || config.ENRICHMENT_MODEL || "glm-4.7-flash:latest";
  const timeout = config.QUERY_REWRITE_TIMEOUT || 8000;

  const prompt =
    `Break this complex question into 2-3 focused search sub-queries. ` +
    `Each sub-query should target one specific topic. ` +
    `Output ONLY the sub-queries, one per line. No numbering, no explanation.\n\n` +
    `Question: ${query}`;

  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: 100 },
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) return [query];
    const data = await res.json();
    const lines = (data.message?.content || "")
      .split("\n")
      .map(l => l.replace(/^\d+[.)]\s*/, "").replace(/^[-•]\s*/, "").trim())
      .filter(l => l.length > 5 && l.length < 150);

    if (lines.length >= 2 && lines.length <= 4) {
      return lines.slice(0, 3);
    }
    return [query];
  } catch (_) {
    return [query];
  }
}

module.exports = {
  rewriteQuery,
  decomposeQuery,
  needsRewriting,
  needsDecomposition,
  REWRITE_TYPES,
};
