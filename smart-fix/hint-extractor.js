// smart-fix/hint-extractor.js
// Extracts structured compiler hints from error messages across all languages

const HINT_PATTERNS = [
  // Rust: multi-line format — "help: a macro/X with a similar name exists" followed by replacement source line
  { re: /help:[^\n]*similar name[\s\S]{0,300}?\d+\s*\|\s+([A-Za-z_]\w*)/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Rust: "help: a X with a similar name exists: `Y`"
  { re: /help:\s+.*similar name exists:\s*[`']([^`']+)[`']/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Rust: "help: consider importing this Y: `use Z`"
  { re: /help:\s+consider (?:importing|using)[^:]*:\s*[`']?([^`'\n]+)[`']?/, type: "suggested_import", applicability: "MaybeIncorrect" },
  // Go: "imported and not used"
  { re: /"([^"]+)" imported and not used/, type: "unused_import", applicability: "MachineApplicable" },
  // Go: "declared and not used"
  { re: /(\w+) declared (?:and|but) not used/, type: "unused_variable", applicability: "MachineApplicable" },
  // Elixir: "did you mean one of:" or "did you mean:" followed by newline + "* functionName/arity"
  // Must come before the generic "did you mean:" Python pattern to avoid capturing the bullet prefix
  { re: /did you mean(?:\s+one of)?:?\s*\n\s*\*\s*(\w+)/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // TypeScript: "Did you mean to use 'X'?"
  { re: /[Dd]id you mean to (?:use|call)\s+['`"]([^'`"]+)['`"]\??/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Python: "Did you mean: 'X'?"
  { re: /[Dd]id you mean:\s*['`"]?([^'`"?\n]+)['`"]?\??/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Python: "perhaps you meant 'X'"
  { re: /perhaps you meant\s+['`"]([^'`"]+)['`"]/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // C#: "Are you missing X?"
  { re: /Are you missing.*?['`"]([^'`"]+)['`"]/, type: "missing_reference", applicability: "MaybeIncorrect" },
  // Java/Kotlin: "cannot find symbol... did you mean 'X'?" — limited window to prevent ReDoS
  { re: /cannot find symbol[\s\S]{0,300}?did you mean\s*['`"]?(\w+)['`"]?\??/i, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Java: "error: cannot access X"
  { re: /cannot access\s+(\w+)/, type: "missing_reference", applicability: "MaybeIncorrect" },
  // PHP: "Did you mean X?" (unquoted, optionally backslash-prefixed namespace)
  { re: /Did you mean\s+\\?([^'`"\s?][^\s?]*)\s*\?/i, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // PHP: "Undefined variable $X"
  { re: /Undefined variable \$(\w+)/, type: "undefined_variable", applicability: "MaybeIncorrect" },
  // Rust: "consider borrowing here: `&X`"
  { re: /consider borrowing here:\s*[`']([^`']+)[`']/, type: "borrow_suggestion", applicability: "MaybeIncorrect" },
  // Swift: "did you mean 'X'?"
  { re: /did you mean\s+'([^']+)'\?/, type: "did_you_mean", applicability: "MachineApplicable" },
  // Kotlin: "Unresolved reference: X. Did you mean Y?"
  { re: /Unresolved reference:?\s*\w+.*?[Dd]id you mean\s+'?(\w+)'?\??/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // C/C++ (GCC/Clang): "note: suggested alternative: 'X'"
  { re: /note:\s*suggested alternative:\s*['`"]([^'`"]+)['`"]/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // C/C++ (GCC): "note: 'X' declared here" (after undefined reference)
  { re: /note:\s*['`"]([^'`"]+)['`"]\s+declared here/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Ruby: "Did you mean? X" (no quotes, question mark before suggestion)
  { re: /Did you mean\?\s+(\S+)/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Dart: "Try correcting the name to 'X'"
  { re: /Try correcting the name to\s+'([^']+)'/, type: "did_you_mean", applicability: "MaybeIncorrect" },
  // Dart: "Try importing the library that defines 'X'"
  { re: /Try importing the library that defines\s+'([^']+)'/, type: "suggested_import", applicability: "MaybeIncorrect" },
  // "Did you mean 'X'?" — universal fallback (must come after all language-specific patterns)
  { re: /[Dd]id you mean[:\s]+['`"]([^'`"]+)['`"]\??/, type: "did_you_mean", applicability: "MachineApplicable" },
];

function extractHints(message, fullOutput, language) {
  // language param reserved for future filtering — patterns are currently universal
  // Try message first, then full output
  for (const source of [message, fullOutput]) {
    if (!source) continue;
    for (const { re, type, applicability } of HINT_PATTERNS) {
      const match = source.match(re);
      if (match) {
        return {
          suggestion: match[1].trim(),
          type,
          applicability,
          raw: match[0],
        };
      }
    }
  }
  return null;
}

module.exports = { extractHints, HINT_PATTERNS };
