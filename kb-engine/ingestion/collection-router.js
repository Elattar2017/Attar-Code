'use strict';

const ROUTES = [
  { patterns: ['express', 'node', 'npm', 'next.js', 'nextjs', 'react', 'vue', 'angular', 'svelte', 'nuxt'], collection: 'nodejs' },
  { patterns: ['django', 'flask', 'fastapi', 'python', 'pip', 'pytest', 'pydantic'],                        collection: 'python' },
  { patterns: ['go', 'golang', 'gin', 'echo', 'fiber'],                                                     collection: 'go' },
  { patterns: ['rust', 'cargo', 'tokio', 'actix'],                                                          collection: 'rust' },
  { patterns: ['java', 'spring', 'maven', 'gradle', 'kotlin', 'android'],                                   collection: 'java' },
  { patterns: ['csharp', 'c#', 'dotnet', '.net', 'asp.net', 'blazor'],                                      collection: 'csharp' },
  { patterns: ['php', 'laravel', 'symfony', 'wordpress', 'composer'],                                       collection: 'php' },
  { patterns: ['ruby', 'rails', 'sinatra', 'gems'],                                                         collection: 'ruby' },
  { patterns: ['swift', 'swiftui', 'ios', 'xcode'],                                                         collection: 'swift' },
  { patterns: ['tailwind', 'css', 'html', 'sass', 'bootstrap'],                                             collection: 'css_html' },
  { patterns: ['docker', 'kubernetes', 'k8s', 'ci/cd', 'github-actions', 'jenkins', 'terraform'],           collection: 'devops' },
  { patterns: ['sql', 'postgres', 'mysql', 'mongodb', 'redis', 'prisma', 'sequelize', 'database'],          collection: 'databases' },
];

const LANG_MAP = {
  javascript: 'nodejs',
  typescript: 'nodejs',
  python:     'python',
  go:         'go',
  rust:       'rust',
  java:       'java',
  kotlin:     'java',
  csharp:     'csharp',
  php:        'php',
  ruby:       'ruby',
  swift:      'swift',
  css:        'css_html',
};

/**
 * Route a document to the appropriate Qdrant collection.
 *
 * @param {string}      filePath  - Path (or filename) of the document.
 * @param {object|null} metadata  - Optional metadata; may include `language`.
 * @param {object|null} options   - Optional overrides; `options.collection` takes priority.
 * @returns {string} Collection name.
 */
function routeToCollection(filePath, metadata, options) {
  // Explicit user override always wins
  if (options?.collection) return options.collection;

  const fp = filePath.toLowerCase();

  // Route by technology/framework keyword in filepath
  for (const route of ROUTES) {
    if (route.patterns.some(p => fp.includes(p))) return route.collection;
  }

  // Route by detected language (from format-detector or caller-supplied metadata)
  if (metadata?.language && LANG_MAP[metadata.language]) {
    return LANG_MAP[metadata.language];
  }

  return 'general';
}

module.exports = { routeToCollection };
