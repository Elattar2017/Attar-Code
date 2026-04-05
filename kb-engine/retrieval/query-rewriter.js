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

// ── Grammar-word ratio approach (zero domain keywords) ───────────────────────
//
// Instead of hardcoded regex patterns that break on "class in python" vs
// "class MyComponent", we detect WHETHER a query is natural language using
// universal grammar/function words. These are purely structural English words
// that appear in questions/requests but never in code identifiers.

const GRAMMAR_WORDS = new Set([
  // Pronouns / determiners
  'i','my','me','we','our','you','your','it','its','this','that',
  'these','those','they','their','them',
  // Question words
  'what','how','why','when','where','who','which',
  // Articles / prepositions
  'a','an','the','in','for','of','to','at','on','by','with','about','between',
  // Conjunctions / logical
  'and','or','but','not','no','if',
  // Auxiliary verbs
  'is','are','was','were','be','been','have','has','do','does','did',
  'will','would','could','should','can','may','might',
  // High-signal intent words (appear in queries, never in code identifiers)
  'need','want','help','get','fix','make','please','explain',
  'understand','tell','show','give','find',
]);

const GRAMMAR_RATIO_THRESHOLD = 0.40;

// Regex to detect code/technical syntax characters in a token
const SPECIFICITY_RE = /[.()[\]{}<>=;:/\\$@#_]/;

/**
 * Classify whether a query is natural language (needs rewriting) or
 * technical/code (skip rewriting). Uses structural signal analysis —
 * zero domain-specific keyword lists.
 *
 * grammarRatio:    fraction of tokens that are universal grammar words
 * specificityNorm: normalized score for tokens that look like code identifiers
 * vaguenessScore:  grammarRatio - specificityNorm * 0.5 (higher = more NL)
 *
 * @param {string} query
 * @returns {{ isNaturalLanguage: boolean, grammarRatio: number, specificityNorm: number, vaguenessScore: number }}
 */
function classifyQueryNature(query) {
  const tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
  const n = tokens.length;
  if (n === 0) return { isNaturalLanguage: false, grammarRatio: 0, specificityNorm: 0, vaguenessScore: 0 };

  // Grammar ratio: count pure grammar/function-word tokens
  let grammarCount = 0;
  for (const tok of tokens) {
    const lower = tok.replace(/[^a-z]/gi, '').toLowerCase();
    if (GRAMMAR_WORDS.has(lower)) grammarCount++;
  }
  const grammarRatio = grammarCount / n;

  // Specificity bonus: tokens that look like code identifiers
  let specificityBonus = 0;
  for (const tok of tokens) {
    const core = tok.replace(/^[^a-zA-Z0-9$_@#]+|[^a-zA-Z0-9$_@#]+$/g, '');
    if (core.length === 0) continue;

    if (SPECIFICITY_RE.test(tok))            specificityBonus += 0.30; // syntax char (., :, (), etc.)
    if (/^[A-Z]{3,}$/.test(core))            specificityBonus += 0.35; // ALL_CAPS acronym (ENOENT, HTTP)
    if (/^[A-Z][a-z]+[A-Z]/.test(core) ||
        /^[a-z]+[A-Z]/.test(core))           specificityBonus += 0.30; // CamelCase / camelCase
    if (/^\d+\.\d+/.test(core))              specificityBonus += 0.30; // version number (3.10)
    if (/:$/.test(tok) && core.length > 5)   specificityBonus += 0.35; // ErrorName: prefix
  }

  const specificityNorm = Math.min(specificityBonus / n, 1.0);
  const vaguenessScore  = Math.max(0, grammarRatio - specificityNorm * 0.5);

  return {
    isNaturalLanguage: vaguenessScore >= GRAMMAR_RATIO_THRESHOLD,
    grammarRatio,
    specificityNorm,
    vaguenessScore,
  };
}

/**
 * Detect if a query is vague/natural-language and would benefit from rewriting.
 * Uses structural signal analysis — no domain keyword lists.
 *
 * @param {string} query
 * @returns {boolean}
 */
/**
 * Check if query is predominantly non-Latin script (Arabic, CJK, Cyrillic, etc.)
 * Non-English queries should bypass the English LLM rewriter and decomposer.
 */
function isLikelyNonEnglish(query) {
  if (!query || query.length < 4) return false;
  const nonLatin = (query.match(/[^\u0000-\u024F\s\d]/g) || []).length;
  return nonLatin / query.length > 0.2;
}

function needsRewriting(query) {
  if (!query || query.length < 5) return false;
  if (isLikelyNonEnglish(query)) return false; // non-English → skip rewriter
  if (query.length > 150) return true;  // pasted error dump
  return classifyQueryNature(query).isNaturalLanguage;
}

/**
 * Detect if a query should be decomposed into sub-queries.
 * @param {string} query
 * @returns {boolean}
 */
function needsDecomposition(query) {
  if (isLikelyNonEnglish(query)) return false; // non-English → skip decomposition
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
  isLikelyNonEnglish,
  classifyQueryNature,
  REWRITE_TYPES,
};
