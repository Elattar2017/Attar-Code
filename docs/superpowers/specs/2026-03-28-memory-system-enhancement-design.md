# Memory System Enhancement — Design Specification

## Goal

Replace the current noisy, single-layer memory system with a three-layer adaptive architecture that prevents model drift, manages context efficiently across all model sizes (8K-128K), integrates with smart-fix, and learns across sessions.

## Problem Statement

The current CLI suffers from:
1. **Model loses focus** — forgets current task after errors, revisits old topics (observed with glm-4.7-flash)
2. **Memory quality** — 370+ entries in memory.json, many garbage ("you like to work on today?")
3. **Context waste** — old tool outputs consume tokens until a single compression cliff at 20 messages
4. **No cross-session learning** — build state, error signatures, corrections lost on exit
5. **Smart-fix disconnected** — memory has project facts but doesn't inform fix selection; smart-fix outcomes don't feed back into memory

## Architecture

Three-layer memory with heavy reinforcement, 12 feedback loops, model-driven extraction, and smart-fix integration.

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: WORKING MEMORY (always in context)        │
│  Task Anchor + Instructions + Corrections           │
│  Injected at BOTH start and end of every prompt     │
│  Budget: 500-2000 tokens (scales with model)        │
├─────────────────────────────────────────────────────┤
│  Layer 2: SESSION MEMORY (in context, managed)      │
│  Conversation + Tool Results (adaptive masking)     │
│  + Rolling Summaries                                │
│  Tiered compression: 40% → mask, 60% → summarize,  │
│  80% → extract memories, 95% → full compaction      │
├─────────────────────────────────────────────────────┤
│  Layer 3: LONG-TERM MEMORY (Qdrant, searched)       │
│  Past Sessions + Error Patterns + Archived Facts    │
│  Searched on demand via semantic + keyword search    │
│  Synced from flat files at session boundaries        │
└─────────────────────────────────────────────────────┘
```

## Layer 1: Working Memory

### Task Anchor Block

Injected at both start and end of every prompt sent to Ollama. Prevents model drift.

```
[TASK] Create JSON schema validator in omar/
[STATUS] ✓ Directory created → ✓ File written → ⏳ Running tests
[STEP] Check test output, fix if failing
[CORRECTIONS] User: "use pydantic not jsonschema" (turn 3)
[PAST FIXES] This project: 2 similar validation errors fixed via schema update
[DO NOT] Search for observability. That question is resolved.
```

Fields:
- `[TASK]` — extracted from first user message of current topic, or from `/plan` goal
- `[STATUS]` — auto-updated after each tool call (file written? test passed? error hit?)
- `[STEP]` — what the model should do next (derived from task + current state)
- `[CORRECTIONS]` — user corrections from this session (max 5 most recent)
- `[PAST FIXES]` — relevant fix patterns from smart-fix bridge
- `[DO NOT]` — explicitly blocks revisiting resolved topics

Size: 100-300 tokens. Scales with model tier.

### Instructions Block

Loaded from flat files at session start:

```
[PROJECT] Express + SQLite ticketing system at C:\path\to\project
[BUILD] cd backend && npm run build
[TEST] cd backend && npm test
[STYLE] Use async/await not callbacks. No semicolons.
[USER] Prefers minimal fixes. Explain before making large changes.
```

Source: `project.json` (per-project) + `user.json` (global). Max 500 tokens combined.

### Recovery Directive

When a tool call fails, appended to the error response:

```
[RECOVERY] The write_file tool was blocked. Alternative: write to C:\Users\Attar\Desktop\omar\ instead.
Continue with the CURRENT task: Create JSON schema validator.
Do NOT change topic or search for unrelated content.
```

## Layer 2: Session Memory

### Adaptive Observation Masking

After the model responds, old tool results are evaluated:

- **>500 tokens, already responded to** → Mask to summary: `[read_file] src/auth.js → ✓ 247 lines, Express JWT middleware`
- **<500 tokens, already responded to** → Keep for 3 more turns, then mask
- **Current turn** → Always keep full
- **Error results** → Keep full for 5 turns

Estimated savings: ~10K tokens per 30-turn session.

### Tiered Compression

Replaces the current single cliff at 20 messages. Thresholds adapt to model size:

| Context Used | Small (<16K) | Medium (16-64K) | Large (>64K) | Action |
|---|---|---|---|---|
| Tier 1 | 35% | 40% | 50% | Mask all tool outputs older than 3 turns |
| Tier 2 | 50% | 60% | 70% | LLM summarizes old turns, keeping first + last 8 |
| Tier 3 | 70% | 80% | 85% | Force memory extraction before content is lost |
| Tier 4 | 90% | 95% | 95% | Full compaction: anchored summary + last 4 turns |

### Rolling Summary (Anchored Summary Technique)

Instead of one big summary that replaces everything, a rolling summary is maintained and appended to as each compression tier triggers:

```
[SESSION SUMMARY — updated at turn 42]
• Created Express backend with auth middleware (turns 1-15)
• Fixed 3 build errors: missing bcrypt, wrong import path, async handler (turns 16-25)
• User correction: "use pydantic not jsonschema" (turn 28)
• Currently: writing JSON schema validator in omar/ (turn 38)
[END SUMMARY]
```

### Turn Tracking

Every message gets metadata for masking and drift detection:

```javascript
{
  role: "assistant",
  content: "...",
  _turn: 15,
  _tokens: 340,
  _masked: false,
  _topic: "json-schema"
}
```

## Layer 3: Long-Term Memory (Qdrant Archive)

### Storage

Single new Qdrant collection `memories` with payload fields:

```javascript
{
  content: "User prefers pydantic over jsonschema for validation",
  memory_type: "correction" | "decision" | "error_pattern" | "project_fact" | "session_summary",
  scope: "global" | "project",
  project: "C:\\path\\to\\project",
  source_session: "02e99e5b",
  confidence: 0.85,
  created: "2026-03-28",
  last_validated: "2026-03-28",
  expires: "2026-04-25"
}
```

### What Gets Archived

| Source | When | Content |
|---|---|---|
| Memory extractor | After every exchange (async) | Extracted facts, corrections, decisions |
| Compaction | Context compresses | Dropped conversation summary |
| Session end | `/exit` or CLI close | Full session summary + working.json |
| Smart-fix | After successful fix | Fix recipe (unified with existing JSONL) |
| Error trending | After build errors | Error code + timestamp + resolution |

### Memory Lifecycle

- Created at confidence 1.0
- Decays: 0.7 at 7 days, 0.4 at 14 days, 0.2 at 21 days, expired at 28 days
- Re-validation (model uses it or user confirms) resets confidence to 1.0 and expiry to 28 days
- Effectively lives forever if useful

### Deduplication

Before storing, check Qdrant for >80% semantic similarity:
- Same fact → update timestamp, boost confidence, skip insert
- Contradicting fact → replace old with new, log change
- Related but different → store both

### Retrieval Triggers

1. Session start — project-scoped memories loaded into project.json
2. Error occurs — search for similar error patterns (bridges to smart-fix)
3. Model asks about past work — memory search triggered
4. Extractor finds a claim — validates against existing memories

## Memory Extractor (Model-Driven)

### Extraction Prompt

Sent to fast model (glm-4.7-flash) async after every exchange:

```
You are a memory extractor for a coding assistant. Given this exchange, extract ONLY facts worth remembering in future sessions. Output JSON array or empty array [].

Categories:
- correction: User corrected the assistant's approach
- decision: A design/architecture decision was made
- project_fact: Learned something about the project
- error_pattern: An error was fixed — root cause and fix
- user_pref: User expressed a preference

Rules:
- ONLY extract facts useful in FUTURE sessions
- Be specific: "User wants pydantic not jsonschema" NOT "User has preferences"
- Skip: greetings, acknowledgments, questions without answers, tool outputs
- Max 3 extractions per exchange
```

### Quality Gate

Before storing, each extraction is checked:
- Content length > 10 chars
- Not duplicate (Jaccard >0.8 with existing entries)
- Has valid type
- If type is `error_pattern`, also store in smart-fix JSONL

### Flow

```
User sends message → Model responds → Response shown
  ↓ (async, non-blocking)
Extract via fast LLM → Validate not duplicate → Store in working.json
  ↓ (at session end)
Flush to Qdrant archive
```

## Smart-Fix Integration

### Bridge: Memory → Smart-Fix

When a build error occurs:
1. Smart-fix classifies the error (existing)
2. Smart-fix searches JSONL + Qdrant for past fixes (existing)
3. **NEW**: Memory bridge queries project.json for:
   - Error frequency trending ("this error occurred 3 times this week")
   - Project technology context ("this project uses Express + SQLite")
   - User preferences ("prefers minimal fixes, not refactors")
4. All context injected into smart-fix prompt template
5. Model generates fix

### Bridge: Smart-Fix → Memory

After a fix succeeds:
1. Fix-learner records outcome in JSONL + Qdrant (existing)
2. **NEW**: Memory extractor captures "fixed X by doing Y" into working.json
3. **NEW**: Error trending updated in project.json
4. **NEW**: If same error fixed 3+ times → memory stores the pattern as project_fact

### Strategy Escalation

- After 2 failed attempts with same strategy → auto-escalate to next tier
- After Tier3 fails → flag to user "manual intervention needed"
- Cross-session: if same error pattern failed in previous sessions → skip Tier1, go straight to Tier3

### Error Trending (Cross-Session)

Stored in project.json:

```javascript
{
  error_trends: {
    "MODULE_NOT_FOUND": {
      occurrences: [
        { session: "abc123", date: "2026-03-25", fixed: true, strategy: "create_missing_file" },
        { session: "def456", date: "2026-03-27", fixed: true, strategy: "fix_import_path" },
        { session: "ghi789", date: "2026-03-28", fixed: false, strategy: "llm_edit" }
      ],
      last_seen: "2026-03-28",
      total: 3,
      success_rate: 0.67
    }
  }
}
```

After 3 sessions with same error: inject "SYSTEMIC: This error has recurred across 3 sessions. Previous fixes: X, Y, Z. Try a fundamentally different approach."

## Feedback Loops (12 Total)

### Existing (6 — unchanged)

1. **Edit loop** (line 2381): Same file edited 6+ times → blocks, redirects
2. **Build repeat** (line 3723): Same build error 3+ times → auto-searches web
3. **Bash retry** (line 2044): Same command fails 3x in 60s → stop
4. **Read loop** (line 2075): Same file read without changes → take action
5. **File create without build** (line 2357): 10+ files → build now
6. **Endpoint retry** (line 3372): Repeated failures → escalate

### New (6)

7. **Task anchor feedback** (working-memory.js): Tool result → updates [STATUS] and [STEP] → model sees correct next action
8. **Correction accumulation** (working-memory.js): User correction → stored in working.json → injected in [CORRECTIONS] every turn → persisted to project.json/user.json at session end
9. **Memory quality feedback** (memory-extractor.js): Memory injected → model follows it (boost confidence) or ignores it (decay confidence) → stale memories auto-expire
10. **Search repetition** (session-manager.js): Same KB query 3+ times → inject "Already searched for X. Result was Y. Move on."
11. **Topic drift** (working-memory.js): Tool args reference old task keywords → inject "WRONG TOPIC. Current task is: Z"
12. **Cross-session error trending** (smartfix-bridge.js + project.json): Same error pattern across 3+ sessions → escalate strategy, flag systemic issue

## Adaptive Budget Allocation

### Model Tier Detection

```javascript
const tier = CONFIG.numCtx <= 16384 ? 'small'
           : CONFIG.numCtx <= 65536 ? 'medium'
           : 'large';
```

Auto-detected on session start and when model changes via `/model`.

### Budget Distribution

| Component | Small (<16K) | Medium (16-64K) | Large (>64K) |
|---|---|---|---|
| System prompt | 400 (3%) | 500 (2%) | 600 (1%) |
| L1: Task anchor + instructions | 300 (2.5%) | 500 (2%) | 800 (1.5%) |
| L1: End-of-context reinforcement | 200 (1.5%) | 300 (1%) | 400 (0.7%) |
| Retrieved memories (Qdrant) | 500 (4%) | 1000 (3%) | 1500 (2.5%) |
| Conversation history | ~89% | ~92% | ~95% |

## Flat File Structure

```
~/.attar-code/
├── user.json                  # Global preferences (persistent)
├── fix-outcomes.jsonl         # Smart-fix hot cache (existing)
├── promoted-strategies.json   # Existing, unchanged
└── projects/
    └── {project-hash}/
        ├── project.json       # Project facts, build commands, error trends (persistent)
        └── working.json       # Session state, task anchor (reset each session, archived to Qdrant)
```

## Integration Points

> **Note:** All line numbers are as of 2026-03-28. Implementers must re-verify before modifying.

| Existing Component | Location | Integration |
|---|---|---|
| System prompt building | attar-code.js:6606 | L1 injected into sysPrompt + end-of-context block |
| Request to Ollama | attar-code.js:6776 | L1 reinforcement appended after last message |
| Context budget | attar-code.js:1575-1618 | Replaced by adaptive context-budget.js |
| Context compression | attar-code.js:1623-1704 | Replaced by tiered session-manager.js |
| MemoryStore class | attar-code.js:846-936 | Replaced by memory-store.js (flat files + Qdrant) |
| SESSION object | attar-code.js:480-492 | New fields: _taskAnchor, _corrections, _extractionQueue |
| Tool handler | attar-code.js:1900-3600 | Masking metadata + loop detection |
| KB search | search-proxy.js:241 | Also searches memories collection |
| Smart-fix engine | smart-fix/fix-engine/index.js | Accepts project context from bridge, strategy escalation |
| Fix learner | smart-fix/fix-engine/fix-learner.js | Unified storage, cross-session trending |
| System prompt template | prompt.txt | Memory-aware instructions |
| Hook: PostToolUse | attar-code.js | Triggers observation masking check |
| Hook: PreCompact | attar-code.js | Triggers memory extraction |
| Hook: SessionStart | attar-code.js | Loads flat files + async Qdrant sync |
| Hook: SessionEnd | attar-code.js | Final extraction + flush to Qdrant |

## New Files

| File | Responsibility |
|---|---|
| `memory/working-memory.js` | Task anchor, corrections, reinforcement blocks, topic drift detection, recovery directives |
| `memory/session-manager.js` | Observation masking, tiered compression, turn tracking, search repetition, rolling summaries |
| `memory/memory-extractor.js` | Async LLM extraction after every exchange, quality gate, dedup check |
| `memory/memory-store.js` | Flat files (working/project/user.json) + Qdrant archive, lifecycle, expiration |
| `memory/context-budget.js` | Adaptive allocation based on model size, compression thresholds |
| `memory/smartfix-bridge.js` | Error trending, strategy escalation, project patterns → fix prompts |

## Migration

On first run with new memory system:
1. Read existing `~/.attar-code/memory.json`
2. Filter out garbage entries (content < 20 chars, or containing greetings)
3. Classify remaining into user_pref → `user.json`, project_fact → `project.json`, error_solution → Qdrant
4. Archive original as `memory.json.bak`
5. Delete old `memory.json` and `MEMORY.md`

## Success Criteria

1. Model stays on task after tool errors (no topic drift)
2. Memory.json noise eliminated (only meaningful facts stored)
3. 10K+ tokens saved per 30-turn session via observation masking
4. Cross-session error patterns detected and escalated
5. Smart-fix prompts include project context from memory
6. All existing 12 feedback loops continue working
7. Works with all model sizes (8K-128K) via adaptive budgets
8. Qdrant dependency is optional — flat files work standalone

## Smart-Fix Bridge Interface

### `smartfixBridge.getContextForFix(errorCode, projectRoot)`

Returns project memory context to inject into fix prompts:

```javascript
{
  errorTrending: {
    occurrences: 3,
    lastSeen: "2026-03-27",
    successRate: 0.67,
    previousFixes: ["create_missing_file", "fix_import_path"],
    systemic: false  // true if 3+ sessions with same error
  },
  projectContext: {
    tech: "Express + SQLite",
    buildCommand: "cd backend && npm run build",
    style: "async/await, no semicolons"
  },
  userPrefs: {
    fixStyle: "minimal fixes, explain before large changes"
  }
}
```

**Integration into smart-fix:**
- `runFixEngine(fixPlan, tree, language, projectRoot, options)` receives this via `options.memoryContext`
- `prompt-template.js` interpolates `memoryContext.errorTrending` into a `[PROJECT CONTEXT]` section before the fix instructions
- `prompt-template.js` interpolates `memoryContext.userPrefs.fixStyle` into the instruction block

## Memory Extractor Output Schema

### Extraction JSON Format

Each extraction from the LLM produces:

```json
[
  {
    "type": "correction",
    "content": "User prefers pydantic over jsonschema for validation",
    "scope": "project"
  }
]
```

Valid types: `correction`, `decision`, `project_fact`, `error_pattern`, `user_pref`
Valid scopes: `global`, `project`

### Payload Mapping (extractor → storage)

`memory-store.js` fills in the remaining fields before writing:

| Field | Source |
|---|---|
| `content` | From extractor |
| `memory_type` | From extractor `type` |
| `scope` | From extractor `scope` |
| `project` | `SESSION.cwd` if scope is "project", null if "global" |
| `source_session` | `SESSION.id` |
| `confidence` | `1.0` (initial) |
| `created` | `new Date().toISOString()` |
| `last_validated` | Same as created |
| `expires` | `+28 days from created` |

## Qdrant Degradation Behavior

When Qdrant is unavailable, the system degrades gracefully:

| Failure Point | Behavior |
|---|---|
| **Session start** — Qdrant down | Use `project.json` + `user.json` only. Skip Qdrant memory retrieval. Log warning: "Qdrant unavailable — using local memory only." |
| **Session end** — flush to Qdrant fails | Leave `working.json` in place (don't delete). On next session start, retry flush of any leftover `working.json` entries. |
| **Dedup check** — Qdrant search fails | Write the memory anyway (accept possible duplicates). Log warning. Periodic cleanup deduplicates on next successful Qdrant connection. |
| **Smart-fix bridge** — Qdrant recipe search fails | Fall back to JSONL-only search (already the Tier 1-3 path). Log warning. |
| **Memory extraction** — Ollama slow/unavailable | Skip extraction for this exchange. Queue for retry on next exchange. After 3 consecutive failures, disable extraction until next session. |

## Search Repetition Tracking (Feedback Loop #10)

### Data Structure

```javascript
SESSION._kbQueryHistory = [
  { query: "observability invalid data", turn: 5, resultCount: 1, topResultHash: "abc123" },
  { query: "observability data choices", turn: 6, resultCount: 1, topResultHash: "abc123" },
  ...
];
```

### Interception Point

In the `kb_search` tool handler in `attar-code.js` (within the tool dispatch switch), after receiving results from search-proxy:

1. Compute query similarity (Jaccard) against last 5 entries in `_kbQueryHistory`
2. If similarity > 0.6 AND same `topResultHash` returned 3+ times:
   - Inject into tool result: `"⚠ You have searched for similar queries ${count} times with the same results. The answer is in the results above. Move on to the next step."`
   - Add to `[DO NOT]` block in task anchor: the query topic

### Eviction

`_kbQueryHistory` is capped at 20 entries (FIFO). Resets on `/clear`.

## Deduplication Pipeline (Two-Stage)

### Stage 1: Quality Gate (in-process, synchronous)

Before writing to `working.json`:
- Jaccard similarity against **`working.json` entries within current session only**
- Threshold: **0.6** (lowered from 0.8 — semantically equivalent facts often have low token overlap)
- If duplicate found: skip insert, log "duplicate skipped"

### Stage 2: Before Qdrant Insert (async, at session end)

Before flushing to Qdrant:
- Semantic cosine similarity via Qdrant search against `memories` collection
- Threshold: **0.80**
- If same fact: update timestamp + boost confidence on existing entry, skip insert
- If contradicting fact: replace old with new, log change
- If related but different: store both

## Migration (Updated)

On first run with new memory system:
1. Check for `~/.attar-code/memory.json` — if exists and no `migrated` flag in new files:
2. Read existing entries
3. Filter out garbage (content < 20 chars, or matching `/^(you |hello|hi |ok |yes|no )/i`)
4. Classify remaining: `user_pref` → `user.json`, `project_fact` → `project.json`, `error_solution` → Qdrant queue
5. Archive original as `memory.json.bak`
6. Write `migrated: true` flag in `user.json`
7. **Remove all references to old MemoryStore class** in `attar-code.js` — single atomic swap to new `memory-store.js`. No dual-write period. The old `memoryStore` variable is reassigned to the new module's instance.
8. Delete `MEMORY.md` (the new system does not write it)

## Project Hash Function

Projects are identified by MD5 hash of resolved absolute path:

```javascript
const crypto = require('crypto');
const projectHash = crypto.createHash('md5').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
// Example: ~/.attar-code/projects/a1b2c3d4e5f6/project.json
```

Truncated to 12 hex chars (48 bits — collision-safe for local use).

## Extractor Concurrency

The async memory extractor uses a **serial queue** to prevent concurrent writes to `working.json`:

```javascript
class ExtractionQueue {
  constructor() { this._queue = []; this._running = false; }

  enqueue(exchange) {
    this._queue.push(exchange);
    if (!this._running) this._drain();
  }

  async _drain() {
    this._running = true;
    while (this._queue.length > 0) {
      const exchange = this._queue.shift();
      await this._extract(exchange);  // LLM call + write to working.json
    }
    this._running = false;
  }
}
```

Only one extraction runs at a time. Queue drains in order. If CLI exits while queue has items, they're lost (acceptable — session-end extraction catches the full session anyway).

## Extractor Model Fallback

The extractor prefers a fast model for low latency:

1. Try `glm-4.7-flash:latest` (fast, small)
2. If not available, try `qwen2.5:7b` (small but capable)
3. If neither available, use the session's current model (`CONFIG.model`)
4. If all fail (Ollama down), skip extraction, log warning

Model availability is checked once at session start and cached.

## Task Anchor [DO NOT] Block Eviction

- Maximum **3 entries** in the `[DO NOT]` block
- When a 4th entry is added, the oldest is evicted (LRU)
- Entries are also evicted when the task anchor changes (new topic = clean slate)
- Each entry includes the turn number it was added, for age tracking

## Non-Goals

- No UI/frontend for memory browsing (CLI commands are sufficient)
- No cloud sync (everything local)
- No multi-user support
- No automatic memory sharing between projects (explicit only via user.json)
