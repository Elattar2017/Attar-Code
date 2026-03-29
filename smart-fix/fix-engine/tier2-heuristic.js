// smart-fix/fix-engine/tier2-heuristic.js
// Generates 2-3 fix candidates for LLM to choose from

const path = require("path");

const TIER2_STRATEGIES = new Set([
  "fix_syntax", "update_type_annotation", "add_null_check",
  "cast_type", "initialize_variable", "add_missing_return", "close_bracket",
]);

/**
 * Generate 2-3 candidate fixes for an error. LLM picks the best one.
 * @returns {object|null} { candidates: [{id, code, rationale, confidence}], context, promptBlock }
 */
function generateHeuristicCandidates(error, fileContent, captures, language) {
  const strategy = error.fixHint?.primaryStrategy;
  if (!strategy || !TIER2_STRATEGIES.has(strategy)) return null;

  const lines = fileContent.split("\n");
  const lineIdx = (error.line || 1) - 1;
  const errorLine = lineIdx >= 0 && lineIdx < lines.length ? lines[lineIdx] : "";

  // Surrounding context (5 lines above and below)
  const ctxStart = Math.max(0, lineIdx - 5);
  const ctxEnd = Math.min(lines.length, lineIdx + 6);
  const context = lines.slice(ctxStart, ctxEnd).map((l, i) => {
    const lineNum = ctxStart + i + 1;
    const marker = lineNum === error.line ? " >>>" : "    ";
    return `${marker} ${lineNum}: ${l}`;
  }).join("\n");

  let candidates;

  switch (strategy) {
    case "add_null_check":
      candidates = generateNullCheckCandidates(error, errorLine, captures, language);
      break;
    case "cast_type":
      candidates = generateCastCandidates(error, errorLine, captures, language);
      break;
    case "update_type_annotation":
      candidates = generateTypeAnnotationCandidates(error, errorLine, captures, language);
      break;
    case "add_missing_return":
      candidates = generateMissingReturnCandidates(error, lines, lineIdx, captures, language);
      break;
    case "fix_syntax":
      candidates = generateSyntaxCandidates(error, errorLine, captures, language);
      break;
    case "initialize_variable":
      candidates = generateInitCandidates(error, errorLine, captures, language);
      break;
    case "close_bracket":
      candidates = generateCloseBracketCandidates(error, lines, lineIdx);
      break;
    default:
      return null;
  }

  if (!candidates || candidates.length === 0) return null;

  // Build structured prompt block for LLM
  const promptBlock = buildPromptBlock(error, context, candidates);

  return { candidates, context, promptBlock };
}

// ── Candidate Generators ──

function generateNullCheckCandidates(error, errorLine, captures, language) {
  const symbol = captures.symbolName || error.message?.match(/['"](\w+)['"]/)?.[1] || "value";
  const candidates = [];

  if (language === "TypeScript" || language === "JavaScript") {
    candidates.push({
      id: 0,
      code: errorLine.replace(new RegExp(`\\b${symbol}\\b`), `${symbol}?`),
      rationale: "Optional chaining — safely access property, returns undefined if null",
      confidence: 0.7,
    });
    candidates.push({
      id: 1,
      code: `if (${symbol}) {\n  ${errorLine.trim()}\n}`,
      rationale: "Explicit null guard — skips the operation entirely if null",
      confidence: 0.6,
    });
    candidates.push({
      id: 2,
      code: errorLine.replace(new RegExp(`\\b${symbol}\\b`), `${symbol}!`),
      rationale: "Non-null assertion — tells TypeScript you guarantee it's not null (use only if certain)",
      confidence: 0.4,
    });
  } else if (language === "Python") {
    candidates.push({
      id: 0,
      code: `if ${symbol} is not None:\n    ${errorLine.trim()}`,
      rationale: "Explicit None check before access",
      confidence: 0.7,
    });
    candidates.push({
      id: 1,
      code: errorLine.replace(new RegExp(`\\b${symbol}\\b`), `(${symbol} or default_value)`),
      rationale: "Falsy fallback — use default if None/empty",
      confidence: 0.5,
    });
  } else if (language === "Rust") {
    candidates.push({
      id: 0,
      code: errorLine.replace(/\.unwrap\(\)/, ".unwrap_or_default()"),
      rationale: "unwrap_or_default — returns Default::default() instead of panicking",
      confidence: 0.7,
    });
    candidates.push({
      id: 1,
      code: errorLine.replace(/\.unwrap\(\)/, "?"),
      rationale: "? operator — propagates the error to the caller",
      confidence: 0.8,
    });
  } else if (language === "Swift") {
    candidates.push({
      id: 0,
      code: `if let ${symbol} = ${symbol} {\n    ${errorLine.trim()}\n}`,
      rationale: "if let unwrap — safely unwraps the optional",
      confidence: 0.7,
    });
    candidates.push({
      id: 1,
      code: `guard let ${symbol} = ${symbol} else { return }`,
      rationale: "guard let — early exit if nil",
      confidence: 0.6,
    });
    candidates.push({
      id: 2,
      code: errorLine.replace(new RegExp(`\\b${symbol}\\b`), `${symbol} ?? defaultValue`),
      rationale: "Nil coalescing — provide a default value",
      confidence: 0.5,
    });
  }

  return candidates.length > 0 ? candidates : null;
}

function generateCastCandidates(error, errorLine, captures, language) {
  const actualType = captures.actualType || captures.actual_type || "unknown";
  const expectedType = captures.expectedType || captures.expected_type || "unknown";
  const candidates = [];

  if (language === "TypeScript" || language === "JavaScript") {
    candidates.push({
      id: 0,
      code: errorLine + ` as ${expectedType}`,
      rationale: `Type assertion — cast to ${expectedType}`,
      confidence: 0.5,
    });
    candidates.push({
      id: 1,
      code: errorLine.replace(actualType, expectedType),
      rationale: `Change the type annotation from ${actualType} to ${expectedType}`,
      confidence: 0.6,
    });
  } else if (language === "Go") {
    candidates.push({
      id: 0,
      code: errorLine.replace(new RegExp(`\\b${actualType}\\b`), `${expectedType}`),
      rationale: `Type conversion: ${expectedType}(value)`,
      confidence: 0.6,
    });
  } else if (language === "Rust") {
    candidates.push({
      id: 0,
      code: errorLine.trimEnd() + ".into()",
      rationale: `.into() — convert using the Into trait`,
      confidence: 0.6,
    });
    candidates.push({
      id: 1,
      code: errorLine.replace(/&(\w+)/, "$1.clone()"),
      rationale: `.clone() — create an owned copy`,
      confidence: 0.5,
    });
  } else if (language === "Python") {
    candidates.push({
      id: 0,
      code: `${expectedType}(${errorLine.trim()})`,
      rationale: `Explicit type conversion to ${expectedType}`,
      confidence: 0.5,
    });
  }

  return candidates.length > 0 ? candidates : null;
}

function generateTypeAnnotationCandidates(error, errorLine, captures, language) {
  const actualType = captures.actualType || "actual";
  const expectedType = captures.expectedType || "expected";
  const candidates = [];

  if (language === "TypeScript" || language === "JavaScript") {
    candidates.push({
      id: 0,
      code: errorLine.replace(expectedType, `${actualType} | ${expectedType}`),
      rationale: `Widen type to union: ${actualType} | ${expectedType}`,
      confidence: 0.6,
    });
    candidates.push({
      id: 1,
      code: errorLine.replace(actualType, expectedType),
      rationale: `Narrow to expected type: ${expectedType}`,
      confidence: 0.5,
    });
  }

  return candidates.length > 0 ? candidates : null;
}

function generateMissingReturnCandidates(error, lines, lineIdx, captures, language) {
  // Find the function containing this line
  let funcEnd = lineIdx;
  let depth = 0;
  for (let i = lineIdx; i < lines.length; i++) {
    depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
    if (depth <= 0) { funcEnd = i; break; }
  }

  const candidates = [];
  const indent = "  ";

  if (language === "TypeScript" || language === "JavaScript") {
    candidates.push({ id: 0, code: `${indent}return undefined;`, rationale: "Return undefined (safe default)", confidence: 0.5 });
    candidates.push({ id: 1, code: `${indent}return null;`, rationale: "Return null (explicit no-value)", confidence: 0.5 });
    candidates.push({ id: 2, code: `${indent}throw new Error('Not implemented');`, rationale: "Throw error (make it explicit this needs implementation)", confidence: 0.4 });
  } else if (language === "Python") {
    candidates.push({ id: 0, code: `${indent}return None`, rationale: "Return None", confidence: 0.6 });
    candidates.push({ id: 1, code: `${indent}raise NotImplementedError()`, rationale: "Raise NotImplementedError", confidence: 0.4 });
  } else if (language === "Go") {
    candidates.push({ id: 0, code: `${indent}return`, rationale: "Empty return (for void functions)", confidence: 0.5 });
    candidates.push({ id: 1, code: `${indent}return nil`, rationale: "Return nil (for pointer/interface returns)", confidence: 0.5 });
  } else if (language === "Rust") {
    candidates.push({ id: 0, code: `${indent}todo!()`, rationale: "todo!() macro — marks as unimplemented", confidence: 0.4 });
    candidates.push({ id: 1, code: `${indent}Default::default()`, rationale: "Default::default() — zero value for the return type", confidence: 0.5 });
  }

  // Each candidate needs to be inserted before funcEnd
  return candidates.length > 0 ? candidates.map(c => ({
    ...c,
    insertAtLine: funcEnd, // Insert before closing brace
  })) : null;
}

function generateSyntaxCandidates(error, errorLine, captures, language) {
  const expected = captures.expected || error.message?.match(/['"]([^'"]+)['"]\s*expected/)?.[1] || "";
  if (!expected) return null;

  const candidates = [];
  const col = error.column || errorLine.length;

  candidates.push({
    id: 0,
    code: errorLine.slice(0, col) + expected + errorLine.slice(col),
    rationale: `Insert '${expected}' at the error position`,
    confidence: 0.6,
  });

  if (col > 0) {
    candidates.push({
      id: 1,
      code: errorLine.slice(0, col - 1) + expected + errorLine.slice(col),
      rationale: `Replace character before error with '${expected}'`,
      confidence: 0.4,
    });
  }

  return candidates;
}

function generateInitCandidates(error, errorLine, captures, language) {
  const varName = captures.symbolName || error.message?.match(/['"](\w+)['"]/)?.[1] || "variable";
  const candidates = [];

  if (language === "TypeScript" || language === "JavaScript") {
    candidates.push({ id: 0, code: errorLine.replace(/;?\s*$/, " = undefined;"), rationale: "Initialize to undefined", confidence: 0.5 });
    candidates.push({ id: 1, code: errorLine.replace(/;?\s*$/, " = null;"), rationale: "Initialize to null", confidence: 0.5 });
  } else if (language === "Python") {
    candidates.push({ id: 0, code: `${varName} = None`, rationale: "Initialize to None", confidence: 0.6 });
  }

  return candidates.length > 0 ? candidates : null;
}

function generateCloseBracketCandidates(error, lines, lineIdx) {
  // Walk backwards to find unmatched opening bracket
  let braceCount = 0;
  for (let i = lineIdx; i >= 0; i--) {
    braceCount += (lines[i].match(/}/g) || []).length - (lines[i].match(/{/g) || []).length;
    if (braceCount < 0) {
      // Found an unmatched {
      const indent = lines[i].match(/^(\s*)/)?.[1] || "";
      return [
        { id: 0, code: `${indent}}`, rationale: `Close bracket matching line ${i + 1}`, confidence: 0.7, insertAtLine: lineIdx + 1 },
      ];
    }
  }
  return null;
}

// ── Prompt Block Builder ──

function buildPromptBlock(error, context, candidates) {
  const lines = [];
  lines.push(`[CHOICE] Error ${error.code} in ${path.basename(error.file)} line ${error.line}:`);
  lines.push(`Message: ${error.message}`);
  // Add language so LLM generates correct syntax
  const ext = (error.file || "").split(".").pop()?.toLowerCase();
  const LANG_MAP = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#", php: "PHP", swift: "Swift" };
  const lang = LANG_MAP[ext];
  if (lang) lines.push(`Language: ${lang}`);
  lines.push("");
  lines.push("Context:");
  lines.push(context);
  lines.push("");
  lines.push("Choose the best fix:");
  for (const c of candidates) {
    lines.push(`  [${c.id}] ${c.rationale}`);
    lines.push(`      Code: ${c.code.split("\n")[0]}${c.code.includes("\n") ? " ..." : ""}`);
  }
  // Include codeBlock example if available from plugin
  if (error.codeBlock) {
    lines.push("");
    lines.push("Reference fix (from error catalog):");
    lines.push(error.codeBlock);
  }
  lines.push("");
  lines.push(`Reply with the number (${candidates.map(c => c.id).join(", ")}) of the best fix, or describe a different approach.`);
  return lines.join("\n");
}

module.exports = { generateHeuristicCandidates, TIER2_STRATEGIES, buildPromptBlock };
