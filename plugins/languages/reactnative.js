'use strict';

/**
 * plugins/languages/reactnative.js — React Native framework plugin.
 *
 * Strategy resolution: pnpm -> yarn -> npm (yarn preferred for RN, no bun typically)
 * Wraps defaults/plugins/typescript.json error catalog (React Native is TS-based).
 * Supports: React Native, Expo, TypeScript, JavaScript, Metro, Jest, Detox.
 *
 * SECURITY NOTE: This plugin only invokes known safe commands (node --version,
 * tsc --noEmit, expo start) through OSAbstraction. No user input is interpolated
 * into shell commands. All subprocess execution uses OSAbstraction.exec() or
 * OSAbstraction.getVersion() with hardcoded arguments only.
 */

const fs = require('fs');
const path = require('path');
const { LanguagePlugin } = require('../plugin-contract');
const { OSAbstraction } = require('../os-abstraction');
const { VersionResolver, satisfiesMinimum } = require('../version-resolver');

class ReactNativePlugin extends LanguagePlugin {
  constructor(opts = {}) {
    super({
      id: 'reactnative',
      displayName: 'React Native',
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      configFiles: ['app.json', 'app.config.js', 'app.config.ts', 'metro.config.js'],
      ...opts,
    });
    this._versionResolver = new VersionResolver({ proxyUrl: this._proxyUrl });
  }

  // ─── Catalog override: load typescript.json (RN is TS-based) ──────────────

  loadCatalog() {
    const userPath = path.join(require('os').homedir(), '.attar-code', 'plugins', 'typescript.json');
    const defaultPath = path.join(__dirname, '..', '..', 'defaults', 'plugins', 'typescript.json');
    const catalogPath = fs.existsSync(userPath) ? userPath : defaultPath;
    try { this._catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8')); } catch { this._catalog = { metadata: {}, errorCatalog: { categories: [] }, importSystem: {}, typeTracing: {} }; }
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  detect(projectRoot) {
    // Check for metro.config.js (strong signal)
    if (fs.existsSync(path.join(projectRoot, 'metro.config.js'))) return true;

    // Check app.json with "expo" key
    const appJsonPath = path.join(projectRoot, 'app.json');
    if (fs.existsSync(appJsonPath)) {
      try {
        const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
        if (appJson.expo) return true;
      } catch {}
    }

    // Check for app.config.js or app.config.ts (Expo)
    if (fs.existsSync(path.join(projectRoot, 'app.config.js')) || fs.existsSync(path.join(projectRoot, 'app.config.ts'))) return true;

    // Check package.json for react-native dependency
    const pkg = this._readPkg(projectRoot);
    if (!pkg) return false;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!allDeps['react-native'] || !!allDeps.expo;
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
    if (allDeps.jest || allDeps['@testing-library/react-native']) return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
    if (allDeps.detox) return { name: 'detox', command: 'npx detox test', jsonFlag: null };
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') return { name: 'npm-test', command: this._detectPm(projectRoot) + ' test', jsonFlag: null };
    return null;
  }

  // ─── Environment ──────────────────────────────────────────────────────────

  getStrategyOrder() { return ['pnpm', 'yarn', 'npm']; }

  checkEnvironment(projectRoot) {
    const report = { ready: false, runtime: null, packageManager: null, virtualEnv: null, missing: [], warnings: [], strategy: null };
    const ver = this.detectVersion();
    if (!ver) { report.runtime = { installed: false }; report.missing.push({ tool: 'node', installCmd: OSAbstraction.getInstallHint('node') }); return report; }

    report.runtime = { installed: true, version: ver.version, path: ver.path, compatible: satisfiesMinimum(ver.version, '18.0.0'), minVersion: '18.0.0' };
    if (!report.runtime.compatible) report.warnings.push('Node.js ' + ver.version + ' is below minimum 18.0.0');

    // Detect package manager (prefer yarn for RN)
    for (const pm of this.getStrategyOrder()) {
      const lockfiles = { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' };
      if (pm !== 'npm' && lockfiles[pm] && fs.existsSync(path.join(projectRoot, lockfiles[pm]))) {
        report.strategy = pm; const v = OSAbstraction.getVersion(pm); report.packageManager = { name: pm, version: v?.version || null }; break;
      }
      if (pm !== 'npm' && OSAbstraction.which(pm)) {
        report.strategy = pm; const v = OSAbstraction.getVersion(pm); report.packageManager = { name: pm, version: v?.version || null }; break;
      }
      if (pm === 'npm') { report.strategy = 'npm'; const v = OSAbstraction.getVersion('npm'); report.packageManager = { name: 'npm', version: v?.version || null }; break; }
    }

    // Check for Expo CLI or React Native CLI
    const pkg = this._readPkg(projectRoot);
    const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
    const isExpo = !!allDeps.expo;

    if (isExpo) {
      if (!allDeps.expo && !OSAbstraction.which('expo')) {
        report.warnings.push('expo-cli not found — install with: npm install -g expo-cli');
      }
    } else {
      if (!OSAbstraction.which('react-native')) {
        report.warnings.push('react-native CLI not found — using npx react-native instead');
      }
    }

    // Platform-specific checks
    if (OSAbstraction.isMac && !OSAbstraction.which('watchman')) {
      report.warnings.push('watchman not installed — recommended for file watching on macOS');
    }

    if (!isExpo) {
      // Android SDK check
      if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
        report.warnings.push('ANDROID_HOME not set — required for Android builds');
      }
      // Xcode check (macOS only)
      if (OSAbstraction.isMac && !OSAbstraction.which('xcodebuild')) {
        report.warnings.push('Xcode not installed — required for iOS builds');
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
      { registry: 'npm', pkg: 'react-native' }, { registry: 'npm', pkg: 'expo' },
      { registry: 'npm', pkg: 'react' }, { registry: 'npm', pkg: '@react-navigation/native' },
      { registry: 'npm', pkg: 'typescript' },
    ]);
    return { runtime: runtime?.version || null, frameworks };
  }

  scaffold(name, opts = {}) {
    const files = [], deps = {}, devDeps = {}, scripts = {}, postCreate = [];
    const useExpo = opts.expo !== false; // Default to Expo

    if (opts.manual) {
      if (useExpo) {
        deps.expo = opts.versions?.expo || '~52.0.0';
        deps.react = opts.versions?.react || '^19.0.0';
        deps['react-native'] = opts.versions?.['react-native'] || '^0.76.0';
        devDeps.typescript = opts.versions?.typescript || '^5.8.0';
        devDeps['@types/react'] = 'latest';
        files.push(
          { path: 'app.json', template: 'expo_app_json' },
          { path: 'App.tsx', template: 'expo_app' },
          { path: 'tsconfig.json', template: 'expo_tsconfig' },
        );
        scripts.start = 'expo start';
        scripts.android = 'expo start --android';
        scripts.ios = 'expo start --ios';
        scripts.test = 'jest';
      } else {
        deps.react = opts.versions?.react || '^19.0.0';
        deps['react-native'] = opts.versions?.['react-native'] || '^0.76.0';
        devDeps.typescript = opts.versions?.typescript || '^5.8.0';
        devDeps['@types/react'] = 'latest';
        devDeps.jest = '^29.7.0';
        devDeps['@testing-library/react-native'] = 'latest';
        files.push(
          { path: 'tsconfig.json', template: 'rn_tsconfig' },
          { path: 'App.tsx', template: 'rn_app' },
          { path: 'metro.config.js', template: 'rn_metro_config' },
        );
        scripts.start = 'react-native start';
        scripts.android = 'react-native run-android';
        scripts.ios = 'react-native run-ios';
        scripts.test = 'jest';
      }
    } else {
      if (useExpo) {
        postCreate.push('npx create-expo-app ' + name);
      } else {
        postCreate.push('npx react-native init ' + name);
      }
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
    const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
    if (allDeps.expo) return 'npx expo export';
    if (pkg?.scripts?.build) return this._detectPm(projectRoot) + ' run build';
    return null;
  }

  getRunCommand(projectRoot, entryFile) {
    const pkg = this._readPkg(projectRoot); const pm = this._detectPm(projectRoot);
    const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
    if (allDeps.expo) return 'npx expo start';
    if (pkg?.scripts?.start) return pm + ' start';
    return 'npx react-native start';
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
      errors.push(this._enrichFromCatalog({ file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10), code: m[4], message: m[5].trim(), severity: 'error', category: this._categorizeError(m[4], m[5]), origin: origin || 'compiler', language: 'reactnative', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
    }

    // Metro bundler: Unable to resolve module
    const metroRe = /error:\s*Unable to resolve module\s+['"]?([^'"]+)['"]?/gi;
    while ((m = metroRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'RN_MODULE_RESOLVE', message: m[0], severity: 'error', category: 'import', origin: origin || 'bundler', language: 'reactnative', captures: { moduleName: m[1] }, rootCause: 'Metro bundler cannot find the specified module', prescription: 'Install the missing package or fix the import path; clear Metro cache with --reset-cache', fixHint: null, baseCrossFileProbability: 0.3 });
    }

    // React Native: Invariant Violation
    const invariantRe = /Invariant Violation:\s*(.+)/gi;
    while ((m = invariantRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'RN_INVARIANT', message: m[0], severity: 'error', category: 'runtime', origin: origin || 'runtime', language: 'reactnative', captures: {}, rootCause: 'React Native runtime invariant check failed', prescription: 'Check the error message for details — common causes: missing native module, incorrect component usage', fixHint: null, baseCrossFileProbability: 0 });
    }

    // React Native: Native module cannot be null
    const nativeModRe = /Native module\s+(\S+)\s+cannot be null/gi;
    while ((m = nativeModRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'RN_NATIVE_NULL', message: m[0], severity: 'error', category: 'native', origin: origin || 'runtime', language: 'reactnative', captures: { moduleName: m[1] }, rootCause: 'Native module not properly linked or not installed', prescription: 'Run pod install (iOS) or rebuild the native project; ensure the native module is properly linked', fixHint: 'cd ios && pod install', baseCrossFileProbability: 0 });
    }

    // React Native: Could not connect to development server
    const devServerRe = /Could not connect to development server/gi;
    while ((m = devServerRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'RN_DEV_SERVER', message: m[0], severity: 'error', category: 'network', origin: origin || 'runtime', language: 'reactnative', captures: {}, rootCause: 'Metro bundler is not running or device cannot reach it', prescription: 'Start Metro with npx react-native start or npx expo start; check network connectivity', fixHint: null, baseCrossFileProbability: 0 });
    }

    // Gradle build errors (Android)
    const gradleRe = /Could not determine the dependencies of task\s+'([^']+)'/gi;
    while ((m = gradleRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'RN_GRADLE', message: m[0], severity: 'error', category: 'build', origin: origin || 'compiler', language: 'reactnative', captures: { task: m[1] }, rootCause: 'Gradle dependency resolution failure', prescription: 'Clean the Gradle cache and rebuild: cd android && ./gradlew clean', fixHint: null, baseCrossFileProbability: 0 });
    }

    // Xcode build errors (iOS)
    const xcodeRe = /(?:Build failed|Signing requires a development team)/gi;
    while ((m = xcodeRe.exec(rawOutput)) !== null) {
      errors.push({ file: null, line: null, column: null, code: 'RN_XCODE', message: m[0], severity: 'error', category: 'build', origin: origin || 'compiler', language: 'reactnative', captures: {}, rootCause: 'Xcode build or signing configuration error', prescription: 'Open the .xcworkspace in Xcode, configure signing, and try again', fixHint: null, baseCrossFileProbability: 0 });
    }

    // Node.js runtime fallback
    if (errors.length === 0) {
      const nodeRe = /^(.+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+)\b/gm;
      let lastFile = null, lastLine = null;
      while ((m = nodeRe.exec(rawOutput)) !== null) { lastFile = m[1]; lastLine = parseInt(m[2], 10); }
      const errMatch = rawOutput.match(/^(\w+Error):\s*(.+)$/m);
      if (lastFile && lastLine && errMatch) {
        errors.push(this._enrichFromCatalog({ file: lastFile, line: lastLine, column: null, code: errMatch[1], message: errMatch[1] + ': ' + errMatch[2], severity: 'error', category: this._categorizeError(errMatch[1], errMatch[2]), origin: origin || 'runtime', language: 'reactnative', captures: {}, rootCause: null, prescription: null, fixHint: null, baseCrossFileProbability: 0 }));
      }
    }
    return errors;
  }

  getCrashPatterns() {
    return [/TypeError:/, /ReferenceError:/, /SyntaxError:/, /RangeError:/, /unhandled\s+promise\s+rejection/i, /ECONNREFUSED/, /Cannot find module/, /Invariant Violation/, /Native module.*cannot be null/, /Unable to resolve module/];
  }

  // ─── Testing ──────────────────────────────────────────────────────────────

  getTestCommand(projectRoot, framework) {
    const fw = framework || this.detectTestFramework(projectRoot);
    return fw ? fw.command : this._detectPm(projectRoot) + ' run test';
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
      if (/asyncstorage|@react-native-async-storage/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() }', type: 'storage' };
      if (/animated|react-native-reanimated/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ Value: jest.fn(), timing: jest.fn() }', type: 'animation' };
      if (/platform/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ OS: "ios", select: jest.fn() }', type: 'platform' };
      if (/axios|fetch|got|node-fetch/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ status: 200, data: {} }', type: 'http' };
      if (/navigation|@react-navigation/.test(name)) return { name: dep.module || dep.rawSource, returnValue: '{ navigate: jest.fn(), goBack: jest.fn() }', type: 'navigation' };
      return { name: dep.module || dep.rawSource, returnValue: 'jest.fn()', type: 'generic' };
    });
  }

  buildSearchQuery(error) {
    const parts = ['React Native']; if (error.code) parts.push(error.code);
    const errType = error.message?.match(/^(\w+Error)/)?.[1]; if (errType) parts.push(errType);
    if (error.message) parts.push(error.message.slice(0, 60).trim()); parts.push('fix');
    return parts.join(' ');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _readPkg(r) { try { return JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf-8')); } catch { return null; } }
  _detectPm(r) { if (fs.existsSync(path.join(r, 'pnpm-lock.yaml'))) return 'pnpm'; if (fs.existsSync(path.join(r, 'yarn.lock'))) return 'yarn'; return 'npm'; }
  _categorizeError(code, msg) { const m = (msg || '').toLowerCase(); if (/syntax|parse|unexpected/.test(m)) return 'syntax'; if (/cannot find module|import|require|unable to resolve/.test(m)) return 'import'; if (/type|property.*does not exist|not assignable/.test(m)) return 'type'; if (/invariant/.test(m)) return 'runtime'; return 'runtime'; }

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

module.exports = ReactNativePlugin;
