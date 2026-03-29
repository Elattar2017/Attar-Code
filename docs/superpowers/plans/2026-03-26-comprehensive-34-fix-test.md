# Comprehensive 34-Fix Verification Plan

> Test ALL 34 audit fixes by building a Python e-commerce backend + targeted mini-tests

**Goal:** Verify every fix fires correctly. Not just "tests pass" — observe each fix activating in a real CLI session.

**Strategy:** 6 phases. Each phase triggers specific fixes. Track activation with grep counters.

---

## Fix-to-Phase Mapping

| Fix | What | Triggered By |
|-----|------|-------------|
| **M1** | SESSION removed from tree-manager | Phase 1: Python project with absolute imports |
| **M2** | updateFile uses _analyzeFileAuto | Phase 3: Edit a Python file, verify tree updates |
| **M3** | edgeSymbols cleanup | Phase 3: Edit file that changes imports |
| **M4** | Python empty module guard | Phase 1: `from .. import X` in nested package |
| **M5** | allFromSameOrigin fix | Phase 2: Errors from 2 different origin files |
| **M6** | pydantic/fastapi not stdlib | Phase 1: FastAPI imports detected as external |
| **M10** | Iterative DFS | Phase 1: Verified by no stack overflow on 10+ files |
| **M11** | External queue populated | Phase 2: Missing package error |
| **M12** | noiseNames hoisted | Verified by tests passing (performance) |
| **M13** | Validate default imports | Phase 1: `import os` style imports |
| **C1** | Rollback anchor | Phase 2: Errors increase after edit → auto-revert |
| **C2** | Merge error signatures | Phase 2: Run both run_bash build AND build_and_test |
| **C3** | Multi-language error regex | Phase 1: Python errors through build_and_test |
| **I1** | Dynamic extensions in fullRebuild | Phase 1: Python project uses fullRebuild |
| **I2** | Await autoSearch | Phase 2: Observe search results in context |
| **I3** | Single file read | Verified by code change (performance) |
| **I4** | autoDetect in -p mode | Phase 1: One-shot mode with Python |
| **I5** | Clear stale signatures | Phase 2: Build succeeds → signatures cleared |
| **I6** | Symbol threshold >=2 | Phase 2: 2 files with same symbol error |
| **P1** | Python mypy import fix | Phase 4: Mypy-style error in build output |
| **P2-P8** | Non-Python plugin fixes | Phase 5: Mini-tests per language |
| **P9** | Python dual capture | Phase 4: Mypy import variant |
| **P10-P11** | Go/PHP fixes | Phase 5: Mini-tests |

---

## Pre-Setup

```bash
# Clean slate
rm -rf C:/Users/Attar/Desktop/Cli/koko/pyshop
mkdir -p C:/Users/Attar/Desktop/Cli/koko/pyshop

# Pre-install Python deps
cd C:/Users/Attar/Desktop/Cli/koko/pyshop
pip install fastapi uvicorn sqlalchemy pydantic pydantic-settings python-jose bcrypt python-dotenv email-validator

# Create requirements.txt so the CLI detects Python
echo "fastapi\nuvicorn\nsqlalchemy\npydantic\npydantic-settings\npython-jose\nbcrypt" > requirements.txt
```

---

## Phase 1: Build Python E-Commerce (8 files)
**Tests: M1, M4, M6, C3, I1, I4, M10, M13, Available Imports**

**Why this tests the fixes:**
- M1: Python absolute imports `from app.models import User` use the fixed resolver (no SESSION crash)
- M4: Nested package with `from .. import Base` triggers empty-module guard
- M6: `import fastapi` detected as EXTERNAL (not misclassified as stdlib)
- C3: `build_and_test` errors parsed with multi-language regex (not TS-only)
- I1: `fullRebuild` uses auto-detected Python extensions (not hardcoded .ts)
- I4: One-shot `-p` mode initializes smart-fix + auto-detects Python plugin
- M10: 8+ file project uses iterative DFS (no stack overflow)
- M13: `import os`, `import json` validated as default imports
- Available Imports: Each new file sees exports from existing files

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd C:/Users/Attar/Desktop/Cli/koko/pyshop \
  --auto --ctx 32768 \
  -p "Create Python FastAPI e-commerce. 8 files ONLY. Deps installed. No pip install. Use bcrypt directly (not passlib). Order: 1) app/__init__.py 2) app/config.py (Settings) 3) app/database.py (SQLite engine+SessionLocal) 4) app/models.py (User,Product,Order with SQLAlchemy) 5) app/schemas.py (Pydantic models) 6) app/services.py (CRUD functions importing from models+database) 7) app/routes.py (FastAPI router importing from services+schemas) 8) app/main.py (app+include_router). After ALL: build_and_test."
```

**Verification grep:**
```bash
LOG=/tmp/pyshop-phase1.txt
echo "=== PHASE 1 VERIFICATION ==="
echo "📊 Smart-fix outputs:    $(grep -c '📊' $LOG)"
echo "Available imports:       $(grep -c 'Available imports' $LOG)"
echo "Python plugin detected:  $(grep -c 'Python' $LOG | head -1)"
echo "build_and_test calls:    $(grep -c 'build_and_test' $LOG)"
echo "Multi-lang error parse:  $(grep -c 'ERROR\|error' $LOG)"
echo "BLOCKED:                 $(grep -c 'BLOCKED' $LOG)"
echo "PASS:                    $(grep -c 'PASS' $LOG)"
```

**Pass criteria:**
- [ ] 8 Python files created
- [ ] `📊 Smart-fix` appears for each write_file (Available Imports working)
- [ ] build_and_test runs (C3 tested)
- [ ] No crashes (M1 fixed — no SESSION error)
- [ ] Python plugin auto-detected (I4 fixed in -p mode)

---

## Phase 2: Deliberate Error Cascade + Auto-Rollback
**Tests: C1, C2, I5, I6, M5, M11, SHARED ROOT CAUSE**

**Strategy:** Rename `User` model to `Customer` in models.py ONLY. This breaks schemas.py, services.py, routes.py — all reference `User`. Then the model tries to fix by editing individual files. If errors increase → auto-rollback fires (C1). If same symbol appears in 2+ files → I6 fires.

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd C:/Users/Attar/Desktop/Cli/koko/pyshop \
  --auto --ctx 32768 \
  -p "In app/models.py, rename the User class to Customer. Do NOT change any other file. Then run build_and_test. Report what the error analysis says about the cascade."
```

**Verification grep:**
```bash
LOG=/tmp/pyshop-phase2.txt
echo "=== PHASE 2 VERIFICATION ==="
echo "SHARED ROOT CAUSE:     $(grep -c 'SHARED ROOT\|SYMBOL.*causes' $LOG)"
echo "AUTO-REVERTED:         $(grep -c 'AUTO-REVERTED' $LOG)"
echo "ERRORS INCREASED:      $(grep -c 'ERRORS INCREASED' $LOG)"
echo "Symbol 'User' grouped: $(grep -c 'User.*causes\|User.*files' $LOG)"
echo "Stale cleared on pass: $(grep -c 'errorSignatures.*null\|errorHistory.*\[\]' $LOG)"
```

**Pass criteria:**
- [ ] SHARED ROOT CAUSE or SYMBOL grouping fires (I6: 2+ files reference 'User')
- [ ] AUTO-REVERTED fires if model's edits increase errors (C1)
- [ ] Build eventually succeeds → stale signatures cleared (I5)

---

## Phase 3: Edit Cycle — Tree Updates for Python
**Tests: M2, M3, M4**

**Strategy:** Edit an existing Python file — add a new function. Verify the tree detects the structural change (new export). Then edit imports in another file. Verify edgeSymbols cleaned.

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd C:/Users/Attar/Desktop/Cli/koko/pyshop \
  --auto --ctx 32768 \
  -p "Add a new function 'get_product_stats()' to app/services.py. Then add a route that calls it in app/routes.py. Then run build_and_test."
```

**Verification:**
- M2: After editing services.py, tree should show new export (`get_product_stats`)
- M3: Old edges cleaned when imports change
- Smart-fix edit response should show "Changes detected: Added exports: get_product_stats"

**Pass criteria:**
- [ ] Edit response includes structural change info
- [ ] build_and_test succeeds after edits

---

## Phase 4: Server + Endpoint Testing
**Tests: SERVER-SIDE ERROR auto-embed, auto-search with Python queries, P1, P9**

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd C:/Users/Attar/Desktop/Cli/koko/pyshop \
  --auto --ctx 32768 \
  -p "Start the server: start_server 'python -m uvicorn app.main:app --port 8000'. Then test: test_endpoint GET http://localhost:8000/ and POST http://localhost:8000/api/users with {\"username\":\"test\",\"email\":\"t@t.com\",\"password\":\"pass123\"}. If any test fails, fix and retry."
```

**Verification grep:**
```bash
LOG=/tmp/pyshop-phase4.txt
echo "=== PHASE 4 VERIFICATION ==="
echo "SERVER-SIDE ERROR:     $(grep -c 'SERVER-SIDE ERROR' $LOG)"
echo "STARTUP ERROR:         $(grep -c 'STARTUP ERROR' $LOG)"
echo "Smart search Python:   $(grep -c 'Python.*TypeError\|Python.*ImportError\|Python.*install' $LOG)"
echo "PASS:                  $(grep -c 'PASS' $LOG)"
echo "Server started:        $(grep -c 'start_server' $LOG)"
```

**Pass criteria:**
- [ ] If server fails: STARTUP ERROR section shows Python traceback
- [ ] If endpoint returns 500: SERVER-SIDE ERROR auto-embedded
- [ ] Auto-search generates Python-specific query (not "build_error Technology: Python")
- [ ] Eventually: at least 1 PASS endpoint

---

## Phase 5: Multi-Language Mini-Tests (Plugin Verification)
**Tests: P2-P8, P10-P11**

These can't be tested by a Python project. Verify by checking plugin JSON validity and running the file analyzer on small code snippets.

```bash
node -e "
const { analyzeFileWithPlugin } = require('./smart-fix/file-analyzer');
const fs = require('fs');
const tests = [
  { name: 'TypeScript', plugin: 'typescript.json', code: 'import { User } from \"./types\";\nexport function getUser(): User { return {} as User; }', ext: '.ts' },
  { name: 'Go', plugin: 'go.json', code: 'package main\nimport \"fmt\"\nfunc GetUser() { fmt.Println(\"hello\") }\ntype Config struct { Port int }', ext: '.go' },
  { name: 'Rust', plugin: 'rust.json', code: 'use crate::models::User;\npub fn create_user() -> User { todo!() }\npub struct AppConfig { pub port: u16 }', ext: '.rs' },
  { name: 'Java', plugin: 'java.json', code: 'import java.util.List;\npublic class UserService {\n    public User findById(int id) { return null; }\n}', ext: '.java' },
  { name: 'C#', plugin: 'csharp.json', code: 'using App.Models;\npublic class UserService {\n    public User CreateUser(string name) { return null; }\n}', ext: '.cs' },
  { name: 'PHP', plugin: 'php.json', code: '<?php\nuse App\\Models\\User;\nclass UserService {\n    public function findById(int $id): ?User { return null; }\n}', ext: '.php' },
  { name: 'Swift', plugin: 'swift.json', code: 'import Foundation\nclass UserService {\n    func createUser(name: String) -> User { return User() }\n}', ext: '.swift' },
];
for (const t of tests) {
  const plugin = JSON.parse(fs.readFileSync('defaults/plugins/' + t.plugin, 'utf-8'));
  const result = analyzeFileWithPlugin(t.code, '/test' + t.ext, plugin);
  const imports = result.imports.length;
  const exports = result.exports.length;
  const defs = result.definitions.length;
  console.log(t.name + ': imports=' + imports + ' exports=' + exports + ' defs=' + defs + (imports+exports+defs > 0 ? ' ✅' : ' ❌'));
}
"
```

**Pass criteria:**
- [ ] All 7 languages extract at least 1 import, 1 export, or 1 definition
- [ ] No ❌ in output

---

## Phase 6: CLI Protection + Loop Prevention
**Tests: All 20 CLI fixes (read gate, write block, tool cap, etc.)**

Already verified in prior test runs. This phase is a regression check:

```bash
# Test self-protection
node attar-code.js --model glm-4.7-flash:latest \
  --cwd C:/Users/Attar/Desktop/Cli/Attar-Code \
  --auto --ctx 32768 \
  -p "Create test.js with console.log('hello') in the current directory."
# Expected: BLOCKED

# Test tool cap
node -e "
const sf = require('./smart-fix');
console.log('Smart-fix:', sf ? 'loaded' : 'FAIL');
const t = sf.initSmartFix();
t.autoDetectAndLoadPlugin('C:/Users/Attar/Desktop/Cli/koko/pyshop');
console.log('Plugin:', t.detectedLanguage || 'NONE');
console.log('Files:', t.getFileCount());
"
```

---

## Master Metrics Script

Run after ALL phases complete:

```bash
echo "╔════════════════════════════════════════════════╗"
echo "║     34-FIX COMPREHENSIVE VERIFICATION          ║"
echo "╠════════════════════════════════════════════════╣"

for PHASE in 1 2 3 4; do
  LOG=/tmp/pyshop-phase${PHASE}.txt
  if [ -f "$LOG" ]; then
    echo ""
    echo "Phase $PHASE:"
    echo "  write_file:      $(grep -c 'write_file' $LOG 2>/dev/null)"
    echo "  edit_file:       $(grep -c 'edit_file' $LOG 2>/dev/null)"
    echo "  build_and_test:  $(grep -c 'build_and_test' $LOG 2>/dev/null)"
    echo "  start_server:    $(grep -c 'start_server' $LOG 2>/dev/null)"
    echo "  test_endpoint:   $(grep -c 'test_endpoint' $LOG 2>/dev/null)"
    echo "  PASS:            $(grep -c 'PASS' $LOG 2>/dev/null)"
    echo "  FAIL:            $(grep -c 'FAIL' $LOG 2>/dev/null)"
    echo "  📊 Smart-fix:    $(grep -c '📊' $LOG 2>/dev/null)"
    echo "  Available:       $(grep -c 'Available imports' $LOG 2>/dev/null)"
    echo "  SHARED ROOT:     $(grep -c 'SHARED ROOT\|SYMBOL.*causes' $LOG 2>/dev/null)"
    echo "  AUTO-REVERTED:   $(grep -c 'AUTO-REVERTED' $LOG 2>/dev/null)"
    echo "  ERRORS INCREASED:$(grep -c 'ERRORS INCREASED' $LOG 2>/dev/null)"
    echo "  SERVER-SIDE:     $(grep -c 'SERVER-SIDE ERROR\|STARTUP ERROR' $LOG 2>/dev/null)"
    echo "  Search:          $(grep -c 'web_search\|AUTO-SEARCH' $LOG 2>/dev/null)"
    echo "  BLOCKED:         $(grep -c 'BLOCKED' $LOG 2>/dev/null)"
    echo "  LOOP:            $(grep -c 'LOOP DETECTED' $LOG 2>/dev/null)"
  fi
done

echo ""
echo "╠════════════════════════════════════════════════╣"
echo "║              FIX ACTIVATION MATRIX              ║"
echo "╠════════════════════════════════════════════════╣"
echo ""
echo "Module fixes:"
echo "  M1 (SESSION removed):     $(grep -c 'Smart-fix' /tmp/pyshop-phase1.txt 2>/dev/null) outputs (>0 = working, no crash)"
echo "  M2 (updateFile auto):     Phase 3 edit response"
echo "  M3 (edgeSymbols):         Phase 3 no stale data"
echo "  M4 (Python empty path):   Phase 1 no crash on nested imports"
echo "  M5 (allFromSameOrigin):   Phase 2 correct grouping"
echo "  M6 (fastapi external):    Phase 1 external detection"
echo "  M10 (iterative DFS):      Phase 1 no stack overflow"
echo "  M12 (noiseNames):         Tests pass (performance)"
echo ""
echo "CLI fixes:"
echo "  C1 (rollback anchor):     $(grep -c 'AUTO-REVERTED' /tmp/pyshop-phase2.txt 2>/dev/null) reverts"
echo "  C2 (merge signatures):    Phase 2 signatures preserved"
echo "  C3 (multi-lang regex):    $(grep -c 'build_and_test' /tmp/pyshop-phase1.txt 2>/dev/null) builds with Python errors"
echo "  I1 (dynamic extensions):  Phase 1 Python tree built"
echo "  I4 (plugin in -p mode):   $(grep -c '📊' /tmp/pyshop-phase1.txt 2>/dev/null) smart-fix outputs in one-shot"
echo "  I5 (clear stale):         Phase 2 build success clears"
echo "  I6 (threshold >=2):       Phase 2 symbol grouping"
echo ""
echo "Plugin fixes:"
echo "  P1 (mypy import):         Phase 4 search query"
echo "  P2-P8 (non-Python):       Phase 5 mini-tests"
echo ""
echo "╚════════════════════════════════════════════════╝"
```

---

## Execution Order

| Phase | Duration | Dependencies |
|-------|----------|-------------|
| Pre-setup | 1 min | None |
| Phase 1: Build | 5-10 min | Pre-setup |
| Phase 2: Error cascade | 3-5 min | Phase 1 |
| Phase 3: Edit cycle | 2-3 min | Phase 1 |
| Phase 4: Server test | 3-5 min | Phase 1 |
| Phase 5: Plugin mini-tests | 30 sec | None (independent) |
| Phase 6: Protection check | 30 sec | None (independent) |
| **Total** | **15-25 min** | |
