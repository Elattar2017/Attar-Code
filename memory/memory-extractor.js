'use strict';

/**
 * memory-extractor.js — Model-driven memory extraction.
 *
 * After each user-model exchange, an async LLM call extracts facts worth
 * remembering. Uses a serial queue to prevent concurrent writes.
 */

const VALID_TYPES = new Set(['correction', 'decision', 'project_fact', 'error_pattern', 'user_pref']);

// Jaccard word similarity
function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) { if (setB.has(w)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

class MemoryExtractor {
  /**
   * @param {object} [opts]
   * @param {string} [opts.ollamaUrl]   Ollama base URL
   * @param {string} [opts.model]       Model for extraction (fast model preferred)
   * @param {boolean} [opts.extract]    Whether to actually run LLM calls (default true)
   * @param {Function} [opts.onExtraction]  Callback when extractions are ready: (extractions) => void
   */
  constructor(opts = {}) {
    this._ollamaUrl = opts.ollamaUrl || 'http://127.0.0.1:11434';
    this._model = opts.model || null; // null = auto-detect
    this._extract = opts.extract !== false;
    this._onExtraction = opts.onExtraction || null;
    this._queue = [];
    this._running = false;
    this._recentExtractions = []; // last 20 for dedup
    this._consecutiveFailures = 0;
  }

  // ── Extraction Prompt ──────────────────────────────────────────────────

  /**
   * Build the extraction prompt.
   * @param {string} userMessage
   * @param {string} assistantResponse
   * @param {string} toolSummary
   * @returns {string}
   */
  buildExtractionPrompt(userMessage, assistantResponse, toolSummary) {
    const user = (userMessage || '').slice(0, 500);
    const asst = (assistantResponse || '').slice(0, 800);
    const tools = (toolSummary || '').slice(0, 300);

    return `You are a memory extractor for a coding assistant. Given this exchange, extract ONLY facts worth remembering in future sessions. Output a JSON array or empty array [].

Categories:
- correction: User corrected the assistant's approach
- decision: A design/architecture decision was made
- project_fact: Learned something about the project (build command, framework, structure)
- error_pattern: An error was fixed — what was the root cause and fix
- user_pref: User expressed a preference for how to work

Rules:
- ONLY extract facts useful in FUTURE sessions (not greetings, not "ok", not "yes")
- Be specific: "User wants pydantic not jsonschema" NOT "User has preferences"
- Skip: greetings, acknowledgments, questions without answers, tool outputs
- Max 3 extractions per exchange
- Each extraction must have: type, content, scope ("global" or "project")

Exchange:
User: ${user}
Assistant: ${asst}
${tools ? `Tools used: ${tools}` : ''}

Output ONLY a JSON array:`;
  }

  // ── Quality Gate ───────────────────────────────────────────────────────

  /**
   * Check if an extraction passes quality criteria.
   * @param {{ type: string, content: string, scope: string }} extraction
   * @returns {boolean}
   */
  passesQualityGate(extraction) {
    if (!extraction || !extraction.content || !extraction.type) return false;
    if (extraction.content.length < 10) return false;
    if (!VALID_TYPES.has(extraction.type)) return false;

    // Dedup against recent extractions (Jaccard > 0.6)
    for (const recent of this._recentExtractions) {
      if (jaccard(extraction.content, recent.content) > 0.6) return false;
    }

    return true;
  }

  // ── Parse LLM Response ─────────────────────────────────────────────────

  /**
   * Parse the LLM's extraction response into validated extractions.
   * @param {string} response  Raw LLM response (should be JSON array)
   * @returns {Array<{ type: string, content: string, scope: string }>}
   */
  parseExtractionResponse(response) {
    if (!response) return [];

    let text = response.trim();
    // Handle markdown code blocks
    const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) text = codeBlock[1].trim();

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      // Cap at 3 and validate each
      return parsed.slice(0, 3).filter(e =>
        e && typeof e.type === 'string' && typeof e.content === 'string'
      ).map(e => ({
        type: e.type,
        content: e.content,
        scope: e.scope || 'project',
      }));
    } catch (_) {
      return [];
    }
  }

  // ── Serial Queue ───────────────────────────────────────────────────────

  /**
   * Enqueue an exchange for extraction (async, non-blocking).
   * @param {{ userMessage: string, assistantResponse: string, toolSummary: string }} exchange
   */
  enqueue(exchange) {
    if (!this._extract) {
      this._queue.push(exchange);
      return;
    }
    if (this._consecutiveFailures >= 3) return; // disabled until next session

    this._queue.push(exchange);
    if (!this._running) this._drain();
  }

  async _drain() {
    this._running = true;
    while (this._queue.length > 0) {
      const exchange = this._queue.shift();
      await this._extractOne(exchange);
    }
    this._running = false;
  }

  async _extractOne(exchange) {
    const prompt = this.buildExtractionPrompt(
      exchange.userMessage,
      exchange.assistantResponse,
      exchange.toolSummary
    );

    try {
      const model = this._model || 'glm-4.7-flash:latest';
      const res = await fetch(`${this._ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 200 },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        this._consecutiveFailures++;
        return;
      }

      const data = await res.json();
      const extractions = this.parseExtractionResponse(data.response || '');

      // Apply quality gate
      const valid = extractions.filter(e => this.passesQualityGate(e));

      if (valid.length > 0) {
        // Track for dedup
        for (const v of valid) {
          this._recentExtractions.push(v);
          if (this._recentExtractions.length > 20) this._recentExtractions.shift();
        }

        // Notify callback
        if (this._onExtraction) this._onExtraction(valid);
      }

      this._consecutiveFailures = 0;
    } catch (_) {
      this._consecutiveFailures++;
    }
  }

  /**
   * Find the best available model for extraction.
   * Called once at session start.
   * @returns {Promise<string|null>}
   */
  async detectModel() {
    const candidates = ['glm-4.7-flash:latest', 'qwen2.5:7b'];
    for (const model of candidates) {
      try {
        const res = await fetch(`${this._ollamaUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          this._model = model;
          return model;
        }
      } catch (_) {}
    }
    return null; // will use CONFIG.model as fallback
  }
}

module.exports = { MemoryExtractor };
