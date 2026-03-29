'use strict';

/**
 * plugins/languages/nextjs.js — Next.js framework plugin.
 *
 * Strategy resolution: pnpm -> bun -> yarn -> npm
 * Wraps defaults/plugins/typescript.json error catalog (Next.js is TypeScript-based).
 * Supports: Next.js, React, TypeScript, JavaScript, tsc, vitest, jest, playwright.
 *
 * SECURITY NOTE: This plugin only invokes known safe commands (node --version,
 * tsc --noEmit, next build) through OSAbstraction. No user input is interpolated
 * into shell commands. All subprocess execution uses OSAbstraction.exec() or
 * OSAbstraction.getVersion() with hardcoded arguments only.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class NextJSPlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'nextjs',
      displayName: 'Next.js',
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // ─── Catalog override: load typescript.json (Next.js is TS-based) ─────────

  loadCatalog() {
    const userPath = path.join(require('os').homedir(), '.attar-code', 'plugins', 'typescript.json');
    const defaultPath = path.join(__dirname, '..', '..', 'defaults', 'plugins', 'typescript.json');
    const catalogPath = fs.existsSync(userPath) ? userPath : defaultPath;
    try { this._catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8')); } catch { this._catalog = { metadata: {}, errorCatalog: { categories: [] }, importSystem: {}, typeTracing: {} }; }
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  detect(projectRoot) {
    if (this.configFiles.some(f => fs.existsSync(path.join(projectRoot, f)))) return true;
    const pkg = this._readPkg(projectRoot);
    if (!pkg) return false;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!allDeps.next;
  }

  detectVersion() {
    const info = OSAbstraction.getVersion('node', '--version', /v(\d+\.\d+\.\d+)/);
    if (!info) return null;
    return { version: info.version, path: OSAbstraction.which('node'), source: 'node' };
  }

  detectTestFramework(projectRoot) {
    const pkg = this._readPkg(projectRoot);
    if (!pkg) return null;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps.vitest) return { name: 'vitest', command: 'npx vitest run', jsonFlag: '--reporter=json' };
    if (allDeps.jest) return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
    if (allDeps.playwright || allDeps['@playwright/test']) return { name: 'playwright', command: 'npx playwright test', jsonFlag: '--reporter=json' };
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') return { name: 'npm-test', command: this._detectPm(projectRoot) + ' test', jsonFlag: null };
    return null;
  }

  // ─── Environment ──────────────────────────────────────────────────────────

  getStrategyOrder() { return ['pnpm', 'bun', 'yarn', 'npm']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) { report.runtime = { installed: false }; report.missing.push({ tool: 'node', installCmd: OSAbstraction.getInstallHint('node') }); return report; }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '18.18.0'), minVersion: '18.18.0' };
    if (!report.runtime.compatible) report.warnings.push('Node.js ' + ver.version + ' is below minimum 18.18.0 for Next.js 15+');

    for (const pm of this.getStrategyOrder()) {
      const lockfiles = { pnpm: 'pnpm-lock.yaml', bun: 'bun.lockb', yarn: 'yarn.lock' };
      if (pm !== 'npm' && lockfiles[pm] && fs.existsSync(path.join(projectRoot, lockfiles[pm]))) {
        report.strategy = pm; const v = OSAbstraction.getVersion(pm); report.packageManager = { name: pm, version: v?.version || null }; break;
      }
      if (pm !== 'npm' && OSAbstraction.which(pm)) {
        report.strategy = pm; const v = OSAbstraction.getVersion(pm); report.packageManager = { name: pm, version: v?.version || null }; break;
      }
      if (pm === 'npm') { report.strategy = 'npm'; const v = OSAbstraction.getVersion('npm'); report.packageManager = { name: 'npm', version: v?.version || null }; break; }
    }

    // Check Next.js installed
    const pkg = this._readPkg(projectRoot);
    const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
    if (!allDeps.next) {
      report.warnings.push('next package not found in dependencies');
    }

    // Check Next.js version compatibility with Node.js
    if (allDeps.next && ver.version) {
      const nv = (allDeps.next || '').replace(/[\^~>=<]/g, '');
      if (parseInt(nv, 10) >= 15 && !satisfiesMinimum(ver.version, '18.18.0')) {
        report.warnings.push('Next.js ' + nv + ' requires Node.js 18.18+');
      }
    }

    report.ready = report.runtime.installed && report.runtime.compatible;
    return report;
  }

  setupEnvironment(projectRoot) {
    return { steps: [{ action: 'install_deps', command: this._detectPm(projectRoot) + ' install' }], venvPath: null, activateCmd: null };
  }

  // ─── Scaffolding ──────────────────────────────────────────────────────────

  async getLatestVersions() {
    const runtime = this.detectVersion();
    const frameworks = await this._versionResolver.resolveAll([
      { registry: 'npm', pkg: 'next' }, { registry: 'npm', pkg: 'react' },
      { registry: 'npm', pkg: 'react-dom' }, { registry: 'npm', pkg: '@next/font' },
      { registry: 'npm', pkg: 'tailwindcss' }, { registry: 'npm', pkg: 'typescript' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];

    if (opts.manual) {
      deps.next = opts.versions?.next || '^15.0.0';
      deps.react = opts.versions?.react || '^19.0.0';
      deps['react-dom'] = opts.versions?.['react-dom'] || '^19.0.0';
      if (opts.typescript !== false) {
        devDeps.typescript = opts.versions?.typescript || '^5.8.0';
        devDeps['@types/react'] = 'latest';
        devDeps['@types/node'] = 'latest';
        files.push(
          { path: 'tsconfig.json', template: 'nextjs_tsconfig' },
          { path: 'next.config.ts', template: 'nextjs_config' },
          { path: 'app/layout.tsx', template: 'nextjs_layout' },
          { path: 'app/page.tsx', template: 'nextjs_page' },
        );
      } else {
        files.push(
          { path: 'next.config.js', template: 'nextjs_config_js' },
          { path: 'app/layout.js', template: 'nextjs_layout_js' },
          { path: 'app/page.js', template: 'nextjs_page_js' },
        );
      }
      if (opts.tailwind) { devDeps.tailwindcss = '^4.0.0'; devDeps.postcss = '^8.0.0'; devDeps.autoprefixer = '^10.0.0'; }
      scripts.dev = 'next dev';
      scripts.build = 'next build';
      scripts.start = 'next start';
      scripts.lint = 'next lint';
    } else {
      let cmd = 'npx create-next-app@latest ' + name;
      if (opts.typescript !== false) cmd += ' --typescript';
      if (opts.tailwind) cmd += ' --tailwind';
      if (opts.eslint !== false) cmd += ' --eslint';
      if (opts.appRouter !== false) cmd += ' --app';
      if (opts.srcDir) cmd += ' --src-dir';
      postCreate.push(cmd);
    }

    return { files, deps, devDeps, scripts, postCreate };
  }

  // ─── Build & Run ──────────────────────────────────────────────────────────

  getSyntaxCheckCommand(files, projectRoot) {
    if (!files || !files.length) return null;
    if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return 'npx tsc --noEmit';
    return files.map(f => 'node --check "' + f + '"').join(' && ');
  }

  getBuildCommand(projectRoot) {
    const pkg = this._readPkg(projectRoot);
    if (pkg?.scripts?.build) return this._detectPm(projectRoot) + ' run build';
    return 'next build';
  }

  getRunCommand(projectRoot, entryFile) {
    const pkg = this._readPkg(projectRoot); const pm = this._detectPm(projectRoot);
    if (pkg?.scripts?.dev) return pm + ' run dev';
    if (pkg?.scripts?.start) return pm + ' start';
    return 'next dev';
  }

  getInstallCommand(projectRoot) { return this._detectPm(projectRoot) + ' install'; }

  // ─── Error Parsing ────────────────────────────────────────────────────────

  parseErrors(rawOutput, origin) {
    if (!rawOutput) return [];
    const errors = [];

    // TypeScript: file(line,col): error TSNNNN: message
    const tsRe = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
    let m;
    while ((m = tsRe.exec(rawOutput)) !== null) {
      errors.push(this._enrichFromCatalog({ file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10), code: m[4], message: m[5].trim(), severity: 'error', category: this._categorizeError(m[4], m[5]), origin: origin || 'compiler', language: 'nextjs', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
    }

    // Next.js-specific: Hydration failed
    const hydrationRe = /Error:\s*Hydration failed because.*$/gm;
    while ((m = hydrationRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEXT_HYDRATION', message: m[0], severity: 'error', category: 'hydration', origin: origin || 'runtime', language: 'nextjs', captures: {}, rootCause: 'Server-rendered HTML does not match client-rendered output', prescription: 'Ensure server and client render the same content; avoid browser-only APIs during initial render', fixHint: 'Use useEffect() for browser-only code or add suppressHydrationWarning', baseCrossFileProbability: 0.5 });
    }

    // Next.js-specific: client/server component boundary
    const boundaryRe = /You're importing a component that needs\s+(.+)/gi;
    while ((m = boundaryRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEXT_CLIENT_BOUNDARY', message: m[0], severity: 'error', category: 'boundary', origin: origin || 'compiler', language: 'nextjs', captures: {}, rootCause: 'Client component imported in a Server Component without "use client" directive', prescription: 'Add "use client" directive at the top of the file or restructure the component tree', fixHint: '"use client";', baseCrossFileProbability: 0.8 });
    }

    // Next.js-specific: Server Error / Internal Server Error
    const serverErrRe = /Server Error[:\s]+(.+)/gi;
    while ((m = serverErrRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEXT_SERVER_ERROR', message: m[0], severity: 'error', category: 'runtime', origin: origin || 'runtime', language: 'nextjs', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 });
    }

    // Next.js-specific: Module not found
    const moduleRe = /Module not found:\s*Can't resolve\s+'([^']+)'/gi;
    while ((m = moduleRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEXT_MODULE_NOT_FOUND', message: m[0], severity: 'error', category: 'import', origin: origin || 'compiler', language: 'nextjs', captures: { moduleName: m[1] }, rootCause: 'Module not installed or incorrect import path', prescription: 'Install the missing module or fix the import path', fixHint: null, baseCrossFileProbability: 0.3 });
    }

    // Next.js-specific: next/image errors
    const imageRe = /Image.*(?:missing|required).*(?:width|height|src)/gi;
    while ((m = imageRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'NEXT_IMAGE', message: m[0], severity: 'error', category: 'component', origin: origin || 'runtime', language: 'nextjs', captures: {}, rootCause: 'next/image component requires width and height props for static images', prescription: 'Provide width and height props or use fill prop with a sized parent container', fixHint: '<Image src="..." width={500} height={300} alt="..." />', baseCrossFileProbability: 0 });
    }

    // Node.js runtime fallback
    if (errors.length === 0) {
      const nodeRe = /^(.+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+)\b/gm;
      let lastFile = null, lastLine = null;
      while ((m = nodeRe.exec(rawOutput)) !== null) { lastFile = m[1]; lastLine = parseInt(m[2], 10); }
      const errMatch = rawOutput.match(/^(\w+Error):\s*(.+)$/m);
      if (lastFile && lastLine && errMatch) {
        errors.push(this._enrichFromCatalog({ file: lastFile, line: lastLine, column: null, code: errMatch[1], message: errMatch[1] + ': ' + errMatch[2], severity: 'error', category: this._categorizeError(errMatch[1], errMatch[2]), origin: origin || 'runtime', language: 'nextjs', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
      }
    }
    return errors;
  }

  getCrashPatterns() {
    return [/TypeError:/, /ReferenceError:/, /SyntaxError:/, /RangeError:/, /unhandled\s+promise\s+rejection/i, /ECONNREFUSED/, /EADDRINUSE/, /Cannot find module/, /Hydration failed/, /Server Error/, /NEXT_NOT_FOUND/];
  }

  // ─── Testing ──────────────────────────────────────────────────────────────

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    return fw ? fw.command : null;
  }

  parseTestOutput(raw) {
    const result = { passed: 0, failed: 0, errors: [] };
    if (!raw) return result;
    const p = raw.match(/(\d+)\s+passed/); if (p) result.passed = parseInt(p[1], 10);
    const f = raw.match(/(\d+)\s+failed/); if (f) result.failed = parseInt(f[1], 10);
    const failRe = /FAIL\s+(\S+)/g; let m; while ((m = failRe.exec(raw)) !== null) result.errors.push({ file: m[1] });
    return result;
  }

  getEdgeCases(paramType) {
    const t = (paramType || '').toLowerCase();
    if (t.includes('string')) return [{ label: 'empty', value: '""' }, { label: 'whitespace', value: '" "' }, { label: 'long', value: '"a".repeat(10000)' }];
    if (t.includes('number')) return [{ label: 'zero', value: '0' }, { label: 'negative', value: '-1' }, { label: 'NaN', value: 'NaN' }, { label: 'Infinity', value: 'Infinity' }];
    if (t.includes('boolean')) return [{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }];
    if (t.includes('array') || t.includes('[]')) return [{ label: 'empty', value: '[]' }, { label: 'single', value: '[1]' }, { label: 'with null', value: '[null]' }];
    return [{ label: 'undefined', value: 'undefined' }, { label: 'null', value: 'null' }];
  }

  generateMocks(deps) {
    return deps.map(dep => {
      const name = (dep.module || dep.rawSource || '').toLowerCase();
      if (/prisma|sequelize|mongoose|knex|typeorm/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '[]', type: 'database' };
      if (/next\/router|next\/navigation/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ push: jest.fn(), replace: jest.fn(), back: jest.fn(), pathname: "/" }', type: 'router' };
      if (/next\/headers/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ get: jest.fn(), set: jest.fn() }', type: 'headers' };
      if (/axios|fetch|got|node-fetch/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ status: 200, data: {} }', type: 'http' };
      if (/^fs$|^path$|^fs\/promises/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '"mock content"', type: 'filesystem' };
      return { name: dep.module || dep.rawSource, returnValue: 'jest.fn()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['Next.js']; if (error.code) parts.push(error.code);
    const errType = error.message?.match(/^(\w+Error)/)?.[1]; if (errType) parts.push(errType);
    if (error.message) parts.push(error.message.slice(0, 60).trim()); parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _readPkg(r) { try { return JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf-8')); } catch { return null; } }
  _detectPm(r) { if (fs.existsSync(path.join(r, 'pnpm-lock.yaml'))) return 'pnpm'; if (fs.existsSync(path.join(r, 'bun.lockb'))) return 'bun'; if (fs.existsSync(path.join(r, 'yarn.lock'))) return 'yarn'; return 'npm'; }
  _categorizeError(code, msg) { const m = (msg || '').toLowerCase(); if (/syntax|parse|unexpected/.test(m)) return 'syntax'; if (/cannot find module|import|require|can't resolve/.test(m)) return 'import'; if (/type|property.*does not exist|not assignable/.test(m)) return 'type'; if (/hydration/.test(m)) return 'hydration'; return 'runtime'; }

  _enrichFromCatalog(error) {
    for (const cat of (this.errorCatalog.categories || [])) {
      for (const entry of (cat.errors || [])) {
        if (entry.code === error.code) {
          const captures = {};
          if (entry.messagePattern) { try { const m = error.message.match(new RegExp(entry.messagePattern)); if (m && entry.captures) entry.captures.forEach((cap, i) => { if (cap.name && m[i + 1]) captures[cap.name] = m[i + 1]; }); } catch {} }
          return { ...error, captures, rootCause: entry.rootCause || null, prescription: entry.prescription || null, fixHint: entry.fixHint || null, baseCrossFileProbability: entry.baseCrossFileProbability || 0 };
        }
      }
    }
    return error;
  }
}

module.exports = NextJSPlugin;
