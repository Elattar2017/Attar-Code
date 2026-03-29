// smart-fix/function-extractor.js
// Finds the enclosing function for a given line number

const FUNC_PATTERNS = {
  JavaScript: /^[\s]*((?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)))/,
  TypeScript: /^[\s]*((?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*[:=]|(?:public|private|protected|static|async)\s+(\w+)\s*\())/,
  Python: /^(\s*)((?:async\s+)?def\s+(\w+)\s*\()/,
  Go: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,
  Rust: /^[\s]*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  Java: /^[\s]*(?:public|private|protected|static|\s)*\s+\w+(?:<[^>]*>)?\s+(\w+)\s*\(/,
  CSharp: /^[\s]*(?:public|private|protected|internal|static|async|virtual|override|\s)*\s+\w+(?:<[^>]*>)?\s+(\w+)\s*\(/,
  PHP: /^[\s]*(?:public|private|protected|static|\s)*function\s+(\w+)\s*\(/,
  Swift: /^[\s]*(?:public|private|internal|open|static|\s)*func\s+(\w+)/,
  Kotlin: /^[\s]*(?:public|private|protected|internal|override|suspend|\s)*fun\s+(\w+)/,
  Cpp: /^[\s]*(?:template\s*<[^>]*>\s*)?(?:static|virtual|inline|const|extern|\s)*\w+[\w\s*&<>,]*\s+(\w+)\s*\(/,
  Ruby: /^(\s*)(def\s+(\w+[?!]?))/,
  Dart: /^[\s]*(?:(?:static|async|final|const|late)\s+)*(?!(?:throw|return|if|else|for|while|await|new)\b)\w+[\w<>,\s]*\s+(\w+)\s*\(/,
};

function extractEnclosingFunction(code, errorLine, language) {
  const lines = code.split("\n");
  const lang = normalizeLang(language);
  const pattern = FUNC_PATTERNS[lang];
  if (!pattern) return fallbackWindow(lines, errorLine);
  if (lang === "Python" || lang === "Ruby") return extractPythonFunction(lines, errorLine, pattern);
  return extractBraceFunction(lines, errorLine, pattern);
}

function extractBraceFunction(lines, errorLine, pattern) {
  let funcStart = -1;
  let funcName = null;
  for (let i = errorLine - 1; i >= 0; i--) {
    const match = lines[i].match(pattern);
    if (match) {
      // For const/let/var matches, verify it's a function declaration, not a regular variable
      const matchedName = match[2] || match[3] || match[4] || match[1];
      const line = lines[i];
      if (/\b(?:const|let|var)\s/.test(line) && !/(=>|function\b)/.test(line)) {
        // This is a regular variable assignment, not a function — keep looking
        continue;
      }
      funcStart = i + 1;
      funcName = matchedName;
      break;
    }
  }
  if (funcStart === -1) return fallbackWindow(lines, errorLine);
  let braceCount = 0;
  let funcEnd = lines.length;
  let started = false;
  for (let i = funcStart - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { braceCount++; started = true; }
      if (ch === "}") braceCount--;
      if (started && braceCount === 0) {
        funcEnd = i + 1;
        return buildResult(lines, funcStart, funcEnd, funcName, errorLine);
      }
    }
  }
  return buildResult(lines, funcStart, Math.min(funcEnd, funcStart + 50), funcName, errorLine);
}

function extractPythonFunction(lines, errorLine, pattern) {
  let funcStart = -1;
  let funcName = null;
  let funcIndent = 0;
  for (let i = errorLine - 1; i >= 0; i--) {
    const match = lines[i].match(pattern);
    if (match) {
      funcStart = i + 1;
      funcIndent = match[1].length;
      funcName = match[3];
      break;
    }
  }
  if (funcStart === -1) return fallbackWindow(lines, errorLine);
  let funcEnd = lines.length;
  let lastNonBlank = funcStart;
  for (let i = funcStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= funcIndent && i > funcStart) {
      funcEnd = lastNonBlank;
      break;
    }
    lastNonBlank = i + 1; // 1-based line number of this non-blank line
  }
  return buildResult(lines, funcStart, funcEnd, funcName, errorLine);
}

function fallbackWindow(lines, errorLine) {
  const start = Math.max(1, errorLine - 15);
  const end = Math.min(lines.length, errorLine + 15);
  return buildResult(lines, start, end, null, errorLine);
}

function buildResult(lines, startLine, endLine, name, errorLine) {
  const codeLines = lines.slice(startLine - 1, endLine).map((l, i) => {
    const num = startLine + i;
    const marker = num === errorLine ? " >>> " : "     ";
    return `${marker}${num}: ${l}`;
  });
  return { startLine, endLine, name, code: codeLines.join("\n") };
}

function normalizeLang(lang) {
  if (!lang) return "JavaScript";
  const l = lang.toLowerCase();
  if (l.includes("typescript") || l === "ts") return "TypeScript";
  if (l.includes("javascript") || l === "js") return "JavaScript";
  if (l.includes("python") || l === "py") return "Python";
  if (l.includes("go") || l === "golang") return "Go";
  if (l.includes("rust") || l === "rs") return "Rust";
  if (l.includes("java") && !l.includes("script")) return "Java";
  if (l.includes("c#") || l.includes("csharp")) return "CSharp";
  if (l.includes("php")) return "PHP";
  if (l.includes("swift")) return "Swift";
  if (l.includes("kotlin") || l === "kt") return "Kotlin";
  if (l.includes("c++") || l.includes("cpp") || l === "cc" || l === "cxx") return "Cpp";
  if (l.includes("ruby") || l === "rb") return "Ruby";
  if (l.includes("dart")) return "Dart";
  return "JavaScript";
}

module.exports = { extractEnclosingFunction };
