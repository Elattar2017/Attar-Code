const { TreeManager } = require("./tree-manager");
const { computeFixOrder } = require("./fix-order");
const { buildCreateFileResponse, buildEditFileResponse, buildBuildErrorAnalysis } = require("./context-builder");
const { runFixEngine, classifyTier, FixLearner } = require("./fix-engine");

let extractHints;
try { extractHints = require("./hint-extractor").extractHints; } catch (_) {}
let extractEnclosingFunction;
try { extractEnclosingFunction = require("./function-extractor").extractEnclosingFunction; } catch (_) {}
let assembleFixPrompt, detectLanguageFromFile;
try { ({ assembleFixPrompt, detectLanguageFromFile } = require("./prompt-template")); } catch (_) {}

let treeManager = null;

function initSmartFix() {
  treeManager = new TreeManager();
  return treeManager;
}

function getTree() {
  return treeManager;
}

module.exports = {
  initSmartFix,
  getTree,
  TreeManager,
  computeFixOrder,
  buildCreateFileResponse,
  buildEditFileResponse,
  buildBuildErrorAnalysis,
  // v2: Fix Engine
  runFixEngine,
  classifyTier,
  FixLearner,
  // v3: Hint extractor, function extractor, prompt template
  extractHints,
  extractEnclosingFunction,
  assembleFixPrompt,
  detectLanguageFromFile,
};
