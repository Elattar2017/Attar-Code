// smart-fix/fix-engine/index.js
// Orchestrates the 3-tier fix pipeline

const { applyPatch, revertPatch, clearBackups, getBackup } = require("./apply-engine");
const { verifyFix } = require("./verify-engine");
const { FixLearner } = require("./fix-learner");
const { generateDeterministicFix } = require("./tier1-deterministic");
const { generateHeuristicCandidates } = require("./tier2-heuristic");
const { buildComplexContext } = require("./tier3-complex");
const fs = require("fs");
const path = require("path");

// Strategy classification into tiers
const TIER1_STRATEGIES = new Set([
  "add_import", "remove_import", "update_import_path",
  "add_semicolon", "fix_indentation", "remove_duplicate",
  "apply_compiler_hint",
]);

const TIER2_STRATEGIES = new Set([
  "fix_syntax", "update_type_annotation", "add_null_check",
  "cast_type", "initialize_variable", "add_missing_return", "close_bracket",
]);

// Everything else → tier3

/**
 * Classify which tier should handle this error.
 */
function classifyTier(error, learner, language) {
  const strategy = error.fixHint?.primaryStrategy;
  if (!strategy) return 3;

  // Check if learner has promoted this error code
  const promoted = learner?.getPromotedStrategies(language);
  if (promoted && promoted[error.code]) return 1;

  // Cross-file edits always go to tier3
  if (error.fixHint?.requiresCrossFileEdit) return 3;

  // High cross-file probability → minimum tier2
  if (error.crossFileProbability > 0.7 && TIER1_STRATEGIES.has(strategy)) return 2;

  if (TIER1_STRATEGIES.has(strategy)) return 1;
  if (TIER2_STRATEGIES.has(strategy)) return 2;
  return 3;
}

/**
 * Main entry point: run the fix engine on a fix plan.
 * Phase 1: Returns empty results (no fixes applied yet).
 * Phase 2+: Will generate and apply fixes.
 *
 * @param {object} fixPlan - from computeFixOrder()
 * @param {object} tree - TreeManager instance
 * @param {string} language - detected language
 * @param {string} projectRoot - project directory
 * @param {object} options - { maxTier1Fixes: 10, timeout: 500 }
 * @returns {object} fixEngineResult
 */
async function runFixEngine(fixPlan, tree, language, projectRoot, options = {}) {
  const maxTier1 = options.maxTier1Fixes || 10;
  const learner = new FixLearner();

  const result = {
    autoFixed: [],
    candidatesForLLM: [],
    complexForLLM: [],
    skipped: [],
    stats: {
      total: 0,
      autoFixed: 0,
      heuristic: 0,
      complex: 0,
      skipped: 0,
    },
  };

  // Process all error groups from both queues
  const allGroups = [...(fixPlan.queue1 || []), ...(fixPlan.queue2 || [])];

  for (const group of allGroups) {
    for (const error of group.errors || []) {
      result.stats.total++;
      const tier = classifyTier(error, learner, language);

      if (tier === 1 && result.autoFixed.length < maxTier1) {
        // Tier 1: attempt deterministic auto-fix
        try {
          const filePath = group.file;
          if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const fix = generateDeterministicFix(error, fileContent, tree, language);
            if (fix) {
              const applyResult = applyPatch(filePath, fix.patch, tree);
              if (applyResult.success) {
                // Verify the fix
                const verifyResult = await verifyFix(filePath, language, fix.strategy, tree);
                if (verifyResult.passed) {
                  result.autoFixed.push({
                    file: filePath, error, strategy: fix.strategy,
                    patch: fix.patch, description: fix.description,
                    verifyResult, confidence: fix.confidence,
                  });
                  result.stats.autoFixed++;
                  // Record success
                  learner.recordOutcome({
                    errorCode: error.code, strategy: fix.strategy,
                    language, file: filePath, passed: true,
                    confidence: verifyResult.confidence, duration: verifyResult.duration,
                  });
                  continue; // Fixed! Skip to next error
                } else {
                  // Verification failed — revert
                  revertPatch(filePath, applyResult.backupContent, tree);
                  learner.recordOutcome({
                    errorCode: error.code, strategy: fix.strategy,
                    language, file: filePath, passed: false,
                    confidence: verifyResult.confidence, duration: verifyResult.duration,
                  });
                }
              }
            }
          }
        } catch (err) { /* tier1 failed silently — fall through to tier3 */ }
        // Tier1 failed or couldn't generate fix — pass to LLM
        result.complexForLLM.push({ file: group.file, error, tier: 1 });
        result.stats.complex++;
      } else if (tier === 2) {
        // Tier 2: generate candidates for LLM to choose
        try {
          const filePath = group.file;
          if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const candidateSet = generateHeuristicCandidates(error, fileContent, error.captures || {}, language);
            if (candidateSet && candidateSet.candidates.length > 0) {
              result.candidatesForLLM.push({
                file: filePath, error, candidates: candidateSet.candidates,
                context: candidateSet.context, promptBlock: candidateSet.promptBlock,
              });
              result.stats.heuristic++;
              continue;
            }
          }
        } catch (_) {}
        // Couldn't generate candidates — fall through to tier3
        result.complexForLLM.push({ file: group.file, error, tier: 2 });
        result.stats.complex++;
      } else {
        // Tier 3: build rich context for LLM
        try {
          const filePath = group.file;
          if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            // Check for similar successful fix from history (3-tier: JSONL sync → Qdrant async)
            if (learner) {
              // Tier 1: fast sync search in JSONL (exact code match + pattern match)
              const similar = learner.getSimilarSuccessfulFix(error.code, error.captures || {}, language, error.message);
              if (similar && similar.fixDiff) {
                error._pastFix = {
                  strategy: similar.strategy,
                  file: similar.fixFile || similar.file,
                  confidence: similar.confidence,
                  fixDiff: similar.fixDiff,
                  fixDescription: similar.fixDescription,
                  source: "jsonl",
                };
              } else {
                // Tier 2: async semantic search in Qdrant KB
                try {
                  const kbRecipe = await learner.searchKBForFix(error.message, language);
                  if (kbRecipe) {
                    error._pastFix = {
                      strategy: kbRecipe.strategy,
                      file: kbRecipe.fixFile,
                      confidence: kbRecipe.score || 0.6,
                      fixDiff: kbRecipe.fixDiff,
                      fixDescription: kbRecipe.fixDescription,
                      source: "qdrant",
                    };
                  }
                } catch (_) {}
              }
            }
            const ranks = tree?.getRanks?.() || new Map();
            const complexCtx = buildComplexContext(error, fileContent, tree, ranks);
            result.complexForLLM.push({
              file: filePath, error, tier: 3,
              fullContext: complexCtx, promptBlock: complexCtx.promptBlock,
            });
          } else {
            result.complexForLLM.push({ file: group.file, error, tier: 3 });
          }
        } catch (_) {
          result.complexForLLM.push({ file: group.file, error, tier: 3 });
        }
        result.stats.complex++;
      }
    }
  }

  // Auto-resolvable errors are skipped entirely
  for (const error of fixPlan.autoResolvable || []) {
    result.skipped.push({ file: error.file, error, reason: "auto_resolvable" });
    result.stats.skipped++;
  }

  return result;
}

module.exports = {
  runFixEngine,
  classifyTier,
  TIER1_STRATEGIES,
  TIER2_STRATEGIES,
  applyPatch,
  revertPatch,
  clearBackups,
  getBackup,
  verifyFix,
  FixLearner,
  generateDeterministicFix,
  generateHeuristicCandidates,
  buildComplexContext,
};
