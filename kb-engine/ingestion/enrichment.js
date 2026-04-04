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

// Dynamically resolve the best available chat model for enrichment.
// Priority: 1) explicitly set model, 2) currently loaded Ollama chat model, 3) config default
let _cachedEnrichModel = null;
let _cacheTime = 0;
async function getEnrichmentModel(ollamaUrl) {
  // Cache for 60 seconds to avoid hammering /api/ps
  if (_cachedEnrichModel && Date.now() - _cacheTime < 60000) return _cachedEnrichModel;
  try {
    const url = ollamaUrl || config.OLLAMA_URL || 'http://localhost:11434';
    const res = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    // Find a loaded chat model (not embedding, not reranker)
    const chatModel = (data.models || []).find(m =>
      !m.name.includes('embed') && !m.name.includes('Embed') &&
      !m.name.includes('rerank') && !m.name.includes('Rerank')
    );
    if (chatModel) {
      _cachedEnrichModel = chatModel.name;
      _cacheTime = Date.now();
      return chatModel.name;
    }
  } catch (_) {}
  return config.ENRICHMENT_MODEL || 'gemma4:e4b';
}

/**
 * Enrich a chunk with a short LLM-generated context blurb.
 * Uses the `gemma4:e4b` model by default (fast, small).
 * Falls back to returning the original `chunk` string on any error.
 *
 * @param {string}  chunk        - Raw chunk text.
 * @param {string}  [docTitle]   - Document title for context.
 * @param {string}  [sectionPath] - Section heading path (e.g. "Guide > Installation").
 * @param {string}  [ollamaUrl]  - Ollama base URL override.
 * @returns {Promise<string>}    - Enriched chunk (context prefix + original chunk).
 */
async function enrichChunk(chunk, docTitle, sectionPath, ollamaUrl, prevChunk, nextChunk) {
  const url = ollamaUrl || config.OLLAMA_URL;
  const model = await getEnrichmentModel(url);

  // Anthropic-style contextual enrichment: include neighbor context
  // so the LLM understands where this chunk fits in the document flow
  let neighborContext = '';
  if (prevChunk) neighborContext += `Preceding context: ${prevChunk.slice(-300)}\n`;
  if (nextChunk) neighborContext += `Following context: ${nextChunk.slice(0, 300)}\n`;

  const prompt =
    `You are indexing documentation. Given this document section and its surrounding context, write a brief context (50-80 words) that explains what this chunk is about and where it fits in the document. Only output the context, nothing else.\n\n` +
    `Document: ${docTitle || 'Unknown'}\n` +
    `Section: ${sectionPath || 'Unknown'}\n` +
    (neighborContext ? `${neighborContext}\n` : '') +
    `Content: ${chunk.slice(0, 800)}`;

  try {
    const res = await fetch(`${url}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream:  false,
        think: false,  // disable thinking for enrichment
        options: { temperature: 0.1, num_predict: 120 },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return chunk; // server error → fallback

    const data    = await res.json();
    const context = (data.message?.content || data.response || '').trim();

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
function enrichChunkFast(chunk, docTitle, sectionPath, prevChunkContent) {
  const breadcrumb = [docTitle, sectionPath].filter(Boolean).join(' > ');
  // Contextual enrichment: add last sentence of previous chunk for continuity
  let contextHint = '';
  if (prevChunkContent) {
    const sentences = prevChunkContent.trim().split(/[.!?]\s+/);
    const lastSentence = sentences[sentences.length - 1]?.trim();
    if (lastSentence && lastSentence.length > 20 && lastSentence.length < 200) {
      contextHint = ` (continues from: ${lastSentence})`;
    }
  }
  const prefix = breadcrumb ? `[${breadcrumb}${contextHint}]\n\n` : '';
  return prefix + chunk;
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
  const model = await getEnrichmentModel(url);
  // Truncate to ~8K chars to avoid overwhelming the model
  const inputText = combinedText.slice(0, 8000);

  const userMsg = `Summarize the following section "${sectionName}" in 100-200 words. Focus on key concepts, main points, code patterns used, and what the reader will learn. Be concise and factual.\n\n---\n\n${inputText}`;

  try {
    // Use /api/chat (not /api/generate) — some models (Gemma 4) return empty via generate
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: userMsg }],
        stream: false,
        think: false,  // disable thinking — summaries don't need chain-of-thought
        options: { temperature: 0.2, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      process.stderr.write(`  [generateSummary] HTTP ${res.status} for "${sectionName}" (model: ${model})\n`);
      return null;
    }
    const data = await res.json();
    const summary = (data.message?.content || '').trim();
    if (summary.length <= 30) {
      process.stderr.write(`  [generateSummary] Empty/short response for "${sectionName}" (model: ${model}, got ${summary.length} chars)\n`);
    }
    return summary.length > 30 ? summary : null;
  } catch (err) {
    process.stderr.write(`  [generateSummary] FAILED for "${sectionName}": ${err.message}\n`);
    return null;
  }
}

module.exports = { enrichChunk, enrichChunkFast, generateSummary };
