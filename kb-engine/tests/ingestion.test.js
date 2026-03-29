'use strict';

const { detectFormat }     = require('../ingestion/format-detector');
const { routeToCollection } = require('../ingestion/collection-router');

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------
describe('detectFormat — extension-based', () => {
  test('.pdf → pdf / null', () => {
    expect(detectFormat('guide.pdf')).toEqual({ format: 'pdf', language: null });
  });

  test('.js → code / javascript', () => {
    expect(detectFormat('app.js')).toEqual({ format: 'code', language: 'javascript' });
  });

  test('.mjs → code / javascript', () => {
    expect(detectFormat('module.mjs')).toEqual({ format: 'code', language: 'javascript' });
  });

  test('.ts → code / typescript', () => {
    expect(detectFormat('index.ts')).toEqual({ format: 'code', language: 'typescript' });
  });

  test('.tsx → code / typescript', () => {
    expect(detectFormat('Component.tsx')).toEqual({ format: 'code', language: 'typescript' });
  });

  test('.jsx → code / javascript', () => {
    expect(detectFormat('App.jsx')).toEqual({ format: 'code', language: 'javascript' });
  });

  test('.py → code / python', () => {
    expect(detectFormat('main.py')).toEqual({ format: 'code', language: 'python' });
  });

  test('.go → code / go', () => {
    expect(detectFormat('server.go')).toEqual({ format: 'code', language: 'go' });
  });

  test('.rs → code / rust', () => {
    expect(detectFormat('lib.rs')).toEqual({ format: 'code', language: 'rust' });
  });

  test('.java → code / java', () => {
    expect(detectFormat('Main.java')).toEqual({ format: 'code', language: 'java' });
  });

  test('.html → html / null', () => {
    expect(detectFormat('index.html')).toEqual({ format: 'html', language: null });
  });

  test('.htm → html / null', () => {
    expect(detectFormat('page.htm')).toEqual({ format: 'html', language: null });
  });

  test('.md → markdown / null', () => {
    expect(detectFormat('README.md')).toEqual({ format: 'markdown', language: null });
  });

  test('.mdx → markdown / null', () => {
    expect(detectFormat('docs.mdx')).toEqual({ format: 'markdown', language: null });
  });

  test('.txt → text / null', () => {
    expect(detectFormat('notes.txt')).toEqual({ format: 'text', language: null });
  });

  test('.rst → text / null', () => {
    expect(detectFormat('readme.rst')).toEqual({ format: 'text', language: null });
  });

  test('.css → code / css', () => {
    expect(detectFormat('styles.css')).toEqual({ format: 'code', language: 'css' });
  });

  test('.sh → code / bash', () => {
    expect(detectFormat('deploy.sh')).toEqual({ format: 'code', language: 'bash' });
  });

  test('unknown extension → text / null', () => {
    expect(detectFormat('data.xyz')).toEqual({ format: 'text', language: null });
  });

  test('no extension → text / null', () => {
    expect(detectFormat('Makefile')).toEqual({ format: 'text', language: null });
  });
});

describe('detectFormat — content sniffing (no recognised extension)', () => {
  test('<!DOCTYPE … → html', () => {
    expect(detectFormat('somefile', '<!DOCTYPE html><html>')).toEqual({ format: 'html', language: null });
  });

  test('<html … → html', () => {
    expect(detectFormat('somefile', '<html lang="en">')).toEqual({ format: 'html', language: null });
  });

  test('# Heading → markdown', () => {
    expect(detectFormat('somefile', '# My Document\nsome text')).toEqual({ format: 'markdown', language: null });
  });

  test('## Heading → markdown', () => {
    expect(detectFormat('somefile', '## Section\ncontent')).toEqual({ format: 'markdown', language: null });
  });

  test('### Heading → markdown', () => {
    expect(detectFormat('somefile', '### Sub\ncontent')).toEqual({ format: 'markdown', language: null });
  });

  test('plain text content → text', () => {
    expect(detectFormat('somefile', 'just some plain text here')).toEqual({ format: 'text', language: null });
  });

  test('no content provided + unknown ext → text', () => {
    expect(detectFormat('somefile.xyz')).toEqual({ format: 'text', language: null });
  });

  test('null content + unknown ext → text', () => {
    expect(detectFormat('somefile.xyz', null)).toEqual({ format: 'text', language: null });
  });
});

// ---------------------------------------------------------------------------
// routeToCollection
// ---------------------------------------------------------------------------
describe('routeToCollection — filepath pattern matching', () => {
  test('express-guide.pdf → nodejs', () => {
    expect(routeToCollection('express-guide.pdf', null, null)).toBe('nodejs');
  });

  test('django-docs.md → python', () => {
    expect(routeToCollection('django-docs.md', null, null)).toBe('python');
  });

  test('flask-tutorial.html → python', () => {
    expect(routeToCollection('flask-tutorial.html', null, null)).toBe('python');
  });

  test('nextjs-routing.md → nodejs', () => {
    expect(routeToCollection('nextjs-routing.md', null, null)).toBe('nodejs');
  });

  test('golang-concurrency.md → go', () => {
    expect(routeToCollection('golang-concurrency.md', null, null)).toBe('go');
  });

  test('rust-ownership.md → rust', () => {
    expect(routeToCollection('rust-ownership.md', null, null)).toBe('rust');
  });

  test('spring-boot-guide.pdf → java', () => {
    expect(routeToCollection('spring-boot-guide.pdf', null, null)).toBe('java');
  });

  test('laravel-docs.pdf → php', () => {
    expect(routeToCollection('laravel-docs.pdf', null, null)).toBe('php');
  });

  test('rails-guide.md → ruby', () => {
    expect(routeToCollection('rails-guide.md', null, null)).toBe('ruby');
  });

  test('tailwind-utilities.md → css_html', () => {
    expect(routeToCollection('tailwind-utilities.md', null, null)).toBe('css_html');
  });

  test('kubernetes-deploy.yaml → devops', () => {
    expect(routeToCollection('kubernetes-deploy.yaml', null, null)).toBe('devops');
  });

  test('postgres-tuning.md → databases', () => {
    expect(routeToCollection('postgres-tuning.md', null, null)).toBe('databases');
  });
});

describe('routeToCollection — user override', () => {
  test('explicit collection option overrides filepath pattern', () => {
    expect(routeToCollection('express-guide.pdf', null, { collection: 'custom' })).toBe('custom');
  });

  test('explicit collection option overrides language metadata', () => {
    expect(routeToCollection('unknown-file.txt', { language: 'python' }, { collection: 'my-collection' })).toBe('my-collection');
  });

  test('explicit collection option works on unknown filepath', () => {
    expect(routeToCollection('some-random-file.pdf', null, { collection: 'special' })).toBe('special');
  });
});

describe('routeToCollection — language-based routing (fallback)', () => {
  test('language:javascript → nodejs', () => {
    expect(routeToCollection('unknown.txt', { language: 'javascript' }, null)).toBe('nodejs');
  });

  test('language:typescript → nodejs', () => {
    expect(routeToCollection('unknown.txt', { language: 'typescript' }, null)).toBe('nodejs');
  });

  test('language:python → python', () => {
    expect(routeToCollection('unknown.txt', { language: 'python' }, null)).toBe('python');
  });

  test('language:go → go', () => {
    expect(routeToCollection('unknown.txt', { language: 'go' }, null)).toBe('go');
  });

  test('language:rust → rust', () => {
    expect(routeToCollection('unknown.txt', { language: 'rust' }, null)).toBe('rust');
  });

  test('language:java → java', () => {
    expect(routeToCollection('unknown.txt', { language: 'java' }, null)).toBe('java');
  });

  test('language:kotlin → java', () => {
    expect(routeToCollection('unknown.txt', { language: 'kotlin' }, null)).toBe('java');
  });

  test('language:csharp → csharp', () => {
    expect(routeToCollection('unknown.txt', { language: 'csharp' }, null)).toBe('csharp');
  });

  test('language:ruby → ruby', () => {
    expect(routeToCollection('unknown.txt', { language: 'ruby' }, null)).toBe('ruby');
  });

  test('language:css → css_html', () => {
    expect(routeToCollection('unknown.txt', { language: 'css' }, null)).toBe('css_html');
  });

  test('unrecognised language → general', () => {
    expect(routeToCollection('unknown.txt', { language: 'brainfuck' }, null)).toBe('general');
  });
});

describe('routeToCollection — general fallback', () => {
  test('unknown filepath + no metadata → general', () => {
    expect(routeToCollection('completely-unknown.pdf', null, null)).toBe('general');
  });

  test('unknown filepath + empty metadata → general', () => {
    expect(routeToCollection('completely-unknown.pdf', {}, null)).toBe('general');
  });

  test('no options provided → general', () => {
    expect(routeToCollection('random-doc.txt')).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

const { Chunker } = require('../ingestion/chunker');

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('Chunker constructor', () => {
  test('defaults: maxTokens=512, overlapTokens=80', () => {
    const c = new Chunker();
    expect(c.maxTokens).toBe(512);
    expect(c.overlapTokens).toBe(80);
  });

  test('accepts custom options', () => {
    const c = new Chunker({ maxTokens: 256, overlapTokens: 40 });
    expect(c.maxTokens).toBe(256);
    expect(c.overlapTokens).toBe(40);
  });
});

// ─── _estimateTokens ─────────────────────────────────────────────────────────

describe('Chunker._estimateTokens(text)', () => {
  const c = new Chunker();

  test('empty string returns 0', () => {
    expect(c._estimateTokens('')).toBe(0);
  });

  test('whitespace-only returns 0', () => {
    expect(c._estimateTokens('   \n  ')).toBe(0);
  });

  test('single word returns ceiling of 1/0.75 = 2', () => {
    expect(c._estimateTokens('hello')).toBe(Math.ceil(1 / 0.75));
  });

  test('token estimate is within 20% for a known 9-word string', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const words = text.trim().split(/\s+/).length; // 9
    const expected = Math.ceil(words / 0.75); // 12
    const got = c._estimateTokens(text);
    expect(got).toBeGreaterThanOrEqual(expected * 0.8);
    expect(got).toBeLessThanOrEqual(expected * 1.2);
  });

  test('100-word text: token estimate within 20% of word_count/0.75', () => {
    const text = Array(100).fill('word').join(' ');
    const expected = Math.ceil(100 / 0.75); // 134
    const got = c._estimateTokens(text);
    expect(got).toBeGreaterThanOrEqual(expected * 0.8);
    expect(got).toBeLessThanOrEqual(expected * 1.2);
  });
});

// ─── Empty / trivial input ───────────────────────────────────────────────────

describe('Chunker.chunk() — empty input', () => {
  const c = new Chunker();

  test('empty string returns []', () => {
    expect(c.chunk('')).toEqual([]);
  });

  test('null returns []', () => {
    expect(c.chunk(null)).toEqual([]);
  });

  test('whitespace-only returns []', () => {
    expect(c.chunk('   \n   ')).toEqual([]);
  });
});

// ─── section_path from heading hierarchy ─────────────────────────────────────

describe('Chunker.chunk() — section_path from headings', () => {
  const c = new Chunker();

  test('H1 only → section_path contains H1 text', () => {
    const md = '# Introduction\n\nSome intro text here.';
    const chunks = c.chunk(md);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].section_path).toContain('Introduction');
  });

  test('H1 + H2 → section_path is "H1 > H2"', () => {
    const md = [
      '# Getting Started',
      '',
      'Intro paragraph.',
      '',
      '## Installation',
      '',
      'Run npm install.',
    ].join('\n');

    const chunks = c.chunk(md);
    const installChunk = chunks.find(ch => ch.section_path.includes('Installation'));
    expect(installChunk).toBeDefined();
    expect(installChunk.section_path).toBe('Getting Started > Installation');
  });

  test('H1 + H2 + H3 → section_path has three levels', () => {
    const md = [
      '# Guide',
      '',
      '## Setup',
      '',
      '### Prerequisites',
      '',
      'You need Node.js installed.',
    ].join('\n');

    const chunks = c.chunk(md);
    const prereqChunk = chunks.find(ch => ch.section_path.includes('Prerequisites'));
    expect(prereqChunk).toBeDefined();
    expect(prereqChunk.section_path).toBe('Guide > Setup > Prerequisites');
  });

  test('docTitle is prepended to section_path', () => {
    const md = '# Overview\n\nSome content.';
    const chunks = c.chunk(md, 'MyDoc');
    expect(chunks[0].section_path).toMatch(/^MyDoc/);
    expect(chunks[0].section_path).toContain('Overview');
  });

  test('sibling H2s each get their own section_path', () => {
    const md = [
      '# Parent',
      '',
      '## Alpha',
      '',
      'Alpha content.',
      '',
      '## Beta',
      '',
      'Beta content.',
    ].join('\n');

    const chunks = c.chunk(md);
    const alphaChunk = chunks.find(ch => ch.section_path.includes('Alpha'));
    const betaChunk  = chunks.find(ch => ch.section_path.includes('Beta'));
    expect(alphaChunk).toBeDefined();
    expect(betaChunk).toBeDefined();
    expect(alphaChunk.section_path).toBe('Parent > Alpha');
    expect(betaChunk.section_path).toBe('Parent > Beta');
  });
});

// ─── Chunk output shape ───────────────────────────────────────────────────────

describe('Chunker.chunk() — output shape', () => {
  const c = new Chunker();
  const md = '# Hello\n\nWorld content here.';

  test('each chunk has required keys', () => {
    const chunks = c.chunk(md);
    for (const chunk of chunks) {
      expect(chunk).toHaveProperty('content');
      expect(chunk).toHaveProperty('section_path');
      expect(chunk).toHaveProperty('chunk_index');
      expect(chunk).toHaveProperty('token_estimate');
    }
  });

  test('chunk_index is sequential starting at 0', () => {
    const chunks = c.chunk(md);
    chunks.forEach((ch, i) => expect(ch.chunk_index).toBe(i));
  });

  test('token_estimate is a positive number', () => {
    const chunks = c.chunk(md);
    for (const ch of chunks) {
      expect(typeof ch.token_estimate).toBe('number');
      expect(ch.token_estimate).toBeGreaterThan(0);
    }
  });

  test('content is trimmed (no leading/trailing whitespace)', () => {
    const chunks = c.chunk(md);
    for (const ch of chunks) {
      expect(ch.content).toBe(ch.content.trim());
    }
  });
});

// ─── No-heading content ───────────────────────────────────────────────────────

describe('Chunker.chunk() — no headings', () => {
  const c = new Chunker();

  test('plain text with no headings still produces chunks', () => {
    const md = 'Just some plain text without any headings.\nSecond line.';
    const chunks = c.chunk(md);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('section_path is empty string when no headings and no docTitle', () => {
    const md = 'Plain text, no headings.';
    const chunks = c.chunk(md, '');
    expect(chunks[0].section_path).toBe('');
  });

  test('docTitle used as section_path even with no headings', () => {
    const md = 'Plain text content.';
    const chunks = c.chunk(md, 'MyDoc');
    expect(chunks[0].section_path).toBe('MyDoc');
  });
});

// ─── Long section → recursive split ──────────────────────────────────────────

describe('Chunker.chunk() — long sections get recursively split', () => {
  test('section exceeding maxTokens is split into multiple chunks', () => {
    const c = new Chunker({ maxTokens: 20, overlapTokens: 0 });

    const para1 = Array(50).fill('word').join(' ');
    const para2 = Array(50).fill('text').join(' ');
    const para3 = Array(50).fill('data').join(' ');
    const md = `# Big Section\n\n${para1}\n\n${para2}\n\n${para3}`;

    const chunks = c.chunk(md);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('all split chunks respect maxTokens with reasonable tolerance', () => {
    const c = new Chunker({ maxTokens: 30, overlapTokens: 0 });

    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      Array(20).fill(`w${i}`).join(' ')
    ).join('\n\n');
    const md = `# Section\n\n${paragraphs}`;

    const chunks = c.chunk(md);
    // Allow up to 2x tolerance for edge cases
    for (const ch of chunks) {
      expect(ch.token_estimate).toBeLessThanOrEqual(c.maxTokens * 2);
    }
  });

  test('all split chunks share the parent section_path', () => {
    const c = new Chunker({ maxTokens: 20, overlapTokens: 0 });

    const para1 = Array(40).fill('foo').join(' ');
    const para2 = Array(40).fill('bar').join(' ');
    const md = `# My Section\n\n${para1}\n\n${para2}`;

    const chunks = c.chunk(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      expect(ch.section_path).toContain('My Section');
    }
  });
});

// ─── Code blocks preserved ───────────────────────────────────────────────────

describe('Chunker.chunk() — code blocks are never split', () => {
  test('fenced code block opening and closing fences are in the same chunk', () => {
    const c = new Chunker({ maxTokens: 20, overlapTokens: 0 });

    const codeBlock = [
      '```javascript',
      'function add(a, b) {',
      '  // multi-line code block',
      '  return a + b;',
      '}',
      '```',
    ].join('\n');

    const prose = Array(15).fill('word').join(' ');
    const md = `# Code Example\n\n${prose}\n\n${codeBlock}`;

    const chunks = c.chunk(md);

    // Any chunk that contains a ``` must have an even count (properly paired)
    const codeChunks = chunks.filter(ch => ch.content.includes('```'));
    for (const ch of codeChunks) {
      const fences = (ch.content.match(/```/g) || []).length;
      expect(fences % 2).toBe(0);
    }
  });

  test('code block content appears in output', () => {
    const c = new Chunker();
    const md = [
      '# Example',
      '',
      'Here is some code:',
      '',
      '```python',
      'def hello():',
      '    print("hello world")',
      '```',
    ].join('\n');

    const chunks = c.chunk(md);
    const allContent = chunks.map(ch => ch.content).join('\n');
    expect(allContent).toContain('def hello():');
    expect(allContent).toContain('print("hello world")');
  });

  test('heading inside code block is NOT treated as a document heading', () => {
    const c = new Chunker();
    const md = [
      '# Real Heading',
      '',
      '```markdown',
      '# This is NOT a real heading',
      '## Neither is this',
      '```',
      '',
      'End of section.',
    ].join('\n');

    const chunks = c.chunk(md);
    const badChunk = chunks.find(ch =>
      ch.section_path.includes('This is NOT a real heading')
    );
    expect(badChunk).toBeUndefined();
  });
});

// ─── Overlap ─────────────────────────────────────────────────────────────────

describe('Chunker.chunk() — overlap between chunks', () => {
  test('consecutive chunks share overlapping words when overlapTokens > 0', () => {
    const c = new Chunker({ maxTokens: 20, overlapTokens: 10 });

    const paragraphs = Array.from({ length: 6 }, (_, i) =>
      Array(15).fill(`para${i}word`).join(' ')
    ).join('\n\n');
    const md = `# Section\n\n${paragraphs}`;

    const chunks = c.chunk(md);
    if (chunks.length < 2) return; // guard

    let overlapFound = false;
    for (let i = 1; i < chunks.length; i++) {
      const prevWords = new Set(chunks[i - 1].content.split(/\s+/));
      const currWords = chunks[i].content.split(/\s+/);
      const shared = currWords.filter(w => prevWords.has(w) && w.length > 3);
      if (shared.length > 0) {
        overlapFound = true;
        break;
      }
    }
    expect(overlapFound).toBe(true);
  });

  test('overlapTokens=0 does not crash and produces valid chunks', () => {
    const c = new Chunker({ maxTokens: 20, overlapTokens: 0 });

    const para1 = Array(25).fill('alpha').join(' ');
    const para2 = Array(25).fill('beta').join(' ');
    const md = `# Section\n\n${para1}\n\n${para2}`;

    const chunks = c.chunk(md);
    expect(chunks.length).toBeGreaterThan(0);
    for (const ch of chunks) {
      expect(ch).toHaveProperty('content');
    }
  });
});

// ─── _isInsideCodeBlock ───────────────────────────────────────────────────────

describe('Chunker._isInsideCodeBlock(content, position)', () => {
  const c = new Chunker();

  test('returns false for position before any fence', () => {
    const text = 'Hello world\n```\ncode\n```';
    expect(c._isInsideCodeBlock(text, 5)).toBe(false);
  });

  test('returns true for position between opening and closing fence', () => {
    const text = '```\ncode here\n```';
    const pos = text.indexOf('code here');
    expect(c._isInsideCodeBlock(text, pos)).toBe(true);
  });

  test('returns false for position after closing fence', () => {
    const text = '```\ncode\n```\noutside';
    const pos = text.lastIndexOf('outside');
    expect(c._isInsideCodeBlock(text, pos)).toBe(false);
  });

  test('returns false for empty content', () => {
    expect(c._isInsideCodeBlock('', 0)).toBe(false);
  });
});

// ─── Integration: realistic README-like document ─────────────────────────────

describe('Chunker.chunk() — integration: realistic document', () => {
  const c = new Chunker();

  test('all expected section paths appear', () => {
    const md = [
      '# My Library',
      '',
      'A short intro.',
      '',
      '## Getting Started',
      '',
      'Install with npm.',
      '',
      '### Prerequisites',
      '',
      'Requires Node.js 18+.',
      '',
      '### Installation',
      '',
      'Run `npm install my-lib`.',
      '',
      '## API Reference',
      '',
      'The main export is `createClient(opts)`.',
      '',
      '## Contributing',
      '',
      'Open a PR.',
    ].join('\n');

    const chunks = c.chunk(md);
    expect(chunks.length).toBeGreaterThan(0);

    const paths = chunks.map(ch => ch.section_path);
    expect(paths.some(p => p.includes('Getting Started'))).toBe(true);
    expect(paths.some(p => p.includes('Prerequisites'))).toBe(true);
    expect(paths.some(p => p.includes('Installation'))).toBe(true);
    expect(paths.some(p => p.includes('API Reference'))).toBe(true);
    expect(paths.some(p => p.includes('Contributing'))).toBe(true);
  });

  test('chunk_index values are 0-based and contiguous', () => {
    const md = [
      '# A',
      'Content A.',
      '## B',
      'Content B.',
      '## C',
      'Content C.',
    ].join('\n');

    const chunks = c.chunk(md);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });
});

// ─── Tables preserved ────────────────────────────────────────────────────────

describe('Chunker.chunk() — table rows appear in output', () => {
  test('all table rows survive chunking', () => {
    const c = new Chunker({ maxTokens: 10, overlapTokens: 0 });

    const table = [
      '| Name | Age |',
      '|------|-----|',
      '| Alice | 30 |',
      '| Bob   | 25 |',
    ].join('\n');

    const prose = Array(20).fill('text').join(' ');
    const md = `# Data\n\n${prose}\n\n${table}`;

    const chunks = c.chunk(md);
    const allContent = chunks.map(ch => ch.content).join('\n');
    expect(allContent).toContain('| Alice | 30 |');
    expect(allContent).toContain('| Bob   | 25 |');
  });
});
