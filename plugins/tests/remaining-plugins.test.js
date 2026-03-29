'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { LanguagePlugin } = require('../plugin-contract');

const RustPlugin = require('../languages/rust');
const GoPlugin = require('../languages/go');
const JavaPlugin = require('../languages/java');
const CppPlugin = require('../languages/cpp');

// ═══════════════════════════════════════════════════════════════════════════════
// Rust Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('RustPlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new RustPlugin(); });

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('rust');
      expect(plugin.displayName).toBe('Rust');
    });
    test('has Rust extensions', () => {
      expect(plugin.extensions).toContain('.rs');
    });
    test('has Rust config files', () => {
      expect(plugin.configFiles).toContain('Cargo.toml');
    });
    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  describe('catalog', () => {
    test('loads rust.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('Rust');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories).toBeTruthy();
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with Cargo.toml', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-test-'));
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .rs files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-test-'));
      fs.writeFileSync(path.join(tmpDir, 'main.rs'), 'fn main() {}\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-Rust project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns cargo', () => {
      expect(plugin.getStrategyOrder()).toEqual(['cargo']);
    });
    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-test-'));
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\n');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('parseErrors', () => {
    test('parses rustc error with code', () => {
      const raw = `error[E0308]: mismatched types
 --> src/main.rs:5:14
  |
5 |     let x: i32 = "hello";
  |                   ^^^^^^^ expected \`i32\`, found \`&str\``;
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].language).toBe('rust');
      expect(errors[0].message).toMatch(/mismatched types/);
    });

    test('parses simple error without code', () => {
      const raw = `error: expected one of \`!\`, \`(\`
 --> src/main.rs:3:5`;
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });
    test('matches panic', () => {
      expect(plugin.getCrashPatterns().some(p => p.test("thread 'main' panicked at 'assertion failed'"))).toBe(true);
    });
  });

  describe('getEdgeCases', () => {
    test('Option type returns None/Some', () => {
      const cases = plugin.getEdgeCases('Option<T>');
      expect(cases.some(c => c.label === 'None')).toBe(true);
      expect(cases.some(c => c.label === 'Some')).toBe(true);
    });
    test('Result type returns Ok/Err', () => {
      const cases = plugin.getEdgeCases('Result<T,E>');
      expect(cases.some(c => c.label === 'Ok')).toBe(true);
      expect(cases.some(c => c.label === 'Err')).toBe(true);
    });
    test('&str returns empty string', () => {
      const cases = plugin.getEdgeCases('&str');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });
    test('i32 returns zero/-1', () => {
      const cases = plugin.getEdgeCases('i32');
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.label === 'negative')).toBe(true);
    });
    test('Vec returns vec![]', () => {
      const cases = plugin.getEdgeCases('Vec<T>');
      expect(cases.some(c => c.value === 'vec![]')).toBe(true);
    });
    test('unknown type returns default', () => {
      const cases = plugin.getEdgeCases('SomeCustomType');
      expect(cases.length).toBeGreaterThan(0);
    });
  });

  describe('generateMocks', () => {
    test('generates DB mock for sqlx', () => {
      const mocks = plugin.generateMocks([{ name: 'sqlx' }]);
      expect(mocks[0].type).toBe('database');
    });
    test('generates HTTP mock for reqwest', () => {
      const mocks = plugin.generateMocks([{ name: 'reqwest' }]);
      expect(mocks[0].type).toBe('http');
    });
    test('generates generic mock', () => {
      const mocks = plugin.generateMocks([{ name: 'unknown_crate' }]);
      expect(mocks[0].type).toBe('generic');
    });
  });

  describe('scaffold', () => {
    test('scaffolds actix-web project', () => {
      const result = plugin.scaffold('myapp', { framework: 'actix-web' });
      expect(result.deps).toHaveProperty('actix-web');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.scripts.start).toBe('cargo run');
    });
    test('scaffolds axum project', () => {
      const result = plugin.scaffold('myapp', { framework: 'axum' });
      expect(result.deps).toHaveProperty('axum');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Go Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('GoPlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new GoPlugin(); });

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('go');
      expect(plugin.displayName).toBe('Go');
    });
    test('has Go extensions', () => {
      expect(plugin.extensions).toContain('.go');
    });
    test('has Go config files', () => {
      expect(plugin.configFiles).toContain('go.mod');
    });
    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  describe('catalog', () => {
    test('loads go.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('Go');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories).toBeTruthy();
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with go.mod', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-test-'));
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .go files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-test-'));
      fs.writeFileSync(path.join(tmpDir, 'main.go'), 'package main\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-Go project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-test-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns go', () => {
      expect(plugin.getStrategyOrder()).toEqual(['go']);
    });
    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-test-'));
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\n');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('parseErrors', () => {
    test('parses Go build error', () => {
      const raw = './main.go:10:5: undefined: fmt.Printlnx';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toContain('main.go');
      expect(errors[0].line).toBe(10);
      expect(errors[0].language).toBe('go');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });
    test('matches panic', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('panic: runtime error: index out of range'))).toBe(true);
    });
    test('matches nil pointer dereference', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('runtime error: nil pointer dereference'))).toBe(true);
    });
  });

  describe('getEdgeCases', () => {
    test('pointer returns nil', () => {
      const cases = plugin.getEdgeCases('*T');
      expect(cases.some(c => c.label === 'nil')).toBe(true);
    });
    test('error returns nil/non-nil', () => {
      const cases = plugin.getEdgeCases('error');
      expect(cases.some(c => c.label === 'nil error')).toBe(true);
      expect(cases.some(c => c.label === 'non-nil error')).toBe(true);
    });
    test('string returns empty', () => {
      const cases = plugin.getEdgeCases('string');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });
    test('int returns zero/-1', () => {
      const cases = plugin.getEdgeCases('int');
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.label === 'negative')).toBe(true);
    });
    test('slice returns nil/empty', () => {
      const cases = plugin.getEdgeCases('[]T');
      expect(cases.some(c => c.label === 'nil slice')).toBe(true);
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });
  });

  describe('scaffold', () => {
    test('scaffolds Gin project', () => {
      const result = plugin.scaffold('myapp', { framework: 'gin' });
      expect(result.deps['github.com/gin-gonic/gin']).toBeTruthy();
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.scripts.start).toBe('go run main.go');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Java Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('JavaPlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new JavaPlugin(); });

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('java');
      expect(plugin.displayName).toBe('Java');
    });
    test('has Java/Kotlin extensions', () => {
      expect(plugin.extensions).toContain('.java');
      expect(plugin.extensions).toContain('.kt');
    });
    test('has Java config files', () => {
      expect(plugin.configFiles).toContain('pom.xml');
      expect(plugin.configFiles).toContain('build.gradle');
      expect(plugin.configFiles).toContain('build.gradle.kts');
    });
    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  describe('catalog', () => {
    test('loads java.json catalog', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      expect(cat.metadata).toBeTruthy();
      expect(cat.metadata.language).toBe('Java / Kotlin');
    });
    test('errorCatalog has categories', () => {
      expect(plugin.errorCatalog.categories).toBeTruthy();
      expect(plugin.errorCatalog.categories.length).toBeGreaterThan(0);
    });
  });

  describe('detect', () => {
    test('detects project with pom.xml', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-test-'));
      fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with build.gradle', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-test-'));
      fs.writeFileSync(path.join(tmpDir, 'build.gradle'), 'plugins {}\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .java files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-test-'));
      fs.writeFileSync(path.join(tmpDir, 'Main.java'), 'public class Main {}\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-Java project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-test-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns gradle then maven', () => {
      expect(plugin.getStrategyOrder()).toEqual(['gradle', 'maven']);
    });
    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-test-'));
      fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('parseErrors', () => {
    test('parses javac error', () => {
      const raw = 'Main.java:10: error: cannot find symbol\n    System.out.printlnx("hi");\n                ^';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toContain('Main.java');
      expect(errors[0].line).toBe(10);
      expect(errors[0].language).toBe('java');
    });

    test('parses runtime exception', () => {
      const raw = 'Exception in thread "main" java.lang.NullPointerException: Cannot invoke method\n\tat com.example.Main.run(Main.java:25)';
      const errors = plugin.parseErrors(raw, 'runtime');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].origin).toBe('runtime');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });
    test('matches NullPointerException', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('NullPointerException'))).toBe(true);
    });
    test('matches OutOfMemoryError', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('java.lang.OutOfMemoryError'))).toBe(true);
    });
    test('matches Exception in thread', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Exception in thread "main"'))).toBe(true);
    });
  });

  describe('getEdgeCases', () => {
    test('Optional returns empty/of', () => {
      const cases = plugin.getEdgeCases('Optional<String>');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
      expect(cases.some(c => c.label === 'of')).toBe(true);
    });
    test('String returns empty/null', () => {
      const cases = plugin.getEdgeCases('String');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
      expect(cases.some(c => c.label === 'null')).toBe(true);
    });
    test('int returns zero/MAX_VALUE', () => {
      const cases = plugin.getEdgeCases('int');
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.label === 'MAX_VALUE')).toBe(true);
    });
    test('List returns empty/null', () => {
      const cases = plugin.getEdgeCases('List<String>');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
      expect(cases.some(c => c.label === 'null')).toBe(true);
    });
  });

  describe('scaffold', () => {
    test('scaffolds Spring Boot project', () => {
      const result = plugin.scaffold('myapp', { framework: 'spring-boot' });
      expect(result.deps['org.springframework.boot:spring-boot-starter-web']).toBeTruthy();
      expect(result.files.length).toBeGreaterThan(0);
    });
    test('scaffolds with Maven', () => {
      const result = plugin.scaffold('myapp', { framework: 'spring-boot', buildTool: 'maven' });
      expect(result.scripts.start).toContain('mvn');
      expect(result.files.some(f => f.path === 'pom.xml')).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C/C++ Plugin
// ═══════════════════════════════════════════════════════════════════════════════

describe('CppPlugin', () => {
  let plugin;
  beforeEach(() => { plugin = new CppPlugin(); });

  describe('identity', () => {
    test('has correct id and display name', () => {
      expect(plugin.id).toBe('cpp');
      expect(plugin.displayName).toBe('C/C++');
    });
    test('has C/C++ extensions', () => {
      expect(plugin.extensions).toContain('.c');
      expect(plugin.extensions).toContain('.cpp');
      expect(plugin.extensions).toContain('.cc');
      expect(plugin.extensions).toContain('.h');
      expect(plugin.extensions).toContain('.hpp');
    });
    test('has C/C++ config files', () => {
      expect(plugin.configFiles).toContain('CMakeLists.txt');
      expect(plugin.configFiles).toContain('Makefile');
      expect(plugin.configFiles).toContain('meson.build');
    });
    test('extends LanguagePlugin', () => {
      expect(plugin).toBeInstanceOf(LanguagePlugin);
    });
  });

  describe('catalog', () => {
    test('loads catalog (may be empty fallback)', () => {
      const cat = plugin.catalog;
      expect(cat).toBeTruthy();
      // cpp.json may not exist, so we get fallback
      expect(cat.errorCatalog).toBeTruthy();
    });
  });

  describe('detect', () => {
    test('detects project with CMakeLists.txt', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'));
      fs.writeFileSync(path.join(tmpDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with Makefile', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'));
      fs.writeFileSync(path.join(tmpDir, 'Makefile'), 'all:\n\tg++ main.cpp\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .cpp files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'));
      fs.writeFileSync(path.join(tmpDir, 'main.cpp'), '#include <iostream>\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('detects project with .c files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'));
      fs.writeFileSync(path.join(tmpDir, 'main.c'), '#include <stdio.h>\n');
      expect(plugin.detect(tmpDir)).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    test('does not detect non-C++ project', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'));
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      expect(plugin.detect(tmpDir)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('environment', () => {
    test('getStrategyOrder returns cmake, make, ninja', () => {
      expect(plugin.getStrategyOrder()).toEqual(['cmake', 'make', 'ninja']);
    });
    test('checkEnvironment returns structured report', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-test-'));
      fs.writeFileSync(path.join(tmpDir, 'CMakeLists.txt'), 'project(test)\n');
      const report = plugin.checkEnvironment(tmpDir);
      expect(report).toHaveProperty('ready');
      expect(report).toHaveProperty('runtime');
      expect(report).toHaveProperty('missing');
      expect(report).toHaveProperty('warnings');
      expect(report).toHaveProperty('strategy');
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('parseErrors', () => {
    test('parses gcc/clang error', () => {
      const raw = 'main.cpp:10:5: error: expected expression before \'}\' token';
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toContain('main.cpp');
      expect(errors[0].line).toBe(10);
      expect(errors[0].column).toBe(5);
      expect(errors[0].language).toBe('cpp');
    });

    test('parses linker error', () => {
      const raw = "main.o: In function `main':\nmain.cpp:(.text+0x15): undefined reference to `foo()'";
      const errors = plugin.parseErrors(raw, 'compiler');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].category).toBe('linker');
    });

    test('returns empty for no errors', () => {
      expect(plugin.parseErrors('', 'compiler')).toEqual([]);
      expect(plugin.parseErrors(null, 'compiler')).toEqual([]);
    });
  });

  describe('getCrashPatterns', () => {
    test('returns regex patterns', () => {
      const patterns = plugin.getCrashPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toBeInstanceOf(RegExp);
    });
    test('matches Segmentation fault', () => {
      expect(plugin.getCrashPatterns().some(p => p.test('Segmentation fault (core dumped)'))).toBe(true);
    });
  });

  describe('getEdgeCases', () => {
    test('int returns zero/INT_MAX', () => {
      const cases = plugin.getEdgeCases('int');
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.label === 'INT_MAX')).toBe(true);
    });
    test('char* returns NULL/empty', () => {
      const cases = plugin.getEdgeCases('char*');
      expect(cases.some(c => c.label === 'NULL')).toBe(true);
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });
    test('size_t returns zero/SIZE_MAX', () => {
      const cases = plugin.getEdgeCases('size_t');
      expect(cases.some(c => c.label === 'zero')).toBe(true);
      expect(cases.some(c => c.label === 'SIZE_MAX')).toBe(true);
    });
    test('pointer returns nullptr', () => {
      const cases = plugin.getEdgeCases('int*');
      expect(cases.some(c => c.value === 'nullptr')).toBe(true);
    });
    test('vector returns empty', () => {
      const cases = plugin.getEdgeCases('vector<int>');
      expect(cases.some(c => c.label === 'empty')).toBe(true);
    });
  });

  describe('scaffold', () => {
    test('scaffolds CMake project', () => {
      const result = plugin.scaffold('myapp');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files.some(f => f.path === 'CMakeLists.txt')).toBe(true);
      expect(result.files.some(f => f.path === 'src/main.cpp')).toBe(true);
      expect(result.scripts.build).toContain('cmake');
      expect(result.postCreate.length).toBeGreaterThan(0);
    });
  });

  describe('getLatestVersions', () => {
    test('returns empty frameworks (no central registry)', async () => {
      const versions = await plugin.getLatestVersions();
      expect(versions.frameworks).toEqual({});
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Registry Integration (all 4 plugins)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Registry integration (all 4 plugins)', () => {
  const { PluginRegistry } = require('../index');
  let registry;

  beforeAll(() => {
    registry = new PluginRegistry();
    registry.loadAll();
  });

  test('loadAll finds at least 6 plugins (python, typescript, rust, go, java, cpp)', () => {
    expect(registry.getAll().length).toBeGreaterThanOrEqual(6);
  });

  test('get() finds each plugin by id', () => {
    expect(registry.get('rust')).toBeTruthy();
    expect(registry.get('go')).toBeTruthy();
    expect(registry.get('java')).toBeTruthy();
    expect(registry.get('cpp')).toBeTruthy();
  });

  test('pluginForTech maps correctly', () => {
    expect(registry.pluginForTech('Rust')?.id).toBe('rust');
    expect(registry.pluginForTech('Go')?.id).toBe('go');
    expect(registry.pluginForTech('Java')?.id).toBe('java');
    expect(registry.pluginForTech('Java/Maven')?.id).toBe('java');
    expect(registry.pluginForTech('Java/Gradle')?.id).toBe('java');
    expect(registry.pluginForTech('C/C++')?.id).toBe('cpp');
    expect(registry.pluginForTech('C++')?.id).toBe('cpp');
    expect(registry.pluginForTech('C')?.id).toBe('cpp');
  });

  test('pluginForFile maps extensions correctly', () => {
    expect(registry.pluginForFile('main.rs')?.id).toBe('rust');
    expect(registry.pluginForFile('main.go')?.id).toBe('go');
    expect(registry.pluginForFile('Main.java')?.id).toBe('java');
    expect(registry.pluginForFile('Main.kt')?.id).toBe('java');
    expect(registry.pluginForFile('main.cpp')?.id).toBe('cpp');
    expect(registry.pluginForFile('main.c')?.id).toBe('cpp');
    expect(registry.pluginForFile('header.h')?.id).toBe('cpp');
    expect(registry.pluginForFile('header.hpp')?.id).toBe('cpp');
  });

  test('detectLanguages finds Rust project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\n');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'rust')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('detectLanguages finds Go project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\n');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'go')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('detectLanguages finds Java project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>\n');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'java')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('detectLanguages finds C++ project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    fs.writeFileSync(path.join(tmpDir, 'CMakeLists.txt'), 'project(test)\n');
    const detected = registry.detectLanguages(tmpDir);
    expect(detected.some(p => p.id === 'cpp')).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
