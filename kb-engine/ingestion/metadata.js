'use strict';

/**
 * metadata.js — Rule-based metadata extraction per chunk.
 *
 * Extracts: language, framework, content_type, doc_type, has_code_block, keywords.
 * All detection is purely heuristic — no LLM required.
 */

const path = require('path');

// Extension → language
const LANG_MAP = {
  '.js':    'javascript',
  '.mjs':   'javascript',
  '.cjs':   'javascript',
  '.jsx':   'javascript',
  '.ts':    'typescript',
  '.tsx':   'typescript',
  '.py':    'python',
  '.go':    'go',
  '.rs':    'rust',
  '.java':  'java',
  '.kt':    'kotlin',
  '.cs':    'csharp',
  '.php':   'php',
  '.rb':    'ruby',
  '.swift': 'swift',
  '.cpp':   'cpp',
  '.cc':    'cpp',
  '.cxx':   'cpp',
  '.c':     'c',
  '.h':     'c',
  '.sh':    'bash',
  '.bash':  'bash',
  '.css':   'css',
  '.scss':  'css',
  '.sass':  'css',
  '.sql':   'sql',
  '.r':     'r',
  '.scala': 'scala',
  '.lua':   'lua',
  '.dart':  'dart',
};

// Framework keyword patterns (checked against lowercase file path)
const FRAMEWORKS = [
  { patterns: ['express', 'expressjs'],                                   name: 'express'   },
  { patterns: ['nextjs', 'next.js', 'next-js'],                           name: 'nextjs'    },
  { patterns: ['react', 'reactjs', 'react-js'],                           name: 'react'     },
  { patterns: ['vue', 'vuejs', 'vue.js', 'nuxt'],                         name: 'vue'       },
  { patterns: ['angular', 'angularjs'],                                   name: 'angular'   },
  { patterns: ['svelte', 'sveltekit'],                                    name: 'svelte'    },
  { patterns: ['django'],                                                  name: 'django'    },
  { patterns: ['flask'],                                                   name: 'flask'     },
  { patterns: ['fastapi', 'fast-api'],                                     name: 'fastapi'   },
  { patterns: ['spring', 'springboot', 'spring-boot'],                    name: 'spring'    },
  { patterns: ['laravel'],                                                 name: 'laravel'   },
  { patterns: ['symfony'],                                                 name: 'symfony'   },
  { patterns: ['rails', 'ruby-on-rails', 'ror'],                          name: 'rails'     },
  { patterns: ['sinatra'],                                                 name: 'sinatra'   },
  { patterns: ['gin', 'gin-gonic'],                                       name: 'gin'       },
  { patterns: ['echo'],                                                    name: 'echo'      },
  { patterns: ['fiber'],                                                   name: 'fiber'     },
  { patterns: ['actix', 'actix-web'],                                     name: 'actix'     },
  { patterns: ['tokio'],                                                   name: 'tokio'     },
  { patterns: ['nestjs', 'nest.js'],                                      name: 'nestjs'    },
  { patterns: ['koa'],                                                     name: 'koa'       },
  { patterns: ['hapi'],                                                    name: 'hapi'      },
  { patterns: ['fastify'],                                                 name: 'fastify'   },
  { patterns: ['dotnet', '.net', 'asp.net', 'aspnet'],                    name: 'dotnet'    },
  { patterns: ['blazor'],                                                  name: 'blazor'    },
  { patterns: ['playwright'],                                              name: 'playwright'},
  { patterns: ['pytest'],                                                  name: 'pytest'    },
  { patterns: ['jest'],                                                    name: 'jest'      },
  { patterns: ['tailwind'],                                               name: 'tailwind'  },
  { patterns: ['bootstrap'],                                              name: 'bootstrap' },
  { patterns: ['prisma'],                                                  name: 'prisma'    },
  { patterns: ['sequelize'],                                               name: 'sequelize' },
];

// English stop words excluded from keyword extraction
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','shall','should',
  'may','might','must','can','could',
  'and','but','or','nor','for','yet','so',
  'in','on','at','to','of','by','with','from','as','into','through',
  'during','before','after','above','below','between','out','off','over',
  'under','again','further','then','once',
  'here','there','when','where','why','how',
  'all','each','every','both','few','more','most','other','some','such',
  'no','not','only','own','same','than','too','very','just','because',
  'if','that','this','these','those',
  'it','its','he','she','we','they','them','their','our',
  'which','what','who','whom',
  'i','me','my','you','your','him','his','her','us','their',
]);

/**
 * Extract structured metadata from a chunk.
 *
 * @param {string} content    - Text content of the chunk.
 * @param {string} filePath   - Original file path (used for language/framework detection).
 * @param {object} [options]  - Optional overrides: `language`, `framework`.
 * @returns {{
 *   language: string|null,
 *   framework: string|null,
 *   content_type: 'code'|'mixed'|'prose',
 *   doc_type: 'tutorial'|'api'|'guide'|'reference',
 *   has_code_block: boolean,
 *   keywords: string[],
 * }}
 */
function extractMetadata(content, filePath, options) {
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  const fp  = filePath ? filePath.toLowerCase() : '';

  // ── Language detection ─────────────────────────────────────────────────────
  const language = options?.language || LANG_MAP[ext] || null;

  // ── Framework detection (filepath keyword scan) ───────────────────────────
  let framework = options?.framework || null;
  if (!framework) {
    const match = FRAMEWORKS.find(f => f.patterns.some(p => fp.includes(p)));
    framework = match?.name || null;
  }

  // ── Content type: code / mixed / prose ────────────────────────────────────
  // Count actual lines inside code fences (not the crude "10 lines per block" estimate)
  const lines = content.split('\n');
  const totalLines = lines.length;
  let codeLines = 0;
  let inFence = false;
  let codeBlockCount = 0;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (!inFence) codeBlockCount++;
      inFence = !inFence;
      continue;
    }
    if (inFence) codeLines++;
  }
  const codeRatio = totalLines > 0 ? codeLines / totalLines : 0;

  let content_type;
  if (codeRatio > 0.5)       content_type = 'code';
  else if (codeRatio > 0.1)  content_type = 'mixed';
  else                        content_type = 'prose';

  // ── Doc type from first 500 chars ─────────────────────────────────────────
  const head = content.slice(0, 500);
  let doc_type = 'reference';
  if (/tutorial|getting started|how to|step by step|walkthrough/i.test(head)) {
    doc_type = 'tutorial';
  } else if (/\bAPI\b|reference|method\b|returns\b|parameters|endpoint/i.test(head)) {
    doc_type = 'api';
  } else if (/guide|overview|introduction|concepts/i.test(head)) {
    doc_type = 'guide';
  }

  // ── Keyword extraction (top-10 by frequency) ──────────────────────────────
  const words = content.toLowerCase().match(/[a-z_][\w]*/g) || [];
  const freq  = {};
  for (const w of words) {
    if (w.length > 2 && !STOP_WORDS.has(w)) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  const keywords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);

  return {
    language,
    framework,
    content_type,
    doc_type,
    has_code_block: codeBlockCount > 0,
    keywords,
  };
}

module.exports = { extractMetadata };
