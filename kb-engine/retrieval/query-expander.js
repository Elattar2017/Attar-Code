// kb-engine/retrieval/query-expander.js
// Generates query reformulations via Ollama for better recall.
"use strict";

const config = require("../config");

async function expandQuery(query, context = {}, ollamaUrl) {
  const url = ollamaUrl || config.OLLAMA_URL;
  const techHint = context.tech ? ` (technology: ${context.tech})` : "";
  const prompt = `Generate 3 alternative search queries for: "${query}"${techHint}\nReturn ONLY 3 queries, one per line. No numbering.`;

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: context.model || "glm-4.7-flash:latest",
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 150 },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [query];
    const data = await res.json();
    const lines = (data.response || "")
      .split("\n")
      .map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
      .filter((l) => l.length > 10 && l.length < 200);
    return [query, ...lines.slice(0, 3)];
  } catch (_) {
    return [query];
  }
}

module.exports = { expandQuery };
