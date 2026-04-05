const fs = require("fs");
const path = require("path");

// Language-specific function/class patterns
const PATTERNS = {
  javascript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/gm,
    /^(?:export\s+)?class\s+(\w+)/gm,
  ],
  typescript: [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/gm,
    /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
    /^(?:export\s+)?interface\s+(\w+)/gm,
  ],
  python: [
    /^(?:async\s+)?def\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
  ],
  go: [
    /^func\s+(?:\([^)]+\)\s+)?(\w+)/gm,
    /^type\s+(\w+)\s+struct/gm,
  ],
  rust: [
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm,
    /^(?:pub\s+)?struct\s+(\w+)/gm,
    /^(?:pub\s+)?enum\s+(\w+)/gm,
    /^impl(?:<[^>]+>)?\s+(\w+)/gm,
  ],
  java: [
    /^(?:\s*)(?:public|private|protected)?\s*(?:static\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\(/gm,
    /^(?:\s*)(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/gm,
  ],
  php: [
    /^(?:\s*)(?:public|private|protected)?\s*(?:static\s+)?function\s+(\w+)/gm,
    /^(?:\s*)class\s+(\w+)/gm,
  ],
  ruby: [
    /^(?:\s*)def\s+(\w+)/gm,
    /^(?:\s*)class\s+(\w+)/gm,
    /^(?:\s*)module\s+(\w+)/gm,
  ],
  csharp: [
    /^(?:\s*)(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\(/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*(?:abstract\s+|sealed\s+|static\s+)?class\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*interface\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*record\s+(\w+)/gm,
    /^(?:\s*)namespace\s+([\w.]+)/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*enum\s+(\w+)/gm,
  ],
  swift: [
    /^(?:\s*)(?:public|private|internal|open)?\s*func\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|internal|open)?\s*class\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|internal|open)?\s*struct\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|internal|open)?\s*protocol\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|internal|open)?\s*enum\s+(\w+)/gm,
    /^(?:\s*)extension\s+(\w+)/gm,
  ],
  kotlin: [
    /^(?:\s*)(?:public|private|protected|internal)?\s*fun\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*(?:data\s+|sealed\s+|abstract\s+|open\s+)?class\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*interface\s+(\w+)/gm,
    /^(?:\s*)(?:public|private|protected|internal)?\s*object\s+(\w+)/gm,
  ],
};

function preprocessCode(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  const LANG_MAP = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".cs": "csharp",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
  };
  const language = LANG_MAP[ext] || "javascript";

  // Extract import section (first N lines that are imports/requires)
  const lines = content.split("\n");
  const importLines = [];
  for (const line of lines) {
    if (
      /^(?:import|from|require|use|package|#include|using)\b/.test(
        line.trim()
      ) ||
      /^(?:const|let|var)\s+\w+\s*=\s*require/.test(line.trim())
    ) {
      importLines.push(line);
    } else if (line.trim() === "" && importLines.length > 0) {
      continue; // skip blank lines between imports
    } else if (importLines.length > 0) {
      break; // end of import section
    }
  }
  const importHeader = importLines.join("\n");

  // Split into function/class blocks using regex
  const patterns = PATTERNS[language] || PATTERNS.javascript;
  const blocks = splitByPatterns(content, patterns, language);

  if (blocks.length === 0) {
    // No functions found — return whole file as one chunk
    return {
      chunks: [{ content, name: path.basename(filePath), type: "file" }],
      title: path.basename(filePath),
      format: "code",
      language,
      importHeader,
    };
  }

  return {
    chunks: blocks.map((b) => ({
      content: importHeader ? importHeader + "\n\n" + b.content : b.content,
      name: b.name,
      type: b.type,
    })),
    title: path.basename(filePath),
    format: "code",
    language,
    importHeader,
  };
}

function splitByPatterns(content, patterns, language) {
  // Find all function/class start positions
  const matches = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      matches.push({
        index: m.index,
        name: m[1],
        type: m[0].includes("class")
          ? "class"
          : m[0].includes("struct")
          ? "struct"
          : "function",
      });
    }
  }
  matches.sort((a, b) => a.index - b.index);

  if (matches.length === 0) return [];

  // Extract blocks between matches
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end =
      i + 1 < matches.length ? matches[i + 1].index : content.length;
    blocks.push({
      content: content.slice(start, end).trim(),
      name: matches[i].name,
      type: matches[i].type,
    });
  }

  return blocks;
}

module.exports = { preprocessCode };
