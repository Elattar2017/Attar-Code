// kb-engine/retrieval/kb-search-menu.js
// Conversational KB search menu — shows ONLY when intent is truly ambiguous.
//
// 90% of queries auto-route (no menu). Menu shows for:
//   - Vague queries ("python", "functions") — 1-3 generic words
//   - Structural overlap ("explain the closures section") — conceptual + structural noun
//
// Uses pendingApproval pattern for readline integration (same as permission dialogs).
"use strict";

// Structural nouns that indicate navigation intent when mixed with conceptual queries
const STRUCTURAL_NOUNS_RE = /\b(chapter|section|part|appendix|unit|module|lesson|topic)\b/i;

/**
 * Determine if a menu is needed for this query.
 *
 * @param {object} analysis  Result from analyzeQuery()
 * @param {string} userOriginal  The user's original message
 * @returns {{ show: boolean, variant: 'none'|'vague'|'structural_overlap' }}
 */
function needsMenu(analysis, userOriginal) {
  const type = analysis.type;

  // Clear types → never show menu
  if (['scope', 'error', 'cross_structural', 'code_examples', 'structural'].includes(type)) {
    return { show: false, variant: 'none' };
  }

  // Vague: 'general' type + very short query
  if (type === 'general') {
    const words = (userOriginal || '').trim().split(/\s+/).filter(w => w.length > 1);
    if (words.length <= 3) {
      return { show: true, variant: 'vague' };
    }
  }

  // Structural overlap: conceptual/api type BUT user mentions chapter/section/part
  if ((type === 'conceptual' || type === 'api') && STRUCTURAL_NOUNS_RE.test(userOriginal)) {
    return { show: true, variant: 'structural_overlap' };
  }

  // All other cases → auto-route, no menu
  return { show: false, variant: 'none' };
}

/**
 * Present a search type menu to the user. Only called when needsMenu().show is true.
 *
 * @param {string} userOriginal   User's original message
 * @param {string} modelQuery     Query from LLM tool call
 * @param {object} analysis       Result from analyzeQuery()
 * @param {Function} setPending   Function to set pendingApproval resolver
 * @param {object} opts
 * @param {boolean} opts.autoMode  Skip menu, return default
 * @param {Function} opts.stopSpinner
 * @param {Function} opts.startSpinner
 * @returns {Promise<{ searchType: string, effectiveQuery: string, skip: boolean }>}
 */
async function presentMenu(userOriginal, modelQuery, analysis, setPending, opts = {}) {
  const menuCheck = needsMenu(analysis, userOriginal);

  // No menu needed → return analysis type as-is
  if (!menuCheck.show || opts.autoMode) {
    const searchType = analysis.type === 'general' ? 'search' : analysis.type;
    return { searchType, effectiveQuery: modelQuery, skip: true };
  }

  // Stop spinner before showing menu
  if (opts.stopSpinner) opts.stopSpinner();

  let choice;

  if (menuCheck.variant === 'vague') {
    // Menu A: vague query
    process.stdout.write(
      "\n  KB Search — what would you like to do?\n" +
      "  (1) Search for relevant passages   [default]\n" +
      "  (2) Read a complete chapter or section\n" +
      "  (3) Browse what's available on this topic\n"
    );
    choice = await askWithTimeout(setPending, "  [1]: ", "1", 30000);
  } else {
    // Menu B: structural overlap
    const topic = modelQuery || userOriginal;
    process.stdout.write(
      `\n  Searching for: "${topic.slice(0, 50)}"\n` +
      "  (1) Find relevant passages   [default]\n" +
      "  (2) Read the complete section/chapter\n"
    );
    choice = await askWithTimeout(setPending, "  [1]: ", "1", 30000);
  }

  // Restart spinner
  if (opts.startSpinner) opts.startSpinner("searching");

  // Map choice to search type
  const choiceMap = {
    vague: { '1': 'search', '2': 'scope', '3': 'cross_structural' },
    structural_overlap: { '1': 'search', '2': 'scope' },
  };

  const map = choiceMap[menuCheck.variant] || choiceMap.vague;
  const searchType = map[choice.trim()] || 'search';
  const effectiveQuery = searchType === 'scope' ? userOriginal : modelQuery;

  return { searchType, effectiveQuery, skip: false };
}

/**
 * Ask the user with a timeout (defaults to choice if no response).
 * Uses a simple Promise that resolves on next stdin line.
 */
function askWithTimeout(setPending, promptText, defaultChoice, timeoutMs) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    const timer = setTimeout(() => {
      process.stdout.write(`(timed out — using default: ${defaultChoice})\n`);
      resolve(defaultChoice);
    }, timeoutMs);

    // Use the pendingApproval pattern — the main REPL routes the next input here
    setPending((input) => {
      clearTimeout(timer);
      resolve(input || defaultChoice);
    });
  });
}

/**
 * Generate progressive disclosure suggestions based on query and result type.
 * Appended AFTER search results to guide the user's next step.
 *
 * @param {string} query      The search query
 * @param {string} searchType The type that was executed
 * @param {number} resultCount How many results were returned
 * @returns {string}  Suggestion text to append (or empty string)
 */
function progressiveDisclosure(query, searchType, resultCount) {
  if (resultCount === 0) return '';

  const suggestions = [];
  const shortQuery = query.slice(0, 40);

  if (searchType === 'search') {
    suggestions.push(`→ "read the section on ${shortQuery}" — get the complete section`);
    suggestions.push(`→ "which chapters discuss ${shortQuery}" — see all chapters covering this`);
  } else if (searchType === 'scope') {
    suggestions.push(`→ "search ${shortQuery}" — find specific passages about this topic`);
    suggestions.push(`→ "list chapters" — browse all available chapters`);
  } else if (searchType === 'cross_structural') {
    suggestions.push(`→ "explain chapter N" — read a specific chapter in full`);
  }

  if (suggestions.length === 0) return '';
  return '\n\n  ' + suggestions.slice(0, 2).join('\n  ');
}

module.exports = { presentMenu, needsMenu, progressiveDisclosure };
