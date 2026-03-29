'use strict';

/**
 * plugins/languages/php.js — PHP language plugin.
 *
 * Strategy resolution: composer (only option)
 * Wraps defaults/plugins/php.json error catalog.
 * Supports: PHP 8.1+, Composer, Laravel, Symfony, PHPUnit, Pest.
 *
 * NOTE: This plugin only invokes known, safe commands (php --version, composer install, etc.)
 * through OSAbstraction.exec(). No user input is passed to shell commands.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class PhpPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'php',
      displayName: 'PHP',
      extensions: ['.php', '.phtml', '.blade.php'],
      configFiles: ['composer.json', 'artisan', 'symfony.lock'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // ─── Detection ─────────────────────────────────────────────────────────────

  detect(projectRoot) {
    if (super.detect(projectRoot)) return true;
    try {
      const entries = fs.readdirSync(projectRoot);
      if (entries.some(f => f.endsWith('.php'))) return true;
      const publicDir = path.join(projectRoot, 'public');
      if (fs.existsSync(publicDir)) {
        return fs.readdirSync(publicDir).some(f => f.endsWith('.php'));
      }
    } catch {}
    return false;
  }

  detectVersion() {
    const info = OSAbstraction.getVersion('php', '--version', /PHP\s+(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('php'), source: 'php' };
  }

  detectTestFramework(projectRoot) {
    const composerJson = path.join(projectRoot, 'composer.json');
    if (fs.existsSync(composerJson)) {
      try {
        const content = fs.readFileSync(composerJson, 'utf-8');
        const pkg = JSON.parse(content);
        const allDeps = { ...(pkg.require || {}), ...(pkg['require-dev'] || {}) };
        if (allDeps['pestphp/pest']) return { name: 'pest', command: './vendor/bin/pest', jsonFlag: '--log-junit=results.xml' };
        if (allDeps['phpunit/phpunit']) return { name: 'phpunit', command: './vendor/bin/phpunit', jsonFlag: '--log-junit=results.xml' };
      } catch {}
    }
    // Laravel uses artisan test which wraps PHPUnit/Pest
    if (fs.existsSync(path.join(projectRoot, 'artisan'))) {
      return { name: 'phpunit', command: 'php artisan test', jsonFlag: '--log-junit=results.xml' };
    }
    if (fs.existsSync(path.join(projectRoot, 'vendor', 'bin', 'pest'))) {
      return { name: 'pest', command: './vendor/bin/pest', jsonFlag: '--log-junit=results.xml' };
    }
    if (fs.existsSync(path.join(projectRoot, 'vendor', 'bin', 'phpunit'))) {
      return { name: 'phpunit', command: './vendor/bin/phpunit', jsonFlag: '--log-junit=results.xml' };
    }
    return null;
  }

  /**
   * Detect the PHP framework in use.
   * @param {string} projectRoot
   * @returns {'laravel'|'symfony'|'vanilla'}
   */
  _detectFramework(projectRoot) {
    if (fs.existsSync(path.join(projectRoot, 'artisan'))) return 'laravel';
    if (fs.existsSync(path.join(projectRoot, 'symfony.lock'))) return 'symfony';
    if (fs.existsSync(path.join(projectRoot, 'bin', 'console'))) return 'symfony';
    return 'vanilla';
  }

  // ─── Environment ───────────────────────────────────────────────────────────

  getStrategyOrder() {
    return ['composer'];
  }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null, framework: null, extensions: [] };

    // Detect framework early (before potential early return)
    report.framework = this._detectFramework(projectRoot);

    // Check PHP binary
    const ver = this.detectVersion();
    if (!ver) {
      report.runtime = { installed: false, version: null, compatible: false };
      report.missing.push({ tool: 'php', installCmd: OSAbstraction.getInstallHint('php') || 'choco install php -y' });
      return report;
    }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '8.1.0'), minVersion: '8.1.0' };
    if (!report.runtime.compatible) report.warnings.push(`PHP ${ver.version} is below minimum 8.1.0`);

    // Check Composer
    const composerVer = OSAbstraction.getVersion('composer', '--version', /Composer\s+(?:version\s+)?(\d+\.\d+\.\d+)/);
    if (composerVer) {
      report.strategy = 'composer';
      report.packageManager = { name: 'composer', version: composerVer.version };
    } else {
      report.missing.push({ tool: 'composer', installCmd: OSAbstraction.getInstallHint('composer') || 'curl -sS https://getcomposer.org/installer | php' });
    }

    // Check PHP extensions
    const requiredExtensions = ['mbstring', 'openssl', 'pdo', 'tokenizer', 'xml'];
    try {
      const extList = OSAbstraction.exec('php -m', { timeout: 10000, silent: true }) || '';
      const installedExts = extList.toLowerCase().split(/\r?\n/).map(e => e.trim());
      for (const ext of requiredExtensions) {
        if (installedExts.includes(ext.toLowerCase())) {
          report.extensions.push({ name: ext, installed: true });
        } else {
          report.extensions.push({ name: ext, installed: false });
          report.warnings.push(`PHP extension '${ext}' not found`);
        }
      }
    } catch {
      report.warnings.push('Could not check PHP extensions (php -m failed)');
    }

    report.ready = report.runtime.installed && report.runtime.compatible && !!composerVer;
    return report;
  }

  setupEnvironment(projectRoot) {
    const steps = [];

    // Install dependencies via Composer
    if (fs.existsSync(path.join(projectRoot, 'composer.json'))) {
      steps.push({ action: 'install_deps', command: 'composer install', success: null });
    }

    // Laravel-specific: generate app key if missing
    const framework = this._detectFramework(projectRoot);
    if (framework === 'laravel') {
      if (!fs.existsSync(path.join(projectRoot, '.env'))) {
        steps.push({ action: 'copy_env', command: 'cp .env.example .env', success: null });
      }
      steps.push({ action: 'generate_key', command: 'php artisan key:generate', success: null });
    }

    return { steps, venvPath: null, activateCmd: null };
  }

  // ─── Scaffolding ───────────────────────────────────────────────────────────

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'packagist', pkg: 'laravel/laravel' },
      { registry: 'packagist', pkg: 'symfony/skeleton' },
      { registry: 'packagist', pkg: 'phpunit/phpunit' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const framework = opts.framework || 'laravel';
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    if (framework === 'laravel') {
      postCreate.push(`composer create-project laravel/laravel ${name}`);
      scripts.start = 'php artisan serve';
      scripts.test = 'php artisan test';
    } else if (framework === 'symfony') {
      postCreate.push(`composer create-project symfony/skeleton ${name}`);
      scripts.start = 'symfony server:start';
      scripts.test = './vendor/bin/phpunit';
    } else {
      // Vanilla PHP
      deps['php'] = '>=8.1';
      files.push(
        { path: 'composer.json', template: 'php_composer' },
        { path: 'public/index.php', template: 'php_index' },
        { path: 'src/App.php', template: 'php_app_class' },
      );
      devDeps['phpunit/phpunit'] = opts.versions?.phpunit || '^11.0';
      scripts.start = 'php -S localhost:8000 -t public';
      scripts.test = './vendor/bin/phpunit';
      postCreate.push('composer install');
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // ─── Build & Run ───────────────────────────────────────────────────────────

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || files.length === 0) return null;
    if (files.length <= 10) {
      return files.map(f => `php -l "${f}"`).join(' && ');
    }
    // For many files, just lint the first one (batch handled externally)
    return `php -l "${files[0]}"`;
  }

  getBuildCommand(projectRoot) {
    // PHP is interpreted — no build step. But Laravel has optimize.
    const framework = this._detectFramework(projectRoot);
    if (framework === 'laravel') return 'php artisan optimize';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    const framework = this._detectFramework(projectRoot);
    if (framework === 'laravel') return 'php artisan serve';
    if (framework === 'symfony') {
      if (fs.existsSync(path.join(projectRoot, 'bin', 'console'))) {
        return 'php bin/console server:run';
      }
      return 'symfony server:start';
    }
    if (entryFile) return `php ${entryFile}`;
    // Vanilla PHP built-in server
    if (fs.existsSync(path.join(projectRoot, 'public', 'index.php'))) {
      return 'php -S localhost:8000 -t public';
    }
    if (fs.existsSync(path.join(projectRoot, 'index.php'))) {
      return 'php -S localhost:8000';
    }
    return 'php -S localhost:8000 -t public';
  }

  getInstallCommand(projectRoot) {
    return 'composer install';
  }

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // Use toolchain patterns from JSON catalog
    for (const tc of (this.catalog.metadata?.toolchains || [])) {
      if (!tc.errorFormat) continue;
      try {
        const re = new RegExp(tc.errorFormat, 'gm');
        let m;
        while ((m = re.exec(rawOutput)) !== null) {
          const g = m.groups || {};
          errors.push(this._enrichFromCatalog({
            file: g.file || '', line: parseInt(g.line, 10) || 0, column: parseInt(g.column, 10) || null,
            code: g.code || 'PHP_ERROR', message: (g.message || '').trim(), severity: g.severity || 'error',
            category: this._categorizeError(g.code, g.message, g.severity), origin: origin || 'compiler',
            language: 'php', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
          }));
        }
      } catch {}
    }

    // Fallback: PHP Fatal/Parse error format
    if (errors.length === 0) {
      const phpErrRe = /(?:PHP\s+)?(?:Fatal error|Parse error|Warning|TypeError|ValueError):\s*(.+?)\s+in\s+(\S+?)\s+on\s+line\s+(\d+)/gm;
      let m;
      while ((m = phpErrRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: m[2], line: parseInt(m[3], 10), column: null,
          code: 'PHP_ERROR', message: m[1].trim(), severity: 'error',
          category: this._categorizeError(null, m[1]), origin: origin || 'runtime',
          language: 'php', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    // Fallback: Laravel/Illuminate exceptions
    if (errors.length === 0) {
      const laravelRe = /(Illuminate\\[A-Za-z\\]+Exception):\s*(.+)/gm;
      let m;
      while ((m = laravelRe.exec(rawOutput)) !== null) {
        errors.push(this._enrichFromCatalog({
          file: '', line: 0, column: null,
          code: 'LARAVEL_EXCEPTION', message: `${m[1]}: ${m[2].trim()}`, severity: 'error',
          category: 'runtime', origin: origin || 'runtime',
          language: 'php', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        }));
      }
    }

    // Fallback: Composer errors
    if (errors.length === 0) {
      const composerRe = /Problem\s+\d+\s*\n\s*-\s*(.+)/gm;
      let m;
      while ((m = composerRe.exec(rawOutput)) !== null) {
        errors.push({
          file: 'composer.json', line: 0, column: null,
          code: 'COMPOSER_ERROR', message: m[1].trim(), severity: 'error',
          category: 'dependency', origin: 'compiler',
          language: 'php', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0,
        });
      }
    }

    return errors;
  }

  getCrashPatterns() {
    return [
      /PHP Fatal error/,
      /Parse error/,
      /Uncaught Exception/,
      /Uncaught Error/,
      /Stack trace:/,
      /Segmentation fault/,
      /Allowed memory size of/,
    ];
  }

  // ─── Testing ───────────────────────────────────────────────────────────────

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    if (!fw) return null;
    return fw.command;
  }

  parseTestOutput(raw, framework) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;

    // PHPUnit output: "Tests: 10, Assertions: 25, Failures: 2"
    const testsMatch = raw.match(/Tests:\s*(\d+)/);
    const failMatch = raw.match(/Failures:\s*(\d+)/);
    const errMatch = raw.match(/Errors:\s*(\d+)/);
    const total = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const failures = failMatch ? parseInt(failMatch[1], 10) : 0;
    const errs = errMatch ? parseInt(errMatch[1], 10) : 0;
    result.failed = failures + errs;
    result.passed = total - result.failed;
    if (result.passed < 0) result.passed = 0;

    // Collect failed test names
    const failRe = /FAIL\s+(\S+)::(\S+)/g;
    let m;
    while ((m = failRe.exec(raw)) !== null) {
      result.errors.push({ file: m[1], test: m[2] });
    }

    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    // Check nullable FIRST (PHP ?type syntax, e.g., ?int, ?string)
    if (t.includes('null') || t.includes('nullable') || t.startsWith('?')) return [{ label: 'null', value: 'null' }];
    if (t.includes('string') || t.includes('str')) return [{ label: 'empty string', value: "''" }, { label: 'null', value: 'null' }, { label: "'0' (falsy!)", value: "'0'" }, { label: 'very long', value: "str_repeat('a', 10000)" }];
    if (t.includes('int') || t.includes('integer') || t.includes('number') || t.includes('float')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'PHP_INT_MAX', value: 'PHP_INT_MAX' }, { label: 'PHP_INT_MIN', value: 'PHP_INT_MIN' }];
    if (t.includes('array') || t.includes('list')) return [{ label: 'empty array', value: '[]' }, { label: 'null', value: 'null' }, { label: '[null]', value: '[null]' }];
    if (t.includes('bool') || t.includes('boolean')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    return [{ label: 'null', value: 'null' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.name || '').toLowerCase();
      if (/eloquent|model|database|db|doctrine/.test(name)) return { name: dep.module || dep.name, returnValue: 'new Collection()', type: 'database' };
      if (/http|guzzle|client|request|response/.test(name)) return { name: dep.module || dep.name, returnValue: 'new Response(200, [], "{}")', type: 'http' };
      if (/cache|redis|memcache/.test(name)) return { name: dep.module || dep.name, returnValue: 'null', type: 'cache' };
      if (/mail|email|notification|smtp/.test(name)) return { name: dep.module || dep.name, returnValue: 'Mail::fake()', type: 'email' };
      if (/storage|filesystem|file/.test(name)) return { name: dep.module || dep.name, returnValue: '"mock content"', type: 'filesystem' };
      return { name: dep.module || dep.name, returnValue: 'null', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['PHP'];
    // Detect if Laravel project
    const isLaravel = /laravel|illuminate|artisan/i.test(error.message || '');
    if (isLaravel) parts[0] = 'Laravel';

    if (error.code && error.code !== 'PHP_ERROR') parts.push(error.code);
    if (error.message) parts.push(error.message.slice(0, 60).trim());
    parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _categorizeError(code, message, severity) {
    const msg = (message || '').toLowerCase();
    const sev = (severity || '').toLowerCase();
    if (/parse error|syntax error|unexpected/.test(msg) || sev === 'parse error') return 'syntax';
    if (/class .* not found|interface .* not found|not found/.test(msg)) return 'import';
    if (/type|expected|incompatible|argument|return/.test(msg)) return 'type';
    if (/undefined variable|undefined property/.test(msg)) return 'reference';
    if (/cannot redeclare|already defined/.test(msg)) return 'duplicate';
    if (/memory|timeout|max_execution/.test(msg)) return 'resource';
    return 'runtime';
  }

  _enrichFromCatalog(error) {
    for (const cat of (this.errorCatalog.categories || [])) {
      for (const entry of (cat.errors || [])) {
        if (entry.code && entry.code === error.code) {
          const captures = {};
          if (entry.messagePattern) {
            try {
              const m = error.message.match(new RegExp(entry.messagePattern));
              if (m && entry.captures) entry.captures.forEach((cap, i) => { if (cap.name && m[i + 1]) captures[cap.name] = m[i + 1]; });
            } catch {}
          }
          return { ...error, captures, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
        }
        if (!entry.code && entry.messagePattern) {
          try {
            if (new RegExp(entry.messagePattern).test(error.message)) {
              return { ...error, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
            }
          } catch {}
        }
      }
    }
    return error;
  }
}

module.exports = PhpPlugin;
