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
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\btypeerror\b/i,
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
  /cannot\s+find/i,
  /cannot\s+read/i,
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bfail(ed|ure)?\b/i,
  /\bcrash(ed|es)?\b/i,
  /\b500\b/,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bpanic\b/i,
  /\bsyntaxerror\b/i,
  /\breferenceerror\b/i,
  /\bunhandled\b/i,
  /\bstack\s+trace\b/i,
  /no\s+module\s+named/i,
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

  // Determine query type (checked in order of specificity)
  let type = 'general';

  if (ERROR_PATTERNS.some((p) => p.test(query))) {
    type = 'error';
  } else if (STRUCTURAL_PATTERNS.some((p) => p.test(query))) {
    type = 'structural';
  } else if (CONCEPTUAL_PATTERNS.some((p) => p.test(query))) {
    type = 'conceptual';
  } else if (API_PATTERNS.some((p) => p.test(query))) {
    type = 'api';
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

  if (type === 'structural') {
    // Structural queries need to search all content collections
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

  return { type, preferVector, collections, tech };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { analyzeQuery, detectTech };
