'use strict';

/**
 * enrichment.js — Optional LLM enrichment for indexed chunks.
 *
 * Two modes:
 *   1. `enrichChunk`     — Calls Ollama to generate a 50-80 word contextual prefix.
 *   2. `enrichChunkFast` — Zero-latency: prepends "[docTitle > sectionPath]\n\n" prefix.
 *
 * Both functions return a string (the enriched chunk content).
 * On any failure, `enrichChunk` falls back to returning the original chunk unchanged.
 */

const config = require('../config');

/**
 * Enrich a chunk with a short LLM-generated context blurb.
 * Uses the `glm-4.7-flash:latest` model by default (fast, small).
 * Falls back to returning the original `chunk` string on any error.
 *
 * @param {string}  chunk        - Raw chunk text.
 * @param {string}  [docTitle]   - Document title for context.
 * @param {string}  [sectionPath] - Section heading path (e.g. "Guide > Installation").
 * @param {string}  [ollamaUrl]  - Ollama base URL override.
 * @returns {Promise<string>}    - Enriched chunk (context prefix + original chunk).
 */
async function enrichChunk(chunk, docTitle, sectionPath, ollamaUrl) {
  const url = ollamaUrl || config.OLLAMA_URL;

  const prompt =
    `You are indexing documentation. Given this document section, write a brief context (50-80 words) that explains what this chunk is about and where it fits in the document. Only output the context, nothing else.\n\n` +
    `Document: ${docTitle || 'Unknown'}\n` +
    `Section: ${sectionPath || 'Unknown'}\n` +
    `Content: ${chunk.slice(0, 800)}`;

  try {
    const res = await fetch(`${url}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:   'glm-4.7-flash:latest',
        prompt,
        stream:  false,
        options: { temperature: 0.1, num_predict: 120 },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return chunk; // server error → fallback

    const data    = await res.json();
    const context = (data.response || '').trim();

    if (context.length > 20) {
      return context + '\n\n' + chunk;
    }
    return chunk;
  } catch (_) {
    // Timeout, network error, JSON parse error, etc. → graceful fallback
    return chunk;
  }
}

/**
 * Fast (zero-latency) chunk enrichment — no LLM call.
 * Prepends a bracketed breadcrumb derived from docTitle and sectionPath.
 *
 * Example output:
 *   "[Express Guide > Middleware]\n\nMiddleware functions receive req, res, next…"
 *
 * @param {string}  chunk         - Raw chunk text.
 * @param {string}  [docTitle]    - Document title.
 * @param {string}  [sectionPath] - Section heading path.
 * @returns {string} - Enriched chunk.
 */
function enrichChunkFast(chunk, docTitle, sectionPath) {
  const prefix = [docTitle, sectionPath].filter(Boolean).join(' > ');
  return prefix ? `[${prefix}]\n\n${chunk}` : chunk;
}

module.exports = { enrichChunk, enrichChunkFast };
