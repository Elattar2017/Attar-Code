# Feedback Loop Data — What Gets Stored and Example Data

## Storage Location
```
~/.attar-code/fix-outcomes.jsonl      ← append-only log, one JSON per line
~/.attar-code/promoted-strategies.json ← strategies promoted to auto-fix after 5 successes
```

---

## Record Format

Every fix outcome is stored as a single JSON line in `fix-outcomes.jsonl`:

```json
{
  "timestamp": "2026-03-26T14:30:00.000Z",
  "errorCode": "TS2304",
  "strategy": "add_import",
  "language": "TypeScript",
  "file": "src/controllers/user.controller.ts",
  "passed": true,
  "confidence": 0.9,
  "duration": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO string | When the fix was recorded |
| `errorCode` | string | Error code from compiler/runtime (TS2304, E0308, PY_IMPORT, etc.) or special codes (ENDPOINT_FIX, SERVER_CRASH_FIX) |
| `strategy` | string | How it was fixed: `add_import`, `apply_compiler_hint`, `llm_edit`, `llm_endpoint_fix`, `llm_server_fix` |
| `language` | string | Detected technology: TypeScript, JavaScript, Python, Go, Rust, Java, etc. |
| `file` | string | File that was fixed, or URL for endpoint fixes |
| `passed` | boolean | Did the fix work? |
| `confidence` | number | 0.0-1.0, how confident the fix was |
| `duration` | number | Milliseconds to verify (for auto-fixes) |

---

## 6 Types of Outcomes Now Recorded

### Type 1: Tier 1 Auto-Fix (existing — deterministic, no LLM)

**When:** `build_and_test` fails → `runFixEngine` applies a deterministic fix → verifies it

```json
{"timestamp":"2026-03-26T14:30:00.000Z","errorCode":"TS2304","strategy":"add_import","language":"TypeScript","file":"src/routes.ts","passed":true,"confidence":0.9,"duration":50}
{"timestamp":"2026-03-26T14:30:01.000Z","errorCode":"E0425","strategy":"apply_compiler_hint","language":"Rust","file":"src/main.rs","passed":true,"confidence":0.95,"duration":30}
{"timestamp":"2026-03-26T14:30:02.000Z","errorCode":"GO_UNUSED","strategy":"apply_compiler_hint","language":"Go","file":"cmd/server.go","passed":true,"confidence":0.9,"duration":20}
{"timestamp":"2026-03-26T14:30:03.000Z","errorCode":"PY_IMPORT","strategy":"add_import","language":"Python","file":"app/views.py","passed":false,"confidence":0.7,"duration":100}
```

**What this means:**
- TypeScript: Missing import for a symbol → auto-added import statement → build passed ✅
- Rust: Compiler said "did you mean 'println'?" → auto-replaced → build passed ✅
- Go: Unused import detected → auto-removed line → build passed ✅
- Python: Tried to add import but wrong module → build still failed ❌

---

### Type 2: LLM Build Fix (NEW — Fix 3)

**When:** `build_and_test` fails → LLM reads errors → calls `edit_file` → next `build_and_test` passes

```json
{"timestamp":"2026-03-26T15:00:00.000Z","errorCode":"TS2339","strategy":"llm_edit","language":"Node.js/TypeScript","file":"src/controllers/auth.controller.ts","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T15:00:00.000Z","errorCode":"TS2322","strategy":"llm_edit","language":"Node.js/TypeScript","file":"src/middleware/auth.ts","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T15:10:00.000Z","errorCode":"E0308","strategy":"llm_edit","language":"Rust","file":"src/handler.rs","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T15:20:00.000Z","errorCode":"cannot","strategy":"llm_edit","language":"Go","file":"cmd/api/main.go","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T15:30:00.000Z","errorCode":"IndentationError","strategy":"llm_edit","language":"Python","file":"app/models.py","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T15:40:00.000Z","errorCode":"CS0246","strategy":"llm_edit","language":"C#","file":"Controllers/UserController.cs","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T15:50:00.000Z","errorCode":"SyntaxError","strategy":"llm_edit","language":"Node.js","file":"src/routes/auth.routes.js","passed":true,"confidence":0.7}
```

**What this means:**
- Build failed with specific error codes per file
- LLM edited the files to fix them
- Next build passed
- Recorded: which error codes in which files were fixed by the LLM
- Over time: if LLM consistently fixes TS2339 in a certain way, we can learn that pattern

---

### Type 3: Endpoint Fix (NEW — Fix 4)

**When:** `test_endpoint` fails 2+ times → LLM reads logs, edits code → endpoint passes

```json
{"timestamp":"2026-03-26T16:00:00.000Z","errorCode":"ENDPOINT_FIX","strategy":"llm_endpoint_fix","language":"Node.js","file":"http://localhost:4000/api/auth/login","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T16:05:00.000Z","errorCode":"ENDPOINT_FIX","strategy":"llm_endpoint_fix","language":"Python","file":"http://localhost:8000/api/users/","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T16:10:00.000Z","errorCode":"ENDPOINT_FIX","strategy":"llm_endpoint_fix","language":"Go","file":"http://localhost:3000/api/tickets","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T16:15:00.000Z","errorCode":"ENDPOINT_FIX","strategy":"llm_endpoint_fix","language":"Rust","file":"http://localhost:8080/api/health","passed":true,"confidence":0.6}
```

**What this means:**
- Endpoint was failing (500, 401, connection refused, etc.)
- LLM debugged and fixed the server code
- Endpoint now passes
- Tracks which technology had endpoint issues and how often they're resolved

---

### Type 4: Server Crash Fix (NEW — Fix 5)

**When:** Server crashes (test_endpoint gets "fetch failed") → LLM fixes → server restarts successfully

```json
{"timestamp":"2026-03-26T17:00:00.000Z","errorCode":"SERVER_CRASH_FIX","strategy":"llm_server_fix","language":"Node.js","file":"server","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T17:10:00.000Z","errorCode":"SERVER_CRASH_FIX","strategy":"llm_server_fix","language":"Python","file":"server","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T17:20:00.000Z","errorCode":"SERVER_CRASH_FIX","strategy":"llm_server_fix","language":"Java/Maven","file":"server","passed":true,"confidence":0.6}
```

**What this means:**
- Server crashed during endpoint testing
- LLM read logs, identified the crash cause, edited code
- Server restarted successfully
- Tracks crash→fix→recovery patterns per technology

---

### Type 5: Failed Fix (any type)

```json
{"timestamp":"2026-03-26T18:00:00.000Z","errorCode":"TS2304","strategy":"add_import","language":"TypeScript","file":"src/app.ts","passed":false,"confidence":0.7,"duration":100}
{"timestamp":"2026-03-26T18:05:00.000Z","errorCode":"E0382","strategy":"apply_compiler_hint","language":"Rust","file":"src/lib.rs","passed":false,"confidence":0.5,"duration":80}
```

**What this means:**
- Auto-fix was attempted but verification showed it didn't work
- The fix was reverted
- Recorded as `passed: false` so the strategy is NOT promoted

---

## Promotion System

When the SAME error code + strategy combination succeeds 5 times consecutively, it gets **promoted** to Tier 1 (auto-apply without LLM):

### promoted-strategies.json — Example After Real Usage

```json
{
  "TypeScript": {
    "TS2304": "add_import",
    "TS2551": "apply_compiler_hint",
    "TS2339": "llm_edit"
  },
  "Python": {
    "PY_IMPORT": "add_import",
    "SyntaxError": "llm_edit"
  },
  "Go": {
    "GO_UNUSED": "apply_compiler_hint"
  },
  "Rust": {
    "E0425": "apply_compiler_hint"
  },
  "Node.js": {
    "SyntaxError": "llm_edit",
    "ENDPOINT_FIX": "llm_endpoint_fix"
  },
  "C#": {
    "CS0246": "llm_edit"
  }
}
```

**What this means:**
- TS2304 (Cannot find name) → always fixed by adding import → now auto-applied
- TS2551 (Did you mean?) → always fixed by compiler hint → now auto-applied
- GO_UNUSED (unused import) → always fixed by removing line → now auto-applied
- SyntaxError in Node.js → LLM always fixes it → tracked (but llm_edit can't auto-apply — it just informs the prompt "this was fixed 5 times before by editing")

---

## How the Data Gets Used

### 1. Strategy Promotion (Tier 1 acceleration)
```
FixLearner._checkPromotion() → after 5 consecutive passed=true for same errorCode+strategy+language
  → adds to promoted-strategies.json
  → next time classifyTier() sees this error → routes to Tier 1 instead of Tier 2/3
  → auto-fixes without asking the LLM
```

### 2. Past Fix Context (Tier 3 enrichment)
```
FixLearner.getSimilarSuccessfulFix(errorCode, captures, language)
  → searches fix-outcomes.jsonl for matching error+language with passed=true
  → returns the strategy that worked
  → included in the prompt: "Previously successful strategy for TS2304: add_import"
  → LLM has a hint about what worked before
```

### 3. Fix Rate Analytics (future)
```
Count outcomes by: errorCode × language × passed
  → "TypeScript TS2304: 95% fix rate (19/20 passed)"
  → "Python SyntaxError: 80% fix rate (4/5 passed)"
  → "Go endpoint fixes: 100% (3/3 passed)"
  → Identifies which error types the CLI handles well vs poorly
```

---

## Real-World Example: Ticketing System Build

If the ticketing system build had the new feedback loop, here's what would have been recorded:

```jsonl
{"timestamp":"2026-03-26T12:40:00Z","errorCode":"MODULE_NOT_FOUND","strategy":"llm_edit","language":"Node.js","file":"src/middleware/rbac.js","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T12:40:00Z","errorCode":"MODULE_NOT_FOUND","strategy":"llm_edit","language":"Node.js","file":"src/routes/ticket.routes.js","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T12:40:00Z","errorCode":"MODULE_NOT_FOUND","strategy":"llm_edit","language":"Node.js","file":"src/routes/dashboard.routes.js","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T12:42:00Z","errorCode":"SERVER_CRASH_FIX","strategy":"llm_server_fix","language":"Node.js","file":"server","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T12:45:00Z","errorCode":"ENDPOINT_FIX","strategy":"llm_endpoint_fix","language":"Node.js","file":"http://localhost:4000/api/auth/login","passed":true,"confidence":0.6}
{"timestamp":"2026-03-26T13:00:00Z","errorCode":"ReferenceError","strategy":"llm_edit","language":"Node.js","file":"app/dashboard/page.js","passed":true,"confidence":0.7}
{"timestamp":"2026-03-26T13:05:00Z","errorCode":"ENDPOINT_FIX","strategy":"llm_endpoint_fix","language":"Node.js","file":"http://localhost:3000/dashboard","passed":true,"confidence":0.6}
```

After building 5+ projects, the CLI would learn:
- `MODULE_NOT_FOUND` in Node.js routes → always fixed by editing imports → promote to auto-suggest
- `SERVER_CRASH_FIX` → common in Node.js projects → prioritize reading server logs immediately
- `ReferenceError` (localStorage) in Next.js → always needs SSR guard → could become a template fix
