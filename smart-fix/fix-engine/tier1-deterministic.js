// smart-fix/fix-engine/tier1-deterministic.js
// Auto-generates and applies fixes WITHOUT LLM involvement

const fs = require("fs");
const path = require("path");

const TIER1_STRATEGIES = new Set([
  "add_import", "remove_import", "update_import_path",
  "add_semicolon", "fix_indentation", "remove_duplicate",
  "apply_compiler_hint",
]);

/**
 * Attempt to generate a deterministic fix for an error.
 * @param {object} error - classified error with captures, fixHint, originFile
 * @param {string} fileContent - current file content
 * @param {object} tree - TreeManager for export lookup
 * @param {string} language - detected language
 * @returns {object|null} { patch, strategy, confidence, description } or null
 */
function generateDeterministicFix(error, fileContent, tree, language) {
  const strategy = error.fixHint?.primaryStrategy;
  if (!strategy || !TIER1_STRATEGIES.has(strategy)) return null;

  const lines = fileContent.split("\n");
  const captures = error.captures || {};

  switch (strategy) {
    case "add_import":
      return fixAddImport(error, lines, captures, tree, language);
    case "remove_import":
      return fixRemoveImport(error, lines, captures, language);
    case "update_import_path":
      return fixUpdateImportPath(error, lines, captures, tree, language);
    case "add_semicolon":
      return fixAddSemicolon(error, lines);
    case "remove_duplicate":
      return fixRemoveDuplicate(error, lines, captures);
    case "apply_compiler_hint":
      return fixApplyCompilerHint(error, lines);
    default:
      return null;
  }
}

// ── Strategy: add_import ──

function fixAddImport(error, lines, captures, tree, language) {
  // Extract the missing symbol name
  const symbolName = captures.symbolName || captures.typeName || captures.propertyName ||
    error.message?.match(/['"](\w{2,50})['"]/)?.[1] || null;
  if (!symbolName) return null;

  // Search project exports for the symbol
  if (!tree || typeof tree.getAllExports !== "function") return null;
  const allExports = tree.getAllExports();
  let sourceFile = null;
  let sourceBasename = null;

  for (const [filePath, symbols] of Object.entries(allExports)) {
    if (symbols.includes(symbolName) && path.resolve(filePath) !== path.resolve(error.file)) {
      sourceFile = filePath;
      sourceBasename = path.basename(filePath).replace(/\.\w+$/, "");
      break;
    }
  }

  if (!sourceFile) return null; // Symbol not found in project — can't auto-fix

  // Compute relative import path
  const fromDir = path.dirname(error.file);
  let relPath = path.relative(fromDir, sourceFile).replace(/\\/g, "/").replace(/\.\w+$/, "");
  if (!relPath.startsWith(".")) relPath = "./" + relPath;

  // Generate import line per language
  let importLine;
  switch (language) {
    case "TypeScript":
    case "JavaScript":
      importLine = `import { ${symbolName} } from '${relPath}';`;
      break;
    case "Python":
      // Convert file path to Python module notation
      const pyModule = relPath.replace(/\.\//g, "").replace(/\//g, ".");
      importLine = `from ${pyModule} import ${symbolName}`;
      break;
    case "Go":
      importLine = `\t"${relPath.replace(/\.\//g, "")}"`;
      break;
    case "Rust":
      importLine = `use crate::${relPath.replace(/\.\//g, "").replace(/\//g, "::")}::${symbolName};`;
      break;
    case "Java / Kotlin":
      importLine = `import ${relPath.replace(/\.\//g, "").replace(/\//g, ".")}.${symbolName};`;
      break;
    case "C# / .NET":
      importLine = `using ${relPath.replace(/\.\//g, "").replace(/\//g, ".")};`;
      break;
    case "PHP":
      importLine = `use ${relPath.replace(/\.\//g, "").replace(/\//g, "\\")}\\${symbolName};`;
      break;
    case "Swift":
      importLine = `import ${sourceBasename}`;
      break;
    default:
      return null;
  }

  // Find insertion point (after last existing import)
  let insertLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(import |from |require|use |using |package )/.test(lines[i])) {
      insertLine = i + 1;
    }
  }

  return {
    patch: { type: "insert", insertAtLine: insertLine + 1, text: importLine },
    strategy: "add_import",
    confidence: 0.85,
    description: `Add import: ${importLine}`,
  };
}

// ── Strategy: remove_import ──

function fixRemoveImport(error, lines, captures, language) {
  const lineIdx = (error.line || 1) - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  const line = lines[lineIdx];
  // Verify this line is actually an import
  if (!/^\s*(import |from |require|use |using )/.test(line)) return null;

  return {
    patch: { type: "delete_line", deleteLine: error.line },
    strategy: "remove_import",
    confidence: 0.9,
    description: `Remove unused import: ${line.trim()}`,
  };
}

// ── Strategy: update_import_path ──

function fixUpdateImportPath(error, lines, captures, tree, language) {
  const lineIdx = (error.line || 1) - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  const line = lines[lineIdx];
  // Extract current module path from the import
  const pathMatch = line.match(/['"]([^'"]+)['"]/);
  if (!pathMatch) return null;
  const currentPath = pathMatch[1];

  // Try to find the correct path by searching for the module name
  const moduleName = path.basename(currentPath).replace(/\.\w+$/, "");
  if (!tree) return null;

  const allFiles = tree.graph?.getAllFiles?.() || [];
  const match = allFiles.find(f => {
    const base = path.basename(f).replace(/\.\w+$/, "");
    return base === moduleName && path.resolve(f) !== path.resolve(error.file);
  });

  if (!match) return null;

  const fromDir = path.dirname(error.file);
  let newPath = path.relative(fromDir, match).replace(/\\/g, "/").replace(/\.\w+$/, "");
  if (!newPath.startsWith(".")) newPath = "./" + newPath;

  const newLine = line.replace(currentPath, newPath);

  return {
    patch: { type: "replace_line", line: error.line, oldText: currentPath, newText: newPath },
    strategy: "update_import_path",
    confidence: 0.8,
    description: `Fix import path: '${currentPath}' → '${newPath}'`,
  };
}

// ── Strategy: add_semicolon ──

function fixAddSemicolon(error, lines) {
  const lineIdx = (error.line || 1) - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  const line = lines[lineIdx];
  if (line.trimEnd().endsWith(";")) return null; // Already has semicolon

  return {
    patch: { type: "replace_line", line: error.line, oldText: line, newText: line.trimEnd() + ";" },
    strategy: "add_semicolon",
    confidence: 0.95,
    description: `Add missing semicolon at line ${error.line}`,
  };
}

// ── Strategy: remove_duplicate ──

function fixRemoveDuplicate(error, lines, captures) {
  const symbolName = captures.symbolName || error.message?.match(/['"](\w+)['"]/)?.[1];
  if (!symbolName) return null;

  // Find the duplicate — the SECOND declaration of this symbol
  let firstFound = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(symbolName) && /\b(class|function|const|let|var|interface|type|enum|def|struct)\b/.test(lines[i])) {
      if (firstFound) {
        return {
          patch: { type: "delete_line", deleteLine: i + 1 },
          strategy: "remove_duplicate",
          confidence: 0.6,
          description: `Remove duplicate declaration of '${symbolName}' at line ${i + 1}`,
        };
      }
      firstFound = true;
    }
  }
  return null;
}

// ── Strategy: apply_compiler_hint ──

function fixApplyCompilerHint(error, lines) {
  if (!error.hint || error.hint.applicability !== "MachineApplicable") return null;
  if (error.hint.type !== "did_you_mean" && error.hint.type !== "unused_import") return null;

  const lineIdx = (error.line || 1) - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  const originalLine = lines[lineIdx];

  if (error.hint.type === "did_you_mean") {
    const wrong = error.captures?.wrong || error.captures?.symbol;
    if (!wrong) return null;
    if (!originalLine.includes(wrong)) return null;
    const newLine = originalLine.replace(wrong, error.hint.suggestion);
    if (newLine === originalLine) return null;
    return {
      strategy: "apply_compiler_hint",
      description: `Replace '${wrong}' with '${error.hint.suggestion}' (compiler suggestion)`,
      confidence: 0.95,
      patch: { file: error.file, line: error.line, text: newLine, original: originalLine },
    };
  }

  if (error.hint.type === "unused_import") {
    return {
      strategy: "apply_compiler_hint",
      description: `Remove unused import '${error.hint.suggestion}'`,
      confidence: 0.9,
      patch: { file: error.file, line: error.line, text: "", original: originalLine, action: "delete_line" },
    };
  }

  return null;
}

module.exports = { generateDeterministicFix, TIER1_STRATEGIES };
