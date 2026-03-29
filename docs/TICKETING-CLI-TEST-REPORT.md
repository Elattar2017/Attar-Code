# Ticketing System Build — CLI Smart-Fix Test Report

**Date:** 2026-03-26
**Project:** Full-Stack Ticketing System (Express backend, Phase 1)
**Model:** glm-4.7-flash:latest (30B)
**Duration:** ~8 minutes, 49 steps

---

## What the CLI Built

### Backend Files Created (16 source files)

| File | Status |
|------|--------|
| backend/.env | Created |
| backend/package.json | Created (then edited — switched from better-sqlite3 to sqlite3) |
| backend/src/config/db.js | Created (then edited — adapted to async sqlite3 API) |
| backend/src/middleware/auth.js | Created |
| backend/src/middleware/rbac.js | Created (then edited 2x — fixed requireRole export) |
| backend/src/middleware/errorHandler.js | Created |
| backend/src/middleware/rateLimiter.js | Created |
| backend/src/utils/ticketNumber.js | Created |
| backend/src/controllers/auth.controller.js | Created |
| backend/src/controllers/ticket.controller.js | Created |
| backend/src/controllers/comment.controller.js | Created |
| backend/src/controllers/dashboard.controller.js | Created |
| backend/src/routes/auth.routes.js | Created (then edited — fixed requireRole import) |
| backend/src/routes/ticket.routes.js | Created (then edited — fixed requireRole import) |
| backend/src/routes/comment.routes.js | Created |
| backend/src/routes/dashboard.routes.js | Created (then edited — fixed requireRole import) |
| backend/src/index.js | Created |
| backend/src/seed.js | Created (then edited — adapted to async sqlite3) |

### Tool Usage

| Tool | Count |
|------|-------|
| write_file | 19 |
| edit_file | 6 |
| read_file | 11 |
| test_endpoint | 2 |
| run_bash | ~5 |
| **Total steps** | **49** |

### Endpoint Results

| Endpoint | Result |
|----------|--------|
| GET /api/tickets | **PASS** (returned 401 = auth working) |
| POST /api/auth/register | **FAIL** (fetch failed — server crashed during request) |

---

## Smart-Fix Behavior Observed

### What Worked

1. **Dependency failure recovery:** `better-sqlite3` failed to install (missing Visual Studio C++ tools). The CLI read the npm error, understood the problem, switched to `sqlite3` package, and edited `package.json` + `db.js` + `seed.js` to adapt. This is correct error recovery behavior.

2. **Cross-file error detection:** `requireRole is not a function` appeared across 3 route files (ticket.routes.js, dashboard.routes.js, comment.routes.js). The CLI correctly identified the root cause in `rbac.js` and fixed the export, then propagated the fix to all 3 consuming files. This validates Stage 2 (root cause engine) in practice.

3. **Import chain debugging:** The CLI traced the error through the import chain: routes → rbac.js → auth.js, identified a potential circular dependency, and restructured the middleware exports.

4. **Correct file creation order:** Created files in dependency order: .env → package.json → config/db.js → middleware → utils → controllers → routes → index.js → seed.js. This validates the prompt rules.

5. **Edit vs rewrite:** 6 edit_file calls, 0 unnecessary rewrites. The CLI correctly used targeted edits to fix specific issues rather than rewriting entire files.

### What Didn't Work

1. **Server crash on register endpoint:** After seeding, the register endpoint caused a server crash ("fetch failed" 5 times). The likely cause: async sqlite3 callback-style DB operations are error-prone — the auth.controller.js probably has an unhandled callback error that crashes the process.

2. **Smart-fix enrichment NOT visible in output:** The "Available Imports" and "Error Doctor Prescriptions" enrichments were not visible in the CLI output. This suggests either:
   - The smart-fix tree wasn't built (no build_and_test was called — vanilla JS has no build step)
   - The enrichment was present but not shown in the raw output capture

3. **Only 2 endpoints tested:** The CLI ran out of retries on the register endpoint and stopped. The prompt asked for 7 endpoint tests but only 2 were attempted.

4. **No auto-token attachment visible:** The login endpoint was never successfully called, so the auto-token feature couldn't be tested.

---

## CLI Systems Assessment

| System | Status | Evidence |
|--------|--------|----------|
| **File creation in dependency order** | Working | Created config → middleware → controllers → routes → index |
| **Error recovery (npm install fail)** | Working | Switched from better-sqlite3 to sqlite3 after build fail |
| **Cross-file error detection** | Working | Traced requireRole error across 3 routes to rbac.js |
| **edit_file over write_file** | Working | 6 edits, 0 unnecessary rewrites |
| **Available Imports** | Not tested | No build_and_test call (vanilla JS, no build step) |
| **Error Doctor Prescriptions** | Not tested | No build errors (no TypeScript, no compilation) |
| **Fix ordering (Stage 2)** | Not tested directly | Would require build_and_test with TypeScript project |
| **Function extraction (Stage 3)** | Not tested directly | No tier3 context building visible |
| **Prompt template (Stage 5)** | Not tested directly | No build errors to trigger prompt assembly |
| **Feedback loop (Stage 6)** | Not tested directly | No fix outcomes recorded (no tier1/2/3 pipeline triggered) |
| **Auto-token attachment** | Not tested | Login never succeeded |
| **Seed data** | Working | 6 users + 8 tickets + comments seeded |
| **Server startup** | Working | Port 4000 running |
| **Auth middleware** | Working | GET /api/tickets correctly returned 401 |

---

## Root Causes of Failures

### Register endpoint crash
The `sqlite3` package uses asynchronous callback-based API (`db.run(sql, params, callback)`), which is error-prone for Express route handlers. If the callback throws or the response isn't sent properly, Express crashes. The original prompt specified `better-sqlite3` (synchronous API) specifically to avoid this, but the C++ build tools weren't available.

**CLI Enhancement needed:** When `better-sqlite3` fails to install on Windows, the CLI should suggest installing windows-build-tools: `npm install --global windows-build-tools` or use a pre-built binary approach.

### Smart-fix not triggered
The 6-stage pipeline (hint extraction, root cause, context building, prompt assembly, feedback) only triggers when:
1. `build_and_test` is called (triggers error parsing + classification)
2. Build errors exist (triggers fix engine)
3. The project has a build step (TypeScript, Rust, Go, etc.)

For vanilla JavaScript projects, there is no build step. The CLI correctly uses `start_server` + `test_endpoint` instead, but this path does NOT trigger the smart-fix pipeline.

**CLI Enhancement needed:** Add a "syntax check" mode for vanilla JS projects: `node --check` on each file to catch syntax errors, or ESLint integration. This would trigger the smart-fix pipeline for JS projects.

---

## Enhancement Recommendations

### Critical
1. **Vanilla JS project support in smart-fix:** Run `node --check *.js` as a "build" step for JavaScript projects without TypeScript. This would trigger the full 6-stage pipeline.

### Important
2. **Better error handling for async sqlite3:** When the CLI switches to async sqlite3, it should add proper error handling wrappers or suggest using `sql.js` (pure JS SQLite, no native dependencies).
3. **Retry with different approach after 3 fails:** When test_endpoint fails 3 times with "fetch failed" (server crash), the CLI should automatically read server logs, restart the server, and examine the crash before retrying.

### Nice to Have
4. **Windows build tools detection:** Before attempting to install packages with native modules, check if Visual Studio Build Tools are available.
5. **Project complexity estimation:** Warn when a prompt requests more files than the model can handle in one session (~15 files for 30B models).

---

## Comparison with Previous Tests

| Project | Files | Steps | Endpoint Tests | PASS | FAIL |
|---------|-------|-------|---------------|------|------|
| E-Commerce (25 files) | 23 | 49 | 20 | 11 | 9 |
| **Ticketing (18 files)** | **16** | **49** | **2** | **1** | **1** |

The ticketing build was more efficient per file (16 files / 49 steps = 0.33 files/step), but endpoint testing was cut short by the server crash.

---

## Conclusion

The CLI successfully built a 16-file backend with correct dependency ordering, error recovery, and cross-file debugging. The smart-fix 6-stage pipeline was **not exercised** because vanilla JavaScript has no build step — this is the most significant finding. The pipeline needs a "syntax check" mode for JS projects to trigger error parsing, classification, and the fix engine.

**Next step:** Run Phase 2 (frontend with TypeScript/Next.js) which WILL trigger the smart-fix pipeline through `npm run build` / `tsc` compilation.
