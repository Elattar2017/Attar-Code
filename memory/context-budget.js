'use strict';

/**
 * context-budget.js — Adaptive context budget allocation based on model size.
 *
 * Determines how much of the context window each component gets:
 * - System prompt
 * - Layer 1: Task anchor + instructions (Plan 2)
 * - Layer 1: End-of-context reinforcement (Plan 2)
 * - Retrieved memories (Plan 3)
 * - Conversation history (remainder)
 *
 * Also provides tiered compression thresholds that trigger
 * observation masking, summarization, and compaction.
 */

const TIER_CONFIG = {
  small: {
    // <= 16384 context tokens
    systemPrompt:   400,
    anchor:         300,
    reinforcement:  200,
    memory:         500,
    thresholds: { mask: 0.35, summarize: 0.50, extract: 0.70, compact: 0.90 },
  },
  medium: {
    // 16385 - 65536
    systemPrompt:   500,
    anchor:         500,
    reinforcement:  300,
    memory:         1000,
    thresholds: { mask: 0.40, summarize: 0.60, extract: 0.80, compact: 0.95 },
  },
  large: {
    // > 65536
    systemPrompt:   600,
    anchor:         800,
    reinforcement:  400,
    memory:         1500,
    thresholds: { mask: 0.50, summarize: 0.70, extract: 0.85, compact: 0.95 },
  },
};

class ContextBudget {
  /**
   * @param {number} numCtx  Total context window size in tokens
   */
  constructor(numCtx) {
    this.numCtx = numCtx;
    this.tier = numCtx <= 16384 ? 'small' : numCtx <= 65536 ? 'medium' : 'large';

    const config = TIER_CONFIG[this.tier];

    // Reserve 25% for model response
    this.responseReserve = Math.floor(numCtx * 0.25);
    this.availableInput  = numCtx - this.responseReserve;

    // Fixed allocations
    this.systemPromptBudget   = config.systemPrompt;
    this.anchorBudget         = config.anchor;
    this.reinforcementBudget  = config.reinforcement;
    this.memoryBudget         = config.memory;

    // Conversation gets the remainder
    const fixed = this.systemPromptBudget + this.anchorBudget + this.reinforcementBudget + this.memoryBudget;
    this.conversationBudget = this.availableInput - fixed;

    // Compression thresholds (fraction of availableInput)
    this.thresholds = { ...config.thresholds };
  }

  /**
   * Determine what compression action is needed based on current token usage.
   *
   * @param {number} currentTokens  Current total tokens used (sys + messages + tools)
   * @returns {string|null}  'mask' | 'summarize' | 'extract' | 'compact' | null
   */
  shouldCompress(currentTokens) {
    const usage = currentTokens / this.availableInput;

    if (usage >= this.thresholds.compact)   return 'compact';
    if (usage >= this.thresholds.extract)   return 'extract';
    if (usage >= this.thresholds.summarize) return 'summarize';
    if (usage >= this.thresholds.mask)      return 'mask';
    return null;
  }

  /**
   * Get a plain object summary of the budget (for debugging/logging).
   * @returns {object}
   */
  toJSON() {
    return {
      tier: this.tier,
      numCtx: this.numCtx,
      availableInput: this.availableInput,
      systemPromptBudget: this.systemPromptBudget,
      anchorBudget: this.anchorBudget,
      reinforcementBudget: this.reinforcementBudget,
      memoryBudget: this.memoryBudget,
      conversationBudget: this.conversationBudget,
      thresholds: this.thresholds,
    };
  }
}

module.exports = { ContextBudget, TIER_CONFIG };
