// smart-fix/fix-engine/fix-learner.js
// Records fix outcomes and promotes successful strategies

const fs = require("fs");
const path = require("path");
const os = require("os");

const OUTCOMES_FILE = path.join(os.homedir(), ".attar-code", "fix-outcomes.jsonl");
const PROMOTED_FILE = path.join(os.homedir(), ".attar-code", "promoted-strategies.json");
const PROMOTION_THRESHOLD = 5; // consecutive successes to promote
const DEFAULT_PROXY_URL = "http://localhost:3001";

class FixLearner {
  constructor(outcomesFilePath, proxyUrl) {
    this.outcomesFile = outcomesFilePath || OUTCOMES_FILE;
    this.proxyUrl = proxyUrl || DEFAULT_PROXY_URL;
    this.promoted = this._loadPromoted();
    this.recentOutcomes = this._loadPastOutcomes();
  }

  _loadPastOutcomes() {
    try {
      if (fs.existsSync(this.outcomesFile)) {
        const content = fs.readFileSync(this.outcomesFile, "utf-8").trim();
        if (!content) return [];
        const lines = content.split("\n").filter(l => l.trim());
        return lines.slice(-500).map(line => {
          try { return JSON.parse(line); } catch (_) { return null; }
        }).filter(Boolean);
      }
    } catch (_) {}
    return [];
  }

  /**
   * Record the outcome of a fix attempt.
   * Enhanced: now stores error message, fix diff, and trigger context for future reuse.
   */
  recordOutcome(outcome) {
    const record = {
      timestamp: new Date().toISOString(),
      errorCode: outcome.errorCode,
      strategy: outcome.strategy,
      language: outcome.language,
      file: outcome.file,
      passed: outcome.passed,
      confidence: outcome.confidence,
      duration: outcome.duration,
      // Enhanced fields for fix recipe KB
      errorMessage: outcome.errorMessage || null,     // actual error text (e.g., "Cannot read properties of null")
      trigger: outcome.trigger || null,                // what caused it (e.g., "POST /api/auth/login → 500")
      fixFile: outcome.fixFile || null,                // which file was edited to fix it
      fixDiff: outcome.fixDiff || null,                // the actual code change (old → new, truncated)
      fixDescription: outcome.fixDescription || null,  // human-readable fix summary
    };

    this.recentOutcomes.push(record);

    // Append to file (non-blocking, best-effort)
    try {
      const dir = path.dirname(this.outcomesFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.outcomesFile, JSON.stringify(record) + "\n");
    } catch (_) {}

    // Check for promotion
    if (outcome.passed) {
      this._checkPromotion(outcome.errorCode, outcome.strategy, outcome.language);
    }

    // Store fix recipe in Qdrant KB for semantic search (non-blocking)
    if (outcome.passed && outcome.fixDiff) {
      this._storeInKB(record).catch(() => {});
    }
  }

  /**
   * Store a successful fix recipe in Qdrant for semantic search.
   * Format: searchable error description + fix recipe as content.
   */
  async _storeInKB(record) {
    if (!record.fixDiff) return;
    const recipeId = `fix-${record.errorCode}-${Date.now()}`;
    // Build a document that Qdrant can semantically search
    const content = [
      `ERROR: ${record.errorCode} in ${record.language}`,
      `MESSAGE: ${record.errorMessage || "unknown"}`,
      `TRIGGER: ${record.trigger || "build/test failure"}`,
      `FILE: ${record.fixFile || record.file}`,
      `FIX: ${record.fixDescription || record.strategy}`,
      `DIFF:`,
      record.fixDiff,
      `STRATEGY: ${record.strategy}`,
      `CONFIDENCE: ${record.confidence}`,
      `DATE: ${record.timestamp}`,
    ].join("\n");

    try {
      const res = await fetch(`${this.proxyUrl}/kb/recipe/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          errorCode: record.errorCode,
          errorMessage: record.errorMessage || "unknown",
          language: record.language,
          strategy: record.strategy,
          fixDiff: record.fixDiff,
          fixFile: record.fixFile || record.file,
          fixDescription: record.fixDescription,
          trigger: record.trigger,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return true;
    } catch (_) {}
    return false;
  }

  /**
   * Find a similar successful fix from recent history.
   * 3-tier search: Qdrant semantic → JSONL exact code → JSONL pattern match.
   * Returns the full fix recipe (including diff and description) so the LLM can replicate it.
   */
  getSimilarSuccessfulFix(errorCode, captures, language, errorMessage) {
    // Priority 1: exact error code + language match with fix recipe (fast, in-memory)
    const exactMatch = this.recentOutcomes
      .filter(o => o.errorCode === errorCode && o.language === language && o.passed && o.fixDiff)
      .pop();
    if (exactMatch) return exactMatch;

    // Priority 2: exact error code + language match (without recipe)
    const codeMatch = this.recentOutcomes
      .filter(o => o.errorCode === errorCode && o.language === language && o.passed)
      .pop();
    if (codeMatch) return codeMatch;

    // Priority 3: error message pattern match in JSONL (any language)
    if (errorMessage) {
      const patterns = errorMessage.match(/(?:Cannot read properties of|is not a function|is not defined|ECONNREFUSED|MODULE_NOT_FOUND|SyntaxError|TypeError|null|undefined)/gi) || [];
      if (patterns.length > 0) {
        const msgMatch = this.recentOutcomes
          .filter(o => o.passed && o.errorMessage && o.fixDiff)
          .filter(o => patterns.some(p => o.errorMessage?.toLowerCase().includes(p.toLowerCase())))
          .pop();
        if (msgMatch) return msgMatch;
      }
    }

    return null;
  }

  /**
   * Search Qdrant KB for similar fix recipes using semantic search.
   * This is the ASYNC version — finds fixes that JSONL pattern matching would miss.
   * Example: "NoneType has no attribute" matches "Cannot read properties of null"
   * because Qdrant understands they're both null-pointer errors.
   */
  async searchKBForFix(errorMessage, language, num = 3) {
    if (!errorMessage) return null;
    const query = `${language || ""} error: ${errorMessage}`.slice(0, 300);
    try {
      const res = await fetch(`${this.proxyUrl}/kb/recipe/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, num }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      // Parse results — find ones that contain DIFF: sections (fix recipes, not regular docs)
      const recipes = (data.results || data || [])
        .filter(r => {
          const text = r.text || r.content || r.document || "";
          return text.includes("DIFF:") && text.includes("FIX:");
        })
        .map(r => {
          const text = r.text || r.content || r.document || "";
          // Parse the recipe format
          const errorMatch = text.match(/MESSAGE:\s*(.+)/);
          const fixMatch = text.match(/FIX:\s*(.+)/);
          const diffMatch = text.match(/DIFF:\n([\s\S]*?)(?:\nSTRATEGY:|$)/);
          const fileMatch = text.match(/FILE:\s*(.+)/);
          const strategyMatch = text.match(/STRATEGY:\s*(.+)/);
          return {
            errorMessage: errorMatch?.[1]?.trim() || "",
            fixDescription: fixMatch?.[1]?.trim() || "",
            fixDiff: diffMatch?.[1]?.trim() || "",
            fixFile: fileMatch?.[1]?.trim() || "",
            strategy: strategyMatch?.[1]?.trim() || "kb_recipe",
            score: r.score || r.distance || 0,
            source: "qdrant",
          };
        })
        .filter(r => r.fixDiff); // must have actual diff

      return recipes.length > 0 ? recipes[0] : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Get promoted strategies for a language.
   * @returns {Map<errorCode, strategy>}
   */
  getPromotedStrategies(language) {
    return this.promoted[language] || {};
  }

  /**
   * Check if a strategy should be promoted to tier1 (auto-apply).
   */
  _checkPromotion(errorCode, strategy, language) {
    const key = `${language}:${errorCode}:${strategy}`;
    const consecutiveSuccesses = this.recentOutcomes
      .filter(o => o.errorCode === errorCode && o.strategy === strategy && o.language === language)
      .slice(-PROMOTION_THRESHOLD);

    if (consecutiveSuccesses.length >= PROMOTION_THRESHOLD && consecutiveSuccesses.every(o => o.passed)) {
      if (!this.promoted[language]) this.promoted[language] = {};
      this.promoted[language][errorCode] = strategy;
      this._savePromoted();
    }
  }

  _loadPromoted() {
    try {
      if (fs.existsSync(PROMOTED_FILE)) {
        return JSON.parse(fs.readFileSync(PROMOTED_FILE, "utf-8"));
      }
    } catch (_) {}
    return {};
  }

  _savePromoted() {
    try {
      const dir = path.dirname(PROMOTED_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PROMOTED_FILE, JSON.stringify(this.promoted, null, 2));
    } catch (_) {}
  }
}

module.exports = { FixLearner };
