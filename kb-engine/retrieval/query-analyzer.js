'use strict';

/**
 * kb-engine/retrieval/query-analyzer.js
 *
 * Analyzes a search query to determine intent, preferred embedding vector,
 * and the ordered list of Qdrant collections to search.
 */

// ---------------------------------------------------------------------------
// Tech keyword → collection-name mapping
// ---------------------------------------------------------------------------
const TECH_KEYWORDS = [
  // JavaScript / Node
  { keywords: ['express', 'node', 'nodejs', 'npm', 'require(', "require('"], collection: 'nodejs' },
  // Python
  { keywords: ['django', 'flask', 'fastapi', 'python', 'pip', 'pytest', 'pandas', 'numpy'], collection: 'python' },
  // React / frontend
  { keywords: ['react', 'usestate', 'useeffect', 'jsx', 'tsx', 'next.js', 'nextjs', 'vite'], collection: 'react' },
  // TypeScript
  { keywords: ['typescript', 'interface ', 'type ', ': string', ': number', ': boolean', '.ts', '.tsx'], collection: 'typescript' },
  // Rust
  { keywords: ['rust', 'cargo', 'crate', 'fn main', 'impl ', 'trait ', 'lifetime', "let mut"], collection: 'rust' },
  // Go
  { keywords: ['golang', ' go ', 'goroutine', 'channel', 'func main', 'import "fmt"'], collection: 'go' },
  // Java
  { keywords: ['java', 'spring', 'maven', 'gradle', 'public class', 'public static void'], collection: 'java' },
  // Docker / DevOps
  { keywords: ['docker', 'dockerfile', 'compose', 'kubernetes', 'k8s', 'helm'], collection: 'devops' },
  // SQL / DB
  { keywords: ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'mongodb', 'prisma', 'sequelize'], collection: 'database' },
];

// Context detectedTech label → collection name (case-insensitive match)
const CONTEXT_TECH_MAP = {
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  node: 'nodejs',
  javascript: 'nodejs',
  js: 'nodejs',
  python: 'python',
  py: 'python',
  react: 'react',
  typescript: 'typescript',
  ts: 'typescript',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  java: 'java',
  docker: 'devops',
  kubernetes: 'devops',
  k8s: 'devops',
  sql: 'database',
  mysql: 'database',
  postgres: 'database',
  postgresql: 'database',
  mongodb: 'database',
};

// ---------------------------------------------------------------------------
// Pattern groups for query type detection
// ---------------------------------------------------------------------------
// Specific error TYPE names — always win over scope patterns.
// These are concrete error class names and error codes that unambiguously indicate an error.
const SPECIFIC_ERROR_PATTERNS = [
  /\btypeerror\b/i,
  /\bsyntaxerror\b/i,
  /\breferenceerror\b/i,
  /\bmodulenotfounderror\b/i,
  /\bimporterror\b/i,
  /\battributeerror\b/i,
  /\bnameerror\b/i,
  /\bkeyerror\b/i,
  /\bvalueerror\b/i,
  /\bfilenotfounderror\b/i,
  /\boserror\b/i,
  /\bpermissionerror\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bECONNREFUSED\b/,
  /\btraceback\b/i,
  /\bstack\s+trace\b/i,
  /\bunhandled\b/i,
  /no\s+module\s+named/i,
  /cannot\s+find\s+module/i,
  /cannot\s+read\s+propert/i,
  /\b500\s+internal/i,
];

// Broad error words — checked AFTER scope patterns to avoid false positives
// like "explain the error handling chapter" being classified as error.
const BROAD_ERROR_PATTERNS = [
  /\berror\b/i,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bfail(ed|ure)?\b/i,
  /\bcrash(ed|es)?\b/i,
  /\b500\b/,
  /\bexception\b/i,
  /\bpanic\b/i,
  /not\s+installed/i,
];

const CONCEPTUAL_PATTERNS = [
  /\bhow\s+to\b/i,
  /\bexplain\b/i,
  /\bwhat\s+is\b/i,
  /\bwhy\s+does\b/i,
  /\bdifference\s+between\b/i,
  /\bwhen\s+should\b/i,
  /\bwhat\s+are\b/i,
  /\bhow\s+does\b/i,
  /\bconcept\b/i,
  /\bunderstand\b/i,
  /\bmeaning\s+of\b/i,
];

const API_PATTERNS = [
  /\bimport\b/i,
  /\brequire\b/i,
  /\bsyntax\b/i,
  /\bapi\b/i,
  /\bmethod\b/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /\binterface\b/i,
  /\breturns\b/i,
  /\bparameters?\b/i,
  /\barguments?\b/i,
  /\bsignature\b/i,
  /\boverload\b/i,
];

// Cross-KB structural patterns — user wants to know which chapters/sections
// across ALL documents mention/explain/discuss a specific TOPIC.
// These must be checked BEFORE STRUCTURAL_PATTERNS (which handle single-document queries).
const CROSS_STRUCTURAL_PATTERNS = [
  // "which chapters/sections mention/explain/discuss/cover X"
  /\bwhich\s+(?:chapters?|sections?|parts?)\s+(?:mention|explain|discuss|cover|describe|talk\s+about|include)\s+(.+)/i,
  // "chapters/sections across/in all/from all/in every X"
  /\b(?:chapters?|sections?)\s+(?:across|in\s+all|in\s+every|from\s+all)\s+.+?\s+(?:mention|discuss|cover|explain|about)\s+(.+)/i,
  // "how many chapters/sections mention/discuss/cover/explain X"
  /\bhow\s+many\s+(?:chapters?|sections?)\s+(?:mention|discuss|cover|explain|have|contain|include)\s+(.+)/i,
  // "list all chapters/sections about/on/that cover/discussing/mentioning X"
  /\blist\s+(?:all\s+)?(?:chapters?|sections?)\s+(?:about|on|that\s+(?:cover|discuss|explain|mention)|covering|discussing|mentioning|explaining)\s+(.+)/i,
  // "where is X covered/mentioned/explained/discussed in my docs/books/kb/knowledge"
  /\b(?:where|find)\s+.*?\b(?:is|are|does)\s+(.+?)\s+(?:covered|mentioned|explained|discussed)\b/i,
  // "find sections/chapters that explain/mention X"
  /\bfind\s+(?:all\s+)?(?:chapters?|sections?)\s+(?:that\s+)?(?:explain|mention|discuss|cover)\s+(.+)/i,
];

const STRUCTURAL_PATTERNS = [
  /\bhow\s+many\s+chapters?\b/i,
  /\btable\s+of\s+contents\b/i,
  /\bwhat.*chapter\s+\d/i,
  /\bchapter\s+\d+\s+(?:subject|topic|cover|about|content)/i,
  /\bsubject\s+of\s+chapter/i,
  /\bwhat\s+(?:topics?|sections?)\s+(?:does|do|are|is)/i,
  /\blist\s+(?:all\s+)?(?:chapters?|sections?|topics?)/i,
  /\bwhat(?:'s| is)\s+(?:in|covered|included)\s+(?:in\s+)?(?:this\s+)?(?:book|document|pdf)/i,
  /\boverview\s+of\s+(?:the\s+)?(?:book|document)/i,
  /\bstructure\s+of\b/i,
  /\boutline\b/i,
];

// Page reference patterns — user wants content at a specific page number
const PAGE_REF_PATTERNS = [
  /\bpage\s+(\d+)\b/i,
  /\bwhat(?:'s| is)\s+(?:on|at)\s+page\s+(\d+)\b/i,
  /\bat\s+page\s+(\d+)\b/i,
  /\bp\.\s*(\d+)\b/i,
];

// Metadata patterns — user wants document info (author, date, version), not content
const METADATA_PATTERNS = [
  /\bwho\s+(?:wrote|authored|created|is the author)\b/i,
  /\bauthor(?:s)?\s+(?:of|for)\b/i,
  /\bwhen\s+(?:was|is)\s+(?:this\s+|it\s+)?(?:published|written|created)\b/i,
  /\bpublish(?:ed|ing)?\s+date\b/i,
  /\bwhat\s+(?:year|date)\s+(?:was|is)\b/i,
  /\bwho\s+(?:is|are)\s+the\s+author/i,
];

// Scope patterns — user wants a COMPLETE section/chapter, not just top-5 results.
// These detect scope INTENT only — the actual heading is discovered via vector search
// in the two-phase retrieval pipeline (retrieval/index.js).
// Patterns are checked top-to-bottom; first match wins.
const SCOPE_PATTERNS = [
  // Intent verb + structural noun + identifier
  // "explain chapter 3", "summarize Part II", "describe appendix A", "tell me about the introduction section"
  /\b(?:explain|summarize|summarise|describe|cover|show|give me|tell me about|read|walk me through|go through|show me|summary\s+(?:for|of))\s+(?:the\s+)?(?:whole\s+|entire\s+|full\s+)?(?:chapter|ch\.?|section|sec\.?|part|appendix|unit|module|lesson|topic)\s+.{1,60}/i,

  // Structural noun + identifier + content word
  // "chapter 3 summary", "section 3.1 overview", "appendix A content"
  /\b(?:chapter|ch\.?|section|sec\.?|part|appendix|unit|module|lesson|topic)\s+[\w.]+\s+(?:summary|content|details?|overview|explanation|notes?)/i,

  // Interrogative + structural noun
  // "what's in chapter 3", "what does section 3.2 cover"
  /\bwhat(?:'s| is| does)?\s+(?:in\s+)?(?:the\s+)?(?:chapter|section|part|appendix|unit|module|lesson)\s+.{1,40}/i,

  // Complete/whole/full + structural noun
  // "complete chapter 3", "the whole introduction section", "entire part 2"
  /\b(?:whole|complete|entire|full|all\s+of)\s+(?:the\s+)?(?:chapter|section|part|appendix|unit|module|lesson|topic)\s*.{0,40}/i,

  // Intent verb + "the X section/chapter"
  // "explain the closures section", "summarize the introduction chapter"
  /\b(?:explain|summarize|summarise|describe|show|tell me about|walk me through)\s+(?:the\s+).{3,40}?\s+(?:chapter|section|part|appendix|unit|module|lesson)\b/i,

  // Structural reference from a specific book
  // "explain chapter 3 from Python Programming", "summarize section 2 in CLRS"
  /\b(?:explain|summarize|describe|show|give me|tell me about)\s+(?:chapter|section|part)\s+[\w.]+\s+(?:from|in|of)\s+.{3,60}/i,

  // Bare structural noun + NUMBER (broadest — lowest priority)
  // "chapter 3", "chapter3", "section 3.2", "Part 2"
  // Requires a digit after the noun — prevents false positives like "section in threading"
  /\b(?:chapter|section|part|appendix)\s*(\d[\d.]*)/i,

  // Bare Part/Appendix + roman numeral or single letter
  // "Part II", "Part IV", "appendix A", "Appendix B"
  /\b(?:part|appendix)\s+([IVXLCDM]+|[A-Za-z])\b/i,

  // Bare dotted section number at START of query: "3.1.2 About the source data"
  // N.N or N.N.N format is unambiguous — only used for document sections
  /^\s*(\d+\.\d+(?:\.\d+)?)\s+/,
];

// Code example patterns — user wants code snippets across all books for a topic
const CODE_EXAMPLE_PATTERNS = [
  /\b(?:show|give|list|find)\s+(?:me\s+)?(?:all\s+)?code\s+(?:examples?|samples?|snippets?)/i,
  /\bcode\s+(?:examples?|samples?)\s+(?:for|about|related|on)\b/i,
  /\ball\s+(?:examples?|code)\s+(?:about|for|related|on)\b/i,
  /\b(?:examples?|snippets?)\s+(?:of|for|about)\s+.+\s+(?:from\s+all|across|in\s+every)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * detectTech(query, context) → string | null
 *
 * Priority 1: context.detectedTech (a string label, e.g. "Node.js")
 * Priority 2: keyword matching in the lowercased query string.
 *
 * Returns a collection name string or null.
 */
function detectTech(query, context = {}) {
  // Priority 1 — context-supplied tech
  if (context && context.detectedTech) {
    const label = String(context.detectedTech).toLowerCase().trim();
    if (CONTEXT_TECH_MAP[label]) {
      return CONTEXT_TECH_MAP[label];
    }
    // Partial match: e.g. "Python 3.11" → "python"
    for (const [key, col] of Object.entries(CONTEXT_TECH_MAP)) {
      if (label.includes(key) || key.includes(label)) {
        return col;
      }
    }
  }

  // Priority 2 — keyword scan in query
  const lower = query.toLowerCase();
  for (const entry of TECH_KEYWORDS) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        return entry.collection;
      }
    }
  }

  return null;
}

/**
 * analyzeQuery(query, context) → { type, preferVector, collections, tech }
 */
function analyzeQuery(query, context = {}) {
  if (!query || typeof query !== 'string') {
    return {
      type: 'general',
      preferVector: 'dense',
      collections: ['general'],
      tech: null,
    };
  }

  // Detect tech early — we need it for collections
  const tech = detectTech(query, context);

  // Extract negation/exclusion terms ("except chapter 1", "without testing")
  let excludeTerms = [];
  const NEGATION_RE = /\b(?:except|excluding|not from|without|ignore|skip|other than)\s+["']?(.+?)["']?$/i;
  const negMatch = query.match(NEGATION_RE);
  if (negMatch) {
    excludeTerms = negMatch[1].split(/,|\band\b/).map(t => t.trim()).filter(Boolean);
    query = query.replace(NEGATION_RE, '').trim(); // clean query for search
  }

  // Determine query type — two-tier error detection to avoid false positives.
  //
  // Order: specific error TYPES (TypeError, ENOENT, etc.) → scope → broad error
  //        words (error, null, undefined) → code_examples → structural → conceptual → api
  //
  // This ensures "TypeError in chapter 3" → error (specific type wins)
  // but "explain the error handling chapter" → scope (broad "error" doesn't override scope)
  let type = 'general';
  let scopeHint = null;
  let scopeBook = null;
  let crossTopic = null;

  // 1. SPECIFIC error type names always win (highest priority)
  if (SPECIFIC_ERROR_PATTERNS.some((p) => p.test(query))) {
    type = 'error';
  }

  // 1.5. Metadata queries ("who wrote this", "when was it published")
  if (type === 'general' && METADATA_PATTERNS.some((p) => p.test(query))) {
    type = 'metadata';
  }

  // 1.6. Page reference queries ("page 45", "what's on page 12")
  let pageNumber = null;
  if (type === 'general') {
    for (const pat of PAGE_REF_PATTERNS) {
      const m = query.match(pat);
      if (m) {
        type = 'page_ref';
        pageNumber = parseInt(m[1]);
        break;
      }
    }
  }

  // 2. Scope patterns (only if not already classified as a specific error)
  if (type === 'general') {
    for (const pattern of SCOPE_PATTERNS) {
      if (pattern.test(query)) {
        type = 'scope';
        scopeHint = query;
        const bookMatch = query.match(/\b(?:from|in|of)\s+["']?(.{3,60})["']?\s*$/i);
        if (bookMatch) scopeBook = bookMatch[1].trim();
        break;
      }
    }
  }

  // 3. Cross-structural: "which chapters mention X across all docs"
  if (type === 'general') {
    for (const pattern of CROSS_STRUCTURAL_PATTERNS) {
      const match = pattern.exec(query);
      if (match) {
        type = 'cross_structural';
        crossTopic = (match[1] || '').trim();
        break;
      }
    }
  }

  // 4. Code example patterns
  if (type === 'general' && CODE_EXAMPLE_PATTERNS.some((p) => p.test(query))) {
    type = 'code_examples';
  }

  // 5. Broad error words, structural, conceptual, API (only if not already classified)
  if (type === 'general') {
    if (BROAD_ERROR_PATTERNS.some((p) => p.test(query))) {
      type = 'error';
    } else if (STRUCTURAL_PATTERNS.some((p) => p.test(query))) {
      type = 'structural';
    } else if (CONCEPTUAL_PATTERNS.some((p) => p.test(query))) {
      type = 'conceptual';
    } else if (API_PATTERNS.some((p) => p.test(query))) {
      type = 'api';
    }
  }

  // Single unified vector — always use 'dense'
  // (Query type differentiation is handled by asymmetric instruction prefixes in the embedder)
  const preferVector = 'dense';

  // Build ordered collections list
  const collections = [];

  if (type === 'error') {
    // Errors: search fix_recipes + detected tech + general (fast — max 3 collections)
    collections.push('fix_recipes');
    if (tech && !collections.includes(tech)) collections.push(tech);
    if (!collections.includes('general')) collections.push('general');
    return { type, preferVector, collections, tech };
  }

  if (type === 'scope' || type === 'code_examples' || type === 'structural' || type === 'cross_structural') {
    // Scope, code_examples, and structural queries search all content collections
    // because we don't know which collection the document was ingested into
    const allContent = ['python', 'nodejs', 'go', 'rust', 'java', 'csharp',
      'php', 'ruby', 'swift', 'css_html', 'devops', 'databases', 'general', 'personal'];
    // Put detected tech first for priority, then the rest
    if (tech) {
      collections.push(tech);
      for (const c of allContent) {
        if (c !== tech && !collections.includes(c)) collections.push(c);
      }
    } else {
      collections.push(...allContent);
    }
  } else {
    if (tech) {
      // Tech detected — search that collection first, then general
      if (!collections.includes(tech)) collections.push(tech);
      if (!collections.includes('general')) collections.push('general');
    } else {
      // No tech detected — search ALL content collections
      // (we don't know which collection the user's documents are in)
      const allContent = ['python', 'nodejs', 'go', 'rust', 'java', 'csharp',
        'php', 'ruby', 'swift', 'css_html', 'devops', 'databases', 'general', 'personal'];
      for (const c of allContent) {
        if (!collections.includes(c)) collections.push(c);
      }
    }
  }

  return { type, preferVector, collections, tech, scopeHint, scopeBook, crossTopic, excludeTerms, pageNumber };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { analyzeQuery, detectTech };
