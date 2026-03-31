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

/**
 * Generate a 100-200 word summary of a section's content.
 * Used during ingestion to create summary chunks alongside detail chunks.
 *
 * @param {string} combinedText   - All detail chunks concatenated for this section.
 * @param {string} sectionName    - Section name (e.g., "3.2 Closures").
 * @param {string} [ollamaUrl]    - Ollama API URL.
 * @returns {Promise<string|null>} - Summary text, or null on failure.
 */
async function generateSummary(combinedText, sectionName, ollamaUrl) {
  const url = ollamaUrl || config.OLLAMA_URL || 'http://localhost:11434';
  // Truncate to ~8K chars to avoid overwhelming the model
  const inputText = combinedText.slice(0, 8000);

  const prompt = `Summarize the following section "${sectionName}" in 100-200 words. Focus on key concepts, main points, code patterns used, and what the reader will learn. Be concise and factual.\n\n---\n\n${inputText}`;

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ENRICHMENT_MODEL || 'glm-4.7-flash:latest',
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const summary = (data.response || '').trim();
    return summary.length > 30 ? summary : null;
  } catch {
    return null;
  }
}

module.exports = { enrichChunk, enrichChunkFast, generateSummary };
