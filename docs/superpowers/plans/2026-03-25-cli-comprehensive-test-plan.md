# Attar-Code CLI — Comprehensive Test Plan

> **For agentic workers:** This plan tests ALL 17 fixes, 35 warning/blocking systems, and 37 tools by having the CLI build a real project. Each test phase exercises specific systems.

**Goal:** Verify every prompt rule, error detection system, and smart-fix feature works correctly when a 30B model (GLM-4.7-flash) builds a multi-file project autonomously.

**Strategy:** Instead of one massive project that overwhelms the model, we run **5 focused test phases** — each designed to trigger specific systems. Smaller scope = model succeeds more often = we can observe the CLI systems working correctly.

**Model:** glm-4.7-flash:latest (29.9B, Q4_K_M)

---

## CRITICAL FINDING: Tool Count Issue

**Research shows Qwen3-Coder breaks at ~5 tools. GLM-4.7-Flash handles more (up to 8-10) but degrades beyond that.**

The current CLI sends **10-22 tools per request** depending on keywords. This is likely the #1 cause of model confusion in all our test runs.

**Fix Required Before Testing (Fix 18: Tool Count Cap):**

The `selectToolsForContext()` function at line 5382 needs a hard cap. For 30B models:
- **Core tools (always):** read_file, write_file, edit_file, run_bash, grep_search (5 tools)
- **Phase-specific (add based on context):** max 3-5 additional tools
- **Total cap:** 10 tools maximum per request

Also: reduce context from 65K to **16-32K** for 30B models. Context rot research shows quality degrades well before the limit.

---

## Test Project: Task Manager API + CLI Client

**Why this project:**
- **15 files** (not 30+ — within 30B model's reliable range)
- **Node.js/TypeScript** (best smart-fix support with AST parser)
- **Express backend + CLI client** (tests architecture discovery, server management)
- **Shared types across files** (tests cross-file error detection)
- **SQLite database** (no external deps, works offline)
- **Build step required** (tsc → tests error analysis)

**Structure:**
```
task-manager/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts          # Shared types (Task, User, Status)
│   ├── db.ts             # SQLite setup + queries
│   ├── auth.ts           # JWT auth middleware
│   ├── routes/
│   │   ├── tasks.ts      # CRUD endpoints
│   │   ├── users.ts      # User endpoints
│   │   └── index.ts      # Router barrel
│   ├── services/
│   │   ├── task-service.ts
│   │   └── user-service.ts
│   ├── app.ts            # Express app setup
│   └── server.ts         # Entry point (listen on port)
├── tests/
│   └── tasks.test.ts     # Basic API tests
└── client/
    └── cli.ts            # CLI client for the API
```

---

## Phase 1: Build Phase — Tests File Creation Systems

**What we're testing:**
- [ ] Smart-fix dependency tree builds for TypeScript
- [ ] Import validation warns about missing modules
- [ ] Force-build nudge triggers after 10+ files
- [ ] Identical-content short-circuit works
- [ ] File creates tracked correctly
- [ ] Write count warnings at 2nd write
- [ ] Prompt rule: "Create files in dependency order"

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd "C:/Users/Attar/Desktop/Cli/koko" \
  --auto --ctx 65536 \
  -p "Create a Task Manager REST API in a 'task-manager' directory. TypeScript, Express, better-sqlite3. Structure: src/ with types.ts (Task, User, Status types), db.ts (SQLite), auth.ts (JWT middleware), routes/tasks.ts, routes/users.ts, routes/index.ts, services/task-service.ts, services/user-service.ts, app.ts, server.ts. Also tsconfig.json and package.json. ALL deps already installed. Do NOT npm install. Create files in DEPENDENCY ORDER: types first, then db, then services, then routes, then app, then server. After all files: build_and_test."
```

**Expected Observations:**
1. Files created in dependency order (types → db → services → routes → app → server)
2. Smart-fix tree shows import validation after each write_file
3. Force-build nudge appears after 10th file
4. build_and_test runs and shows error analysis if any errors
5. No rewrite loops (0 files blocked)

**Pass Criteria:**
- 12+ files created
- 0 files blocked
- build_and_test called at least once
- Total write_file calls < 20 (no excessive rewrites)

---

## Phase 2: Error Fix Phase — Tests Error Detection + Fix Ordering

**What we're testing:**
- [ ] Cross-file error grouping (SHARED ROOT CAUSE)
- [ ] Edit loop detection with root cause awareness
- [ ] Auto-symbol-search (findSymbolInProject)
- [ ] Error prescriptions from TypeScript plugin
- [ ] Smart-fix fix ordering (root causes first)
- [ ] Build error analysis from run_bash (Fix 14)
- [ ] Prompt rule: "Fix shared root causes, not individual files"

**Setup:** After Phase 1 succeeds, introduce a deliberate error:
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd "C:/Users/Attar/Desktop/Cli/koko/task-manager" \
  --auto --ctx 65536 \
  -p "There's a bug: in src/types.ts, rename the 'Task' interface to 'TodoItem'. Do NOT update any other files. Just rename it in types.ts. Then run build_and_test to see what breaks."
```

**Expected Observations:**
1. Model renames Task → TodoItem in types.ts
2. build_and_test shows errors in 4+ files (all import Task from types.ts)
3. SHARED ROOT CAUSE message appears: "N files have the same error"
4. Error prescriptions include: "⚡ AUTO-FOUND: 'Task' is defined in types.ts"
5. Smart-fix fix ordering puts types.ts as Priority 1

**Pass Criteria:**
- SHARED ROOT CAUSE message appears in build output
- Error count in build output groups errors correctly
- Model fixes types.ts (or reverts rename) rather than editing each downstream file individually

---

## Phase 3: Server Phase — Tests Server Management + Endpoint Testing

**What we're testing:**
- [ ] start_server works correctly
- [ ] test_endpoint with auto-embedded server logs (Fix: SERVER-SIDE ERROR)
- [ ] Server crash log extraction (Fix: CRASH LOG / STARTUP ERROR)
- [ ] Architecture discovery (Express on specific port)
- [ ] run_bash server interception (redirects to start_server)
- [ ] Pre-start build check (needs tsc compilation first)
- [ ] Port conflict handling (EADDRINUSE)
- [ ] Windows command translation (pwd, lsof, timeout)

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd "C:/Users/Attar/Desktop/Cli/koko/task-manager" \
  --auto --ctx 65536 \
  -p "Start the server and test it. Steps: 1) build_and_test first to compile TypeScript. 2) start_server 'node dist/server.js' on port 3000. 3) test_endpoint GET http://localhost:3000/health. 4) test_endpoint POST http://localhost:3000/api/tasks with body {\"title\":\"Test task\",\"description\":\"Testing\"}. If any test fails, read the error from the response (server logs are included automatically), fix with edit_file, rebuild, restart, retest."
```

**Expected Observations:**
1. Architecture note injected in system prompt (Express server detected)
2. If server fails to start: STARTUP ERROR section shown with traceback
3. If test_endpoint returns 500: SERVER-SIDE ERROR section with server logs
4. If model tries run_bash for server: blocked with "use start_server instead"
5. test_endpoint PASS for health check
6. Same endpoint error warning triggers if POST fails twice

**Pass Criteria:**
- Server starts successfully
- GET /health returns PASS
- At least 1 test_endpoint call shows server logs on failure (if any failure occurs)
- No "call get_server_logs" hint needed (logs auto-embedded)

---

## Phase 4: Read/Edit Loop Phase — Tests Loop Prevention

**What we're testing:**
- [ ] Progressive read gate (summary at 5, block at 8)
- [ ] Tool-call pattern loop detection (4+ same tool:file in 10 calls)
- [ ] Edit loop with shared root cause
- [ ] Bash command typo loop detection (Fix 15)
- [ ] Thinking-without-acting escalation (Fix 6)
- [ ] Write blocker with root cause hint
- [ ] Force web_search after 3+ retries (Fix 8)
- [ ] Empty response handling

**This phase is OBSERVATIONAL** — we can't force these to trigger, but we watch for them during Phases 1-3. If the model gets stuck in any phase, these systems should activate.

**Monitoring Script:**
```bash
# Run after each phase to count system activations
grep -c "BLOCKED\|LOOP DETECTED\|SHARED ROOT\|MISSING IMPORT\|SAME COMMAND\|SAME ENDPOINT\|STARTUP ERROR\|SERVER-SIDE ERROR\|CRASH LOG\|ARCHITECTURE\|auto-search\|web_search\|Auto-fix" /tmp/attar-test-log.txt
```

**Pass Criteria:**
- If model reads same file 5+ times: summary version returned (not full content)
- If model reads same file 8+ times: BLOCKED message returned
- If same tool:file pattern appears 4+ times in 10 calls: LOOP DETECTED message
- If thinking-without-acting happens 3+ times: escalated nudge with specific actions

---

## Phase 5: CLI Self-Protection Phase — Tests Safety Systems

**What we're testing:**
- [ ] CLI source directory write protection (Fix 17)
- [ ] CLI source directory edit protection
- [ ] CLI source directory bash mkdir protection
- [ ] Windows command translation (pwd, kill, lsof, timeout, chmod)

**CLI Command:**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd "C:/Users/Attar/Desktop/Cli/Attar-Code" \
  --auto --ctx 65536 \
  -p "Create a file called test-project/hello.js with console.log('hello'). Then try to create a file called bad-file.js in the CURRENT directory (not in test-project). Report what happened."
```

**Expected Observations:**
1. `test-project/hello.js` → BLOCKED (writing inside CLI directory)
2. `bad-file.js` → BLOCKED (writing inside CLI directory)
3. Model gets clear message: "Cannot write inside CLI's source directory"

**Pass Criteria:**
- Both writes are BLOCKED
- Error message mentions the --cwd directory should be used instead
- Model does NOT create files inside Attar-Code/

---

## Phase 6: Multi-Language Validation (Optional)

**What we're testing:**
- [ ] Python plugin loads and validates imports
- [ ] Go plugin loads and validates imports
- [ ] Plugin auto-detection from project markers
- [ ] Universal symbol search across languages

**CLI Command (Python):**
```bash
node attar-code.js --model glm-4.7-flash:latest \
  --cwd "C:/Users/Attar/Desktop/Cli/koko" \
  --auto --ctx 65536 \
  -p "Create a small Python Flask app in 'flask-test' directory with 3 files: app.py (Flask app), models.py (User class), routes.py (imports User from models, has /users endpoint). All deps installed. After creating: build_and_test."
```

**Expected Observations:**
1. Python plugin auto-loaded (detects .py files)
2. Import validation shows for Python files
3. Dependency tree shows models.py as hub, routes.py as leaf

---

## Monitoring & Reporting

### Per-Phase Metrics to Capture

```bash
# Run this after each phase completes
LOG=/tmp/attar-test-log.txt
echo "=== METRICS ==="
echo "write_file: $(grep -c 'write_file' $LOG)"
echo "edit_file: $(grep -c 'edit_file' $LOG)"
echo "read_file: $(grep -c 'read_file' $LOG)"
echo "build_and_test: $(grep -c 'build_and_test' $LOG)"
echo "start_server: $(grep -c 'start_server' $LOG)"
echo "test_endpoint: $(grep -c 'test_endpoint' $LOG)"
echo "web_search: $(grep -c 'web_search' $LOG)"
echo "PASS: $(grep -c '✅ PASS' $LOG)"
echo "FAIL: $(grep -c '❌ FAIL' $LOG)"
echo "BLOCKED: $(grep -c 'BLOCKED' $LOG)"
echo "SHARED ROOT: $(grep -c 'SHARED ROOT' $LOG)"
echo "LOOP DETECTED: $(grep -c 'LOOP DETECTED' $LOG)"
echo "SERVER-SIDE ERROR: $(grep -c 'SERVER-SIDE ERROR' $LOG)"
echo "STARTUP ERROR: $(grep -c 'STARTUP ERROR' $LOG)"
echo "SAME COMMAND: $(grep -c 'SAME COMMAND' $LOG)"
echo "SAME ENDPOINT: $(grep -c 'SAME ENDPOINT' $LOG)"
echo "ARCHITECTURE: $(grep -c 'ARCHITECTURE' $LOG)"
echo "MISSING IMPORT: $(grep -c 'MISSING IMPORT' $LOG)"
echo "AUTO-SEARCH: $(grep -c 'auto-search\|AUTO-SEARCH\|Deep research' $LOG)"
echo "Files created: $(find $PROJECT_DIR -type f -name '*.ts' -o -name '*.js' | wc -l)"
```

### Final Report Template

After all phases complete, generate:

1. **Systems Activated:** Which of the 35 warning/blocking systems fired?
2. **Systems NOT Activated:** Which systems were never triggered? (need separate unit tests)
3. **Model Behavior:** Did the model follow prompt rules? Which rules were ignored?
4. **Fix Effectiveness:** For each of the 17 fixes — did it help? Quantify.
5. **Remaining Gaps:** What broke that no system caught?

---

## Execution Order

| Phase | Duration (est) | Dependencies |
|-------|---------------|-------------|
| Phase 1: Build | 5-10 min | Clean koko/ directory |
| Phase 2: Error Fix | 5-10 min | Phase 1 succeeded (project exists) |
| Phase 3: Server | 5-10 min | Phase 1 succeeded (project compiled) |
| Phase 4: Loop Monitor | Passive | Observed during Phases 1-3 |
| Phase 5: Self-Protection | 2-3 min | Independent (can run anytime) |
| Phase 6: Multi-Language | 5-10 min | Independent (optional) |

**Total estimated time:** 25-45 minutes for Phases 1-5.

---

## Pre-Requisites

Before running tests:
1. Ollama running with glm-4.7-flash:latest loaded
2. Search proxy running (`node search-proxy.js` on port 3001)
3. Node.js 18+ installed
4. TypeScript installed globally (`npm i -g typescript`)
5. better-sqlite3 installed in test project OR available globally
6. koko/ directory clean (no leftover projects)
7. All 49 smart-fix unit tests passing (`npx jest smart-fix/tests/`)
