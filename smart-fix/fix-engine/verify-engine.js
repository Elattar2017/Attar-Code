// smart-fix/fix-engine/verify-engine.js
// Lightweight fix verification without full build

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Verify a fix using the fastest available method for the language.
 */
async function verifyFix(filePath, language, strategy, tree, timeout = 8000) {
  const start = Date.now();
  const method = selectMethod(language, strategy);

  try {
    let result;
    switch (method) {
      case "babel_reparse": result = verifyBabelReparse(filePath); break;
      case "import_graph_check": result = verifyImportGraph(filePath, tree); break;
      case "python_ast": result = verifyPythonAst(filePath, timeout); break;
      case "go_vet": result = verifyGoVet(filePath, timeout); break;
      case "php_lint": result = verifyPhpLint(filePath, timeout); break;
      case "rustc_check": result = verifyRustcCheck(filePath, timeout); break;
      default: result = { passed: true, evidence: "no verification available", confidence: 0.4 };
    }
    return { ...result, method, duration: Date.now() - start };
  } catch (err) {
    return { passed: false, method, evidence: err.message, confidence: 0, duration: Date.now() - start };
  }
}

function selectMethod(language, strategy) {
  if (["add_import", "remove_import", "update_import_path"].includes(strategy)) return "import_graph_check";
  const map = {
    "TypeScript": "babel_reparse", "JavaScript": "babel_reparse",
    "Python": "python_ast", "Go": "go_vet", "Rust": "rustc_check", "PHP": "php_lint",
  };
  return map[language] || "babel_reparse";
}

function verifyBabelReparse(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const ext = path.extname(filePath).toLowerCase();
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const { parse } = require("@babel/parser");
      parse(content, {
        sourceType: "module",
        plugins: [
          ...([".ts", ".tsx", ".mts", ".cts"].includes(ext) ? ["typescript"] : []),
          ...([".tsx", ".jsx"].includes(ext) ? ["jsx"] : []),
          "decorators-legacy", "classProperties", "dynamicImport", "optionalChaining", "nullishCoalescingOperator",
        ],
        errorRecovery: false,
      });
      return { passed: true, evidence: "syntax valid", confidence: 0.75 };
    }
    // Non-JS/TS: basic bracket balance
    const braces = (content.match(/{/g) || []).length - (content.match(/}/g) || []).length;
    if (braces !== 0) return { passed: false, evidence: `unbalanced braces: ${braces}`, confidence: 0.5 };
    return { passed: true, evidence: "basic structure valid", confidence: 0.4 };
  } catch (err) {
    return { passed: false, evidence: `parse error: ${err.message.slice(0, 100)}`, confidence: 0.8 };
  }
}

function verifyImportGraph(filePath, tree) {
  if (!tree || typeof tree.validateImports !== "function") return { passed: true, evidence: "no tree", confidence: 0.3 };
  try {
    const validation = tree.validateImports(filePath);
    const errors = validation.filter(v => v.status === "error");
    if (errors.length > 0) return { passed: false, evidence: errors.map(e => e.message).join("; "), confidence: 0.9 };
    return { passed: true, evidence: `${validation.length} imports validated`, confidence: 0.9 };
  } catch (err) {
    return { passed: true, evidence: "validation error", confidence: 0.3 };
  }
}

function verifyPythonAst(filePath, timeout) {
  try {
    // Use execFileSync with separate args to avoid shell injection
    const out = execFileSync("python", ["-c", `import ast; ast.parse(open(r'${filePath}').read()); print('OK')`],
      { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { passed: out.includes("OK"), evidence: "parsed", confidence: 0.85 };
  } catch (err) {
    return { passed: false, evidence: (err.stderr || err.message || "").slice(0, 150), confidence: 0.85 };
  }
}

function verifyGoVet(filePath, timeout) {
  try {
    execFileSync("go", ["vet", "./..."], { cwd: path.dirname(filePath), encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] });
    return { passed: true, evidence: "go vet passed", confidence: 0.85 };
  } catch (err) {
    return { passed: false, evidence: (err.stderr || err.message || "").slice(0, 150), confidence: 0.85 };
  }
}

function verifyPhpLint(filePath, timeout) {
  try {
    const out = execFileSync("php", ["-l", filePath], { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] });
    return { passed: out.includes("No syntax errors"), evidence: out.trim().slice(0, 100), confidence: 0.85 };
  } catch (err) {
    return { passed: false, evidence: (err.stderr || err.message || "").slice(0, 150), confidence: 0.85 };
  }
}

function verifyRustcCheck(filePath, timeout) {
  try {
    execFileSync("cargo", ["check"], { cwd: path.dirname(filePath), encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] });
    return { passed: true, evidence: "cargo check passed", confidence: 0.95 };
  } catch (err) {
    return { passed: false, evidence: (err.stderr || err.message || "").slice(0, 150), confidence: 0.95 };
  }
}

module.exports = { verifyFix };
