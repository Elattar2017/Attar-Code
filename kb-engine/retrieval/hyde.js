// kb-engine/retrieval/hyde.js
// HyDE — Hypothetical Document Embedding
//
// Generates a hypothetical ideal answer to a query, then embeds that
// hypothetical text for dense search. The hypothesis embedding is closer
// in vector space to relevant documents than the raw query.
//
// Only activates for conceptual, error, api, and general query types.
// Scope, structural, and code_examples queries skip HyDE.
"use strict";

const config = require("../config");

/**
 * Query types that benefit from HyDE.
 * Scope/structural/code_examples have specialized retrieval paths.
 */
const HYDE_TYPES = new Set(["conceptual", "error", "api", "general"]);

/**
 * Generate a hypothetical answer to a query using Ollama chat.
 *
 * Uses the currently loaded chat model (context.model) for zero cold-start latency.
 * Falls back to config.ENRICHMENT_MODEL if no model specified.
 *
 * @param {string} query       - The user's search query
 * @param {string} [ollamaUrl] - Ollama base URL override
 * @param {string} [model]     - Model name (prefer the currently loaded chat model)
 * @returns {Promise<string|null>} Hypothetical answer text, or null on failure
 */
async function generateHypothetical(query, ollamaUrl, model) {
  const url = ollamaUrl || config.OLLAMA_URL;
  const useModel = model || config.ENRICHMENT_MODEL || "glm-4.7-flash:latest";
  const timeout = config.HYDE_TIMEOUT || 10000;
  const maxTokens = config.HYDE_MAX_TOKENS || 200;

  const prompt =
    `Write a short paragraph (100-150 words) that would be the ideal documentation passage answering this question. ` +
    `Output ONLY the paragraph, nothing else.\n\nQuestion: ${query}`;

  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0.3, num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const text = (data.message?.content || "").trim();

    // Reject very short or empty responses
    return text.length > 30 ? text : null;
  } catch (_) {
    // Timeout, network error, JSON parse error → silent fallback
    return null;
  }
}

module.exports = { generateHypothetical, HYDE_TYPES };
