'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const PhpPlugin = require('../languages/php');
const CSharpPlugin = require('../languages/csharp');
const { LanguagePlugin } = require('../plugin-contract');

// ═══════════════════════════════════════════════════════════════════════════════
// PHP Plugin Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PhpPlugin', () => {
  let plugin;

  beforeEach(() => {
    plugin = new PhpPlugin();
  });

  // ─── Identity ──────────────────────────────────────────────────────────────

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('php');
      expect(plugin.displayName).toBe('PHP');
    });

    test('has PHP extensions', () => {
      expect(plugin.extensions).toContain('.php');
      expect(plugin.extensions).toContain('.phtml');
      expect(plugin.extensions).toContain('.blade.php');
    });

    test('has PHP config files', () => {
      expect(plugin.configFiles).toContain('composer.json');
      expect(plugin.configFiles).toContain('artisan');
      expect(plugin.configFiles).toContain('symfony.lock');
    });

    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  // ─── Catalog ───────────────────────────────────────────────────────────────

  describe('catalog', () => {
    test('loads php.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('PHP');
    });

    test('errorCatalog has categories', () => {
      const ec = plugin.errorCatalog;
      expect(ec.categories).toBeTruthy();
      expect(ec.categories.length).toBeGreaterThan(0);
    });

    test('importSystem is available', () => {
      expect(plugin.importSystem).toBeTruthy();
    });

    test('typeTracing is available', () => {
      expect(plugin.typeTracing).toBeTruthy();
    });

    test('catalog has toolchains', () => {
      expect(plugin.catalog.metadata.toolchains).toBeTruthy();
      expect(plugin.catalog.metadata.toolchains.length).toBeGreaterThan(0);
      const names = plugin.catalog.metadata.toolchains.map(t => t.name);
      expect(names).toContain('php');
    });
  });

  // ─── Detection ─────────────────────────────────────────────────────────────

  describe('detect', () => {
    test('detects project with composer.json', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with artisan (Laravel)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .php files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'index.php'), '<?php echo "hello"; ?>');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .php in public/', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.mkdirSync(path.join(tmpDir, 'public'));
      fs.writeFileSync(path.join(tmpDir, 'public', 'index.php'), '<?php echo "hello"; ?>');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-PHP project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Strategy ──────────────────────────────────────────────────────────────

  describe('getStrategyOrder', () => {
    test('returns composer as only strategy', () => {
      expect(plugin.getStrategyOrder()).toEqual(['composer']);
    });
  });

  // ─── Environment ───────────────────────────────────────────────────────────

  describe('checkEnvironment', () => {
    test('returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{}');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('packageManager');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      expect(report).toHaveProperty('framework');
      expect(report).toHaveProperty('extensions');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects Laravel framework', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php\n');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report.framework).toBe('laravel');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects Symfony framework', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'symfony.lock'), '{}');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report.framework).toBe('symfony');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects vanilla framework', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'composer.json'), '{}');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report.framework).toBe('vanilla');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Scaffolding ───────────────────────────────────────────────────────────

  describe('scaffold', () => {
    test('scaffolds Laravel project', () => {
      const result = plugin.scaffold('myapp', { framework: 'laravel' });
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('composer create-project laravel/laravel');
      expect(result.scripts).toHaveProperty('start');
      expect(result.scripts.start).toContain('artisan serve');
      expect(result.scripts).toHaveProperty('test');
    });

    test('scaffolds Symfony project', () => {
      const result = plugin.scaffold('myapp', { framework: 'symfony' });
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('symfony/skeleton');
      expect(result.scripts).toHaveProperty('start');
    });

    test('scaffolds Vanilla PHP project', () => {
      const result = plugin.scaffold('myapp', { framework: 'vanilla' });
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.devDeps).toHaveProperty('phpunit/phpunit');
      expect(result.scripts.start).toContain('php -S');
    });
  });

  // ─── Build Commands ────────────────────────────────────────────────────────

  describe('build commands', () => {
    test('getSyntaxCheckCommand generates php -l commands', () => {
      const cmd = plugin.getSyntaxCheckCommand(['app.php', 'routes.php']);
      expect(cmd).toContain('php -l');
      expect(cmd).toContain('app.php');
    });

    test('getSyntaxCheckCommand returns null for empty files', () => {
      expect(plugin.getSyntaxCheckCommand([])).toBeNull();
      expect(plugin.getSyntaxCheckCommand(null)).toBeNull();
    });

    test('getBuildCommand returns null for vanilla PHP', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      expect(plugin.getBuildCommand(tmpDir)).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getBuildCommand returns artisan optimize for Laravel', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php\n');
      const cmd = plugin.getBuildCommand(tmpDir);
      expect(cmd).toContain('artisan optimize');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getRunCommand returns artisan serve for Laravel', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      fs.writeFileSync(path.join(tmpDir, 'artisan'), '#!/usr/bin/env php\n');
      const cmd = plugin.getRunCommand(tmpDir);
      expect(cmd).toContain('artisan serve');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getRunCommand returns built-in server for vanilla', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      const cmd = plugin.getRunCommand(tmpDir);
      expect(cmd).toContain('php -S');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getInstallCommand returns composer install', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-test-'));
      expect(plugin.getInstallCommand(tmpDir)).toBe('composer install');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Error Parsing ─────────────────────────────────────────────────────────

  describe('parseErrors', () => {
    test('parses PHP Fatal error', () => {
      const raw = 'PHP Fatal error: Uncaught Error: Call to undefined function foo() in /app/index.php on line 15';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].language).toBe('php');
      expect(errors[0].origin).toBe('runtime');
    });

    test('parses PHP Parse error', () => {
      const raw = "Parse error: syntax error, unexpected '}' in /app/routes.php on line 42";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].line).toBe(42);
    });

    test('parses Laravel Illuminate exception', () => {
      const raw = "Illuminate\\Database\\QueryException: SQLSTATE[42S02]: Base table or view not found";
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('LARAVEL_EXCEPTION');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });
  });

  // ─── Crash Patterns ────────────────────────────────────────────────────────

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });

    test('matches PHP Fatal error', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('PHP Fatal error: ...'))).toBe(true);
    });

    test('matches Parse error', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('Parse error: syntax error'))).toBe(true);
    });

    test('matches Segmentation fault', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('Segmentation fault'))).toBe(true);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  describe('getEdgeCases', () => {
    test('returns string edge cases with PHP-specific falsy "0"', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.label.includes('empty'))).toBe(true);
      expect(cases.some(c => c.value.includes("'0'"))).toBe(true);
    });

    test('returns int edge cases', () => {
      const cases = plugin.getEdgeCases('int');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.value === 'PHP_INT_MAX')).toBe(true);
    });

    test('returns array edge cases', () => {
      const cases = plugin.getEdgeCases('array');
      expect(cases.length).toBeGreaterThan(0);
    });

    test('returns bool edge cases', () => {
      const cases = plugin.getEdgeCases('bool');
      expect(cases.length).toBe(2);
    });

    test('returns null for nullable', () => {
      const cases = plugin.getEdgeCases('?int');
      expect(cases.some(c => c.value === 'null')).toBe(true);
    });

    test('returns default for unknown type', () => {
      const cases = plugin.getEdgeCases('SomeCustomType');
      expect(cases.length).toBeGreaterThan(0);
    });
  });

  // ─── Mocks ─────────────────────────────────────────────────────────────────

  describe('generateMocks', () => {
    test('generates DB mock for Eloquent', () => {
      const mocks = plugin.generateMocks([{ module: 'Eloquent' }]);
      expect(mocks[0].type).toBe('database');
    });

    test('generates HTTP mock for Guzzle', () => {
      const mocks = plugin.generateMocks([{ module: 'GuzzleHttp' }]);
      expect(mocks[0].type).toBe('http');
    });

    test('generates cache mock', () => {
      const mocks = plugin.generateMocks([{ module: 'Cache' }]);
      expect(mocks[0].type).toBe('cache');
    });

    test('generates email mock', () => {
      const mocks = plugin.generateMocks([{ module: 'Mail' }]);
      expect(mocks[0].type).toBe('email');
    });

    test('generates generic mock', () => {
      const mocks = plugin.generateMocks([{ module: 'SomeLib' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  // ─── Diagnostics ───────────────────────────────────────────────────────────

  describe('diagnostics', () => {
    test('buildSearchQuery includes PHP', () => {
      const query = plugin.buildSearchQuery({ code: 'PHP_ERROR', message: 'Call to undefined function foo()' });
      expect(query).toContain('PHP');
      expect(query).toContain('fix');
    });

    test('buildSearchQuery uses Laravel for Laravel errors', () => {
      const query = plugin.buildSearchQuery({ code: 'LARAVEL_EXCEPTION', message: 'Illuminate\\Database\\QueryException: SQLSTATE error' });
      expect(query).toContain('Laravel');
    });

    test('buildFixPrompt generates structured prompt', () => {
      const prompt = plugin.buildFixPrompt(
        { code: 'PHP_ERROR', message: 'Call to undefined function foo()', category: 'runtime', file: 'index.php', line: 10, column: 0 },
        { functionName: 'handle', codeSnippet: 'foo();' }
      );
      expect(prompt).toContain('PHP');
      expect(prompt).toContain('index.php');
      expect(prompt).toContain('Respond as JSON');
    });
  });

  // ─── Registry Integration ──────────────────────────────────────────────────

  describe('registry integration', () => {
    test('can be loaded by PluginRegistry', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      const count = registry.loadAll();
      expect(count).toBeGreaterThanOrEqual(1);
      const php = registry.get('php');
      expect(php).toBeTruthy();
      expect(php.id).toBe('php');
    });

    test('pluginForTech finds PHP', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('PHP')).toBeTruthy();
      expect(registry.pluginForTech('PHP')?.id).toBe('php');
    });

    test('pluginForTech finds Laravel as PHP', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('Laravel')?.id).toBe('php');
    });

    test('pluginForFile finds .php', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForFile('index.php')?.id).toBe('php');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// C# Plugin Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('CSharpPlugin', () => {
  let plugin;

  beforeEach(() => {
    plugin = new CSharpPlugin();
  });

  // ─── Identity ──────────────────────────────────────────────────────────────

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('csharp');
      expect(plugin.displayName).toBe('C#');
    });

    test('has C# extensions', () => {
      expect(plugin.extensions).toContain('.cs');
      expect(plugin.extensions).toContain('.csx');
      expect(plugin.extensions).toContain('.razor');
    });

    test('has C# config files', () => {
      expect(plugin.configFiles).toContain('*.csproj');
      expect(plugin.configFiles).toContain('*.sln');
      expect(plugin.configFiles).toContain('global.json');
    });

    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  // ─── Catalog ───────────────────────────────────────────────────────────────

  describe('catalog', () => {
    test('loads csharp.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('C# / .NET');
    });

    test('errorCatalog has categories', () => {
      const ec = plugin.errorCatalog;
      expect(ec.categories).toBeTruthy();
      expect(ec.categories.length).toBeGreaterThan(0);
    });

    test('importSystem is available', () => {
      expect(plugin.importSystem).toBeTruthy();
    });

    test('typeTracing is available', () => {
      expect(plugin.typeTracing).toBeTruthy();
    });

    test('catalog has toolchains', () => {
      expect(plugin.catalog.metadata.toolchains).toBeTruthy();
      expect(plugin.catalog.metadata.toolchains.length).toBeGreaterThan(0);
      const names = plugin.catalog.metadata.toolchains.map(t => t.name);
      expect(names).toContain('roslyn');
    });
  });

  // ─── Detection ─────────────────────────────────────────────────────────────

  describe('detect', () => {
    test('detects project with .csproj', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'MyApp.csproj'), '<Project></Project>');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .sln', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'MyApp.sln'), 'Microsoft Visual Studio Solution');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with global.json', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'global.json'), '{"sdk":{"version":"8.0.0"}}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .cs files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'Program.cs'), 'class Program {}');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with src/ layout', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.mkdirSync(path.join(tmpDir, 'src', 'MyApp'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'MyApp', 'MyApp.csproj'), '<Project></Project>');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-C# project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Strategy ──────────────────────────────────────────────────────────────

  describe('getStrategyOrder', () => {
    test('returns dotnet as only strategy', () => {
      expect(plugin.getStrategyOrder()).toEqual(['dotnet']);
    });
  });

  // ─── Environment ───────────────────────────────────────────────────────────

  describe('checkEnvironment', () => {
    test('returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'MyApp.csproj'), '<Project></Project>');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('packageManager');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      expect(report).toHaveProperty('projectType');
      expect(report).toHaveProperty('sdks');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Scaffolding ───────────────────────────────────────────────────────────

  describe('scaffold', () => {
    test('scaffolds Web API project', () => {
      const result = plugin.scaffold('myapp', { framework: 'webapi' });
      expect(result.postCreate.length).toBeGreaterThan(0);
      expect(result.postCreate[0]).toContain('dotnet new webapi');
      expect(result.scripts).toHaveProperty('start');
      expect(result.scripts.start).toBe('dotnet run');
    });

    test('scaffolds Console project', () => {
      const result = plugin.scaffold('myapp', { framework: 'console' });
      expect(result.postCreate[0]).toContain('dotnet new console');
      expect(result.scripts).toHaveProperty('start');
    });

    test('scaffolds Blazor project', () => {
      const result = plugin.scaffold('myapp', { framework: 'blazor' });
      expect(result.postCreate[0]).toContain('dotnet new blazor');
    });

    test('scaffolds MVC project', () => {
      const result = plugin.scaffold('myapp', { framework: 'mvc' });
      expect(result.postCreate[0]).toContain('dotnet new mvc');
    });

    test('scaffolds Class Library project', () => {
      const result = plugin.scaffold('myapp', { framework: 'classlib' });
      expect(result.postCreate[0]).toContain('dotnet new classlib');
      // classlib has no start script
      expect(result.scripts.start).toBeUndefined();
    });
  });

  // ─── Build Commands ────────────────────────────────────────────────────────

  describe('build commands', () => {
    test('getSyntaxCheckCommand returns dotnet build --no-restore', () => {
      const cmd = plugin.getSyntaxCheckCommand(['Program.cs']);
      expect(cmd).toBe('dotnet build --no-restore');
    });

    test('getBuildCommand returns dotnet build for .csproj project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      fs.writeFileSync(path.join(tmpDir, 'MyApp.csproj'), '<Project></Project>');
      const cmd = plugin.getBuildCommand(tmpDir);
      expect(cmd).toBe('dotnet build');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getBuildCommand returns null for empty directory', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      const cmd = plugin.getBuildCommand(tmpDir);
      expect(cmd).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getRunCommand returns dotnet run', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      expect(plugin.getRunCommand(tmpDir)).toBe('dotnet run');
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('getInstallCommand returns dotnet restore', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
      expect(plugin.getInstallCommand(tmpDir)).toBe('dotnet restore');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Error Parsing ─────────────────────────────────────────────────────────

  describe('parseErrors', () => {
    test('parses MSBuild errors', () => {
      const raw = 'Program.cs(10,5): error CS0103: The name \'foo\' does not exist in the current context';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toContain('Program.cs');
      expect(errors[0].line).toBe(10);
      expect(errors[0].column).toBe(5);
      expect(errors[0].language).toBe('csharp');
    });

    test('parses runtime exceptions', () => {
      const raw = 'Unhandled exception. System.NullReferenceException: Object reference not set to an instance of an object.';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('NullReferenceException');
    });

    test('parses NuGet errors', () => {
      const raw = 'error NU1101: Unable to find package Newtonsoft.Json. No packages exist with this id in source(s)';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('NU1101');
      expect(errors[0].category).toBe('dependency');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });
  });

  // ─── Crash Patterns ────────────────────────────────────────────────────────

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });

    test('matches Unhandled exception', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('Unhandled exception.'))).toBe(true);
    });

    test('matches System exceptions', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('System.NullReferenceException'))).toBe(true);
    });

    test('matches StackOverflowException', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.some(p => p.test('StackOverflowException'))).toBe(true);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  describe('getEdgeCases', () => {
    test('returns string edge cases with string.Empty', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.value === 'string.Empty')).toBe(true);
    });

    test('returns int edge cases', () => {
      const cases = plugin.getEdgeCases('int');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.value === 'int.MaxValue')).toBe(true);
      expect(cases.some(c => c.value === 'int.MinValue')).toBe(true);
    });

    test('returns bool edge cases', () => {
      const cases = plugin.getEdgeCases('bool');
      expect(cases.length).toBe(2);
    });

    test('returns list edge cases', () => {
      const cases = plugin.getEdgeCases('List<T>');
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.some(c => c.value === 'new List<T>()')).toBe(true);
    });

    test('returns nullable edge cases', () => {
      const cases = plugin.getEdgeCases('Nullable<int>');
      expect(cases.some(c => c.value === 'null')).toBe(true);
    });

    test('returns default for unknown type', () => {
      const cases = plugin.getEdgeCases('SomeCustomType');
      expect(cases.length).toBeGreaterThan(0);
    });
  });

  // ─── Mocks ─────────────────────────────────────────────────────────────────

  describe('generateMocks', () => {
    test('generates DB mock for DbContext', () => {
      const mocks = plugin.generateMocks([{ module: 'DbContext' }]);
      expect(mocks[0].type).toBe('database');
    });

    test('generates HTTP mock for HttpClient', () => {
      const mocks = plugin.generateMocks([{ module: 'HttpClient' }]);
      expect(mocks[0].type).toBe('http');
    });

    test('generates logging mock for ILogger', () => {
      const mocks = plugin.generateMocks([{ module: 'ILogger' }]);
      expect(mocks[0].type).toBe('logging');
    });

    test('generates config mock for IConfiguration', () => {
      const mocks = plugin.generateMocks([{ module: 'IConfiguration' }]);
      expect(mocks[0].type).toBe('config');
    });

    test('generates generic mock', () => {
      const mocks = plugin.generateMocks([{ module: 'SomeService' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  // ─── Diagnostics ───────────────────────────────────────────────────────────

  describe('diagnostics', () => {
    test('buildSearchQuery includes C#', () => {
      const query = plugin.buildSearchQuery({ code: 'CS0103', message: "The name 'foo' does not exist in the current context" });
      expect(query).toContain('C#');
      expect(query).toContain('CS0103');
      expect(query).toContain('fix');
    });

    test('buildSearchQuery uses ASP.NET for web errors', () => {
      const query = plugin.buildSearchQuery({ code: 'CS_ERROR', message: 'Microsoft.AspNetCore routing error' });
      expect(query).toContain('ASP.NET');
    });

    test('buildFixPrompt generates structured prompt', () => {
      const prompt = plugin.buildFixPrompt(
        { code: 'CS0103', message: "The name 'foo' does not exist", category: 'import', file: 'Program.cs', line: 10, column: 5 },
        { functionName: 'Main', codeSnippet: 'var x = foo();' }
      );
      expect(prompt).toContain('C#');
      expect(prompt).toContain('Program.cs');
      expect(prompt).toContain('Respond as JSON');
    });
  });

  // ─── Registry Integration ──────────────────────────────────────────────────

  describe('registry integration', () => {
    test('can be loaded by PluginRegistry', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      const count = registry.loadAll();
      expect(count).toBeGreaterThanOrEqual(1);
      const cs = registry.get('csharp');
      expect(cs).toBeTruthy();
      expect(cs.id).toBe('csharp');
    });

    test('pluginForTech finds C#', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('C#')).toBeTruthy();
      expect(registry.pluginForTech('C#')?.id).toBe('csharp');
    });

    test('pluginForTech finds .NET as C#', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('.NET')?.id).toBe('csharp');
    });

    test('pluginForTech finds ASP.NET as C#', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForTech('ASP.NET')?.id).toBe('csharp');
    });

    test('pluginForFile finds .cs', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForFile('Program.cs')?.id).toBe('csharp');
    });

    test('pluginForFile finds .razor', () => {
      const { PluginRegistry } = require('../index');
      const registry = new PluginRegistry();
      registry.loadAll();
      expect(registry.pluginForFile('Counter.razor')?.id).toBe('csharp');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Version Resolver Registry Integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('Version Resolver Registry Integration', () => {
  test('REGISTRIES includes packagist', () => {
    const { REGISTRIES } = require('../version-resolver');
    expect(REGISTRIES.packagist).toBeTruthy();
    expect(REGISTRIES.packagist.urlTemplate).toContain('packagist.org');
    expect(typeof REGISTRIES.packagist.extractVersion).toBe('function');
  });

  test('REGISTRIES includes nuget', () => {
    const { REGISTRIES } = require('../version-resolver');
    expect(REGISTRIES.nuget).toBeTruthy();
    expect(REGISTRIES.nuget.urlTemplate).toContain('nuget.org');
    expect(typeof REGISTRIES.nuget.extractVersion).toBe('function');
  });

  test('packagist extractVersion works', () => {
    const { REGISTRIES } = require('../version-resolver');
    const mockData = {
      package: {
        versions: {
          'v11.4.0': {},
          'v11.3.2': {},
          'dev-main': {},
        },
      },
    };
    const version = REGISTRIES.packagist.extractVersion(mockData);
    expect(version).toBe('11.4.0');
  });

  test('packagist extractVersion skips dev/alpha/beta/RC', () => {
    const { REGISTRIES } = require('../version-resolver');
    const mockData = {
      package: {
        versions: {
          'dev-main': {},
          'v2.0.0-beta.1': {},
          'v1.0.0': {},
        },
      },
    };
    const version = REGISTRIES.packagist.extractVersion(mockData);
    expect(version).toBe('1.0.0');
  });

  test('nuget extractVersion works', () => {
    const { REGISTRIES } = require('../version-resolver');
    const mockData = {
      versions: ['7.0.0', '8.0.0', '8.0.1'],
    };
    const version = REGISTRIES.nuget.extractVersion(mockData);
    expect(version).toBe('8.0.1');
  });

  test('nuget extractVersion handles empty', () => {
    const { REGISTRIES } = require('../version-resolver');
    expect(REGISTRIES.nuget.extractVersion({})).toBeNull();
    expect(REGISTRIES.nuget.extractVersion({ versions: [] })).toBeNull();
  });

  test('fallback versions.json has packagist entries', () => {
    const versions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'defaults', 'versions.json'), 'utf-8'));
    expect(versions['packagist:laravel/laravel']).toBeTruthy();
    expect(versions['packagist:symfony/skeleton']).toBeTruthy();
    expect(versions['packagist:phpunit/phpunit']).toBeTruthy();
  });

  test('fallback versions.json has nuget entries', () => {
    const versions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'defaults', 'versions.json'), 'utf-8'));
    expect(versions['nuget:Microsoft.AspNetCore.App']).toBeTruthy();
  });
});
