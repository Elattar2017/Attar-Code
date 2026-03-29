# Language Plugin Generator — Master Prompt

Use this prompt with a capable LLM (Claude Opus, GPT-4, Qwen 72B+) to generate the language plugin JSON for each technology. Replace `{{LANGUAGE}}` and `{{LANGUAGE_CONFIG}}` before sending.

---

## The Prompt

```
You are an expert compiler engineer with 20 years of experience in {{LANGUAGE}}. You are building a COMPLETE, MACHINE-READABLE JSON knowledge base for a CLI tool that:

1. Parses build/compiler errors from raw output
2. Classifies each error as local (fixable in the same file) or cross-file (root cause in another file)
3. Traces symbol dependencies through imports, exports, inheritance, and composition
4. Determines fix ordering when multiple files have errors

This JSON is consumed by a JavaScript engine that evaluates every field mechanically. Every regex must be valid JavaScript. Every field must be precise. Do NOT truncate, summarize, or use "..." placeholders.

{{LANGUAGE_CONFIG}}

Produce a single valid JSON object with ALL of the following sections:

---

### Section 1: "metadata"

```json
{
  "metadata": {
    "language": "Human-readable language name",
    "version": "1.0.0",
    "description": "One-line description of what this plugin covers",
    "toolchains": [
      {
        "name": "compiler/tool name",
        "errorPrefix": "Error code prefix (e.g., 'TS' for TypeScript, 'E' for Rust, null if message-based)",
        "errorFormat": "JavaScript regex that matches ONE full error line from this tool's output. MUST have named captures.",
        "errorFormatCaptures": ["file", "line", "column", "code", "message"],
        "outputStream": "stdout or stderr — which stream errors appear on",
        "supportsJsonOutput": true/false,
        "jsonOutputFlag": "--flag for JSON output, or null"
      }
    ],
    "fileExtensions": [".ext1", ".ext2"],
    "generatedBy": "plugin-generator-v1",
    "generatedFor": "attar-code-smart-fix"
  }
}
```

Requirements:
- errorFormat regex MUST match the EXACT output format of the tool. Test mentally against 5 real error lines.
- Include ALL toolchains (compiler, linter, type checker, bundler) that produce errors for this language.
- errorFormatCaptures lists the named groups in order. Every group must exist in the regex.

---

### Section 2: "errorCatalog"

Group ALL error codes/messages into categories. Each error entry has TWO parts:

**Part A — Dependency Analysis** (used by the fix-ordering engine to classify errors as local vs cross-file and compute fix order):

**Part B — Prescription** (used by the LLM to understand and fix the error — includes human-readable root cause, step-by-step fix instructions, and code examples):

```json
{
  "code": "Error code (e.g., 'TS2339') or unique ID for message-based errors (e.g., 'GO_UNDEFINED')",
  "category": "Category ID this error belongs to (e.g., 'syntax', 'module_resolution', 'type_errors')",
  "severity": "error | warning",
  "messagePattern": "JavaScript regex with named captures that matches the error MESSAGE portion (not the full line)",
  "match": "JavaScript regex that matches the FULL error line including error code prefix (e.g., 'TS2339:.*Property...'). Used by the legacy pattern matcher. Can reuse messagePattern if the full-line format is just 'CODE: message'.",
  "captures": [
    { "name": "capture_name", "role": "One of: target_module, property_name, type_name, symbol_name, expected_type, actual_type, literal_value, file_path, package_name" }
  ],

  "__comment_part_a": "=== DEPENDENCY ANALYSIS (fix ordering engine) ===",
  "baseCrossFileProbability": 0.0 to 1.0,
  "confidence": "known (well-understood) or heuristic (best-guess)",
  "refinements": [
    {
      "check": { "type": "check_type", "target": "capture_name_to_check" },
      "adjustedProbability": 0.0 to 1.0,
      "traceDepth": "none | direct | transitive",
      "traceTarget": "same_file | imported_file | re_export_origin | inherited_parent | external_package | composed_type"
    }
  ],
  "fixHint": {
    "primaryStrategy": "strategy_name",
    "requiresCrossFileEdit": true/false,
    "typicalScope": "single_line | file_header | type_definition | function_body | entire_file"
  },
  "coOccurrence": [
    {
      "code": "related error code",
      "relationship": "caused_by_this | causes_this | same_root_cause | always_together | sometimes_together",
      "sharedCapture": "which capture value links them (or null)",
      "resolution": "fix_this_first | fix_other_first | fix_either | auto_resolves_when_other_fixed"
    }
  ],

  "__comment_part_b": "=== PRESCRIPTION (LLM fix guidance) ===",
  "rootCause": "Human-readable explanation of WHY this error happens. Use {capture_name} placeholders to reference captured values. Example: \"Property '{propertyName}' does not exist on type '{typeName}'. The type definition is missing this property.\"",
  "prescription": "Step-by-step instructions for HOW TO FIX this error. Use {capture_name} placeholders. Be specific and actionable. Example: \"Add '{propertyName}' to the '{typeName}' interface definition, or check for typos in the property name.\"",
  "codeBlock": "A code example showing the fix. Use {capture_name} placeholders. Show BEFORE (wrong) and AFTER (correct) when possible. Set to null if a generic code example is not helpful.",
  "conditions": [
    {
      "when": "DSL condition: 'capture_name contains|startsWith|equals|endsWith value'",
      "rootCause": "Override rootCause when this condition matches. Use {capture_name} placeholders.",
      "prescription": "Override prescription when this condition matches.",
      "codeBlock": "Override code example when this condition matches, or null."
    }
  ]
}
```

CRITICAL RULES for errorCatalog:
- Include EVERY error code the compiler can emit. For TypeScript, that is 500+ codes. For Rust, 400+ E-codes. Do NOT skip any.
- EVERY entry MUST have BOTH Part A (dependency analysis) AND Part B (prescription). An entry without rootCause/prescription is INCOMPLETE.
- baseCrossFileProbability calibration:
  - 0.0 = ALWAYS local (syntax errors, missing semicolons)
  - 0.1-0.3 = usually local (logic errors, wrong return type in same function)
  - 0.4-0.6 = could go either way (type mismatches that depend on where the type is defined)
  - 0.7-0.9 = usually cross-file (property not found on imported type, wrong import path)
  - 1.0 = ALWAYS cross-file (module not found, package not installed)
- rootCause/prescription MUST be specific and actionable, not generic. "{propertyName} does not exist on {typeName}" is better than "a property is missing."
- conditions array is OPTIONAL but strongly encouraged for errors with common specific triggers (e.g., TS2307 with "node_modules" in the path = missing package; TS2307 with relative path = wrong file path). Use the DSL: "capture_name contains|startsWith|equals|endsWith value".
- codeBlock should show BEFORE/AFTER when possible. Use null only when no generic example applies.
- The `match` field is the FULL error line regex (used by the legacy pattern matcher). Format: "ERROR_CODE:.*actual_message_pattern". For TS errors: "TS1005:.*'([^']+)'\\s+expected".
- For languages WITHOUT numeric error codes (Go, Swift, Java), create descriptive IDs like "GO_UNDEFINED", "JAVA_CANNOT_FIND_SYMBOL", "SWIFT_TYPE_MISMATCH"
- coOccurrence is critical for cascading errors. A syntax error in file A causes "cannot find module" in files B, C, D. Document these chains.
- Every messagePattern must handle the EXACT wording the compiler uses, including variations across versions

Valid check types for refinements:
  is_imported, is_local, is_external, is_re_exported, is_composed_type, is_generic_param, exists_in_file, symbol_was_deleted, is_default_export, is_namespace_import, is_type_only_import, comes_from_package, is_inherited, is_interface_member, is_overridden

Valid fix strategies:
  add_import, remove_import, update_import_path, update_type_annotation, add_property, remove_property, change_signature, add_type_assertion, fix_syntax, add_missing_return, initialize_variable, add_null_check, update_export, add_export, rename_symbol, install_package, update_package, add_declaration, remove_duplicate, fix_access_modifier, add_override, implement_interface, fix_generic_constraint, wrap_async, add_await, cast_type, fix_enum_value, add_semicolon, close_bracket, fix_indentation, restructure_code, update_config

Valid coOccurrence relationships:
  caused_by_this, causes_this, same_root_cause, always_together, sometimes_together

Valid coOccurrence resolutions:
  fix_this_first, fix_other_first, fix_either, auto_resolves_when_other_fixed

---

### Section 3: "importSystem"

Document EVERY way code can import and export in this language.

```json
{
  "importPatterns": [
    {
      "type": "descriptive_name (e.g., named, default, namespace, side_effect, dynamic, type_only)",
      "regex": "JavaScript regex with named captures",
      "captures": [
        { "name": "capture_name", "index": 1, "isList": true/false, "listSeparator": "," }
      ],
      "example": "One real code example showing this pattern",
      "isMultiLine": true/false,
      "multiLineRegex": "Alternative regex with [\\s\\S] for multi-line matching (required if isMultiLine is true)"
    }
  ],
  "exportPatterns": [
    {
      "type": "descriptive_name",
      "regex": "JavaScript regex with named captures",
      "captures": [...],
      "isReExport": true/false,
      "example": "One real code example"
    }
  ],
  "moduleResolution": {
    "strategy": "node | go | rust | python | java",
    "extensions": [".ts", ".js", ...],
    "indexFiles": ["index.ts", "index.js", ...],
    "aliasConfig": {
      "file": "config file name (e.g., tsconfig.json)",
      "path": "JSON path to alias definitions (e.g., compilerOptions.paths)",
      "format": "How to interpret the alias definitions"
    },
    "packageEntryPoints": ["types", "main", "module", "exports"],
    "relativeImportRules": "How relative imports are resolved",
    "absoluteImportRules": "How non-relative imports are resolved"
  }
}
```

CRITICAL: For each import pattern, provide BOTH a single-line regex AND a multi-line regex if the pattern can span lines. Most real imports span multiple lines in production code.

---

### Section 4: "typeTracing"

```json
{
  "definitionPatterns": [
    {
      "kind": "interface | class | type_alias | function | variable | enum | struct | trait | protocol",
      "regex": "JavaScript regex with named capture for the symbol name",
      "captures": [{ "name": "name", "index": 1 }],
      "canBeExported": true/false,
      "example": "One real code example"
    }
  ],
  "inheritancePatterns": [
    {
      "kind": "extends | implements | interface_extends | trait_impl | protocol_conformance | embedding",
      "regex": "JavaScript regex capturing child and parent(s)",
      "captures": [
        { "name": "child", "index": 1, "isList": false },
        { "name": "parents", "index": 2, "isList": true, "listSeparator": "," }
      ],
      "traceConfidence": 0.0 to 1.0,
      "example": "One real code example"
    }
  ],
  "compositionPatterns": [
    {
      "kind": "intersection | union | generic_instantiation | mixin | embedding",
      "regex": "JavaScript regex",
      "captures": [...],
      "decomposable": true/false,
      "traceConfidence": 0.0 to 1.0,
      "example": "One real code example"
    }
  ],
  "confidenceTiers": {
    "direct_import": 0.95,
    "re_export_one_hop": 0.85,
    "re_export_multi_hop": 0.70,
    "inheritance_direct": 0.90,
    "inheritance_chain": 0.75,
    "generic_resolution": 0.50,
    "inferred_type": 0.30,
    "dynamic_type": 0.15
  }
}
```

---

### Section 5: "externalDependencies"

```json
{
  "pathIndicators": ["directories that indicate external packages (e.g., node_modules/, vendor/, site-packages/)"],
  "packageManifest": "package.json / Cargo.toml / go.mod / requirements.txt / etc.",
  "lockFile": "package-lock.json / Cargo.lock / go.sum / etc.",
  "typesPackagePattern": "@types/* (TypeScript) or null for other languages",
  "typeDeclarationLocations": [
    {
      "description": "Where to find type declarations for external packages",
      "path": "e.g., node_modules/{package}/index.d.ts",
      "fallback": "e.g., node_modules/@types/{package}/index.d.ts",
      "entryPointField": "e.g., package.json → types field"
    }
  ],
  "detectionRules": [
    {
      "signal": "descriptive name",
      "condition": "When this applies",
      "errorCodes": ["which error codes this triggers"],
      "suggestedActions": ["human-readable fix steps"],
      "autoFixable": true/false,
      "autoFixCommand": "command to run (or null)"
    }
  ],
  "commonBreakingPatterns": [
    {
      "description": "Pattern that commonly causes errors with external packages",
      "errorCodes": ["affected error codes"],
      "resolution": "How to resolve"
    }
  ]
}
```

---

### Section 6: "quirks"

Language-specific gotchas that affect dependency tracing:

```json
{
  "quirks": [
    {
      "id": "unique_id",
      "name": "Human-readable name",
      "description": "What this quirk is and why it matters for dependency tracing",
      "affectsTracing": true/false,
      "affectsResolution": true/false,
      "workaround": "How to handle this quirk programmatically",
      "example": "Code example showing the quirk",
      "relatedErrorCodes": ["error codes this quirk can cause"]
    }
  ]
}
```

Include AT LEAST:
- Barrel file / re-export patterns
- Path alias / module mapping patterns
- Circular dependency patterns
- Dynamic import / lazy loading patterns
- Conditional compilation / feature flags (if applicable)
- Auto-generated code patterns
- Module augmentation / declaration merging (if applicable)

---

### Section 7: "buildTools"

```json
{
  "buildTools": [
    {
      "name": "tool name",
      "detectFiles": ["files that indicate this tool is used"],
      "buildCommand": "command to run a type-check/compile without emitting (e.g., npx tsc --noEmit 2>&1)",
      "watchCommand": "watch mode command (or null)",
      "errorStream": "stdout or stderr",
      "supportsJsonOutput": true/false,
      "jsonOutputFlag": "flag or null",
      "commonConfigs": ["config files for this tool"]
    }
  ]
}
```

---

FINAL RULES:
1. Output raw JSON only. No markdown. No explanations. No comments.
2. Every regex must be valid JavaScript with proper JSON string escaping (double-escape backslashes).
3. Do NOT use "..." or placeholders. Every array must be complete.
4. The errorCatalog MUST be exhaustive — include EVERY error code. This is the most important section.
5. Test each regex mentally against 3 real examples before including it.
6. For message-based languages (Go, Java, Swift), create at least 50 error entries covering all common compiler messages.
7. Cross-file probability values must be calibrated against real-world frequency, not theoretical possibility.
8. coOccurrence chains must include cascading patterns: syntax error → module not found → symbol not found.
9. EVERY error entry MUST have BOTH dependency analysis fields (baseCrossFileProbability, refinements, fixHint, coOccurrence) AND prescription fields (rootCause, prescription, codeBlock). An entry missing either half is INCOMPLETE and will be rejected.
10. The `match` field must match the FULL error output line (with error code prefix), while `messagePattern` matches just the message. Both are required.
11. Use {capture_name} template placeholders in rootCause, prescription, and codeBlock. These are interpolated at runtime with the actual captured values from the error message.
12. The `conditions` array provides specialized prescriptions for common sub-cases. For example, TS2307 with a relative path has a different rootCause than TS2307 with a package name. Include conditions for the top 3-5 most common sub-cases of each error.
```

---

## Language Config Blocks

### TypeScript / JavaScript
```
Language: TypeScript / JavaScript
Primary compiler: tsc (TypeScript Compiler)
Error code format: TS#### where:
  - TS1xxx = syntax/parse errors (TS1005, TS1128, TS1109, TS1003, etc.)
  - TS2xxx = semantic/type errors (TS2304, TS2307, TS2322, TS2339, TS2345, TS2351, TS2365, TS2395, etc.)
  - TS4xxx = declaration emit errors
  - TS5xxx = compiler option errors
  - TS6xxx = informational messages
  - TS7xxx = noImplicitAny related
  - TS18xxx = newer errors (TS18004, etc.)
There are 500+ error codes total. Include ALL of them.

Additional toolchains: ESLint (rule-based, format: "rule-name"), Vite/Webpack (bundler errors)

Error output format: "file(line,column): error TSxxxx: message"
Example: "src/api.ts(12,5): error TS2339: Property 'phone' does not exist on type 'User'"

Module systems:
  - ES modules: import/export with named, default, namespace, type-only, side-effect, dynamic
  - CommonJS: require(), module.exports, exports.x
  - Dynamic: import() returns Promise
  - Re-exports: export { x } from './y', export * from './y', export * as ns from './y'
  - Type-only: import type { X } from './y', export type { X }

Type system complexity:
  - Interfaces (with extends, index signatures, call signatures, generics)
  - Type aliases (intersection &, union |, conditional extends ? :, mapped types, template literals)
  - Classes (extends, implements, abstract, static, private/protected/public, decorators)
  - Enums (numeric, string, const)
  - Generics with constraints (extends), defaults, variance annotations (in/out)
  - Declaration merging (interface + interface, namespace + class, namespace + function)
  - Module augmentation (declare module 'x' { })
  - satisfies operator, const assertions (as const)

Resolution:
  - tsconfig.json: paths, baseUrl, rootDirs, moduleResolution (node, node16, bundler, nodenext)
  - .d.ts files for type declarations
  - @types/* packages from DefinitelyTyped
  - package.json exports field, types field, typings field

Common cascading patterns:
  - Syntax error in types.ts → TS2307 in every file importing types.ts → TS2304 for every symbol from types.ts
  - Missing export → TS2305 at import site → TS2304 for the symbol → TS2339 for properties of that symbol
  - Wrong type definition → TS2322 at assignment → TS2345 at function call → TS2339 for property access
  - Deleted file → TS2307 everywhere it was imported → cascade of TS2304/TS2339
  - Renamed export → TS2305 "has no exported member" in all importers

Quirks to document:
  - Barrel files (index.ts re-exporting from sub-modules)
  - Path aliases (@/* from tsconfig paths)
  - Circular imports (A imports B, B imports A — causes TS2454 "used before assigned")
  - Declaration merging across files
  - Module augmentation (extending Express Request, etc.)
  - Side-effect imports (import './polyfill')
  - Dynamic imports (import('./module'))
  - Ambient modules (declare module '*.css')
  - Triple-slash references (/// <reference path="..." />)
```

### Python
```
Language: Python 3.8+
Primary toolchains:
  - Python interpreter (runtime errors as tracebacks)
  - mypy (static type checker, format: "file:line: error: message [error-code]")
  - pylint (linter, format: "file:line:column: C####: message (symbol)")
  - ruff (fast linter, format similar to pylint)
  - pyright (type checker, format: "file:line:column - error: message (reportXxx)")

Runtime error format: Multi-line traceback ending with "ErrorType: message"
mypy error format: "file.py:10: error: Incompatible types in assignment [assignment]"

Import system:
  - import module
  - from module import name1, name2
  - from module import name as alias
  - from . import module (relative)
  - from .module import name (relative)
  - from ..module import name (parent relative)
  - import module as alias
  - Dynamic: importlib.import_module('name')
  - Conditional: if TYPE_CHECKING: import ...
  - __all__ list controls star exports
  - __init__.py as package marker and barrel file

Type system:
  - Type hints (PEP 484): int, str, List[int], Optional[str], Union[int, str]
  - Protocols (PEP 544): structural subtyping
  - TypeVar, Generic, ParamSpec
  - dataclasses, Pydantic models, attrs
  - TYPE_CHECKING guard for import-only types
  - overload decorator
  - Literal types, TypedDict, NamedTuple

Resolution:
  - sys.path based
  - PYTHONPATH environment variable
  - pyproject.toml, setup.cfg, setup.py
  - requirements.txt, Pipfile, poetry.lock
  - Virtual environments (venv, conda)
  - Namespace packages (no __init__.py)

Common cascading patterns:
  - ImportError in base module → NameError in all importing modules
  - TypeError in shared utility → cascading TypeErrors in callers
  - Missing __init__.py → ModuleNotFoundError across package
  - Circular import → ImportError or NameError at runtime

Quirks:
  - Circular imports extremely common (restructure with TYPE_CHECKING guard)
  - __init__.py as barrel file with from .submodule import *
  - Dynamic attributes (setattr, __getattr__) make static tracing unreliable
  - Monkey patching external modules
  - Relative import resolution depends on package structure
  - Implicit namespace packages (PEP 420)
```

### Rust
```
Language: Rust
Compiler: rustc via cargo
Error code format: E#### (E0308, E0382, E0433, E0499, E0502, E0599, etc.) — 400+ codes
Additional: clippy (lint warnings with clippy:: prefix)

Error output format: "error[E0308]: mismatched types\n --> file.rs:10:5"
Cargo format: "error[E####]: message\n  --> file:line:column"

Module system:
  - mod module_name; (file-based)
  - use crate::path::to::item;
  - use super::item;
  - use self::item;
  - pub use path::to::item; (re-export)
  - use path::{item1, item2}; (grouped)
  - use path::*; (glob)
  - extern crate name; (legacy)
  - pub(crate), pub(super), pub(in path) visibility

Type system:
  - Structs (named fields, tuple structs, unit structs)
  - Enums (with data variants)
  - Traits (with associated types, default impls, supertraits)
  - impl blocks (inherent + trait impls, can be in different files)
  - Generics with trait bounds (where clauses)
  - Lifetimes ('a, 'static, elision rules)
  - Type aliases
  - const generics

Unique errors:
  - Ownership/borrowing (E0382 use of moved value, E0499 mutable borrow, E0502 immutable while mutable)
  - Lifetime errors (E0106 missing lifetime, E0621 lifetime mismatch)
  - Trait errors (E0277 trait not implemented, E0599 method not found)

Resolution:
  - Cargo.toml for dependencies
  - Cargo workspaces for monorepos
  - Feature flags (conditional compilation)
  - build.rs for code generation
  - mod.rs or filename-based module tree

Quirks:
  - Trait impls can be in a completely different file from the struct
  - Orphan rule (can only impl foreign trait for local type)
  - Macro expansion can obscure real error location
  - Feature flags change available APIs
  - Auto-traits (Send, Sync) are implicit
  - Deref coercions make type tracing complex
```

### Go
```
Language: Go 1.21+
Compiler: go build, go vet
Error format: NO error codes. Message-based only.
Format: "file.go:line:column: message"

Additional: golangci-lint, staticcheck (SA####, S####)

Create descriptive IDs for each error pattern:
  GO_UNDEFINED ("undefined: symbolName")
  GO_UNUSED_IMPORT ("imported and not used: \"package\"")
  GO_UNUSED_VAR ("variableName declared and not used")
  GO_TYPE_MISMATCH ("cannot use X (type T1) as type T2")
  GO_MISSING_RETURN ("missing return at end of function")
  GO_PACKAGE_NOT_FOUND ("package package/path is not in std")
  etc. — create at least 50 entries

Import system:
  - import "path/to/package"
  - import alias "path/to/package"
  - import . "path/to/package" (dot import)
  - import _ "path/to/package" (blank import for side effects)
  - Grouped: import ( "pkg1"\n "pkg2" )

Type system:
  - Structs with exported (Capitalized) and unexported fields
  - Interfaces (implicit satisfaction — no "implements" keyword)
  - Embedding (struct in struct, interface in interface)
  - Generics with type constraints (Go 1.18+)
  - Type aliases and defined types

Resolution:
  - go.mod for module path and dependencies
  - go.sum for checksums
  - replace directives for local development
  - Go workspaces (go.work)
  - GOPATH (legacy)
  - Exported = Capitalized first letter

Quirks:
  - Implicit interface satisfaction (no implements keyword, tracing must check method sets)
  - Exported vs unexported is case-based, not keyword-based
  - init() functions run automatically, cannot be traced as dependencies
  - Circular imports are compile errors (not runtime like Python)
  - Internal packages (internal/ directory restricts import visibility)
  - Go generate directives
  - Build tags for conditional compilation
```

### Java / Kotlin
```
Language: Java 17+ / Kotlin 1.9+
Compilers: javac, kotlinc
Error format: NO standard codes. Message-based.
javac format: "file.java:10: error: message"
kotlinc format: "e: file.kt:10:5: message"

Additional: Gradle (build errors), Maven (build errors), IntelliJ inspections

Create descriptive IDs:
  JAVA_CANNOT_FIND_SYMBOL ("cannot find symbol\n  symbol: class/method/variable X")
  JAVA_INCOMPATIBLE_TYPES ("incompatible types: T1 cannot be converted to T2")
  JAVA_PACKAGE_NOT_EXIST ("package x.y.z does not exist")
  KOTLIN_UNRESOLVED_REFERENCE ("Unresolved reference: X")
  KOTLIN_TYPE_MISMATCH ("Type mismatch: inferred type is T1 but T2 was expected")
  etc. — create at least 60 entries across Java and Kotlin

Import system:
  - import package.Class;
  - import package.*;
  - import static package.Class.method;
  - import static package.Class.*;
  - Kotlin: import package.Class
  - Kotlin: import package.Class as Alias
  - Kotlin: import package.* (star import)

Type system:
  - Classes (extends, implements, abstract, sealed)
  - Interfaces (default methods, static methods)
  - Generics with bounds (extends, super, wildcards ? extends T)
  - Annotations and annotation processing
  - Kotlin: data classes, sealed classes, object, companion object
  - Kotlin: extension functions, delegated properties
  - Kotlin: null safety (?, !!, ?.let)
  - Java records (Java 16+)
  - Java sealed interfaces (Java 17+)

Resolution:
  - Maven: pom.xml
  - Gradle: build.gradle, build.gradle.kts
  - Multi-module projects
  - Classpath dependencies
  - Kotlin multiplatform

Quirks:
  - Annotation processing generates code at compile time
  - Spring Boot auto-configuration creates invisible dependencies
  - Kotlin/Java interop (platform types, SAM conversions)
  - Gradle multi-module with api vs implementation dependency scope
  - Source sets (main, test, integration)
```

### PHP
```
Language: PHP 8.1+
Toolchains:
  - PHP interpreter (runtime errors)
  - PHPStan (levels 0-9, format: "Line X: message in file.php")
  - Psalm (format: "ERROR: PsalmErrorType - file.php:line:column - message")

Import system:
  - use Namespace\ClassName;
  - use Namespace\ClassName as Alias;
  - use function Namespace\functionName;
  - use const Namespace\CONSTANT;
  - Grouped: use Namespace\{Class1, Class2};
  - require/require_once/include/include_once

Type system:
  - Classes (extends, implements, abstract, final, readonly)
  - Interfaces
  - Traits (use TraitName, conflict resolution)
  - Enums (PHP 8.1, backed enums)
  - Union types (PHP 8.0): int|string
  - Intersection types (PHP 8.1): Countable&Iterator
  - Generics via docblocks only (@template, @extends)
  - Named arguments

Resolution:
  - Composer (composer.json, autoload PSR-4/PSR-0)
  - vendor/ directory
  - Namespace → directory mapping via PSR-4

Quirks:
  - PSR-4 autoloading maps namespace to directory structure
  - Traits can override methods in complex ways
  - Magic methods (__get, __call) make static analysis unreliable
  - Laravel/Symfony facades are static calls to dynamic instances
  - PHPStan levels determine strictness (level 0 = basic, 9 = maximum)
  - Dynamic class instantiation (new $className())
```

### Swift
```
Language: Swift 5.9+
Compiler: swiftc via Swift Package Manager (SPM) or Xcode
Error format: NO numeric codes. Message-based.
Format: "file.swift:10:5: error: message"

Additional: SwiftLint (rule-based)

Create descriptive IDs:
  SWIFT_USE_UNRESOLVED ("use of unresolved identifier 'X'")
  SWIFT_TYPE_MISMATCH ("cannot convert value of type 'T1' to expected argument type 'T2'")
  SWIFT_MISSING_MEMBER ("value of type 'T' has no member 'X'")
  SWIFT_MISSING_CONFORMANCE ("type 'T' does not conform to protocol 'P'")
  etc. — create at least 50 entries

Import system:
  - import Module
  - import struct Module.StructName
  - @testable import Module (testing)

Type system:
  - Protocols (with associated types, protocol extensions, existential types)
  - Generics (with where clauses, primary associated types)
  - Structs, Classes, Enums, Actors
  - Property wrappers (@State, @Published, custom)
  - Result builders (@ViewBuilder)
  - Opaque types (some Protocol)
  - Existential types (any Protocol)
  - async/await, actors, Sendable

Resolution:
  - Package.swift (SPM)
  - Xcode project/workspace (pbxproj)
  - Framework/module targets

Quirks:
  - Protocol conformance can be in extensions in different files
  - Access control (open > public > internal > fileprivate > private)
  - @objc bridging for Objective-C interop
  - Conditional conformance (extension Array: Equatable where Element: Equatable)
  - Type inference is powerful — explicit types sometimes misleading
  - Actor isolation rules affect what can be called from where
```

### C# / .NET
```
Language: C# 12+ / .NET 8+
Compiler: Roslyn
Error code format: CS#### (CS0246, CS1061, CS0103, CS0029, CS8600-CS8605)
Format: "file.cs(10,5): error CS0246: The type or namespace name 'X' could not be found"

Additional: dotnet analyzers, StyleCop (SA####), Roslynator (RCS####)

Import system:
  - using Namespace;
  - using Alias = Namespace.Type;
  - using static Namespace.Type;
  - global using Namespace; (C# 10, in one file, affects all)
  - Implicit usings (SDK default namespaces)

Type system:
  - Classes (inheritance, abstract, sealed, partial)
  - Structs (value types, ref structs)
  - Records (with positional parameters, with expressions)
  - Interfaces (default interface members)
  - Generics with constraints (where T : class, new(), IInterface)
  - Nullable reference types (CS8600-CS8605 family)
  - Pattern matching (is, switch expressions)
  - Primary constructors (C# 12)

Resolution:
  - .csproj (project file)
  - .sln (solution file)
  - NuGet packages (PackageReference in .csproj)
  - ProjectReference for multi-project solutions
  - Directory.Build.props for shared settings

Quirks:
  - Partial classes split across multiple files
  - Source generators create code at compile time
  - Nullable reference types introduce CS8600-CS8605 family (many errors, all related)
  - Global usings mean imports are invisible in individual files
  - Implicit usings from SDK vary by project type
  - Extension methods found through using directives
```
