// smart-fix/prompt-template.js
// Unified diagnosis-first prompt assembly for all fix tiers

const path = require("path");

// Detect language from file extension — universal mapping for all supported technologies
function detectLanguageFromFile(filePath) {
  const ext = (filePath || "").split(".").pop()?.toLowerCase();
  const LANG_MAP = {
    ts: "TypeScript", tsx: "TypeScript (React)",
    js: "JavaScript", jsx: "JavaScript (React)", mjs: "JavaScript (ESM)", cjs: "JavaScript (CommonJS)",
    py: "Python", pyw: "Python",
    go: "Go",
    rs: "Rust",
    java: "Java",
    kt: "Kotlin", kts: "Kotlin",
    cs: "C#",
    php: "PHP",
    swift: "Swift",
    rb: "Ruby",
    cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
    c: "C", h: "C/C++",
    dart: "Dart",
    scala: "Scala",
    ex: "Elixir", exs: "Elixir",
    lua: "Lua",
    zig: "Zig",
  };
  return LANG_MAP[ext] || null;
}

function assembleFixPrompt(input) {
  const { error, classification, codeBlock, functionContext, dependencies, dependents, cascadeRisk, hint, language, pastFix } = input;
  const lines = [];

  // Section 0: LANGUAGE/TECHNOLOGY (tells LLM what syntax to use)
  const detectedLang = language || detectLanguageFromFile(error.file);
  if (detectedLang) {
    lines.push(`Language: ${detectedLang}`);
  }

  // Section 1: ERROR TYPE + LOCATION
  lines.push(`[ERROR TYPE] ${error.code} in ${path.basename(error.file)} line ${error.line}`);
  lines.push(`Message: ${error.message}`);
  if (cascadeRisk && cascadeRisk !== "UNKNOWN") {
    lines.push(`Cascade risk: ${cascadeRisk}`);
  }
  lines.push("");

  // Section 2: DIAGNOSIS (BEFORE the code)
  if (classification) {
    lines.push("DIAGNOSIS:");
    if (classification.rootCause) lines.push(`  Cause: ${classification.rootCause}`);
    if (classification.prescription) lines.push(`  Fix: ${classification.prescription}`);
    lines.push("");
  }

  // Section 2.5: PAST SUCCESSFUL FIX (personalized from history — includes actual fix recipe)
  if (pastFix) {
    lines.push(`PREVIOUS FIX for similar error (${pastFix.source || "history"}):`);
    if (pastFix.fixDescription) lines.push(`  What was done: ${pastFix.fixDescription}`);
    if (pastFix.file) lines.push(`  File: ${pastFix.file}`);
    if (pastFix.fixDiff) {
      lines.push(`  Code change:`);
      lines.push(`  ${pastFix.fixDiff.split("\n").join("\n  ")}`);
    }
    if (!pastFix.fixDiff) {
      lines.push(`  Strategy: ${pastFix.strategy}`);
    }
    lines.push("");
  }

  // Section 3: COMPILER HINT
  if (hint?.suggestion) {
    lines.push(`Compiler suggestion: replace with '${hint.suggestion}' (confidence: ${hint.applicability})`);
    lines.push("");
  }

  // Section 4: FIX EXAMPLE
  if (codeBlock) {
    lines.push("Fix example (from error catalog):");
    lines.push(codeBlock);
    lines.push("");
  }

  // Section 5: CODE CONTEXT
  lines.push("Code context:");
  lines.push(functionContext || `  (line ${error.line} in ${path.basename(error.file)})`);
  lines.push("");

  // Section 6: DEPENDENCY INFO
  if (dependencies?.length > 0) {
    lines.push("Available from imported files:");
    for (const dep of dependencies) {
      if (dep.definitions?.length > 0) {
        lines.push(`  ${dep.file}: ${dep.definitions.join(", ")}`);
      } else if (dep.exports?.length > 0) {
        lines.push(`  ${dep.file}: exports ${dep.exports.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (dependents?.length > 0) {
    lines.push("Files affected by changes here:");
    for (const dep of dependents) {
      lines.push(`  ${dep.file}: uses ${dep.imports?.join(", ") || "module"}`);
    }
    lines.push("");
  }

  // Section 7: INSTRUCTION (language-aware)
  const langNote = detectedLang ? ` Use correct ${detectedLang} syntax.` : "";
  lines.push(`Fix this error.${langNote} If the fix requires changing another file (the root cause), change THAT file, not this one.`);

  return lines.join("\n");
}

module.exports = { assembleFixPrompt, detectLanguageFromFile };
