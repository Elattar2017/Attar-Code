'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { LanguagePlugin } = require('../plugin-contract');

const NestJSPlugin = require('../languages/nestjs');
const NextJSPlugin = require('../languages/nextjs');
const ReactNativePlugin = require('../languages/reactnative');

// ═══════════════════════════════════════════════════════════════════════════════
// NestJS Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('NestJSPlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new NestJSPlugin(); });

  describe('identity', () => {
    test('has correct id', () => { expect(plugin.id).toBe('nestjs'); });
    test('has correct displayName', () => { expect(plugin.displayName).toBe('NestJS'); });
    test('has TS extensions', () => { expect(plugin.extensions).toContain('.ts'); expect(plugin.extensions).toContain('.tsx'); });
    test('has NestJS config files', () => { expect(plugin.configFiles).toContain('nest-cli.json'); });
    test('extends LanguagePlugin', () => { expect(plugin).toBeInstanceOf(LanguagePlugin); });
  });

  describe('catalog', () => {
    test('loads typescript.json catalog (NestJS is TS-based)', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('TypeScript');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories).toBeTruthy();
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with nest-cli.json', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-'));
      fs.writeFileSync(path.join(tmpDir, 'nest-cli.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project via package.json with @nestjs/core', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { '@nestjs/core': '^11.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect plain TS project without NestJS', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { express: '^5.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect empty directory', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-'));
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns correct order', () => {
      expect(plugin.getStrategyOrder()).toEqual(['pnpm', 'bun', 'yarn', 'npm']);
    });

    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-'));
      fs.writeFileSync(path.join(tmpDir, 'nest-cli.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { '@nestjs/core': '^11.0.0' }
      }));
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      expect(report.runtime.installed).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('scaffold', () => {
    test('scaffolds via npx @nestjs/cli by default', () => {
      const result = plugin.scaffold('myapp');
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('@nestjs/cli new');
    });

    test('scaffolds manual project with deps', () => {
      const result = plugin.scaffold('myapp', { manual: true });
      expect(result.deps).toHaveProperty('@nestjs/core');
      expect(result.deps).toHaveProperty('@nestjs/common');
      expect(result.deps).toHaveProperty('reflect-metadata');
      expect(result.deps).toHaveProperty('rxjs');
      expect(result.devDeps).toHaveProperty('typescript');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.scripts.build).toBe('nest build');
    });
  });

  describe('parseErrors', () => {
    test('parses TypeScript errors', () => {
      const raw = "src/app.ts(12,5): error TS2339: Property 'foo' does not exist on type 'Bar'";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBe(1);
      expect(errors[0].file).toBe('src/app.ts');
      expect(errors[0].line).toBe(12);
      expect(errors[0].code).toBe('TS2339');
      expect(errors[0].language).toBe('nestjs');
    });

    test('parses NestJS dependency resolution errors', () => {
      const raw = "Nest can't resolve dependencies of the UserService";
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEST_DI_RESOLVE');
      expect(errors[0].category).toBe('dependency-injection');
      expect(errors[0].captures.provider).toBe('UserService');
    });

    test('parses circular dependency warnings', () => {
      const raw = 'A circular dependency has been detected';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEST_CIRCULAR_DEP');
      expect(errors[0].prescription).toContain('forwardRef');
    });

    test('parses unknown export errors', () => {
      const raw = 'Unknown export AuthService from module AuthModule';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEST_UNKNOWN_EXPORT');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null)).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('matches NestJS resolve error', () => {
      expect(plugin.getCrashPatterns().some(p => p.test("Nest can't resolve dependencies"))).toBe(true);
    });
    test('matches circular dependency', () => {
      expect(plugin.getCrashPatterns().some(p => p.test("circular dependency detected"))).toBe(true);
    });
    test('matches TypeError', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('TypeError: Cannot read properties'))).toBe(true);
    });
  });

  describe('edge cases and mocks', () => {
    test('getEdgeCases for string', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });

    test('generateMocks for database repository', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'UserRepository' }]);
      expect(mocks[0].type).toBe('database');
    });

    test('generateMocks for ConfigService', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'ConfigService' }]);
      expect(mocks[0].type).toBe('config');
    });

    test('generateMocks for JwtService', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'JwtService' }]);
      expect(mocks[0].type).toBe('auth');
    });

    test('generateMocks for generic', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'unknown' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  describe('diagnostics', () => {
    test('buildSearchQuery uses NestJS prefix', () => {
      const q = plugin.buildSearchQuery({ code: 'TS2339', message: 'Property foo does not exist' });
      expect(q).toContain('NestJS');
      expect(q).toContain('TS2339');
      expect(q).not.toContain('TypeScript');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Next.js Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('NextJSPlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new NextJSPlugin(); });

  describe('identity', () => {
    test('has correct id', () => { expect(plugin.id).toBe('nextjs'); });
    test('has correct displayName', () => { expect(plugin.displayName).toBe('Next.js'); });
    test('has TS/JS extensions', () => {
      expect(plugin.extensions).toContain('.ts');
      expect(plugin.extensions).toContain('.tsx');
      expect(plugin.extensions).toContain('.js');
      expect(plugin.extensions).toContain('.jsx');
    });
    test('has Next.js config files', () => {
      expect(plugin.configFiles).toContain('next.config.js');
      expect(plugin.configFiles).toContain('next.config.mjs');
      expect(plugin.configFiles).toContain('next.config.ts');
    });
    test('extends LanguagePlugin', () => { expect(plugin).toBeInstanceOf(LanguagePlugin); });
  });

  describe('catalog', () => {
    test('loads typescript.json catalog (Next.js is TS-based)', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('TypeScript');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories).toBeTruthy();
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with next.config.js', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-test-'));
      fs.writeFileSync(path.join(tmpDir, 'next.config.js'), 'module.exports = {}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with next.config.mjs', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-test-'));
      fs.writeFileSync(path.join(tmpDir, 'next.config.mjs'), 'export default {}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project via package.json with next dependency', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { next: '^15.0.0', react: '^19.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect plain TS project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { express: '^5.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect empty directory', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-test-'));
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns correct order', () => {
      expect(plugin.getStrategyOrder()).toEqual(['pnpm', 'bun', 'yarn', 'npm']);
    });

    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-test-'));
      fs.writeFileSync(path.join(tmpDir, 'next.config.js'), 'module.exports = {}');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { next: '^15.0.0' }
      }));
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      expect(report.runtime.installed).toBe(true);
      expect(report.runtime.minVersion).toBe('18.18.0');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('scaffold', () => {
    test('scaffolds via create-next-app by default', () => {
      const result = plugin.scaffold('myapp');
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('create-next-app');
    });

    test('scaffolds manual TS project with deps', () => {
      const result = plugin.scaffold('myapp', { manual: true });
      expect(result.deps).toHaveProperty('next');
      expect(result.deps).toHaveProperty('react');
      expect(result.deps).toHaveProperty('react-dom');
      expect(result.devDeps).toHaveProperty('typescript');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.scripts.dev).toBe('next dev');
      expect(result.scripts.build).toBe('next build');
    });

    test('scaffold with tailwind option', () => {
      const result = plugin.scaffold('myapp', { manual: true, tailwind: true });
      expect(result.devDeps).toHaveProperty('tailwindcss');
    });
  });

  describe('parseErrors', () => {
    test('parses TypeScript errors', () => {
      const raw = "src/page.tsx(5,3): error TS2322: Type 'string' is not assignable to type 'number'";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('TS2322');
      expect(errors[0].language).toBe('nextjs');
    });

    test('parses hydration errors', () => {
      const raw = 'Error: Hydration failed because the initial UI does not match what was rendered on the server';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEXT_HYDRATION');
      expect(errors[0].category).toBe('hydration');
    });

    test('parses client/server boundary errors', () => {
      const raw = "You're importing a component that needs useState";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEXT_CLIENT_BOUNDARY');
    });

    test('parses Module not found errors', () => {
      const raw = "Module not found: Can't resolve 'my-package'";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEXT_MODULE_NOT_FOUND');
      expect(errors[0].captures.moduleName).toBe('my-package');
    });

    test('parses Server Error', () => {
      const raw = 'Server Error: Internal error occurred';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NEXT_SERVER_ERROR');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null)).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('matches Hydration failed', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Hydration failed'))).toBe(true);
    });
    test('matches Server Error', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Server Error'))).toBe(true);
    });
    test('matches NEXT_NOT_FOUND', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('NEXT_NOT_FOUND'))).toBe(true);
    });
    test('matches TypeError', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('TypeError: Cannot read properties'))).toBe(true);
    });
  });

  describe('edge cases and mocks', () => {
    test('getEdgeCases for string', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });

    test('generateMocks for next/router', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'next/router' }]);
      expect(mocks[0].type).toBe('router');
    });

    test('generateMocks for next/navigation', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'next/navigation' }]);
      expect(mocks[0].type).toBe('router');
    });

    test('generateMocks for database', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'prisma' }]);
      expect(mocks[0].type).toBe('database');
    });

    test('generateMocks for generic', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'unknown' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  describe('diagnostics', () => {
    test('buildSearchQuery uses Next.js prefix', () => {
      const q = plugin.buildSearchQuery({ code: 'TS2339', message: 'Property foo does not exist' });
      expect(q).toContain('Next.js');
      expect(q).toContain('TS2339');
      expect(q).not.toContain('TypeScript');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// React Native Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('ReactNativePlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new ReactNativePlugin(); });

  describe('identity', () => {
    test('has correct id', () => { expect(plugin.id).toBe('reactnative'); });
    test('has correct displayName', () => { expect(plugin.displayName).toBe('React Native'); });
    test('has TS/JS extensions', () => {
      expect(plugin.extensions).toContain('.ts');
      expect(plugin.extensions).toContain('.tsx');
      expect(plugin.extensions).toContain('.js');
      expect(plugin.extensions).toContain('.jsx');
    });
    test('has RN config files', () => {
      expect(plugin.configFiles).toContain('app.json');
      expect(plugin.configFiles).toContain('app.config.js');
      expect(plugin.configFiles).toContain('metro.config.js');
    });
    test('extends LanguagePlugin', () => { expect(plugin).toBeInstanceOf(LanguagePlugin); });
  });

  describe('catalog', () => {
    test('loads typescript.json catalog (RN is TS-based)', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('TypeScript');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories).toBeTruthy();
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with app.json containing expo key', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'app.json'), JSON.stringify({ expo: { name: 'test' } }));
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with metro.config.js', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'metro.config.js'), 'module.exports = {}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with app.config.js', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'app.config.js'), 'module.exports = {}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project via package.json with react-native dep', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { 'react-native': '^0.76.0', react: '^19.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project via package.json with expo dep', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { expo: '~52.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect plain app.json without expo key', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'app.json'), JSON.stringify({ name: 'test' }));
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect plain TS project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { express: '^5.0.0' }
      }));
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns correct order (no bun)', () => {
      expect(plugin.getStrategyOrder()).toEqual(['pnpm', 'yarn', 'npm']);
    });

    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        dependencies: { 'react-native': '^0.76.0' }
      }));
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      expect(report.runtime.installed).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('scaffold', () => {
    test('scaffolds Expo project by default', () => {
      const result = plugin.scaffold('myapp');
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('create-expo-app');
    });

    test('scaffolds bare React Native project', () => {
      const result = plugin.scaffold('myapp', { expo: false });
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('react-native init');
    });

    test('scaffolds manual Expo project', () => {
      const result = plugin.scaffold('myapp', { manual: true, expo: true });
      expect(result.deps).toHaveProperty('expo');
      expect(result.deps).toHaveProperty('react');
      expect(result.deps).toHaveProperty('react-native');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.scripts.start).toBe('expo start');
    });

    test('scaffolds manual bare RN project', () => {
      const result = plugin.scaffold('myapp', { manual: true, expo: false });
      expect(result.deps).toHaveProperty('react');
      expect(result.deps).toHaveProperty('react-native');
      expect(result.deps).not.toHaveProperty('expo');
      expect(result.scripts.start).toBe('react-native start');
    });
  });

  describe('parseErrors', () => {
    test('parses TypeScript errors', () => {
      const raw = "App.tsx(10,5): error TS2322: Type 'string' is not assignable to type 'number'";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('TS2322');
      expect(errors[0].language).toBe('reactnative');
    });

    test('parses Metro bundler module resolve errors', () => {
      const raw = "error: Unable to resolve module 'missing-package'";
      const errors = plugin.parseErrors(raw, 'bundler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('RN_MODULE_RESOLVE');
      expect(errors[0].captures.moduleName).toBe('missing-package');
    });

    test('parses Invariant Violation', () => {
      const raw = 'Invariant Violation: Text strings must be rendered within a <Text> component';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('RN_INVARIANT');
    });

    test('parses Native module cannot be null', () => {
      const raw = 'Native module RNCameraView cannot be null';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('RN_NATIVE_NULL');
      expect(errors[0].captures.moduleName).toBe('RNCameraView');
    });

    test('parses development server connection errors', () => {
      const raw = 'Could not connect to development server';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('RN_DEV_SERVER');
    });

    test('parses Gradle build errors', () => {
      const raw = "Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('RN_GRADLE');
    });

    test('parses Xcode build errors', () => {
      const raw = 'Signing requires a development team';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('RN_XCODE');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null)).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('matches Invariant Violation', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Invariant Violation: bad stuff'))).toBe(true);
    });
    test('matches Native module cannot be null', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Native module Camera cannot be null'))).toBe(true);
    });
    test('matches Unable to resolve module', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Unable to resolve module foo'))).toBe(true);
    });
    test('matches TypeError', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('TypeError: Cannot read properties'))).toBe(true);
    });
  });

  describe('edge cases and mocks', () => {
    test('getEdgeCases for string', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });

    test('generateMocks for AsyncStorage', () => {
      const mocks = plugin.generateMocks([{ rawSource: '@react-native-async-storage/async-storage' }]);
      expect(mocks[0].type).toBe('storage');
    });

    test('generateMocks for Animated', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'react-native-reanimated' }]);
      expect(mocks[0].type).toBe('animation');
    });

    test('generateMocks for navigation', () => {
      const mocks = plugin.generateMocks([{ rawSource: '@react-navigation/native' }]);
      expect(mocks[0].type).toBe('navigation');
    });

    test('generateMocks for http', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'axios' }]);
      expect(mocks[0].type).toBe('http');
    });

    test('generateMocks for generic', () => {
      const mocks = plugin.generateMocks([{ rawSource: 'unknown' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  describe('diagnostics', () => {
    test('buildSearchQuery uses React Native prefix', () => {
      const q = plugin.buildSearchQuery({ code: 'RN_INVARIANT', message: 'Invariant Violation: Text' });
      expect(q).toContain('React Native');
      expect(q).toContain('RN_INVARIANT');
      expect(q).not.toContain('TypeScript');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Registry Integration (all 3 framework plugins)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Registry integration (framework plugins)', () => {
  const { PluginRegistry } = require('../index');
  let registry;

  beforeAll(() => {
    registry = new PluginRegistry();
    registry.loadAll();
  });

  test('loadAll finds framework plugins', () => {
    expect(registry.get('nestjs')).toBeTruthy();
    expect(registry.get('nextjs')).toBeTruthy();
    expect(registry.get('reactnative')).toBeTruthy();
  });

  test('pluginForTech maps NestJS correctly', () => {
    expect(registry.pluginForTech('NestJS')?.id).toBe('nestjs');
    expect(registry.pluginForTech('Nest.js')?.id).toBe('nestjs');
  });

  test('pluginForTech maps Next.js correctly', () => {
    expect(registry.pluginForTech('Next.js')?.id).toBe('nextjs');
    expect(registry.pluginForTech('NextJS')?.id).toBe('nextjs');
  });

  test('pluginForTech maps React Native correctly', () => {
    expect(registry.pluginForTech('React Native')?.id).toBe('reactnative');
    expect(registry.pluginForTech('react-native')?.id).toBe('reactnative');
    expect(registry.pluginForTech('Expo')?.id).toBe('reactnative');
  });

  test('detectLanguages finds NestJS project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'nest-cli.json'), '{}');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'nestjs')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('detectLanguages finds Next.js project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'next.config.js'), 'module.exports = {}');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'nextjs')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('detectLanguages finds React Native project via metro.config.js', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'metro.config.js'), 'module.exports = {}');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'reactnative')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('detectLanguages finds React Native project via expo in app.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'app.json'), JSON.stringify({ expo: { name: 'test' } }));
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'reactnative')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
