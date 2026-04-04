'use strict';

/**
 * Regression tests for normalizeHeadings() in kb-engine/ingestion/index.js
 *
 * These tests use REAL data from ingested Python books to prevent regressions.
 * Every time the heading normalization logic changes, run these tests to verify
 * that valid headings are promoted and invalid ones are rejected.
 *
 * Run: node kb-engine/tests/heading-normalization.test.js
 */

const { normalizeHeadings } = require('../ingestion/index.js');

let pass = 0;
let fail = 0;

function test(description, input, expectHeading) {
  const result = normalizeHeadings(input).trim();
  const isHeading = result.startsWith('#');
  const ok = isHeading === expectHeading;
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL: ${description}`);
    console.log(`    Input:    ${JSON.stringify(input)}`);
    console.log(`    Expected: ${expectHeading ? 'HEADING' : 'KEPT AS-IS'}`);
    console.log(`    Got:      ${JSON.stringify(result)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALID HEADINGS — MUST be promoted to ## or ### format
// Source: Real section titles from Packt Python and Python Complete Guide books
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== Valid headings (must be promoted) ===');

// Standard section titles
test('CS term: List', '**List Comprehensions**', true);
test('CS term: Dictionary', '**Dictionary Methods**', true);
test('CS term: Array', '**Array Operations**', true);
test('CS term: Path', '**Working with Path Objects**', true);
test('CS term: Node', '**Node.js Integration**', true);
test('CS term: Graph', '**Graph Algorithms**', true);

// Chapter-style headings with colons
test('Chapter with colon', '**Chapter 3: Functions**', true);
test('Numbered with colon', '**1.5.3: Deliverables**', false); // has colon after number - this is `**N.N.N Title**` pattern
test('Section with colon', '**Section 2: Overview**', true);

// Numbered sections (matched by **N.N.N Title** pattern before bold pattern)
test('Numbered 3-level', '**12.3.2 RESTful API app**', true);
test('Numbered 2-level', '**10.3 Approach**', true);
test('Numbered 3-level long', '**4.4.1 Locate more JSON-format data**', true);
test('Numbered elaboration', '**1.2.3 Elaboration, part 2: define components and tests**', true);

// Short descriptive headings
test('Simple heading', '**Introduction**', true);
test('Two words', '**Getting Started**', true);
test('Nominal data', '**Nominal data**', true);
test('About reviewer', '**About the Reviewer**', true);

// Chapter N patterns (matched by Chapter pattern before bold)
test('Chapter pattern', 'Chapter 3: Functions and Closures', true);
test('Bold chapter', '**Chapter 5: Decorators**', true);

// ALL CAPS headings
test('ALL CAPS', 'ADVANCED TOPICS', true);
test('ALL CAPS multi', 'GETTING STARTED WITH PYTHON', true);

// Part/Appendix patterns
test('Part pattern', 'Part 2: Advanced Topics', true);
test('Appendix', 'Appendix A: Reference Guide', true);

// ═══════════════════════════════════════════════════════════════════════════
// INVALID — MUST NOT be promoted (code, sentences, questions, etc.)
// Source: Real content from Python books that was falsely promoted before
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== Invalid (must NOT be promoted) ===');

// Questions
test('Question', '**Is this a comment?**', false);
test('Question path', '**Direct path from v_start to v_end?**', false);

// Sentences ending with period
test('Sentence', "**We don't always know what the actual data looks like.**", false);

// Code with assignment/brackets
test('List assignment', '**list = [1, 2, 3]**', false);
test('Function def', '**def my_function(x, y):**', false);
test('Graph access', '**v_start = graph[0]**', false);
test('Import', '**import os**', false);
test('Ternary', '**print(True) if x else print(False)**', false);
test('Matrix', '**The graph represented as adjacency matrix G = [[1, 1, 0]]**', false);
test('Path assignment', '**path[0] = v_start**', false);

// Snake_case identifiers
test('Snake case vars', '**v_start and v_end are connected**', false);
test('Dunder', '**__init__ method in Python**', false);
test('Snake func', '**my_custom_function works here**', false);

// Too many words (>10)
test('Too long', '**Making an HTML re que s t with urllib re que s t module**', false);

// Content after closing bold
test('Content after bold', '**Developer Relations Marketing Executive** : Sonia Chauhan', false);

// ALL CAPS but sentence-like
test('ALL CAPS sentence.', 'THIS IS A FULL SENTENCE ENDING WITH A PERIOD.', false);
test('ALL CAPS question', 'IS THIS A QUESTION?', false);

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases — tricky content that tests boundary conditions
// ═══════════════════════════════════════════════════════════════════════════

console.log('=== Edge cases ===');

// Valid but contain words that could be confused
test('Edge: "Error Handling"', '**Error Handling**', true);
test('Edge: "Data Types"', '**Data Types**', true);
// These ARE valid heading titles even though they contain Python keywords.
// The keywords (class, return, import) appear as topic words, not code.
// Code like "import os" is rejected by the lowercase-start check (/^[A-Z]/).
test('Edge: "Class Methods"', '**Class Methods**', true);
test('Edge: "Return Values"', '**Return Values**', true);
test('Edge: "Import Statements"', '**Import Statements**', true);

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log();
console.log(`${pass} passed, ${fail} failed out of ${pass + fail}`);
if (fail > 0) {
  console.log('REGRESSION DETECTED — fix normalizeHeadings before deploying');
  process.exit(1);
} else {
  console.log('All heading normalization tests passed');
}
