'use strict';

const path = require('path');

const CODE_EXTS = {
  '.js':   'javascript',
  '.mjs':  'javascript',
  '.cjs':  'javascript',
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.jsx':  'javascript',
  '.py':   'python',
  '.go':   'go',
  '.rs':   'rust',
  '.java': 'java',
  '.kt':   'kotlin',
  '.cs':   'csharp',
  '.php':  'php',
  '.rb':   'ruby',
  '.swift':'swift',
  '.cpp':  'cpp',
  '.c':    'c',
  '.h':    'c',
  '.css':  'css',
  '.html': 'html',
  '.sh':   'bash',
};

/**
 * Detect file format from extension, with content sniffing as fallback.
 *
 * @param {string} filePath - Path (or filename) of the file.
 * @param {string|null} [content] - First bytes/lines of the file for sniffing.
 * @returns {{ format: 'pdf'|'html'|'markdown'|'code'|'text', language: string|null }}
 */
function detectFormat(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') return { format: 'pdf', language: null };
  if (ext === '.html' || ext === '.htm') return { format: 'html', language: null };
  if (ext === '.md'  || ext === '.mdx')  return { format: 'markdown', language: null };
  if (ext === '.txt' || ext === '.rst')  return { format: 'text', language: null };
  if (CODE_EXTS[ext]) return { format: 'code', language: CODE_EXTS[ext] };

  // Content sniffing fallback
  if (content) {
    if (content.startsWith('<!DOCTYPE') || content.startsWith('<html')) {
      return { format: 'html', language: null };
    }
    if (/^#{1,3}\s/.test(content)) {
      return { format: 'markdown', language: null };
    }
  }

  return { format: 'text', language: null };
}

module.exports = { detectFormat };
