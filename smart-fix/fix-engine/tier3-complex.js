// smart-fix/fix-engine/tier3-complex.js
// Builds maximum useful context for LLM-driven fixes

const path = require("path");
const fs = require("fs");

let extractEnclosingFunction;
try { extractEnclosingFunction = require("../function-extractor").extractEnclosingFunction; } catch (_) {}

let assembleFixPrompt;
try { assembleFixPrompt = require("../prompt-template").assembleFixPrompt; } catch (_) {}

/**
 * Build rich context for complex errors that need LLM reasoning.
 * Includes: error file content, dependency definitions, dependent usages, cascade risk.
 */
function buildComplexContext(error, fileContent, tree, ranks) {
  const lines = fileContent.split("\n");
  const lineIdx = (error.line || 1) - 1;

  // Try function-level extraction first, fall back to ±15 lines
  let surroundingLines;
  if (extractEnclosingFunction) {
    const lang = detectLanguage(error.file);
    const extracted = extractEnclosingFunction(fileContent, error.line || 1, lang);
    surroundingLines = extracted.code;
  } else {
    const ctxStart = Math.max(0, lineIdx - 15);
    const ctxEnd = Math.min(lines.length, lineIdx + 16);
    surroundingLines = lines.slice(ctxStart, ctxEnd).map((l, i) => {
      const num = ctxStart + i + 1;
      const marker = num === error.line ? " >>> " : "     ";
      return `${marker}${num}: ${l}`;
    }).join("\n");
  }

  // Get file rank for cascade risk assessment
  const fileRank = ranks?.get?.(error.file) || null;
  const cascadeRisk = fileRank ? (fileRank.dependentCount > 5 ? "HIGH" : fileRank.dependentCount > 2 ? "MEDIUM" : "LOW") : "UNKNOWN";

  // Get dependency type definitions (what this file imports)
  const dependencies = [];
  if (tree) {
    const deps = tree.getDependenciesOf?.(error.file) || [];
    for (const dep of deps.slice(0, 5)) { // Max 5 dependencies
      try {
        const depAnalysis = tree.getFileAnalysis?.(dep);
        if (depAnalysis) {
          const exports = depAnalysis.exports?.flatMap(e => e.symbols) || [];
          const defs = depAnalysis.definitions?.map(d => `${d.kind} ${d.name}`).slice(0, 10) || [];
          dependencies.push({
            file: path.basename(dep),
            exports: exports.slice(0, 10),
            definitions: defs,
          });
        }
      } catch (_) {}
    }
  }

  // Get dependent files (what imports from this file)
  const dependents = [];
  if (tree) {
    const deps = tree.getDependentsOf?.(error.file) || [];
    for (const dep of deps.slice(0, 5)) {
      try {
        const depAnalysis = tree.getFileAnalysis?.(dep);
        if (depAnalysis) {
          const imported = depAnalysis.imports
            ?.filter(imp => !imp.isExternal)
            .flatMap(imp => imp.symbols)
            .slice(0, 5) || [];
          dependents.push({ file: path.basename(dep), imports: imported });
        }
      } catch (_) {}
    }
  }

  // Build the prompt block
  let promptBlock;
  if (assembleFixPrompt) {
    const detectedLang = detectLanguage(error.file);
    promptBlock = assembleFixPrompt({
      error,
      language: detectedLang,
      classification: {
        rootCause: error.fixHint ? `Strategy: ${error.fixHint.primaryStrategy}` : null,
        prescription: error.fixHint?.requiresCrossFileEdit ? "May require editing multiple files" : null,
      },
      codeBlock: error.codeBlock || null,
      functionContext: surroundingLines,
      dependencies,
      dependents,
      cascadeRisk,
      hint: error.hint || null,
      pastFix: error._pastFix || null,
    });
  } else {
    promptBlock = buildComplexPromptBlock(error, surroundingLines, dependencies, dependents, cascadeRisk, fileRank);
  }

  return {
    primaryFile: { path: error.file, errorLine: error.line, surroundingLines },
    dependencies,
    dependents,
    cascadeRisk,
    fileRank,
    promptBlock,
  };
}

function buildComplexPromptBlock(error, surroundingLines, dependencies, dependents, cascadeRisk, fileRank) {
  const lines = [];
  lines.push(`[FIX_CONTEXT] ${error.code} in ${path.basename(error.file)} line ${error.line}`);
  const lang = detectLanguage(error.file);
  if (lang) lines.push(`Language: ${lang}`);
  lines.push(`Message: ${error.message}`);
  lines.push(`Cascade risk: ${cascadeRisk}${fileRank ? ` (${fileRank.dependentCount} files depend on this)` : ""}`);
  lines.push("");

  // Error location with surrounding code
  lines.push("Code around the error:");
  lines.push(surroundingLines);
  lines.push("");

  // What this file imports from (type definitions available)
  if (dependencies.length > 0) {
    lines.push("Types/functions available from imported files:");
    for (const dep of dependencies) {
      if (dep.definitions.length > 0) {
        lines.push(`  ${dep.file}: ${dep.definitions.join(", ")}`);
      } else if (dep.exports.length > 0) {
        lines.push(`  ${dep.file}: exports ${dep.exports.join(", ")}`);
      }
    }
    lines.push("");
  }

  // What depends on this file (impact of changes)
  if (dependents.length > 0) {
    lines.push("Files that import from this file (will be affected by changes):");
    for (const dep of dependents) {
      lines.push(`  ${dep.file}: uses ${dep.imports.join(", ") || "module"}`);
    }
    lines.push("");
  }

  // Fix hint from plugin
  if (error.fixHint) {
    lines.push(`Suggested strategy: ${error.fixHint.primaryStrategy}`);
    if (error.fixHint.requiresCrossFileEdit) {
      lines.push("⚠ This fix may require editing MULTIPLE files.");
    }
    lines.push(`Typical scope: ${error.fixHint.typicalScope || "unknown"}`);
  }

  // Fix example from error catalog
  if (error.codeBlock) {
    lines.push("");
    lines.push("Fix example (from error catalog):");
    lines.push(error.codeBlock);
  }

  lines.push("");
  lines.push("Fix this error. If the fix requires changing the type definition in another file, change THAT file (the root cause), not this file.");

  return lines.join("\n");
}

function detectLanguage(filePath) {
  const ext = (filePath || "").split(".").pop()?.toLowerCase();
  const map = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java", cs: "CSharp", php: "PHP", swift: "Swift", kt: "Kotlin" };
  return map[ext] || "JavaScript";
}

module.exports = { buildComplexContext };
