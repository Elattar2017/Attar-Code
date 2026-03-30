#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║   attar-code v2 — Local AI CLI (Claude Code Edition)             ║
// ║   Works with any Ollama model                                    ║
// ║   node attar-code.js                                              ║
// ╚══════════════════════════════════════════════════════════════════╝

const readline = require("readline");
const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const crypto   = require("crypto");
const { execSync, spawn } = require("child_process");

// ── Smart-fix dependency tree (optional) ──
let smartFix;
try { smartFix = require("./smart-fix"); } catch (e) { smartFix = null; }

// ── Hint extractor (optional, part of smart-fix) ──
let extractHints;
try { extractHints = require("./smart-fix/hint-extractor").extractHints; } catch (_) {}

// Memory system modules
let SessionManager, ContextBudget;
try {
  ({ SessionManager } = require('./memory/session-manager'));
  ({ ContextBudget } = require('./memory/context-budget'));
} catch (_) { /* graceful degradation — old system still works */ }

// Working Memory (Layer 1: task anchoring & reinforcement)
let WorkingMemory;
try {
  ({ WorkingMemory } = require('./memory/working-memory'));
} catch (_) {}

// Memory Store, Extractor, SmartFix Bridge (Layer 3: persistent memory & error trending)
let MemoryFileStore, MemoryExtractor, SmartFixBridge;
try {
  ({ MemoryFileStore } = require('./memory/memory-store'));
  ({ MemoryExtractor } = require('./memory/memory-extractor'));
  ({ SmartFixBridge } = require('./memory/smartfix-bridge'));
} catch (_) {}

// ── Ignore File (.attar-code/ignore) ────────────────────────────────────────
// Files and directories Attar-Code should never read, write, or analyze.
let IGNORE_PATTERNS = [];
function loadIgnoreFile() {
  const paths = [
    path.join(process.cwd(), ".attar-code", "ignore"),
    path.join(HOME_DIR, "ignore"),
    path.join(__dirname, "defaults", "ignore"),
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, "utf-8").split("\n")
          .map(l => l.trim())
          .filter(l => l && !l.startsWith("#"));
        IGNORE_PATTERNS = [...new Set([...IGNORE_PATTERNS, ...lines])];
      }
    } catch { /* skip */ }
  }
}
// NOTE: loadIgnoreFile() is called AFTER HOME_DIR is defined (~line 200)

/**
 * Check if a file path should be ignored.
 * @param {string} filePath
 * @returns {boolean}
 */
function isIgnoredPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() || "";
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.endsWith("/")) {
      // Directory pattern: match directory segment in path
      if (normalized.includes("/" + pattern) || normalized.includes("/" + pattern.slice(0, -1) + "/")) return true;
    } else if (pattern.startsWith("*.")) {
      // Extension pattern: match file extension
      if (filename.endsWith(pattern.slice(1))) return true;
    } else if (pattern.startsWith("*")) {
      // Suffix wildcard: match end of filename
      if (filename.includes(pattern.slice(1))) return true;
    } else {
      // Exact filename match (not substring — ".env.local" should NOT match ".env.local.bak")
      if (filename === pattern || normalized.endsWith("/" + pattern)) return true;
    }
  }
  return false;
}

// ── Risk Levels for Action Classification ──
// safe: never ask | low: auto in balanced+ | medium: auto in autonomous | high: always ask | blocked: never
const RISK_LEVELS = {
  read_file: "safe", grep_search: "safe", find_files: "safe", get_project_structure: "safe",
  detect_build_system: "safe", check_environment: "safe", kb_search: "safe", kb_list: "safe",
  search_docs: "safe", web_search: "safe", session_search: "safe", recent_sessions: "safe",
  todo_write: "safe", todo_done: "safe", todo_list: "safe", memory_read: "safe", use_skill: "safe",
  get_server_logs: "safe", present_file: "safe",
  write_file: "low", edit_file: "low", build_and_test: "low", generate_tests: "low",
  setup_environment: "low", memory_write: "low",
  run_bash: "dynamic",  // evaluated per-command
  start_server: "medium", test_endpoint: "low",
  web_fetch: "medium", research: "medium", search_all: "medium", github_search: "medium", deep_search: "medium",
  kb_add: "medium",
  create_pdf: "low", create_docx: "low", create_excel: "low", create_pptx: "low", create_chart: "low",
};

/**
 * Get the risk level for a tool + command combination.
 * For run_bash, evaluates the actual command.
 */
function getRiskLevel(toolName, args) {
  const base = RISK_LEVELS[toolName] || "medium";
  if (base !== "dynamic") return base;
  // Dynamic: evaluate run_bash command
  const cmd = (args?.command || "").trim();
  if (isSafeCommand(cmd)) return "safe";
  if (requiresExplicitApproval(cmd)) return "high";
  if (/\b(rm|mv|cp|install|uninstall|upgrade|npm|pip|cargo|go get)\b/i.test(cmd)) return "medium";
  return "low"; // build, test, lint, etc.
}

/**
 * Check if current permission mode allows auto-approval for a risk level.
 */
function shouldAutoApprove(riskLevel) {
  const mode = CONFIG.permissionMode || "supervised";
  if (riskLevel === "safe") return true;
  if (riskLevel === "blocked") return false;
  if (mode === "supervised") return false; // ask for everything
  if (mode === "balanced") return riskLevel === "low"; // auto low, ask medium+
  if (mode === "autonomous") return riskLevel === "low" || riskLevel === "medium"; // auto low+medium, ask high
  if (mode === "locked") return false; // deny everything not in allow list
  return false;
}

/** Helper: is current mode auto-approving? Mode takes precedence over legacy flag. */
function isAutoMode() {
  // If permissionMode is explicitly set, it takes precedence over legacy autoApprove
  if (CONFIG.permissionMode && CONFIG.permissionMode !== "supervised") {
    return CONFIG.permissionMode === "autonomous";
  }
  return CONFIG.autoApprove === true;
}

// ── Platform-aware shell selection ──
const IS_WIN = process.platform === "win32";
const SHELL = IS_WIN ? process.env.COMSPEC || "cmd.exe" : "/bin/bash";
const SHELL_FLAG = IS_WIN ? "/c" : "-c";
const PYTHON = IS_WIN ? "python" : "python3";

// ── Plugin System (optional — falls back to existing behavior if not available) ──
let pluginRegistry;
try {
  const { PluginRegistry } = require('./plugins');
  pluginRegistry = new PluginRegistry({
    proxyUrl: 'http://localhost:3001',
    ollamaUrl: 'http://localhost:11434',
  });
  pluginRegistry.loadAll();
} catch (e) { pluginRegistry = null; }

// ══════════════════════════════════════════════════════════════════
// TUNING CONSTANTS
// ══════════════════════════════════════════════════════════════════
// Reduced from 40960 → 32768. Research shows 30B models degrade severely beyond 8K effective tokens.
// 32K is enough for the system prompt + conversation + tools, while reducing context rot.
const DEFAULT_NUM_CTX         = 32768;
const TOOL_TIMEOUT_MS         = 30000;
const THINKING_TIMEOUT_MS     = 120000;
const MAX_RESPONSE_TOKENS     = 4096;
const SEARCH_PROXY_PORT       = 3001;
const OLLAMA_DEFAULT_PORT     = 11434;
const MAX_RETRIES             = 5;
const CONTEXT_BUDGET_RATIO    = 0.75;  // 75% input, 25% response
const HOOK_TIMEOUT_S          = 30;
const MAX_CHECKPOINTS         = 20;
const MAX_SKILLS              = 3;
const MAX_SKILL_CHARS         = 4000;

// ══════════════════════════════════════════════════════════════════
// ANSI
// ══════════════════════════════════════════════════════════════════
const C = {
  reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m", italic:"\x1b[3m",
  under:"\x1b[4m",
  black:"\x1b[30m", red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m",
  blue:"\x1b[34m", magenta:"\x1b[35m", cyan:"\x1b[36m", white:"\x1b[37m",
  gray:"\x1b[90m",
  bRed:"\x1b[91m", bGreen:"\x1b[92m", bYellow:"\x1b[93m", bBlue:"\x1b[94m",
  bMagenta:"\x1b[95m", bCyan:"\x1b[96m", bWhite:"\x1b[97m",
  bgBlack:"\x1b[40m", bgRed:"\x1b[41m", bgGreen:"\x1b[42m", bgBlue:"\x1b[44m",
};
const W = () => process.stdout.columns || 80;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad   = (s, n) => s + " ".repeat(Math.max(0, n - strip(s).length));
const hr    = (ch="─", col=C.gray) => col + ch.repeat(W()) + C.reset;
const co    = (...p) => p.join("") + C.reset;

// ══════════════════════════════════════════════════════════════════
// CONFIG & PATHS
// ══════════════════════════════════════════════════════════════════
const HOME_DIR      = path.join(os.homedir(), ".attar-code");
const CONFIG_FILE   = path.join(HOME_DIR, "config.json");
const SESSIONS_DIR  = path.join(HOME_DIR, "sessions");
const CHECKPOINTS_DIR = path.join(HOME_DIR, "checkpoints");
const CMDS_DIR      = path.join(HOME_DIR, "commands");
const MEMORY_FILE   = path.join(HOME_DIR, "MEMORY.md");
const MEMORY_JSON   = path.join(HOME_DIR, "memory.json");
const PLANS_DIR     = path.join(HOME_DIR, "plans");

const SKILLS_DIR = path.join(HOME_DIR, "skills");
const OUTPUTS_DIR = path.join(HOME_DIR, "outputs");
for (const d of [HOME_DIR, SESSIONS_DIR, CHECKPOINTS_DIR, CMDS_DIR, PLANS_DIR, SKILLS_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Now that HOME_DIR exists, load ignore patterns
loadIgnoreFile();

const DEFAULTS_DIR = path.join(__dirname, "defaults");
const ERROR_PATTERNS_DIR = path.join(HOME_DIR, "error-patterns");
fs.mkdirSync(ERROR_PATTERNS_DIR, { recursive: true });

const DEBUG = process.env.ATTAR_CODE_DEBUG === "1";
function debugLog(...args) { if (DEBUG) console.error("[DEBUG]", ...args); }

// Bootstrap: copy defaults to ~/.attar-code/ on first run
function bootstrapDefaults() {
  // Copy error patterns if directory is empty
  try {
    const srcDir = path.join(DEFAULTS_DIR, "error-patterns");
    const destDir = ERROR_PATTERNS_DIR;
    if (fs.existsSync(srcDir)) {
      const existing = fs.readdirSync(destDir).filter(f => f.endsWith(".json"));
      if (existing.length === 0) {
        for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith(".json"))) {
          fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
        }
        debugLog(`Bootstrapped ${fs.readdirSync(srcDir).filter(f => f.endsWith(".json")).length} error pattern files`);
      }
    }
  } catch (err) { debugLog(err.message); }

  // Copy skills if directory is empty
  try {
    const srcDir = path.join(DEFAULTS_DIR, "skills");
    const destDir = SKILLS_DIR;
    if (fs.existsSync(srcDir)) {
      const existing = fs.readdirSync(destDir).filter(f => f.endsWith(".md"));
      if (existing.length === 0) {
        for (const f of fs.readdirSync(srcDir).filter(f => f.endsWith(".md"))) {
          fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
        }
        debugLog(`Bootstrapped ${fs.readdirSync(srcDir).filter(f => f.endsWith(".md")).length} skill files`);
      }
    }
  } catch (err) { debugLog(err.message); }

  // Copy dependency tree plugins if directory is empty
  try {
    const pluginSrcDir = path.join(DEFAULTS_DIR, "plugins");
    const pluginDestDir = path.join(HOME_DIR, "plugins");
    if (fs.existsSync(pluginSrcDir)) {
      if (!fs.existsSync(pluginDestDir)) fs.mkdirSync(pluginDestDir, { recursive: true });
      const existingPlugins = fs.readdirSync(pluginDestDir).filter(f => f.endsWith(".json"));
      if (existingPlugins.length === 0) {
        for (const f of fs.readdirSync(pluginSrcDir).filter(f => f.endsWith(".json"))) {
          fs.copyFileSync(path.join(pluginSrcDir, f), path.join(pluginDestDir, f));
        }
        debugLog("Bootstrapped dependency tree plugins");
      }
    }
  } catch (err) { debugLog(err.message); }

  // Copy prompt.txt if not exists
  try {
    const srcPrompt = path.join(DEFAULTS_DIR, "prompt.txt");
    const destPrompt = path.join(HOME_DIR, "prompt.txt");
    if (fs.existsSync(srcPrompt) && !fs.existsSync(destPrompt)) {
      fs.copyFileSync(srcPrompt, destPrompt);
      debugLog("Bootstrapped prompt.txt");
    }
  } catch (err) { debugLog(err.message); }
}
bootstrapDefaults();

// ══════════════════════════════════════════════════════════════════
// HOOK SYSTEM — deterministic automation at lifecycle points
// ══════════════════════════════════════════════════════════════════
class HookEngine {
  constructor() {
    this.hooks = {};
    this.loadHooks();
  }

  loadHooks() {
    this.hooks = {};
    // Load from global config
    try {
      const globalConf = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (globalConf.hooks) this.mergeHooks(globalConf.hooks);
    } catch (err) { debugLog(err.message); }
    // Load from project .attar-code/hooks.json
    try {
      const projHooks = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".attar-code", "hooks.json"), "utf-8"));
      if (projHooks) this.mergeHooks(projHooks);
    } catch (err) { debugLog(err.message); }
    // Load from project .attar-code/hooks.local.json
    try {
      const localHooks = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".attar-code", "hooks.local.json"), "utf-8"));
      if (localHooks) this.mergeHooks(localHooks);
    } catch (err) { debugLog(err.message); }
  }

  mergeHooks(newHooks) {
    for (const [event, matchers] of Object.entries(newHooks)) {
      if (!this.hooks[event]) this.hooks[event] = [];
      this.hooks[event].push(...(Array.isArray(matchers) ? matchers : [matchers]));
    }
  }

  async fire(eventName, context = {}) {
    const matchers = this.hooks[eventName] || [];
    if (matchers.length === 0) return { blocked: false };

    const matchField = this.getMatchField(eventName, context);

    for (const group of matchers) {
      const matcher = group.matcher || "";
      if (matcher && !new RegExp(matcher, "i").test(matchField)) continue;

      const hookList = group.hooks || [group];
      for (const hook of hookList) {
        if (!hook.type && !hook.command) continue;
        try {
          const result = await this.executeHook(hook, { ...context, hook_event_name: eventName });
          if (result.blocked) return { blocked: true, reason: result.reason, feedback: result.feedback };
          if (result.output) context._hookOutput = (context._hookOutput || "") + result.output;
        } catch (err) {
          debugLog(`Hook error (${eventName}):`, err.message);
        }
      }
    }
    return { blocked: false, output: context._hookOutput };
  }

  getMatchField(eventName, context) {
    if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(eventName)) {
      return context.tool_name || "";
    }
    if (["SessionStart", "SessionEnd"].includes(eventName)) {
      return context.trigger || "";
    }
    if (["PreCompact", "PostCompact"].includes(eventName)) {
      return context.trigger || "";
    }
    if (eventName === "ConfigChange") {
      return context.source || "";
    }
    if (eventName === "TaskCompleted") {
      return context.task_phase || "";
    }
    return context.type || "";
  }

  async executeHook(hook, context) {
    const type = hook.type || "command";
    if (type === "command") return this.runCommand(hook, context);
    return { blocked: false };
  }

  runCommand(hook, context) {
    return new Promise((resolve) => {
      const timeout = (hook.timeout || 30) * 1000;
      const isAsync = hook.async === true;

      try {
        const child = spawn(SHELL, [SHELL_FLAG, hook.command], {
          cwd: context.cwd || SESSION?.cwd || process.cwd(),
          timeout,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", d => { stdout += d.toString(); });
        child.stderr.on("data", d => { stderr += d.toString(); });

        // Pipe context as JSON via stdin
        try {
          child.stdin.write(JSON.stringify(context));
          child.stdin.end();
        } catch (err) { debugLog(err.message); }

        if (isAsync) {
          resolve({ blocked: false });
          return;
        }

        const killTimer = setTimeout(() => {
          try { child.kill(); } catch (err) { debugLog(err.message); }
          resolve({ blocked: false });
        }, timeout + 1000);

        child.on("close", (code) => {
          clearTimeout(killTimer);
          if (code === 2) {
            // Exit 2 = block action
            resolve({ blocked: true, reason: stderr.trim() || "Blocked by hook", feedback: stderr.trim() });
          } else if (code === 0) {
            // Try parsing JSON output for structured decisions
            let decision = null;
            try {
              decision = JSON.parse(stdout.trim());
            } catch (err) { debugLog(err.message); }

            if (decision?.decision === "deny") {
              resolve({ blocked: true, reason: decision.reason || "Denied by hook", feedback: decision.feedback });
            } else {
              resolve({ blocked: false, output: stdout.trim(), decision });
            }
          } else {
            // Other exit codes = log but continue
            debugLog(`Hook exited with code ${code}: ${stderr.trim()}`);
            resolve({ blocked: false });
          }
        });

        child.on("error", (err) => {
          clearTimeout(killTimer);
          debugLog(`Hook spawn error: ${err.message}`);
          resolve({ blocked: false });
        });

      } catch (err) {
        debugLog(`Hook command error: ${err.message}`);
        resolve({ blocked: false });
      }
    });
  }

  getActiveHooks() {
    const result = [];
    for (const [event, matchers] of Object.entries(this.hooks)) {
      for (const group of matchers) {
        const hookList = group.hooks || [group];
        for (const hook of hookList) {
          result.push({ event, matcher: group.matcher || "(all)", command: hook.command, async: hook.async || false });
        }
      }
    }
    return result;
  }
}

let hookEngine;
function initHookEngine() {
  hookEngine = new HookEngine();
}

const DEFAULT_CONFIG = {
  model:        null,  // auto-detect from Ollama on first run
  ollamaUrl:    "http://localhost:11434",
  temperature:  0.15,
  numCtx:       40960,
  systemPrompt: null, // loaded from prompt.txt at runtime
  autoApprove:  false,
  permissionMode: "supervised",  // supervised | balanced | autonomous | locked
  theme:        "dark",
  historySize:  50,
  proxyUrl:     "http://localhost:3001",   // search-proxy server
};

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) }; }
  catch (_) { return { ...DEFAULT_CONFIG }; }
}
function saveConfig() {
  // ConfigChange hook — can block config changes
  if (hookEngine) {
    try {
      const result = hookEngine.fire("ConfigChange", {
        session_id: SESSION?.id, cwd: SESSION?.cwd || process.cwd(),
        source: "user_settings", file_path: CONFIG_FILE,
      });
      // Note: fire is async but we don't await here to avoid breaking sync callers
      // For blocking, users should use PreToolUse hooks on config-modifying commands
    } catch (err) { debugLog(err.message); }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
}

let CONFIG = loadConfig();
// Sync legacy autoApprove with permissionMode (mode takes precedence on startup)
if (CONFIG.permissionMode) {
  CONFIG.autoApprove = (CONFIG.permissionMode === "autonomous");
}

// ── Permissions System ──────────────────────────────────────────────────────
// Loaded from: project-local .attar-code/permissions.json → user-global → bundled defaults
// Deny rules are ABSOLUTE — never overridden by any permission mode.
let PERMISSIONS = { allow: [], ask: [], deny: [] };
function loadPermissions() {
  const paths = [
    path.join(process.cwd(), ".attar-code", "permissions.json"),
    path.join(HOME_DIR, "permissions.json"),
    path.join(__dirname, "defaults", "permissions.json"),
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        // Merge: deny rules are cumulative (never weakened), allow/ask use first-found
        if (!PERMISSIONS._loaded) {
          PERMISSIONS = { ...data, _loaded: true };
        } else {
          // Stack deny rules from all levels
          PERMISSIONS.deny = [...new Set([...(PERMISSIONS.deny || []), ...(data.deny || [])])];
        }
      }
    } catch { /* skip unreadable */ }
  }
}
loadPermissions();

/**
 * Check if an action matches a permission rule.
 * Rules use "category:pattern" format with * wildcards.
 * @param {string} action  e.g., "bash:sudo rm -rf /" or "edit:.env.local" or "delete:temp.txt"
 * @param {string[]} rules  Array of "category:pattern" rules
 * @returns {boolean}
 */
function matchesPermissionRule(action, rules) {
  if (!rules || !Array.isArray(rules)) return false;
  const [cat, ...rest] = action.split(":");
  const detail = rest.join(":");
  for (const rule of rules) {
    const [rCat, ...rRest] = rule.split(":");
    const rDetail = rRest.join(":");
    if (rCat !== cat && rCat !== "*") continue;
    // Wildcard matching
    if (rDetail === "*") return true;
    if (rDetail.endsWith("*") && detail.startsWith(rDetail.slice(0, -1))) return true;
    if (rDetail.startsWith("*") && detail.endsWith(rDetail.slice(1))) return true;
    if (detail === rDetail) return true;
    if (detail.includes(rDetail.replace(/\*/g, ""))) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — loaded from prompt.txt with platform-aware placeholders
// ══════════════════════════════════════════════════════════════════
function loadSystemPrompt() {
  const osName = IS_WIN ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  const osUpper = osName.toUpperCase();
  const osCommands = IS_WIN
    ? "Windows commands: mkdir (no -p flag), dir (not ls), type (not cat), where (not which), del (not rm), backslashes in paths"
    : "Unix commands: mkdir -p, ls, cat, rm, which, forward slashes in paths";
  const whichCmd = IS_WIN ? "where" : "which";
  const pkgCheck = IS_WIN ? "where choco" : process.platform === "darwin" ? "which brew" : "which apt";
  const commonInstalls = IS_WIN
    ? "java → choco install temurin17 -y, maven → choco install maven -y, python → choco install python3 -y, node → choco install nodejs -y"
    : process.platform === "darwin"
    ? "java → brew install --cask temurin@17, maven → brew install maven, python → brew install python3, node → brew install node"
    : "java → sudo apt install openjdk-17-jdk -y, maven → sudo apt install maven -y, python → sudo apt install python3 -y, node → sudo apt install nodejs -y";

  // Build environment version block — use cached versions, fall back to bundled defaults/versions.json
  let envVersions = "";
  if (pluginRegistry) {
    try {
      const vr = pluginRegistry.versionResolver;
      let cached = vr.getAllCached();
      // If cache is empty, seed from bundled defaults/versions.json
      if (Object.keys(cached).length === 0) {
        try {
          const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "defaults", "versions.json"), "utf-8"));
          for (const [key, ver] of Object.entries(bundled)) {
            if (key !== "_meta" && typeof ver === "string") vr.updateCache(key, ver);
          }
          cached = vr.getAllCached();
        } catch { /* no bundled file */ }
      }
      if (Object.keys(cached).length > 0) {
        const lines = [];
        for (const [key, entry] of Object.entries(cached)) {
          if (!key.startsWith('_')) lines.push(`${key.replace(':', ' ')}: ${entry.version}`);
        }
        if (lines.length > 0) envVersions = "LATEST STABLE VERSIONS (use these for new projects):\n" + lines.slice(0, 15).join(", ");
      }
    } catch { /* no cached versions yet */ }
  }

  const placeholders = {
    "{{OS}}": osName,
    "{{OS_UPPER}}": osUpper,
    "{{OS_COMMANDS}}": osCommands,
    "{{WHICH_CMD}}": whichCmd,
    "{{PKG_CHECK}}": pkgCheck,
    "{{COMMON_INSTALLS}}": commonInstalls,
    "{{ENV_VERSIONS}}": envVersions,
  };

  // Try loading from multiple locations (project-local first, then global, then bundled)
  // Smart models (Nemotron, DeepSeek) get compact prompt; others get verbose prompt
  const modelName = (CONFIG.model || "").toLowerCase();
  const isSmartModel = modelName.includes("nemotron") || modelName.includes("deepseek");
  const promptFile = isSmartModel ? "prompt-nemotron.txt" : "prompt.txt";

  const promptPaths = [
    path.join(process.cwd(), ".attar-code", promptFile),         // project-local override
    path.join(HOME_DIR, promptFile),                              // user global override
    path.join(__dirname, promptFile),                              // bundled with CLI
    // Fallback to default prompt.txt if model-specific not found
    ...(isSmartModel ? [
      path.join(process.cwd(), ".attar-code", "prompt.txt"),
      path.join(HOME_DIR, "prompt.txt"),
      path.join(__dirname, "prompt.txt"),
    ] : []),
  ];

  for (const fp of promptPaths) {
    try {
      let prompt = fs.readFileSync(fp, "utf-8");
      for (const [key, val] of Object.entries(placeholders)) {
        prompt = prompt.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), val);
      }
      debugLog(`System prompt loaded from: ${fp} (${prompt.length} chars)`);
      return prompt;
    } catch (err) { debugLog(err.message); }
  }

  // Fallback if no prompt.txt found anywhere
  debugLog("No prompt.txt found, using minimal fallback");
  return `You are a local AI coding assistant on ${osName}. Call tools immediately to complete tasks. Use ${whichCmd} to check if commands exist before running them.`;
}

// ══════════════════════════════════════════════════════════════════
// SKILLS SYSTEM — inject expert knowledge based on task context
// ══════════════════════════════════════════════════════════════════
function loadSkill(name) {
  // Check project-local first, then global
  const localPath = path.join(SESSION.cwd, ".attar-code", "skills", `${name}.md`);
  const globalPath = path.join(SKILLS_DIR, `${name}.md`);
  try { return fs.readFileSync(localPath, "utf-8"); } catch (err) { debugLog(err.message); }
  try { return fs.readFileSync(globalPath, "utf-8"); } catch (err) { debugLog(err.message); }
  return null;
}

function matchSkills(userMessage) {
  // Skill trigger patterns — technology-agnostic
  const skillTriggers = [
    { name: "backend", patterns: /\b(api|rest|endpoint|server|express|flask|django|fastapi|spring|controller|route|middleware|auth|jwt|database|crud|microservice)\b/i },
    { name: "frontend", patterns: /\b(react|vue|svelte|angular|next|nuxt|component|page|layout|css|tailwind|html|ui|ux|form|button|modal|responsive|dom)\b/i },
    { name: "code-review", patterns: /\b(review|refactor|clean|optimize|improve|quality|lint|best.?practice|code.?smell|dry|solid)\b/i },
    { name: "ui-design", patterns: /\b(design|beautiful|modern|stunning|polished|premium|elegant|theme|dark.?mode|light.?mode|color|typography|spacing|animation|gradient)\b/i },
    { name: "testing", patterns: /\b(test|spec|assert|expect|jest|mocha|pytest|unittest|coverage|mock|stub|e2e|integration|unit)\b/i },
    { name: "devops", patterns: /\b(deploy|docker|ci|cd|pipeline|kubernetes|k8s|nginx|pm2|systemd|github.?action|workflow)\b/i },
    { name: "database", patterns: /\b(sql|postgres|mysql|mongo|redis|prisma|drizzle|sequelize|typeorm|migration|schema|query|index|relation)\b/i },
    { name: "security", patterns: /\b(security|xss|csrf|injection|sanitize|encrypt|hash|bcrypt|helmet|cors|rate.?limit|owasp|vulnerability)\b/i },
    { name: "performance", patterns: /\b(performance|optimize|cache|lazy|bundle|minify|compress|cdn|lighthouse|web.?vitals|memory.?leak|profil)\b/i },
    { name: "documentation", patterns: /\b(readme|document|jsdoc|swagger|openapi|changelog|comment|wiki)\b/i },
  ];

  const matched = [];
  for (const trigger of skillTriggers) {
    if (trigger.patterns.test(userMessage)) {
      const content = loadSkill(trigger.name);
      if (content) matched.push({ name: trigger.name, content });
    }
  }

  // Also check for custom skills — any .md file in skills dir with a #trigger line
  try {
    const globalSkills = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
    for (const file of globalSkills) {
      const name = file.replace(".md", "");
      if (matched.some(m => m.name === name)) continue; // already matched
      try {
        const content = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8");
        const triggerLine = content.match(/^#\s*trigger:\s*(.+)/im);
        if (triggerLine) {
          const pattern = new RegExp(triggerLine[1].trim(), "i");
          if (pattern.test(userMessage)) {
            matched.push({ name, content });
          }
        }
      } catch (err) { debugLog(err.message); }
    }
  } catch (err) { debugLog(err.message); }

  // Limit to 3 skills max, 4000 chars total
  let totalChars = 0;
  const selected = [];
  for (const skill of matched.slice(0, 3)) {
    if (totalChars + skill.content.length > 4000) break;
    totalChars += skill.content.length;
    selected.push(skill);
  }
  return selected;
}

// Load system prompt (override config if null)
if (!CONFIG.systemPrompt) {
  CONFIG.systemPrompt = loadSystemPrompt();
}

// ══════════════════════════════════════════════════════════════════
// SESSION STATE
// ══════════════════════════════════════════════════════════════════
let SESSION = {
  id:          crypto.randomBytes(4).toString("hex"),
  name:        null,
  messages:    [],
  cwd:         process.cwd(),
  startTime:   Date.now(),
  toolCount:   0,
  checkpoints: [],
  todoList:    [],
  planMode:    false,
  plan:        null,       // structured plan: { id, goal, status, phases[], created, updated }
  _depGraph:   null,       // smart-fix dependency tree manager
};

// Initialize session manager (if memory modules available)
let sessionManager = SessionManager ? new SessionManager({ numCtx: CONFIG.numCtx }) : null;
let workingMemory = WorkingMemory ? new WorkingMemory() : null;

let memoryFileStore = MemoryFileStore ? new MemoryFileStore({
  projectRoot: SESSION.cwd,
  sessionId: SESSION.id,
  legacyMemoryPath: path.join(os.homedir(), '.attar-code', 'memory.json'),
}) : null;

let memoryExtractor = MemoryExtractor ? new MemoryExtractor({
  onExtraction: (extractions) => {
    if (memoryFileStore) {
      for (const e of extractions) {
        memoryFileStore.addExtractedMemory(e);
        if (e.scope === 'global' && e.type === 'user_pref') {
          memoryFileStore.setUser('pref_' + Date.now(), e.content);
        } else if (e.scope === 'project') {
          memoryFileStore.setProject('fact_' + Date.now(), e.content);
        }
      }
    }
  },
}) : null;

let smartFixBridge = SmartFixBridge ? new SmartFixBridge() : null;
if (smartFixBridge && memoryFileStore) {
  const savedTrends = memoryFileStore.getProject('error_trends');
  if (savedTrends) smartFixBridge.importTrends(savedTrends);
}

// ══════════════════════════════════════════════════════════════════
// PERMISSION SYSTEM
// ══════════════════════════════════════════════════════════════════
// Commands that are always safe (auto-approved)
const SAFE_CMDS = new Set([
  "ls","cat","pwd","echo","which","whoami","date","uname","df","du",
  "git status","git log","git diff","git branch","grep","find","head",
  "tail","wc","tree","lsof","ps","env","printenv","node --version",
  "python3 --version","python --version","npm --version","git --version",
]);

function isSafeCommand(cmd) {
  const base = cmd.trim().split(/\s+/).slice(0,2).join(" ");
  if (SAFE_CMDS.has(base)) return true;
  if (SAFE_CMDS.has(cmd.trim().split(" ")[0])) return true;
  // read-only git commands
  if (/^git (status|log|diff|show|branch|tag|remote -v)/.test(cmd)) return true;
  return false;
}

let pendingApproval = null; // resolves when user types y/n

// Commands that require explicit confirmation even in --auto mode
function requiresExplicitApproval(cmd) {
  const installPatterns = /\b(choco\s+install|winget\s+install|apt\s+install|apt-get\s+install|brew\s+install|pip\s+install|npm\s+install\s+-g|cargo\s+install|snap\s+install|yum\s+install|dnf\s+install|pacman\s+-S)\b/i;
  const dangerousPatterns = /\b(rm\s+-rf|format|mkfs|dd\s+if=|shutdown|reboot|curl\s.*\|\s*sh|wget\s.*\|\s*sh)\b/i;
  return installPatterns.test(cmd) || dangerousPatterns.test(cmd);
}

async function askPermission(toolName, detail, args_for_diff) {
  return new Promise(async (resolve) => {
    const riskLevel = getRiskLevel(toolName, { command: detail });
    const action = `${toolName === "run_bash" ? "bash" : toolName === "write_file" || toolName === "edit_file" ? "edit" : toolName}:${String(detail).slice(0, 200)}`;

    // 1. DENY rules — absolute, never overridden
    if (matchesPermissionRule(action, PERMISSIONS.deny)) {
      console.log(co(C.bRed, `\n  ⊘ BLOCKED by deny rule: ${toolName}`));
      console.log(co(C.dim, `  Action "${String(detail).slice(0, 80)}" is in the deny list.`));
      console.log(co(C.dim, "  This rule cannot be overridden. Edit permissions.json to change.\n"));
      resolve(false);
      return;
    }

    // 2. BLOCKED risk level — never allowed
    if (riskLevel === "blocked") { resolve(false); return; }

    // 3. SAFE or auto-approved by permission mode
    if (riskLevel === "safe" || shouldAutoApprove(riskLevel)) { resolve(true); return; }

    // 4. ALLOW rules from permissions.json
    if (matchesPermissionRule(action, PERMISSIONS.allow)) { resolve(true); return; }

    // 5. Legacy autoApprove check (backward compat with --auto flag)
    const needsExplicit = requiresExplicitApproval(String(detail));
    if (!needsExplicit && isAutoMode()) { resolve(true); return; }

    stopSpinner();

    // 6. HIGH risk: install-specific prompt even in auto mode
    if (needsExplicit && isAutoMode()) {
      console.log();
      console.log(co(C.bgBlue, C.bWhite, " 📦 INSTALL REQUEST ") + co(C.dim, " Tool: ") + co(C.bold, toolName));
      console.log(co(C.dim, "  Command: ") + co(C.yellow, String(detail).slice(0, 200)));
      console.log(co(C.dim, "  This will install software on your system."));
      process.stdout.write(co(C.bCyan, "  Proceed? [y/N] ") + C.reset);
      pendingApproval = resolve;
      return;
    }

    // 7. LOCKED mode: deny everything not explicitly allowed
    if (CONFIG.permissionMode === "locked") {
      debugLog(`Locked mode: denied ${toolName} ${String(detail).slice(0, 80)}`);
      resolve(false);
      return;
    }
    // Check PreToolUse hooks for permission decisions
    if (hookEngine) {
      try {
        const hookResult = await hookEngine.fire("PermissionRequest", {
          tool_name: toolName, detail: String(detail), cwd: SESSION.cwd, session_id: SESSION.id,
        });
        if (hookResult.blocked) { resolve(false); return; }
        const decision = hookResult.output;
        if (decision) {
          try {
            const parsed = JSON.parse(decision);
            if (parsed.decision === "allow") { resolve(true); return; }
            if (parsed.decision === "deny") { resolve(false); return; }
          } catch (err) { debugLog(err.message); }
        }
      } catch (err) { debugLog(err.message); }
    }
    console.log();

    // Rich confirmation: show context based on tool type
    const riskColors = { low: C.bCyan, medium: C.bYellow, high: C.bRed };
    const riskLabel = riskLevel === "high" ? "HIGH RISK" : riskLevel === "medium" ? "MEDIUM" : "PERMISSION";
    const riskColor = riskColors[riskLevel] || C.bYellow;
    console.log(co(riskLevel === "high" ? C.bgRed : C.bgYellow, C.bWhite, ` ⚠ ${riskLabel} `) + co(C.dim, " Tool: ") + co(C.bold, toolName));
    console.log(co(C.dim, "  ") + co(C.yellow, String(detail).slice(0, 200)));

    // Show diff preview for edit_file
    if (toolName === "edit_file" && args_for_diff) {
      const { old_str, new_str } = args_for_diff;
      if (old_str && new_str) {
        console.log(co(C.dim, "  Changes:"));
        const oldLines = old_str.split("\n").slice(0, 3);
        const newLines = new_str.split("\n").slice(0, 3);
        for (const l of oldLines) console.log(co(C.bRed, `  - ${l.slice(0, 80)}`));
        for (const l of newLines) console.log(co(C.bGreen, `  + ${l.slice(0, 80)}`));
        if (old_str.split("\n").length > 3) console.log(co(C.dim, `  ... (${old_str.split("\n").length} lines total)`));
      }
    }

    // Show reversibility hint
    const isGitTracked = (() => { try { return !!execSync(`git ls-files "${String(detail).split("/").pop()}"`, { cwd: SESSION.cwd, encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 3000 }).trim(); } catch { return false; } })();
    if (riskLevel === "high" || riskLevel === "medium") {
      const rev = isGitTracked ? co(C.dim, "  Reversible: yes (git tracked)") : co(C.bYellow, "  ⚠ Not git tracked — changes may be difficult to reverse");
      console.log(rev);
    }

    process.stdout.write(co(riskColor, `  Allow? [y/N/always] `));
    pendingApproval = resolve;
  });
}

// ══════════════════════════════════════════════════════════════════
// CHECKPOINT SYSTEM (like Claude Code's /rewind)
// ══════════════════════════════════════════════════════════════════
function createCheckpoint(label) {
  const id    = `cp_${Date.now()}`;
  const files = {};

  // Snapshot all recently touched files
  const recentFiles = getRecentFiles();
  for (const fp of recentFiles) {
    try { files[fp] = fs.readFileSync(fp, "utf-8"); } catch (err) { debugLog(err.message); }
  }

  const cp = {
    id, label: label || `checkpoint-${SESSION.checkpoints.length + 1}`,
    time: new Date().toISOString(), files,
    messageCount: SESSION.messages.length,
    messages: SESSION.messages.slice(),    // full conversation snapshot
    todoList: JSON.parse(JSON.stringify(SESSION.todoList)),  // task snapshot
    cwd: SESSION.cwd,
  };

  SESSION.checkpoints.push(cp);

  // Save to disk
  const cpFile = path.join(CHECKPOINTS_DIR, `${id}.json`);
  fs.writeFileSync(cpFile, JSON.stringify(cp, null, 2));

  return cp;
}

function rewindToCheckpoint(indexOrId) {
  if (SESSION.checkpoints.length === 0) return null;

  let cp;
  if (typeof indexOrId === "number") {
    cp = SESSION.checkpoints[SESSION.checkpoints.length - 1 - indexOrId];
  } else {
    cp = SESSION.checkpoints.find(c => c.id === indexOrId);
  }
  if (!cp) return null;

  // Restore files
  for (const [fp, content] of Object.entries(cp.files)) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, "utf-8");
    } catch (err) { debugLog(err.message); }
  }

  // Restore conversation and task state
  if (cp.messages) {
    SESSION.messages = cp.messages.slice();
  } else {
    SESSION.messages = SESSION.messages.slice(0, cp.messageCount);
  }
  if (cp.todoList) {
    SESSION.todoList = JSON.parse(JSON.stringify(cp.todoList));
  }
  SESSION.cwd = cp.cwd;

  return cp;
}

function pruneCheckpoints() {
  try {
    const files = fs.readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith(".json")).sort();
    if (files.length <= 20) return; // Keep at least 20

    const now = Date.now();
    const oneHour = 3600000;
    const oneDay = 86400000;
    const oneWeek = 7 * oneDay;

    for (const f of files) {
      const fp = path.join(CHECKPOINTS_DIR, f);
      try {
        const cp = JSON.parse(fs.readFileSync(fp, "utf-8"));
        const age = now - new Date(cp.time).getTime();
        const isManual = !cp.label.startsWith("auto-") && !cp.label.startsWith("before:");

        // Keep: all manual, all < 1 hour, hourly < 1 day, daily < 1 week
        if (isManual) continue;
        if (age < oneHour) continue;
        if (age < oneDay) {
          // Keep one per hour
          const hour = new Date(cp.time).getHours();
          const otherSameHour = files.filter(of => {
            try {
              const ocp = JSON.parse(fs.readFileSync(path.join(CHECKPOINTS_DIR, of), "utf-8"));
              return new Date(ocp.time).getHours() === hour && of !== f;
            } catch (_) { return false; }
          });
          if (otherSameHour.length > 0) { fs.unlinkSync(fp); continue; }
        }
        if (age > oneWeek) {
          fs.unlinkSync(fp);
        }
      } catch (err) { debugLog(err.message); }
    }
  } catch (err) { debugLog(err.message); }
}

// Track which files Claude has touched in this session
const touchedFiles = new Set();
function getRecentFiles() { return [...touchedFiles].slice(-20); }
function trackFile(fp) { touchedFiles.add(fp); }
const readFilesThisTurn = new Set();

// ══════════════════════════════════════════════════════════════════
// TODO / TASK SYSTEM (like Claude Code's TodoWrite/TodoRead)
// ══════════════════════════════════════════════════════════════════
function addTodo(text, opts = {}) {
  const id = SESSION.todoList.length + 1;
  SESSION.todoList.push({
    id, text,
    status: "pending",     // pending, in_progress, done, blocked
    phase: opts.phase || "implement",
    dependsOn: opts.dependsOn || [],
    subtasks: [],
    parentId: opts.parentId || null,
    verification: opts.verification || null,
    created: new Date().toISOString(),
    started: null,
    completed: null,
  });
  return id;
}

function updateTodoStatus(id, status) {
  const t = SESSION.todoList.find(t => t.id === id);
  if (!t) return null;
  t.status = status;
  if (status === "in_progress" && !t.started) t.started = new Date().toISOString();
  if (status === "done") t.completed = new Date().toISOString();

  // Auto-unblock dependents
  if (status === "done") {
    for (const other of SESSION.todoList) {
      if (other.status === "blocked" && other.dependsOn.includes(id)) {
        const allDepsDone = other.dependsOn.every(depId =>
          SESSION.todoList.find(d => d.id === depId)?.status === "done"
        );
        if (allDepsDone) other.status = "pending";
      }
    }
  }
  return t;
}

function doneTodo(id) {
  return updateTodoStatus(id, "done");
}

function printTodos() {
  if (SESSION.todoList.length === 0) { console.log(co(C.dim, "  No tasks.")); return; }
  const statusIcon = { pending: co(C.dim, "○"), in_progress: co(C.bYellow, "►"), done: co(C.bGreen, "✓"), blocked: co(C.bRed, "⊘") };
  for (const t of SESSION.todoList) {
    const icon = statusIcon[t.status] || co(C.dim, "?");
    const text = t.status === "done" ? co(C.dim, t.text) : t.text;
    const phase = t.phase !== "implement" ? co(C.dim, ` [${t.phase}]`) : "";
    const deps = t.dependsOn.length > 0 ? co(C.dim, ` ←#${t.dependsOn.join(",#")}`) : "";
    console.log(`  ${icon} ${co(C.dim, String(t.id).padStart(2))}  ${text}${phase}${deps}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// PLAN SYSTEM — structured, persistent, phase-gated
// ══════════════════════════════════════════════════════════════════
function createPlan(goal) {
  const plan = {
    id: `plan_${Date.now()}`,
    goal,
    status: "planning",  // planning, reviewing, executing, verifying, done
    phases: [
      { name: "understand", description: "Read and explore the codebase" },
      { name: "design", description: "Plan the implementation" },
      { name: "implement", description: "Execute the plan step by step" },
      { name: "verify", description: "Test and validate the work" },
    ],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  SESSION.plan = plan;
  SESSION.planMode = true;
  savePlan(plan);
  return plan;
}

function savePlan(plan) {
  if (!plan) return;
  plan.updated = new Date().toISOString();
  const fp = path.join(PLANS_DIR, `${plan.id}.json`);
  try { fs.writeFileSync(fp, JSON.stringify(plan, null, 2)); } catch (err) { debugLog(err.message); }
}

function loadPlan(planId) {
  const fp = path.join(PLANS_DIR, `${planId}.json`);
  try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch (_) { return null; }
}

function getPlanPhasePrompt(plan) {
  if (!plan) return "";
  const phaseTasks = {};
  for (const t of SESSION.todoList) {
    if (!phaseTasks[t.phase]) phaseTasks[t.phase] = [];
    phaseTasks[t.phase].push(t);
  }

  // Find current active phase
  const phaseOrder = ["understand", "design", "implement", "verify"];
  let currentPhase = null;
  for (const phaseName of phaseOrder) {
    const tasks = phaseTasks[phaseName] || [];
    if (tasks.some(t => t.status !== "done")) {
      currentPhase = phaseName;
      break;
    }
  }

  if (!currentPhase) {
    // All phases done
    plan.status = "done";
    savePlan(plan);
    return "\n\n## Plan Complete ✓\nAll tasks in all phases are done. Summarize what was accomplished.";
  }

  plan.status = currentPhase === "planning" ? "planning" : currentPhase === "verify" ? "verifying" : "executing";
  savePlan(plan);

  const pendingTasks = (phaseTasks[currentPhase] || []).filter(t => t.status !== "done");
  const doneTasks = (phaseTasks[currentPhase] || []).filter(t => t.status === "done");

  const phaseRules = {
    understand: "PHASE: UNDERSTAND — Read and explore ONLY. Do NOT create or modify files.\nUse read_file, grep_search, find_files, get_project_structure.",
    design: "PHASE: DESIGN — Plan the implementation. Use todo_write to create tasks for each step.\nDo NOT start implementing yet. Just plan.",
    implement: "PHASE: IMPLEMENT — Execute the plan step by step.\nAfter completing each step, call todo_done with the task ID.",
    verify: "PHASE: VERIFY — Test and validate the work.\nRun tests, check for errors, verify the implementation matches the goal.",
  };

  let prompt = `\n\n## Active Plan: ${plan.goal}\n`;
  prompt += `${phaseRules[currentPhase] || ""}\n`;
  prompt += `\nPending tasks (${currentPhase}):\n`;
  prompt += pendingTasks.map(t => `- [ ] #${t.id} ${t.text}`).join("\n") || "(none)";
  if (doneTasks.length > 0) {
    prompt += `\nCompleted: ${doneTasks.length} tasks done in this phase.`;
  }

  return prompt;
}

function printPlanStatus(plan) {
  if (!plan) { console.log(co(C.dim, "\n  No active plan.\n")); return; }

  const allTasks = SESSION.todoList;
  const done = allTasks.filter(t => t.status === "done").length;
  const total = allTasks.length || 1;
  const pct = Math.round(done / total * 100);

  const barWidth = 30;
  const filled = Math.round(pct / 100 * barWidth);
  const bar = co(C.bGreen, "\u2588".repeat(filled)) + co(C.dim, "\u2591".repeat(barWidth - filled));

  console.log();
  console.log(co(C.bold, `  Plan: ${plan.goal}`));
  console.log(`  ${bar} ${pct}% (${done}/${total})`);
  console.log(co(C.dim, `  Status: ${plan.status}`));

  const phaseOrder = ["understand", "design", "implement", "verify"];
  for (const phaseName of phaseOrder) {
    const phaseTasks = allTasks.filter(t => t.phase === phaseName);
    const phaseDone = phaseTasks.filter(t => t.status === "done").length;
    const icon = phaseDone === phaseTasks.length && phaseTasks.length > 0 ? co(C.bGreen, "✓") :
                 phaseTasks.some(t => t.status === "in_progress") ? co(C.bYellow, "►") : co(C.dim, "○");
    console.log(`  ${icon} ${phaseName}: ${phaseDone}/${phaseTasks.length}`);
  }
  console.log();
}

// ══════════════════════════════════════════════════════════════════
// MEMORY SYSTEM — Structured, persistent, context-aware
// ══════════════════════════════════════════════════════════════════
class MemoryStore {
  constructor() {
    this.entries = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(MEMORY_JSON, "utf-8"));
      this.entries = data.entries || [];
    } catch (_) {
      // Migrate from old MEMORY.md if it exists
      try {
        const oldMem = fs.readFileSync(MEMORY_FILE, "utf-8").trim();
        if (oldMem) {
          this.entries = [{
            id: `mem_${Date.now()}`, type: "reference", scope: "global",
            content: oldMem, tags: ["migrated"], created: new Date().toISOString(),
            lastUsed: new Date().toISOString(), useCount: 0, source: "manual"
          }];
          this.save();
        }
      } catch (err) { debugLog(err.message); }
    }
  }

  save() {
    fs.writeFileSync(MEMORY_JSON, JSON.stringify({ version: 1, entries: this.entries }, null, 2));
    // Also export to MEMORY.md for human readability
    const md = this.entries.map(e => `## [${e.type}] ${e.tags.join(", ")}\n${e.content}\n`).join("\n");
    try { fs.writeFileSync(MEMORY_FILE, md); } catch (err) { debugLog(err.message); }
  }

  add(content, opts = {}) {
    const entry = {
      id: `mem_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
      type: opts.type || "reference",
      scope: opts.scope || "global",
      content,
      tags: opts.tags || [],
      created: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      useCount: 0,
      source: opts.source || "manual",
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  remove(id) {
    this.entries = this.entries.filter(e => e.id !== id);
    this.save();
  }

  selectRelevant(userMessage, maxTokens = 1500) {
    if (this.entries.length === 0) return [];
    const msgWords = new Set(userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 2));

    const scored = this.entries.map(entry => {
      const entryWords = new Set(
        (entry.content + " " + entry.tags.join(" ")).toLowerCase().split(/\W+/)
      );
      const overlap = [...msgWords].filter(w => entryWords.has(w)).length;
      const daysSinceUsed = (Date.now() - new Date(entry.lastUsed).getTime()) / 86400000;
      return { entry, score: overlap * 2 + entry.useCount * 0.5 - daysSinceUsed * 0.1 };
    });

    scored.sort((a, b) => b.score - a.score);

    let tokens = 0;
    const selected = [];
    for (const { entry } of scored) {
      const entryTokens = estimateTokens(entry.content);
      if (tokens + entryTokens > maxTokens) break;
      tokens += entryTokens;
      entry.lastUsed = new Date().toISOString();
      entry.useCount++;
      selected.push(entry);
    }
    if (selected.length > 0) this.save();
    return selected;
  }

  getAll() { return this.entries; }

  getFormatted() {
    if (this.entries.length === 0) return "";
    return this.entries.map(e => `[${e.type}] ${e.content}`).join("\n");
  }
}

let memoryStore;
// Initialize after CONFIG is loaded
function initMemoryStore() {
  memoryStore = new MemoryStore();
}

// Legacy compat wrappers
function readMemory() {
  if (!memoryStore) initMemoryStore();
  return memoryStore.getFormatted();
}

function writeMemory(content, scope = "global") {
  if (!memoryStore) initMemoryStore();
  memoryStore.add(content, { scope, source: "manual" });
}

// ══════════════════════════════════════════════════════════════════
// CUSTOM SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════
function loadCustomCommands() {
  const cmds = {};
  // Global commands
  try {
    for (const f of fs.readdirSync(CMDS_DIR)) {
      if (f.endsWith(".md")) {
        const name = "/" + f.replace(".md","");
        cmds[name] = fs.readFileSync(path.join(CMDS_DIR, f), "utf-8");
      }
    }
  } catch (err) { debugLog(err.message); }
  // Project commands (.lama/commands/)
  const localCmdsDir = path.join(SESSION.cwd, ".lama", "commands");
  try {
    for (const f of fs.readdirSync(localCmdsDir)) {
      if (f.endsWith(".md")) {
        const name = "/" + f.replace(".md","");
        cmds[name] = fs.readFileSync(path.join(localCmdsDir, f), "utf-8");
      }
    }
  } catch (err) { debugLog(err.message); }
  return cmds;
}

// ══════════════════════════════════════════════════════════════════
// TOOLS
// ══════════════════════════════════════════════════════════════════
const TOOLS = [
  // ── Core Primitives ──────────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "run_bash",
      description: `Run any shell command. This is your most versatile tool — use it for everything that doesn't have a dedicated tool.

USE FOR: git (status, add, commit, push, log, diff, branch, checkout), package management (npm install, pip install, yarn add, cargo add), running tests (npm test, pytest, go test, jest), running scripts (python3 script.py, node script.js), creating directories (mkdir -p), deleting files (rm), checking ports (lsof -i :PORT), installing dependencies, running builds (npm run build, tsc), docker, testing APIs with curl.

DO NOT USE FOR: reading files (use read_file), editing files (use edit_file), creating files with content (use write_file), searching inside files (use grep_search), finding files (use find_files), fetching web pages (use web_fetch).

RULES: Use absolute paths. Quote paths with spaces. Chain commands with &&. If a command fails, try a DIFFERENT approach. For long-running servers, use start_server instead.`,
      parameters: { type:"object", properties: {
        command: { type:"string", description:"Shell command to execute" },
        cwd:     { type:"string", description:"Override working directory (optional)" }
      }, required:["command"] }
    }
  },
  {
    type: "function", function: {
      name: "read_file",
      description: `Read the contents of any file. Automatically handles different formats: source code, plain text, PDF (.pdf), Word (.docx), and Excel (.xlsx/.xls).

USE FOR: reading source code before editing (REQUIRED before edit_file), reading config files, reading PDFs, reading Word docs, reading Excel spreadsheets, examining any file.

DO NOT USE FOR: searching across many files (use grep_search), finding files by name (use find_files).

RULES: You MUST read a file BEFORE editing it with edit_file. For large files (1000+ lines), use offset and limit. Results include line numbers.`,
      parameters: { type:"object", properties: {
        filepath:  { type:"string", description:"Path to the file to read" },
        offset: { type:"number", description:"Line number to start reading from (for large files)" },
        limit:   { type:"number", description:"Number of lines to read (for large files)" }
      }, required:["filepath"] }
    }
  },
  {
    type: "function", function: {
      name: "write_file",
      description: `Create a new file or completely overwrite an existing file with new content.

USE FOR: creating new source code files, config files, any new file that doesn't exist yet, or completely rewriting a file.

DO NOT USE FOR: making small changes to existing files (use edit_file instead — it's safer, preserves the rest of the file).

RULES: PREFER edit_file for existing files. Include complete working content, not placeholders. Create parent directories first with run_bash mkdir -p if needed.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Path for the new file" },
        content:  { type:"string", description:"Complete file content" }
      }, required:["filepath","content"] }
    }
  },
  {
    type: "function", function: {
      name: "edit_file",
      description: `Replace a specific text string in an existing file. This is the PREFERRED way to modify files — only changes what you specify, preserves everything else.

USE FOR: fixing bugs, adding code, changing imports, updating config values, any change to an existing file.

DO NOT USE FOR: creating new files (use write_file), complete rewrites (use write_file).

RULES: MUST read_file FIRST to see actual content. old_str must match EXACTLY including whitespace/indentation. old_str must be UNIQUE in the file — include more context if not. If it fails, read_file again and retry with correct text.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Path to the file to edit" },
        old_str:  { type:"string", description:"Exact text currently in the file to replace (must be unique)" },
        new_str:  { type:"string", description:"New text to replace old_str with (must be different)" }
      }, required:["filepath","old_str","new_str"] }
    }
  },
  {
    type: "function", function: {
      name: "grep_search",
      description: `Search file contents using regex patterns. Returns matching lines with file paths and line numbers.

USE FOR: finding where functions/variables are defined, finding all usages across the project, searching for error messages, finding TODOs, locating imports.

DO NOT USE FOR: finding files by name (use find_files), reading a known file (use read_file), searching the web (use web_search).

RULES: Use simple patterns first. After finding a match, use read_file to see full context around the line.`,
      parameters: { type:"object", properties: {
        pattern:     { type:"string", description:"Regex pattern to search for" },
        dirpath:     { type:"string", description:"Directory to search in (default: cwd)" },
        include:     { type:"string", description:"File extension filter e.g. '*.js' or '*.py'" },
        max_results: { type:"number", description:"Max results (default 20)" }
      }, required:["pattern"] }
    }
  },
  {
    type: "function", function: {
      name: "find_files",
      description: `Find files matching a glob pattern. Returns file paths sorted by modification time.

USE FOR: finding all JS files (**/*.js), test files (**/*.test.js), config files (**/package.json), files by name (**/server.js).

DO NOT USE FOR: searching inside files (use grep_search), reading files (use read_file).`,
      parameters: { type:"object", properties: {
        pattern:  { type:"string", description:"Glob pattern e.g. '**/*.js' or 'src/**/*.ts'" },
        dirpath:  { type:"string", description:"Directory to search in (default: cwd)" }
      }, required:["pattern"] }
    }
  },
  {
    type: "function", function: {
      name: "get_project_structure",
      description: `Get the complete file/directory tree of the current project. Skips node_modules, .git, dist, build, __pycache__, etc.

USE FOR: understanding project layout, finding where files are organized, getting an overview before making changes. Use as FIRST step in unfamiliar projects.`,
      parameters: { type:"object", properties: {
        dirpath: { type:"string", description:"Directory (default: cwd)" },
        depth:   { type:"number", description:"Max depth (default 4)" }
      }}
    }
  },

  // ── Process Management ──────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "start_server",
      description: `Start a long-running process in the background (dev servers, Docker containers). The process continues running after the tool returns.

USE FOR: starting dev servers (npm run dev, python app.py, go run main.go), Docker containers.

DO NOT USE FOR: commands that finish quickly (builds, tests, installs) — use run_bash instead.

RULES: After starting, test with run_bash: curl http://localhost:PORT. If port is in use, check with run_bash: lsof -i :PORT.`,
      parameters: { type:"object", properties: {
        command: { type:"string", description:"Command to start server" },
        port:    { type:"number", description:"Port the server will listen on" },
        cwd:     { type:"string", description:"Working directory" }
      }, required:["command"] }
    }
  },

  // ── Web & Research ──────────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "web_search",
      description: `Search the web using DuckDuckGo. Returns titles, URLs, and text snippets. No API key needed.

USE FOR: finding documentation/tutorials, researching libraries/APIs, looking up error messages, finding implementation examples, getting current information.

DO NOT USE FOR: searching LOCAL documents/knowledge base (use kb_search), reading a URL you already have (use web_fetch), searching project files (use grep_search).

WORKFLOW: After getting results, use web_fetch on the most relevant 1-2 URLs to read full content. Don't fetch all results. If results aren't good, try different keywords.`,
      parameters: { type:"object", properties: {
        query: { type:"string", description:"Search query — be specific" },
        num:   { type:"number", description:"Number of results (default 5)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "web_fetch",
      description: `Fetch a URL and return clean readable text plus code examples. Strips HTML noise (nav, ads, sidebars). Extracts code blocks with language detection.

USE FOR: reading docs found via web_search, reading GitHub READMEs, StackOverflow answers, blog posts, tutorials, any web page.

DO NOT USE FOR: searching the web (use web_search first to find URLs), testing APIs with POST/PUT (use run_bash with curl), reading local files (use read_file).

RULES: Response includes cleaned text AND code examples in markdown blocks. Use after web_search to read full content of relevant results.`,
      parameters: { type:"object", properties: {
        url:       { type:"string", description:"Full URL to fetch (http:// or https://)" },
        max_chars: { type:"number", description:"Max chars to return (default 12000)" }
      }, required:["url"] }
    }
  },
  {
    type: "function", function: {
      name: "search_docs",
      description: "Search official documentation for a technology. Targets the right docs site automatically. Use for TypeScript errors (TS2749), Express middleware, React hooks, Go packages, Rust traits, Python stdlib.",
      parameters: { type:"object", properties: {
        tech: { type:"string", description:"typescript, react, express, nodejs, nextjs, go, rust, python, java, prisma" },
        query: { type:"string", description:"Error code or API to look up, e.g. 'TS2749 refers to value used as type'" }
      }, required:["tech","query"] }
    }
  },
  {
    type: "function", function: {
      name: "deep_search",
      description: "Deep search: searches the web, fetches top results in full, extracts relevant code/content, and synthesizes findings. Use for complex errors, unfamiliar APIs, or when web_search snippets aren't enough. More thorough than web_search but slower.",
      parameters: { type:"object", properties: {
        query: { type:"string", description:"Search query — be specific, include technology name and error message" },
        num_results: { type:"number", description:"Number of pages to fetch in full (default: 3, max: 5)" },
        follow_up_query: { type:"string", description:"Optional refined query if first results aren't relevant" }
      }, required:["query"] }
    }
  },

  // ── Knowledge Base ──────────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "kb_search",
      description: `Search your LOCAL knowledge base using semantic (meaning-based) search. The KB contains documents YOU have indexed — PDFs, books, notes, code files added with kb_add.

USE FOR: when user asks about "my documents", "my notes", "my books", "that PDF I added", or references a specific document they've previously added.

DO NOT USE FOR: searching the web for general info (use web_search), searching project source code (use grep_search), reading a file by path (use read_file).

RULES: Results include relevance score (0-1) and source filename. If no results, suggest adding documents with kb_add. Check kb_list first to see what's available.`,
      parameters: { type:"object", properties: {
        query: { type:"string", description:"What to search for in the knowledge base" },
        language: { type:"string", description:"Filter by programming language (optional)" },
        doc_type: { type:"string", description:"Filter: api, tutorial, reference, fix, or all (optional)" },
        collection: { type:"string", description:"Search specific collection (optional, auto-detected)" },
        num:   { type:"number", description:"Max results (default 5)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "kb_add",
      description: "Add a file to the local knowledge base for semantic search with kb_search. Supports: PDF, TXT, MD, source code (.py, .js, .ts, .java, .go). The file is chunked, embedded, and stored.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Absolute path to file to add" }
      }, required:["filepath"] }
    }
  },
  {
    type: "function", function: {
      name: "kb_list",
      description: "List all documents indexed in the local knowledge base. Shows filenames, types, source paths, and total chunk count. Use to check what's in the KB before searching.",
      parameters: { type:"object", properties: {} }
    }
  },
  {
    type: "function", function: {
      name: "research",
      description: "Deep research on a topic. Automatically searches the web, fetches top results, and combines everything into a comprehensive answer. Use for complex questions requiring multiple sources.",
      parameters: { type:"object", properties: {
        query: { type:"string", description:"Research topic or question" },
        num_search: { type:"number", description:"Number of search results (default: 5)" },
        num_fetch: { type:"number", description:"Number of pages to fetch in full (default: 2)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "search_all",
      description: "Combined search across web AND local knowledge base. Returns results from both sources ranked by relevance. Use when you want both internet results and local docs.",
      parameters: { type:"object", properties: {
        query: { type:"string", description:"Search query" },
        num: { type:"number", description:"Number of results per source (default: 3)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "github_search",
      description: "Search GitHub for code examples, repositories, and projects. Use when building features and need reference implementations or examples.",
      parameters: { type:"object", properties: {
        query: { type:"string", description:"GitHub search query" },
        type: { type:"string", description:"'repositories' or 'code' (default: repositories)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "present_file",
      description: "Present a created file to the user. Copies it to the outputs directory and shows the path. Use after creating documents, reports, or any file the user should access.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Path to the file to present" },
        description: { type:"string", description:"Brief description of the file" }
      }, required:["filepath"] }
    }
  },

  // ── Document Creation ──────────────────────────────────────────────────────
  {
    type: "function", function: {
      name: "create_pdf",
      description: `Create a PDF document from markdown-formatted content. Supports headings, paragraphs, lists, code blocks.

USE FOR: creating reports, summaries, documentation, invoices. DO NOT USE FOR: creating source code files (use write_file).

RULES: filepath is REQUIRED. content must be the ACTUAL text in markdown format, NOT instructions like "write a summary". For summarizing a file: first read_file, then compose summary text, then create_pdf with the summary as content.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output PDF path (must end in .pdf)" },
        content:  { type:"string", description:"Actual text content in markdown format" },
        title:    { type:"string", description:"Document title (optional)" },
        author:   { type:"string", description:"Author name (optional)" }
      }, required:["filepath","content"] }
    }
  },
  {
    type: "function", function: {
      name: "create_docx",
      description: "Create a Word document (.docx) from markdown content. Supports headings, paragraphs, bold, bullet/numbered lists, code blocks, page breaks (---). RULES: filepath REQUIRED, content must be actual text not instructions.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output path (must end in .docx)" },
        content:  { type:"string", description:"Actual text content in markdown format" },
        title:    { type:"string", description:"Document title (optional)" }
      }, required:["filepath","content"] }
    }
  },
  {
    type: "function", function: {
      name: "create_excel",
      description: `Create an Excel spreadsheet (.xlsx). Accepts data as array of objects OR sheets format.

SIMPLE FORMAT: data as array of objects — [{"Name":"Alice","Age":30},{"Name":"Bob","Age":25}] — headers auto-extracted from keys.
ADVANCED FORMAT: sheets as JSON — [{"name":"Sheet1","headers":["Name","Age"],"rows":[["Alice",30],["Bob",25]]}].

RULES: filepath REQUIRED. Use simple format when possible.`,
      parameters: { type:"object", properties: {
        filepath:   { type:"string", description:"Output path (must end in .xlsx)" },
        data:       { type:"string", description:"JSON array of objects e.g. [{\"Name\":\"Alice\",\"Age\":30}]" },
        sheets:     { type:"string", description:"JSON array of sheets (advanced format)" },
        sheet_name: { type:"string", description:"Sheet name (default: Sheet1)" }
      }, required:["filepath"] }
    }
  },
  {
    type: "function", function: {
      name: "create_pptx",
      description: "Create a PowerPoint presentation (.pptx). Each slide has a title and bullet points. RULES: filepath REQUIRED, slides is JSON array of {title, bullets:[...]}.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output path (must end in .pptx)" },
        slides:   { type:"string", description:"JSON array: [{\"title\":\"Welcome\",\"bullets\":[\"Point 1\",\"Point 2\"]}]" },
        title:    { type:"string", description:"Presentation title (optional)" },
        author:   { type:"string", description:"Author (optional)" }
      }, required:["filepath","slides"] }
    }
  },
  {
    type: "function", function: {
      name: "create_chart",
      description: "Create a chart/graph as PNG image. Types: bar, line, pie, scatter. Supports multi-series. RULES: filepath REQUIRED, labels and values are JSON arrays.",
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Output path (must end in .png)" },
        type:     { type:"string", description:"Chart type: bar, line, pie, scatter" },
        title:    { type:"string", description:"Chart title" },
        labels:   { type:"string", description:"JSON array of labels" },
        values:   { type:"string", description:"JSON array of values or [[series1],[series2]] for multi-series" },
        xlabel:   { type:"string", description:"X-axis label (optional)" },
        ylabel:   { type:"string", description:"Y-axis label (optional)" },
        legend:   { type:"string", description:"JSON array of series names (optional)" }
      }, required:["filepath","type","labels","values"] }
    }
  },
  // ── Planning & Memory tools ──
  {
    type: "function", function: {
      name: "todo_write",
      description: "Add a task to the TODO list for tracking multi-step work. Use when planning or breaking down complex tasks.",
      parameters: { type:"object", properties: {
        text: { type:"string", description:"Task description" }
      }, required:["text"] }
    }
  },
  {
    type: "function", function: {
      name: "todo_done",
      description: "Mark a TODO task as completed by its ID number.",
      parameters: { type:"object", properties: {
        id: { type:"number", description:"Task ID to mark done" }
      }, required:["id"] }
    }
  },
  {
    type: "function", function: {
      name: "todo_list",
      description: "List all current TODO tasks with their status (done/pending). Use to check progress.",
      parameters: { type:"object", properties: {} }
    }
  },
  {
    type: "function", function: {
      name: "memory_write",
      description: "Save important information to persistent memory (survives across sessions). Use for user preferences, project facts, or lessons learned.",
      parameters: { type:"object", properties: {
        content: { type:"string", description:"Information to remember" },
        scope:   { type:"string", description:"'global' (all projects) or 'project' (this directory only). Default: global" }
      }, required:["content"] }
    }
  },
  {
    type: "function", function: {
      name: "memory_read",
      description: "Read the current persistent memory contents.",
      parameters: { type:"object", properties: {} }
    }
  },
  {
    type: "function", function: {
      name: "memory_edit",
      description: "Edit persistent memory. Commands: 'remove' (delete by ID), 'search' (find memories by keyword). Use memory_write to add and memory_read to view all.",
      parameters: { type:"object", properties: {
        command: { type:"string", description:"'remove' or 'search'" },
        id: { type:"string", description:"Memory ID to remove (for 'remove' command)" },
        query: { type:"string", description:"Search query (for 'search' command)" }
      }, required:["command"] }
    }
  },
  // ── Session History tools ──
  {
    type: "function", function: {
      name: "session_search",
      description: "Search past conversation sessions by keyword. Use when user references past work, says 'we discussed', 'continue from', or assumes shared context.",
      parameters: { type:"object", properties: {
        query: { type:"string", description:"Keywords to search for in past sessions" },
        max_results: { type:"number", description:"Max results to return (default: 5)" }
      }, required:["query"] }
    }
  },
  {
    type: "function", function: {
      name: "recent_sessions",
      description: "List recent conversation sessions. Use when user asks about recent work, 'what did we do last time', or wants to continue a previous session.",
      parameters: { type:"object", properties: {
        count: { type:"number", description:"Number of recent sessions to list (default: 5, max: 20)" }
      } }
    }
  },

  // ── Testing & Validation tools ──
  {
    type: "function", function: {
      name: "test_endpoint",
      description: "Test an HTTP endpoint. Makes request, checks status code, validates response body. Returns PASS/FAIL. Use after starting a server to verify endpoints work. Works with any technology.",
      parameters: { type:"object", properties: {
        url: { type:"string", description:"Full URL e.g. http://localhost:3000/api/users" },
        method: { type:"string", description:"GET/POST/PUT/DELETE/PATCH (default: GET)" },
        headers: { type:"string", description:"JSON headers e.g. {\"Authorization\":\"Bearer token\"}" },
        body: { type:"string", description:"JSON request body for POST/PUT" },
        expected_status: { type:"number", description:"Expected HTTP status (default: 200)" },
        expected_body: { type:"string", description:"JSON fields to assert e.g. {\"success\":true}" },
        timeout: { type:"number", description:"Timeout ms (default: 5000)" }
      }, required:["url"] }
    }
  },
  {
    type: "function", function: {
      name: "get_server_logs",
      description: "Get stdout/stderr from servers started with start_server. Use when API returns 500 to see the real server-side error. Only works for servers started in this session.",
      parameters: { type:"object", properties: {
        port: { type:"number", description:"Server port (omit for all servers)" },
        lines: { type:"number", description:"Last N lines (default: 50)" }
      } }
    }
  },
  {
    type: "function", function: {
      name: "detect_build_system",
      description: "Detect project type and return exact build/test/start/lint commands. Works for Node.js, Python, Java/Maven/Gradle, Go, Rust, C/C++. Use before building to find the correct commands.",
      parameters: { type:"object", properties: {
        dirpath: { type:"string", description:"Directory to detect (default: cwd)" }
      } }
    }
  },
  {
    type: "function", function: {
      name: "build_and_test",
      description: "Auto-detect build system, install deps, build, then run tests. Reports PASS/FAIL for each stage. Use after creating all project files to verify everything works.",
      parameters: { type:"object", properties: {
        dirpath: { type:"string", description:"Project directory (default: cwd)" },
        skip_build: { type:"boolean", description:"Only run tests" },
        skip_test: { type:"boolean", description:"Only build" }
      } }
    }
  },
  {
    type: "function", function: {
      name: "use_skill",
      description: "Load and activate a skill by name. Skills provide expert knowledge and best practices. Use when you need specialized guidance (e.g., 'backend', 'frontend', 'testing', 'security'). The skill content will be injected into your context for the rest of the session.",
      parameters: { type:"object", properties: {
        name: { type:"string", description:"Skill name (e.g., backend, frontend, code-review, testing, security)" }
      }, required:["name"] }
    }
  },
  // ── Environment & Plugin Tools ──────────────────────────────────────────────
  {
    type: "function", function: {
      name: "check_environment",
      description: `Check if the development environment has required tools, correct versions, and return latest stable package versions for the technology stack.

USE FOR: BEFORE creating any new project (ALWAYS pass technology parameter), before first build, when "command not found" or version errors occur.

RULES: When creating a NEW project, ALWAYS pass the technology parameter so it returns the correct latest versions. Available: python, typescript, rust, go, java, cpp, php, csharp, nestjs, nextjs, reactnative. Use the returned versions — do NOT guess.`,
      parameters: { type:"object", properties: {
        technology: { type:"string", description:"Target technology — REQUIRED for new projects: 'nestjs', 'nextjs', 'reactnative', 'python', 'typescript', 'rust', 'go', 'java', 'cpp', 'php', 'csharp'" },
        dirpath: { type:"string", description:"Project directory to check (default: cwd)" }
      } }
    }
  },
  {
    type: "function", function: {
      name: "setup_environment",
      description: `Set up the development environment: create virtual environments, install dependencies, configure tools. Run check_environment FIRST.

USE FOR: After check_environment shows missing setup. For Python: auto-creates venv (prefers uv over pip). For Node.js: installs packages with detected package manager.

RULES: Always run check_environment first. Asks permission before installing system packages.`,
      parameters: { type:"object", properties: {
        technology: { type:"string", description:"Target technology (auto-detected if omitted)" },
        dirpath: { type:"string", description:"Project directory (default: cwd)" }
      } }
    }
  },
  {
    type: "function", function: {
      name: "generate_tests",
      description: `Generate a comprehensive test file for a source file using two-phase generation: Phase 1 creates a deterministic test skeleton from AST analysis (guaranteed coverage). Phase 2 uses the LLM to fill in expected values.

USE FOR: When user asks to add tests, generate tests, or write tests for a file.

Covers: happy path, edge cases per parameter type, error/invalid input, null/None, async rejection. Auto-generates mocks for external dependencies.`,
      parameters: { type:"object", properties: {
        filepath: { type:"string", description:"Source file to generate tests for" },
        dirpath: { type:"string", description:"Project root (default: cwd)" }
      }, required:["filepath"] }
    }
  },
];

// ── Compact tool definitions for smart models (Nemotron, DeepSeek) ──
// Same tool names + params, but short descriptions. Saves ~5,000 tokens per request.
const TOOLS_COMPACT = [
  { type:"function", function:{ name:"run_bash", description:"Run shell command (git, npm, pip, tests, builds). Not for servers (use start_server) or file reads (use read_file).", parameters:{ type:"object", properties:{ command:{type:"string",description:"Command"}, cwd:{type:"string",description:"Working dir"} }, required:["command"] }}},
  { type:"function", function:{ name:"read_file", description:"Read file contents. Supports source code, PDF, Word, Excel.", parameters:{ type:"object", properties:{ filepath:{type:"string",description:"Path"}, offset:{type:"number",description:"Start line"}, limit:{type:"number",description:"Lines to read"} }, required:["filepath"] }}},
  { type:"function", function:{ name:"write_file", description:"Create new file or overwrite. Prefer edit_file for existing files.", parameters:{ type:"object", properties:{ filepath:{type:"string",description:"Path"}, content:{type:"string",description:"Full content"} }, required:["filepath","content"] }}},
  { type:"function", function:{ name:"edit_file", description:"Replace text in existing file. Must read_file first.", parameters:{ type:"object", properties:{ filepath:{type:"string",description:"Path"}, old_str:{type:"string",description:"Text to find"}, new_str:{type:"string",description:"Replacement"} }, required:["filepath","old_str","new_str"] }}},
  { type:"function", function:{ name:"grep_search", description:"Search file contents with regex.", parameters:{ type:"object", properties:{ pattern:{type:"string",description:"Regex pattern"}, dirpath:{type:"string",description:"Directory"}, include:{type:"string",description:"Glob filter"} }, required:["pattern"] }}},
  { type:"function", function:{ name:"find_files", description:"Find files by name pattern.", parameters:{ type:"object", properties:{ pattern:{type:"string",description:"Glob pattern"}, dirpath:{type:"string",description:"Directory"} }, required:["pattern"] }}},
  { type:"function", function:{ name:"get_project_structure", description:"Show directory tree.", parameters:{ type:"object", properties:{ dirpath:{type:"string",description:"Directory"} } }}},
  { type:"function", function:{ name:"start_server", description:"Start server in background. Monitors readiness.", parameters:{ type:"object", properties:{ command:{type:"string",description:"Start command"}, port:{type:"number",description:"Port"}, cwd:{type:"string",description:"Dir"} }, required:["command"] }}},
  { type:"function", function:{ name:"test_endpoint", description:"Test HTTP endpoint. Checks status and body.", parameters:{ type:"object", properties:{ url:{type:"string",description:"URL"}, method:{type:"string",description:"HTTP method"}, body:{type:"string",description:"JSON body"}, expected_status:{type:"number",description:"Expected status"} }, required:["url"] }}},
  { type:"function", function:{ name:"build_and_test", description:"Auto-detect build system, install deps, build, test.", parameters:{ type:"object", properties:{ dirpath:{type:"string",description:"Project dir"}, skip_build:{type:"boolean"}, skip_test:{type:"boolean"} } }}},
  { type:"function", function:{ name:"detect_build_system", description:"Detect project type and build/test commands.", parameters:{ type:"object", properties:{ dirpath:{type:"string",description:"Dir"} } }}},
  { type:"function", function:{ name:"check_environment", description:"Check tools, versions, and get scaffold commands for a technology.", parameters:{ type:"object", properties:{ technology:{type:"string",description:"nestjs|nextjs|python|typescript|rust|go|java|php|csharp|cpp"}, dirpath:{type:"string",description:"Dir"} } }}},
  { type:"function", function:{ name:"setup_environment", description:"Set up environment: create venv, install deps.", parameters:{ type:"object", properties:{ technology:{type:"string"}, dirpath:{type:"string"} } }}},
  { type:"function", function:{ name:"generate_tests", description:"Generate test file from source analysis (AST skeleton + LLM).", parameters:{ type:"object", properties:{ filepath:{type:"string",description:"Source file"}, dirpath:{type:"string"} }, required:["filepath"] }}},
  { type:"function", function:{ name:"web_search", description:"Search the web.", parameters:{ type:"object", properties:{ query:{type:"string",description:"Search query"}, num:{type:"number",description:"Results"} }, required:["query"] }}},
  { type:"function", function:{ name:"web_fetch", description:"Fetch and clean a URL.", parameters:{ type:"object", properties:{ url:{type:"string",description:"URL"} }, required:["url"] }}},
  { type:"function", function:{ name:"kb_search", description:"Search local knowledge base (books, docs).", parameters:{ type:"object", properties:{ query:{type:"string",description:"Query"}, num:{type:"number"} }, required:["query"] }}},
  { type:"function", function:{ name:"todo_write", description:"Add a task to the todo list.", parameters:{ type:"object", properties:{ text:{type:"string",description:"Task description"} }, required:["text"] }}},
  { type:"function", function:{ name:"todo_done", description:"Mark a task complete.", parameters:{ type:"object", properties:{ id:{type:"number",description:"Task ID"} }, required:["id"] }}},
  { type:"function", function:{ name:"memory_write", description:"Save persistent memory.", parameters:{ type:"object", properties:{ content:{type:"string"}, type:{type:"string"} }, required:["content"] }}},
  { type:"function", function:{ name:"present_file", description:"Share a file with the user.", parameters:{ type:"object", properties:{ filepath:{type:"string"} }, required:["filepath"] }}},
  { type:"function", function:{ name:"get_server_logs", description:"Get logs from running server.", parameters:{ type:"object", properties:{ port:{type:"number"} } }}},
  { type:"function", function:{ name:"create_pdf", description:"Create PDF from markdown.", parameters:{ type:"object", properties:{ filepath:{type:"string"}, content:{type:"string"} }, required:["filepath","content"] }}},
  { type:"function", function:{ name:"create_docx", description:"Create Word doc from markdown.", parameters:{ type:"object", properties:{ filepath:{type:"string"}, content:{type:"string"} }, required:["filepath","content"] }}},
];

/**
 * Get the right tool definitions for the active model.
 * Smart models (Nemotron, DeepSeek) use compact descriptions.
 * Others use verbose descriptions with USE FOR/DO NOT USE/RULES.
 */
function getToolsForModel() {
  const name = (CONFIG.model || "").toLowerCase();
  if (name.includes("nemotron") || name.includes("deepseek")) {
    return TOOLS_COMPACT;
  }
  return TOOLS;
}

// Scan directory tree recursively (any technology)
function scanDirectory(dir, prefix, depth, maxDepth) {
  if (depth > maxDepth) return "";
  const skipDirs = new Set(["node_modules",".git","dist","build","__pycache__","target",
    "venv",".venv","env",".next",".nuxt",".svelte-kit","vendor","Pods",
    ".gradle",".idea",".vscode",".DS_Store","coverage",".cache","tmp","temp","logs"]);

  let tree = depth === 0 ? "\n## Project Structure:\n" : "";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !skipDirs.has(e.name) && !e.name.startsWith('.'));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        tree += `${prefix}📂 ${entry.name}/\n`;
        tree += scanDirectory(path.join(dir, entry.name), prefix + "  ", depth + 1, maxDepth);
      } else {
        const size = fs.statSync(path.join(dir, entry.name)).size;
        const sizeStr = size < 1024 ? `${size}B` : `${(size/1024).toFixed(1)}KB`;
        tree += `${prefix}📄 ${entry.name} (${sizeStr})\n`;
      }
    }
  } catch (err) { debugLog(err.message); }
  return tree;
}

// ══════════════════════════════════════════════════════════════════
// PRE-EXECUTION MIDDLEWARE — catches bad tool calls before running
// ══════════════════════════════════════════════════════════════════
function validateToolCall(name, args) {
  const fixes = [];

  // ── Safety Invariants (apply to ALL tools, ALL modes) ──────────────────

  // 0. Block access to ignored files (.attar-code/ignore patterns)
  if ((name === "read_file" || name === "write_file" || name === "edit_file") && args?.filepath) {
    if (isIgnoredPath(args.filepath)) {
      return { blocked: true, reason: `File "${args.filepath}" is in the ignore list (.attar-code/ignore). This file cannot be read, written, or analyzed.` };
    }
  }

  // 1. Block sudo/root commands
  if (name === "run_bash" && args?.command) {
    if (/\bsudo\b/i.test(args.command)) {
      return { blocked: true, reason: "sudo commands are not allowed. Attar-Code runs without elevated privileges. Ask the developer to run this command manually." };
    }
  }

  // 2. Block edits outside project directory
  if ((name === "write_file" || name === "edit_file") && args?.filepath) {
    const targetPath = path.resolve(SESSION.cwd, args.filepath);
    const projectRoot = path.resolve(SESSION.cwd);
    if (!targetPath.startsWith(projectRoot)) {
      return { blocked: true, reason: `Cannot modify files outside project directory.\n  Target: ${targetPath}\n  Project: ${projectRoot}\n  Edit files within the project directory only.` };
    }
  }

  // 3. Check permissions.json deny rules for bash commands
  if (name === "run_bash" && args?.command) {
    const action = `bash:${args.command}`;
    if (matchesPermissionRule(action, PERMISSIONS.deny)) {
      return { blocked: true, reason: `Command blocked by deny rule in permissions.json.\n  Command: ${args.command.slice(0, 80)}` };
    }
  }

  switch (name) {
    case "edit_file": {
      // Enforce read-before-edit
      const editFp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!readFilesThisTurn.has(editFp)) {
        const recentRead = SESSION.messages.slice(-8).some(m =>
          m.role === "tool" && m.content?.includes("[TOOL RESULT: read_file]") && m.content?.includes(path.basename(args.filepath))
        );
        if (!recentRead) {
          return { blocked: true, reason: `You must read_file("${args.filepath}") first before editing. Read the file to see exact content, then retry edit_file.` };
        }
        readFilesThisTurn.add(editFp);
      }
      // Check old_str is not empty
      if (!args.old_str || !args.old_str.trim()) {
        return { blocked: true, reason: "old_str cannot be empty. Read the file first to find the exact string to replace." };
      }
      // Check file exists
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) {
        return { blocked: true, reason: `File not found: ${fp}. Use write_file to create it first.` };
      }
      // Check old_str exists in file
      const content = fs.readFileSync(fp, "utf-8");
      if (!content.includes(args.old_str)) {
        // Try to find a close match
        const lines = args.old_str.split('\n');
        if (lines.length > 0) {
          const firstLine = lines[0].trim();
          if (firstLine && content.includes(firstLine)) {
            return { blocked: true, reason: `old_str not found exactly, but "${firstLine}" exists in the file. Read the file first to get the exact text, including whitespace.` };
          }
        }
        return { blocked: true, reason: `old_str not found in ${args.filepath}. Read the file first to see its exact content.` };
      }
      break;
    }

    case "run_bash": {
      // Block obviously dangerous commands
      const cmd = (args.command || "").trim();
      if (/^(rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|:\(\)\{|fork\s+bomb)/i.test(cmd)) {
        return { blocked: true, reason: "Blocked dangerous command. This could damage the system." };
      }
      break;
    }
  }

  return { ok: true, args, fixes };
}

// ══════════════════════════════════════════════════════════════════
// TOOL RESULT FORMATTER — clear labels so model never confuses
// tool output with user messages
// ══════════════════════════════════════════════════════════════════
function formatToolResult(toolName, result) {
  const maxLen = 3000; // Keep results concise for small model context
  let text = String(result);

  // Truncate very long results
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n... (truncated ${text.length - maxLen} chars)`;
  }

  // Remove ANSI escape codes that confuse the model
  text = text.replace(/\x1b\[[0-9;]*m/g, '');

  return `[TOOL RESULT: ${toolName}]\n${text}\n[END TOOL RESULT]`;
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT BUDGET — prevents overflowing the model's context window.
// 4B models have 8192 token context. We need to leave room for response.
// ══════════════════════════════════════════════════════════════════
// Dynamic: use ~75% of context for input, leave ~25% for model response
function getMaxInputTokens() { return Math.floor(CONFIG.numCtx * 0.75); }

function estimateTokens(text) {
  if (!text) return 0;
  const len = text.length;
  // Code/JSON has more special chars = more tokens per character
  const specialChars = (text.match(/[{}\[\]();:=<>\/\\,\n\t"'`|&!@#$%^*~?]/g) || []).length;
  const codeRatio = specialChars / Math.max(len, 1);
  // code/JSON ~3 chars/token, prose ~3.8 chars/token
  const charsPerToken = codeRatio > 0.08 ? 3.0 : 3.8;
  return Math.ceil(len / charsPerToken);
}

function enforceContextBudget(sysPrompt, messages, tools) {
  let sysTokens  = estimateTokens(sysPrompt);
  let toolTokens = estimateTokens(JSON.stringify(tools));
  let msgTokens  = messages.reduce((s, m) => s + estimateTokens(m.content || "") + 10, 0);
  let total      = sysTokens + toolTokens + msgTokens;

  if (total <= getMaxInputTokens()) return; // fits fine

  debugLog(`Context budget: ${total} tokens (limit ${getMaxInputTokens()}), trimming...`);

  // Strategy 1: Trim the last user message's auto-loaded context (biggest offender)
  const lastUserIdx = messages.findLastIndex(m => m.role === "user");
  if (lastUserIdx >= 0) {
    const msg = messages[lastUserIdx];
    if (msg.content?.includes("═══")) {
      // Keep user's original text, trim auto-loaded context
      const parts = msg.content.split("═══");
      const userPart = parts[0];
      const budget = (getMaxInputTokens() - sysTokens - toolTokens - (msgTokens - estimateTokens(msg.content))) * 4;
      msg.content = userPart.slice(0, Math.max(budget, 2000));
      debugLog(`Trimmed auto-context to ${msg.content.length} chars`);
      return;
    }
    // Trim file paste content if too large
    if (msg.content?.includes("[FILE:")) {
      const beforeFile = msg.content.split("[FILE:")[0];
      const afterFile = msg.content.split("[END FILE]").pop() || "";
      const fileMatch = msg.content.match(/\[FILE:[\s\S]*?\[END FILE\]/);
      if (fileMatch && fileMatch[0].length > 4000) {
        const trimmedFile = fileMatch[0].slice(0, 3000) + "\n...(file truncated to fit context)\n[END FILE]";
        msg.content = beforeFile + trimmedFile + afterFile;
        debugLog(`Trimmed file paste to 3000 chars`);
      }
    }
  }

  // Strategy 2: Reduce conversation history
  if (messages.length > 6) {
    const keep = [messages[0], ...messages.slice(-4)];
    messages.length = 0;
    messages.push(...keep);
    debugLog(`Reduced history to ${messages.length} messages`);
  }
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT COMPRESSOR — summarizes old messages to keep context fresh
// ══════════════════════════════════════════════════════════════════
function compressContext(messages, maxMessages = 20) {
  if (messages.length <= maxMessages) return messages;

  // PreCompact hook — notify before compaction
  if (hookEngine) {
    hookEngine.fire("PreCompact", {
      session_id: SESSION?.id, cwd: SESSION?.cwd,
      trigger: "auto", message_count: messages.length, max_messages: maxMessages,
    }).catch(err => debugLog(err.message));
  }

  const first = messages[0];
  const recent = messages.slice(-maxMessages);
  const trimmed = messages.slice(1, -maxMessages);

  // Build a rich summary of what was trimmed
  const toolActions = [];
  const filesModified = new Set();
  const keyDecisions = [];
  let errorCount = 0;
  let successCount = 0;

  for (const msg of trimmed) {
    const content = msg.content || "";
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        const name = fn.name;
        toolActions.push(name);
        // Extract file paths from tool args
        try {
          const tArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
          if (tArgs?.filepath) filesModified.add(tArgs.filepath);
          if (tArgs?.file_path) filesModified.add(tArgs.file_path);
        } catch (err) { debugLog(err.message); }
      }
    }
    if (msg.role === "tool") {
      if (content.includes("\u2713") || content.includes("\u2705")) successCount++;
      if (content.includes("\u274C") || content.includes("STDERR") || content.includes("Error")) errorCount++;
    }
    // Capture key decisions from assistant messages
    if (msg.role === "assistant" && content.length > 20 && !msg.tool_calls) {
      const firstSentence = content.split(/[.!?\n]/)[0].trim();
      if (firstSentence.length > 10 && firstSentence.length < 200) {
        keyDecisions.push(firstSentence);
      }
    }
  }

  const uniqueTools = [...new Set(toolActions)];
  const summaryParts = [
    `Previous ${trimmed.length} messages summarized.`,
    uniqueTools.length > 0 ? `Tools used: ${uniqueTools.join(", ")}.` : "",
    filesModified.size > 0 ? `Files modified: ${[...filesModified].slice(0, 5).join(", ")}${filesModified.size > 5 ? ` (+${filesModified.size - 5} more)` : ""}.` : "",
    `Results: ${successCount} successes, ${errorCount} errors.`,
    keyDecisions.length > 0 ? `Key context: ${keyDecisions.slice(-3).join("; ")}.` : "",
  ].filter(Boolean);

  const summary = {
    role: "user",
    content: `[CONTEXT SUMMARY]\n${summaryParts.join("\n")}\n[END CONTEXT SUMMARY]`
  };

  const result = [first, summary, ...recent];

  // PostCompact hook — can inject context after compaction
  if (hookEngine) {
    hookEngine.fire("PostCompact", {
      session_id: SESSION?.id, cwd: SESSION?.cwd,
      trigger: "auto", trimmed_count: trimmed.length,
      summary_text: summaryParts.join(" "),
    }).then(hookResult => {
      if (hookResult?.output) {
        // Inject hook output as context reminder
        result.push({ role: "user", content: `[Post-compaction context]: ${hookResult.output}` });
      }
    }).catch(err => debugLog(err.message));
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// CROSS-PLATFORM COMMAND TRANSLATION
// ══════════════════════════════════════════════════════════════════
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
const IS_UNIX = IS_MAC || IS_LINUX;

function translateCommand(cmd) {
  if (IS_WIN) {
    // ── Translate Unix env-prefix syntax: PORT=3001 npm start → set PORT=3001 && npm start ──
    const envPrefixMatch = cmd.match(/^(\s*(?:[A-Z_][\w]*=\S+\s+)+)(.+)/);
    if (envPrefixMatch) {
      const envPart = envPrefixMatch[1].trim();
      const cmdPart = envPrefixMatch[2].trim();
      const setStatements = envPart.split(/\s+/).filter(p => p.includes("=")).map(pair => `set ${pair}`).join(" && ");
      cmd = `${setStatements} && ${cmdPart}`;
    }
    // ── Linux/Mac → Windows ──
    cmd = cmd.replace(/\bmkdir\s+-p\s+/g, "mkdir ");
    if (/^\s*mkdir\s+/.test(cmd)) cmd = cmd.replace(/\//g, "\\");
    if (/^\s*ls(\s|$)/.test(cmd)) cmd = cmd.replace(/^\s*ls/, "dir");
    cmd = cmd.replace(/\brm\s+-rf?\s+/g, "rmdir /s /q ");
    if (/^\s*cat\s+/.test(cmd)) cmd = cmd.replace(/^\s*cat/, "type");
    if (/^\s*which\s+/.test(cmd)) cmd = cmd.replace(/^\s*which/, "where");
    // pwd → cd (Windows cd without args prints current directory)
    if (/^\s*pwd\s*$/.test(cmd)) cmd = "cd";
    // timeout N command → strip timeout (Windows timeout is interactive, not a prefix)
    const timeoutMatch = cmd.match(/^\s*timeout\s+\d+\s+(.+)/);
    if (timeoutMatch) cmd = timeoutMatch[1];
    // clear → cls
    if (/^\s*clear\s*$/.test(cmd)) cmd = "cls";
    // uname → ver
    if (/^\s*uname/.test(cmd)) cmd = "ver";
    // chmod/chown → skip (Windows doesn't use these)
    if (/^\s*(chmod|chown)\s+/.test(cmd)) cmd = `echo "chmod/chown not needed on Windows — permissions handled differently"`;
    // kill -9 PID → taskkill /F /PID
    const killMatch = cmd.match(/^\s*kill\s+(?:-9\s+)?(\d+)/);
    if (killMatch) cmd = `taskkill /F /PID ${killMatch[1]}`;
    // lsof -i :PORT → netstat
    if (/^\s*lsof\s+-i/.test(cmd)) {
      const portMatch = cmd.match(/:(\d+)/);
      cmd = portMatch ? `netstat -ano | findstr :${portMatch[1]}` : "netstat -ano";
    }
    if (/^\s*touch\s+/.test(cmd)) {
      const file = cmd.replace(/^\s*touch\s+/, "").trim();
      cmd = `echo. > "${file}"`;
    }
    // head/tail → powershell
    cmd = cmd.replace(/\|\s*head\s+-(\d+)/g, '| powershell -c "$input | Select-Object -First $1"');
    cmd = cmd.replace(/\|\s*head\b/g, '| powershell -c "$input | Select-Object -First 10"');
    if (/^\s*head\s+/.test(cmd)) {
      const m = cmd.match(/^\s*head\s+(?:-(\d+)\s+)?(.+)/);
      if (m) cmd = `powershell -c "Get-Content '${m[2].trim()}' | Select-Object -First ${m[1]||10}"`;
    }
    cmd = cmd.replace(/\|\s*tail\s+-(\d+)/g, '| powershell -c "$input | Select-Object -Last $1"');
    cmd = cmd.replace(/\|\s*tail\b/g, '| powershell -c "$input | Select-Object -Last 10"');
    // grep → findstr
    cmd = cmd.replace(/\|\s*grep\s+/g, "| findstr ");
    // wc -l (piped and standalone)
    cmd = cmd.replace(/\|\s*wc\s+-l/g, '| find /c /v ""');
    if (/^\s*wc\s+-l\s+/.test(cmd)) {
      const file = cmd.replace(/^\s*wc\s+-l\s+/, "").trim();
      cmd = `type ${file} | find /c /v ""`;
    }
    // timeout → ping (sleep equivalent)
    if (/^\s*timeout\s+\d/.test(cmd) && !/\/t/i.test(cmd)) {
      const secs = cmd.match(/^\s*timeout\s+(\d+)/)?.[1] || "1";
      cmd = cmd.replace(/^\s*timeout\s+\d+\s*/, `ping -n ${parseInt(secs)+1} 127.0.0.1 >nul && `);
    }
    // cp → copy
    if (/^\s*cp\s+/.test(cmd)) cmd = cmd.replace(/^\s*cp\s+/, "copy ");
    // chmod → noop on Windows
    if (/^\s*chmod\s+/.test(cmd)) cmd = "echo (chmod not needed on Windows)";
    // clear → cls
    if (/^\s*clear\s*$/.test(cmd)) cmd = "cls";
    // sleep N → ping -n N+1
    if (/^\s*sleep\s+\d/.test(cmd)) {
      const secs = cmd.match(/^\s*sleep\s+(\d+)/)?.[1] || "1";
      cmd = `ping -n ${parseInt(secs)+1} 127.0.0.1 >nul`;
    }

  } else if (IS_UNIX) {
    // ── Windows → Linux/Mac ──
    if (/^\s*dir(\s|$)/i.test(cmd)) cmd = cmd.replace(/^\s*dir/i, "ls -la");
    if (/^\s*type\s+/i.test(cmd)) cmd = cmd.replace(/^\s*type\s+/i, "cat ");
    if (/^\s*where\s+/i.test(cmd)) cmd = cmd.replace(/^\s*where\s+/i, "which ");
    if (/^\s*cls\s*$/i.test(cmd)) cmd = "clear";
    if (/^\s*copy\s+/i.test(cmd)) cmd = cmd.replace(/^\s*copy\s+/i, "cp ");
    cmd = cmd.replace(/\|\s*findstr\s+/gi, "| grep ");
    cmd = cmd.replace(/\brmdir\s+\/s\s+\/q\s+/gi, "rm -rf ");
    cmd = cmd.replace(/\bdel\s+\/f\s+\/q\s+/gi, "rm -f ");
    // Convert backslash paths to forward slash
    if (/\\[a-zA-Z]/.test(cmd) && !cmd.includes("\\n") && !cmd.includes("\\t")) {
      cmd = cmd.replace(/\\/g, "/");
    }
  }

  return cmd;
}

// ══════════════════════════════════════════════════════════════════
// TOOL EXECUTOR
// ══════════════════════════════════════════════════════════════════
let lastError = null;

async function executeTool(name, args) {
  SESSION.toolCount++;

  // Track action history for /history command
  if (!SESSION._actionHistory) SESSION._actionHistory = [];
  const _actionEntry = { time: Date.now(), tool: name, arg: args?.filepath || args?.command || args?.query || args?.dirpath || "", outcome: "ok" };

  // Skills are injected in chat() via system prompt, not here

  // Guard: fix missing required args that would crash with TypeError
  // Small models often omit args — catch it here instead of crashing
  const needsFilepath = new Set(["read_file","write_file","edit_file","create_pdf",
    "create_docx","create_excel","create_pptx","create_chart","kb_add"]);
  if (needsFilepath.has(name) && !args.filepath) {
    // Try to find filepath in other args (model sometimes puts it in wrong field)
    const guessed = args.file || args.path || args.filename || args.name || args.output;
    if (guessed) {
      args.filepath = String(guessed);
    } else {
      return `❌ Missing required argument: filepath. Call ${name} with filepath="<path>".`;
    }
  }
  // Guard other required string args
  if (name === "run_bash" && !args.command) {
    args.command = args.cmd || args.bash || args.shell;
    if (!args.command) return `❌ Missing required argument: command. Call run_bash with command="<cmd>".`;
  }
  if ((name === "web_search" || name === "kb_search") && !args.query) {
    args.query = args.q || args.search || args.text;
    if (!args.query) return `❌ Missing required argument: query. Call ${name} with query="<search terms>".`;
  }
  if (name === "edit_file" && !args.old_str) {
    return `❌ Missing required argument: old_str. Read the file first, then call edit_file with old_str="<text to find>".`;
  }

  // Pre-execution validation
  const validation = validateToolCall(name, args);
  if (validation.blocked) {
    printToolError(validation.reason);
    return `❌ BLOCKED: ${validation.reason}`;
  }
  if (validation.fixes?.length) {
    for (const fix of validation.fixes) {
      console.log(co(C.bYellow, `  ⚡ ${fix}`));
    }
    if (validation.args) args = validation.args;
  }

  // Git safety net: track file count and auto-stash before large batch changes
  if (["write_file","edit_file"].includes(name)) {
    if (!SESSION._batchFileCount) SESSION._batchFileCount = 0;
    SESSION._batchFileCount++;
    // At 3+ file modifications, create git stash if working tree is clean
    if (SESSION._batchFileCount === 3 && PERMISSIONS.gitCheckpointBeforeMultiFileChange !== false) {
      try {
        const gitStatus = execSync("git status --porcelain", { cwd: SESSION.cwd, encoding: "utf-8", timeout: 5000, shell: IS_WIN ? true : "/bin/bash", stdio: ["pipe","pipe","pipe"] }).trim();
        if (!gitStatus) {
          // Clean tree — create a safety commit
          execSync('git add -A && git commit -m "attar-code: auto-checkpoint before multi-file change" --allow-empty', { cwd: SESSION.cwd, timeout: 10000, shell: IS_WIN ? true : "/bin/bash", stdio: ["pipe","pipe","pipe"] });
          console.log(co(C.dim, "  🔒 Git checkpoint created (3+ files being modified)"));
        }
      } catch { /* not a git repo or git not available — skip */ }
    }
  }

  // Smart auto-checkpoint before destructive operations
  if (["write_file","edit_file"].includes(name)) {
    const label = `before: ${name} ${(args.filepath || "").split(/[/\\]/).pop() || ""}`.trim();
    // Only checkpoint if files actually changed since last checkpoint
    const lastCp = SESSION.checkpoints[SESSION.checkpoints.length - 1];
    const timeSinceLastCp = lastCp ? Date.now() - new Date(lastCp.time).getTime() : Infinity;
    if (timeSinceLastCp > 30000 || !lastCp) { // At least 30s between auto-checkpoints
      createCheckpoint(label);
    }
  } else if (name === "run_bash") {
    const cmd = (args.command || "").trim();
    const isDestructive = /\b(rm|mv|cp|install|uninstall|upgrade|npm|pip|cargo|go get)\b/.test(cmd);
    if (isDestructive) {
      const label = `before: ${cmd.slice(0, 40)}`;
      createCheckpoint(label);
    } else if (SESSION.toolCount % 10 === 0) {
      createCheckpoint(`auto-${SESSION.toolCount}`);
    }
  }

    autoSaveSession();

  let _toolResult;
  try {
  switch (name) {

    case "run_bash": {
      const cwd  = args.cwd ? path.resolve(SESSION.cwd, args.cwd) : SESSION.cwd;
      let cmd = args.command;

      // ── Intercept dangerous process-kill commands ──
      const dangerousKillPattern = /taskkill\b.*\/IM\s+(node|python|python3|deno|bun)\.exe/i;
      if (IS_WIN && dangerousKillPattern.test(cmd) && !/\/PID\s+\d+/i.test(cmd)) {
        console.log(co(C.bRed, `\n  ⚡ BLOCKED: taskkill /IM would kill ALL processes including this CLI`));
        let pidHint = "";
        if (SESSION._servers && Object.keys(SESSION._servers).length > 0) {
          const entries = Object.entries(SESSION._servers)
            .filter(([, p]) => p && p.pid)
            .map(([port, p]) => `port ${port} → PID ${p.pid}`);
          if (entries.length > 0) {
            const firstPid = Object.values(SESSION._servers).find(p => p && p.pid)?.pid;
            pidHint = `\nManaged servers: ${entries.join(", ")}\nSafe command: taskkill /F /PID ${firstPid}`;
          }
        } else {
          pidHint = `\nFind the PID first: run_bash("netstat -ano | findstr :PORT | findstr LISTENING")\nThen: taskkill /F /PID <PID>`;
        }
        return `❌ BLOCKED: "taskkill /IM node.exe" kills ALL node processes including this CLI.\nUse PID-specific kill instead: taskkill /F /PID <PID>${pidHint}`;
      }

      // ── Block mkdir/write inside CLI's own directory ──
      const bashInstallDir = path.resolve(__dirname).replace(/\\/g, "/").toLowerCase();
      const bashCwd = (args.cwd ? path.resolve(SESSION.cwd, args.cwd) : SESSION.cwd).replace(/\\/g, "/").toLowerCase();
      if (bashCwd.startsWith(bashInstallDir) && bashCwd !== bashInstallDir) {
        if (/^\s*(mkdir|touch|echo\s*>|cp\s|mv\s)/.test(cmd)) {
          return `❌ BLOCKED: Cannot create files/directories inside the CLI's source directory (${__dirname}).\nYour project should be in a separate directory. Set --cwd to your project path.`;
        }
      }

      // ── Intercept server-start commands → redirect to start_server tool ──
      const serverStartPattern = /^\s*(?:npm\s+(?:start|run\s+(?:dev|serve|start))|node\s+\S+\.(?:js|ts)|npx\s+(?:ts-node|nodemon|next\s+dev|next\s+start)|python3?\s+(?:-m\s+)?(?:uvicorn|flask|gunicorn|django)|python3?\s+\S+\.py.*(?:runserver|app\.py|manage\.py)|java\s+-jar|mvn\s+spring-boot:run|gradle\s+bootRun|go\s+run\s+\.|cargo\s+run|dotnet\s+run|php\s+(?:-S|artisan\s+serve))/i;
      if (serverStartPattern.test(cmd)) {
        console.log(co(C.bYellow, `\n  ⚡ Server command detected → use start_server tool instead`));
        console.log(co(C.dim, `     run_bash has a 30s timeout — servers need start_server to run in background`));
        return `⚠ "${cmd}" is a server/long-running command. Do NOT use run_bash for this. Use start_server tool instead:\n  start_server(command="${cmd}", port=<PORT>)\nThe start_server tool runs the process in the background so it stays alive.`;
      }

      // ── Intercept file-reading commands → redirect to CLI tools ──
      const fileAnalysisPattern = /powershell\s.*(?:Get-Content|Select-String|Measure-Object|select\s+-First|-split)/i;
      if (IS_WIN && fileAnalysisPattern.test(cmd)) {
        const fileMatch = cmd.match(/['"]([\w\\/.:]+\.\w+)['"]/);
        const hint = fileMatch ? `Use read_file("${fileMatch[1]}") or grep_search instead.` : "Use read_file or grep_search instead.";
        return `⚠ Do NOT use PowerShell for file analysis.\n${hint}`;
      }

      // ── Intercept ALL file-write attempts via bash → redirect to write_file/edit_file ──
      const fileWriteViaBash = /(?:echo\s+.*>|python[3]?\s+-c\s+.*write|sed\s+-i|awk\s.*>)\s*.*\.\w+/i;
      const powershellWrite = /powershell\s.*(?:Set-Content|Add-Content|Out-File|New-Item.*-Value|Export-|Tee-Object)/i;
      if (fileWriteViaBash.test(cmd) || powershellWrite.test(cmd)) {
        return `⚠ Do NOT use bash/echo/python/powershell to write files — use write_file or edit_file instead.\nThese tools handle encoding and formatting correctly and enable smart-fix validation.`;
      }

      // ── Cross-platform command translation ──
      cmd = translateCommand(cmd);

      const approved = await askPermission("run_bash", cmd);
      if (!approved) return "Permission denied by user.";
      printToolRunning("bash", cmd);

      // Track bash commands for typo/loop detection (Fix 15)
      if (!SESSION._bashHistory) SESSION._bashHistory = [];
      SESSION._bashHistory.push({ cmd: cmd.slice(0, 200), time: Date.now() });
      if (SESSION._bashHistory.length > 15) SESSION._bashHistory = SESSION._bashHistory.slice(-15);

      try {
        const out = execSync(cmd, { cwd, encoding:"utf-8", timeout:30000, shell: IS_WIN ? true : "/bin/bash" });
        printToolDone(out);
        return out || "(no output)";
      } catch (e) {
        lastError = e.stderr || e.message;
        const errorOutput = `${e.stderr || ""}\n${e.stdout || ""}`;
        printToolError(e.stderr || e.stdout || e.message);

        // Fix 14: If this was a build command, parse errors and provide prescriptions
        const isBuildCmd = /\b(npm\s+run\s+build|npx\s+tsc|cargo\s+build|go\s+build|dotnet\s+build|mvn\s+compile|gradle\s+build|pytest|python\s+-m\s+pytest|npm\s+test)\b/i.test(cmd);
        let buildAnalysis = "";
        if (isBuildCmd && errorOutput.length > 20) {
          const parsed = pluginParseBuildErrors(errorOutput, SESSION._lastDetectedTech);
          if (parsed && parsed.totalErrors > 0) {
            buildAnalysis = "\n\n" + parsed.summary;
            // Run prescriptions
            const prescriptionText = prescribeFixesForBuild(parsed, errorOutput, cwd);
            if (prescriptionText) buildAnalysis += "\n" + prescriptionText;
            // Run smart-fix error classification if tree available
            if (smartFix && SESSION._depGraph) {
              try {
                if (!SESSION._depGraph.detectedLanguage) SESSION._depGraph.autoDetectAndLoadPlugin(cwd);
                SESSION._depGraph.fullRebuild(cwd);
              } catch (err) { debugLog("Smart-fix rebuild: " + err.message); }
            }
            // Store for cross-file error detection
            if (!SESSION._buildState) SESSION._buildState = { fingerprint: null, repeatCount: 0, lastParsed: null, errorHistory: [], editsBetweenBuilds: 0 };
            SESSION._buildState.lastParsed = parsed;
            SESSION._buildState._pendingErrors = parsed.sorted.map(f => ({
              file: f.file,
              errors: f.errors.slice(0, 5),
              count: f.count,
            }));
            // Cross-file error grouping — TWO strategies:
            // 1. Group by normalized error message (catches identical errors)
            // 2. Group by referenced symbol name (catches different error types about same symbol)
            if (parsed.sorted.length >= 2) {
              const errorSignatures = new Map();
              const symbolSignatures = new Map(); // NEW: group by referenced symbol
              for (const { file: f, errors: errs } of parsed.sorted) {
                for (const err of errs) {
                  // Strategy 1: full message grouping
                  const sig = err.replace(/line\s+\d+:\s*/, "").replace(/['"][^'"]+['"]/g, "'...'").trim().slice(0, 120);
                  if (!errorSignatures.has(sig)) errorSignatures.set(sig, []);
                  errorSignatures.get(sig).push(f);

                  // Strategy 2: extract referenced symbol/type names and group by them
                  const symbolMatches = err.match(/['"](\w{2,50})['"]/g) || [];
                  for (const sm of symbolMatches) {
                    const symbol = sm.replace(/['"]/g, "");
                    // Skip common noise words
                    if (["string", "number", "boolean", "void", "any", "null", "undefined", "never", "object", "true", "false"].includes(symbol)) continue;
                    const key = `symbol:${symbol}`;
                    if (!symbolSignatures.has(key)) symbolSignatures.set(key, { symbol, files: new Set(), errors: [] });
                    symbolSignatures.get(key).files.add(f);
                    symbolSignatures.get(key).errors.push(err.replace(/line\s+\d+:\s*/, "").trim().slice(0, 80));
                  }
                }
              }

              // Report message-based groups (3+ files same message)
              for (const [sig, files] of errorSignatures) {
                if (files.length >= 3) {
                  buildAnalysis += `\n\n⚠ SHARED ROOT CAUSE: ${files.length} files have the same error: "${sig}"`;
                  const missingModule = sig.match(/(?:Cannot find|not found|does not exist|not exported).*?['"](\w+)['"]/i);
                  if (missingModule) {
                    buildAnalysis += `\n⚡ Missing: '${missingModule[1]}'. Create it or fix the import.`;
                  }
                }
              }

              // Report symbol-based groups (2+ files reference same symbol in errors)
              for (const [key, data] of symbolSignatures) {
                if (data.files.size >= 2) {
                  const fileList = [...data.files];
                  const uniqueErrors = [...new Set(data.errors)].slice(0, 3);
                  // Only report if this symbol group wasn't already caught by message grouping
                  const alreadyCaught = [...errorSignatures.entries()].some(([, files]) => files.length >= 3 && files.some(f => fileList.includes(f)));
                  if (!alreadyCaught) {
                    buildAnalysis += `\n\n⚠ SYMBOL '${data.symbol}' causes errors in ${data.files.size} files: ${fileList.map(f => path.basename(f)).join(", ")}`;
                    buildAnalysis += `\n  Errors: ${uniqueErrors.join("; ")}`;
                    buildAnalysis += `\n⚡ Fix the definition of '${data.symbol}' in its SOURCE file, then rebuild. Don't fix each file separately.`;
                  }
                }
              }

              // Merge both signature maps for edit loop detection
              const merged = new Map(errorSignatures);
              for (const [key, data] of symbolSignatures) {
                if (data.files.size >= 2) merged.set(key, [...data.files]);
              }
              SESSION._buildState._errorSignatures = merged;
            }
          }
        }

        // Fix 15: Detect repeated failing bash commands (typo loops)
        let typoWarning = "";
        const recentFails = SESSION._bashHistory.filter(h => Date.now() - h.time < 60000); // Last 60 seconds
        const cmdSig = cmd.replace(/\s+/g, " ").trim().slice(0, 100);
        const sameFailCount = recentFails.filter(h => h.cmd.replace(/\s+/g, " ").trim().slice(0, 100) === cmdSig).length;
        if (sameFailCount >= 3) {
          typoWarning = `\n\n⚠ SAME COMMAND FAILED ${sameFailCount} TIMES in 60 seconds: "${cmdSig.slice(0, 60)}"\nThis command is NOT working. STOP retrying it.\n1. Check the path — is it correct? Use get_project_structure to verify.\n2. Check the command — is it the right tool? (e.g., npm vs npx, python vs python3)\n3. Try a COMPLETELY DIFFERENT approach.`;
        }

        return `STDERR:\n${e.stderr||""}\nSTDOUT:\n${e.stdout||""}${buildAnalysis}${typoWarning}`;
      }
    }

    case "read_file": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) return `Error: Not found: ${fp}`;

      // ── Progressive read gate: warn → summarize → block ──
      if (!SESSION._readCounts) SESSION._readCounts = {};
      if (!SESSION._readContentHash) SESSION._readContentHash = {};
      SESSION._readCounts[fp] = (SESSION._readCounts[fp] || 0) + 1;
      const readCount = SESSION._readCounts[fp];
      // Single read for both hash and content (avoid TOCTOU + double I/O)
      const fileContentForHash = fs.readFileSync(fp, "utf-8");
      const currentHash = crypto.createHash("md5").update(fileContentForHash).digest("hex");
      const lastHash = SESSION._readContentHash[fp];
      const fileUnchanged = lastHash === currentHash;
      SESSION._readContentHash[fp] = currentHash;

      if (readCount > 8 && fileUnchanged) {
        console.log(co(C.bRed, `\n  ⚡ "${path.basename(fp)}" read ${readCount} times (unchanged) — BLOCKING`));
        return `❌ BLOCKED: "${path.basename(fp)}" read ${readCount} times without changes. Take action NOW:\n1. To change this file → use edit_file\n2. To find something across files → use grep_search\n3. If stuck → use web_search with the error message\nDo NOT read this file again.`;
      }
      if (readCount > 4 && fileUnchanged) {
        console.log(co(C.bYellow, `\n  ⚡ "${path.basename(fp)}" read ${readCount} times (unchanged) — returning summary`));
        const fileContent = fileContentForHash;
        const fileLines = fileContent.split("\n");
        const importLines = fileLines.filter(l => /^\s*(import |from |require|use |using |package )/.test(l));
        const exportLines = fileLines.filter(l => /^\s*(export |module\.exports|pub |public |def |class |func |function )/.test(l));
        return `⚡ FILE READ ${readCount}x (unchanged). Summary instead of full content:\n\nImports (${importLines.length}):\n${importLines.slice(0, 10).join("\n") || "(none)"}\n\nDefinitions/Exports (${exportLines.length}):\n${exportLines.slice(0, 10).join("\n") || "(none)"}\n\nFull file: ${fileLines.length} lines. You already know the content. ACT on it:\n- edit_file to make changes\n- grep_search to find things in OTHER files\n- web_search if you don't know the fix`;
      }
      if (readCount > 5) {
        console.log(co(C.bYellow, `\n  ⚡ "${path.basename(fp)}" read ${readCount} times — consider grep_search instead`));
      }

      trackFile(fp);
      readFilesThisTurn.add(fp);
      const ext = path.extname(fp).toLowerCase();

      // ── PDF reading ──
      if (ext === ".pdf") {
        printToolRunning("read_file", `[PDF] ${fp}`);
        const pyCode = `
import sys, json
try:
    import fitz
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "PyMuPDF", "-q"])
    import fitz
filepath = ${JSON.stringify(fp)}
doc = fitz.open(filepath)
text = []
for page in doc:
    text.append(page.get_text())
result = "\\n\\n---PAGE BREAK---\\n\\n".join(text)
print(json.dumps({"text": result[:15000], "total_pages": len(doc)}))
`;
        const tmp = path.join(os.tmpdir(), `ml_rpdf_${Date.now()}.py`);
        fs.writeFileSync(tmp, pyCode);
        try {
          const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
          try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
          const result = JSON.parse(out);
          printToolDone(`${result.total_pages} pages`);
          return `PDF: ${result.total_pages} pages\n\n${result.text}`;
        } catch(e) {
          try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
          return `❌ PDF read failed: ${(e.stderr || e.message).slice(0, 500)}`;
        }
      }

      // ── DOCX reading ──
      if (ext === ".docx") {
        printToolRunning("read_file", `[DOCX] ${fp}`);
        const pyCode = `
import sys, json
try:
    from docx import Document
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx", "-q"])
    from docx import Document
filepath = ${JSON.stringify(fp)}
doc = Document(filepath)
text = []
for para in doc.paragraphs:
    style = para.style.name if para.style else ""
    prefix = ""
    if "Heading 1" in style: prefix = "# "
    elif "Heading 2" in style: prefix = "## "
    elif "Heading 3" in style: prefix = "### "
    elif "List Bullet" in style: prefix = "- "
    elif "List Number" in style: prefix = "1. "
    text.append(prefix + para.text)
for table in doc.tables:
    text.append("")
    for i, row in enumerate(table.rows):
        cells = [cell.text.strip() for cell in row.cells]
        text.append("| " + " | ".join(cells) + " |")
        if i == 0:
            text.append("| " + " | ".join(["---"] * len(cells)) + " |")
result = "\\n".join(text)
print(json.dumps({"text": result[:15000], "paragraphs": len(doc.paragraphs), "tables": len(doc.tables)}))
`;
        const tmp = path.join(os.tmpdir(), `ml_rdocx_${Date.now()}.py`);
        fs.writeFileSync(tmp, pyCode);
        try {
          const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
          try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
          const result = JSON.parse(out);
          printToolDone(`${result.paragraphs} paragraphs, ${result.tables} tables`);
          return `Word Document (${result.paragraphs} paragraphs, ${result.tables} tables):\n\n${result.text}`;
        } catch(e) {
          try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
          return `❌ DOCX read failed: ${(e.stderr || e.message).slice(0, 500)}`;
        }
      }

      // ── Excel reading ──
      if (ext === ".xlsx" || ext === ".xls") {
        printToolRunning("read_file", `[Excel] ${fp}`);
        const pyCode = `
import sys, json
try:
    import openpyxl
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q"])
    import openpyxl
filepath = ${JSON.stringify(fp)}
wb = openpyxl.load_workbook(filepath, data_only=True)
ws = wb.active
headers = [str(c.value or "") for c in ws[1]]
rows = []
for row in ws.iter_rows(min_row=2, values_only=True):
    rows.append([str(v) if v is not None else "" for v in row])
print(json.dumps({"sheet": ws.title, "headers": headers, "rows": rows[:200], "total_rows": ws.max_row - 1, "sheets": wb.sheetnames}))
`;
        const tmp = path.join(os.tmpdir(), `ml_rxl_${Date.now()}.py`);
        fs.writeFileSync(tmp, pyCode);
        try {
          const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
          try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
          const result = JSON.parse(out);
          let text = `Sheet: ${result.sheet} | ${result.total_rows} rows | Sheets: ${result.sheets.join(", ")}\n\n`;
          text += result.headers.join(" | ") + "\n" + result.headers.map(() => "---").join(" | ") + "\n";
          for (const row of result.rows.slice(0, 50)) {
            text += row.join(" | ") + "\n";
          }
          if (result.rows.length > 50) text += `\n... and ${result.total_rows - 50} more rows`;
          printToolDone(`${result.total_rows} rows`);
          return text;
        } catch(e) {
          try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
          return `❌ Excel read failed: ${(e.stderr || e.message).slice(0, 500)}`;
        }
      }

      // ── Default: plain text / source code ──
      let content = fs.readFileSync(fp, "utf-8");
      if (args.offset || args.limit) {
        const lines = content.split("\n");
        const from  = (args.offset || 1) - 1;
        const to    = args.limit ? from + args.limit : lines.length;
        content = lines.slice(from, to).map((l, i) => `${from+i+1}\t${l}`).join("\n");
      }
      printToolRunning("read_file", fp);
      printToolDone(content.slice(0,150) + (content.length>150?"...":""));
      return content.slice(0, 10000);
    }

    case "write_file": {
      let fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      const fileDir = path.resolve(path.dirname(fp));
      const installDir = path.resolve(__dirname);

      // Block file creation during plan mode design phase — user must approve first
      if (SESSION.planMode && SESSION.plan?.status !== "executing" && SESSION.plan?.status !== "verifying") {
        const isProjectFile = !fp.includes('.attar-code') && !fp.includes('todo');
        if (isProjectFile) {
          return `⚠ PLAN MODE: You are still in the design phase. Do NOT create project files yet.\nFinish planning with todo_write, then STOP and wait for user approval.\nThe user will review your plan and approve before implementation starts.`;
        }
      }

      // Redirect .pdf/.docx/.xlsx/.pptx to proper document creation tools
      const docExt = path.extname(fp).toLowerCase();
      if (['.pdf', '.docx', '.xlsx', '.pptx'].includes(docExt)) {
        const toolMap = { '.pdf': 'create_pdf', '.docx': 'create_docx', '.xlsx': 'create_excel', '.pptx': 'create_pptx' };
        return `❌ WRONG TOOL: You are trying to write "${path.basename(fp)}" with write_file, but ${docExt} files need the ${toolMap[docExt]} tool.\nCall ${toolMap[docExt]} with filepath="${fp}" and content set to your markdown text.\nDo NOT use write_file for document formats.`;
      }

      // Block writing to CLI source files, but allow user-created subdirectories
      const normalizedFp = path.resolve(fp).replace(/\\/g, "/").toLowerCase();
      const normalizedInstall = installDir.replace(/\\/g, "/").toLowerCase();
      if (normalizedFp.startsWith(normalizedInstall + "/") || normalizedFp === normalizedInstall) {
        const relPath = normalizedFp.slice(normalizedInstall.length + 1);
        // Known CLI source dirs/files that must NEVER be modified by the model
        const protectedPrefixes = [
          "attar-code.js", "search-proxy.js", "package.json", "package-lock.json",
          "node_modules/", "kb-engine/", "smart-fix/", "prompt.txt", "prompt1.txt",
        ];
        // Explicitly allowed dirs (plugins, error-patterns, skills, docs, user config)
        const allowedPrefixes = ["defaults/", "docs/", "smart-fix/fixtures/", ".attar-code/"];
        const isProtected = protectedPrefixes.some(p => relPath === p || relPath.startsWith(p));
        const isAllowed = allowedPrefixes.some(p => relPath.startsWith(p));

        if (isProtected && !isAllowed) {
          console.log(co(C.bRed, `\n  ⚡ BLOCKED: Cannot write to CLI source file: ${fp}`));
          const blockMsg = `❌ BLOCKED: "${path.basename(fp)}" is a protected CLI source file.\nWrite to "${SESSION.cwd}/${path.basename(fp)}" instead.`;
          const recovery = workingMemory
            ? workingMemory.buildRecoveryDirective(blockMsg, `Write to "${SESSION.cwd}/${path.basename(fp)}" instead`)
            : '\n\nIMPORTANT: Continue with the CURRENT task. Do NOT revisit previous questions.';
          return blockMsg + recovery;
        }
        // If not protected and not in an allowed prefix, it's a user-created subdir — allow it
      }

      // ── Layer 1: Identical-content short-circuit ──
      if (fs.existsSync(fp)) {
        const existingContent = fs.readFileSync(fp, "utf-8");
        if (existingContent === args.content) {
          console.log(co(C.dim, `\n  ⚡ "${path.basename(fp)}" unchanged — skipping identical rewrite`));
          return `✓ "${path.basename(fp)}" already has this exact content — no write needed. Move on to the next task.`;
        }
      }

      // ── Layer 2: Count-gated write with tiered response ──
      if (!SESSION._writeCounts) SESSION._writeCounts = {};
      SESSION._writeCounts[fp] = (SESSION._writeCounts[fp] || 0) + 1;
      const writeCount = SESSION._writeCounts[fp];

      if (writeCount > 3) {
        // Allow up to 3 rewrites (original + 2 corrections), warn on 4th, block on 5th+
        if (writeCount > 4) {
          console.log(co(C.bYellow, `\n  ⚡ "${path.basename(fp)}" written ${writeCount} times — blocking`));
          // Check if the reason for rewrites is a shared root cause
          const sigs = SESSION._buildState?._errorSignatures;
          let rootCauseHint = "";
          if (sigs) {
            for (const [sig, files] of sigs) {
              if (files.length >= 2 && files.some(f => fp.endsWith(f) || f.endsWith(path.basename(fp)))) {
                rootCauseHint = `\n\n⚡ ${files.length} files have the SAME error: "${sig.slice(0, 100)}"\nDo NOT rewrite individual files. Find and fix the SHARED ROOT CAUSE (missing module/config).`;
                break;
              }
            }
          }
          return `❌ BLOCKED: "${fp}" written ${writeCount} times. Use edit_file for targeted changes instead of full rewrites.${rootCauseHint}`;
        }
        console.log(co(C.bYellow, `\n  ⚡ "${path.basename(fp)}" written ${writeCount} times — this is the last allowed rewrite`));
      }

      const approved = await askPermission("write_file", fp);
      if (!approved) return "Permission denied.";
      fs.mkdirSync(path.dirname(fp), { recursive:true });
      fs.writeFileSync(fp, args.content, "utf-8");
      trackFile(fp);
      printToolRunning("write_file", fp);
      printToolDone(`Written ${(args.content.length/1024).toFixed(1)}KB`);

      // Track file creates/edits between builds
      if (!SESSION._buildState) SESSION._buildState = { fingerprint: null, repeatCount: 0, lastParsed: null, errorHistory: [], editsBetweenBuilds: 0 };
      SESSION._buildState.editsBetweenBuilds = (SESSION._buildState.editsBetweenBuilds || 0) + 1;

      // Track total file creates (for "force build" nudge)
      if (!SESSION._fileCreatesWithoutBuild) SESSION._fileCreatesWithoutBuild = 0;
      SESSION._fileCreatesWithoutBuild++;

      // Post-write validation — catch errors immediately
      const writeValidation = validateFileAfterWrite(fp, args.content);
      if (writeValidation) {
        console.log(co(C.bYellow, `  ⚠ Validation: ${writeValidation.split("\n")[0]}`));
      }

      // Smart-fix: update dependency tree + enrich response (ALL languages)
      let smartFixInfo = "";
      // Smart-fix dependency check
      if (smartFix && SESSION._depGraph) {
        try {
          const ext = path.extname(fp).toLowerCase();
          const supportedExts = [".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".pyi",".go",".rs",".java",".kt",".cs",".php",".swift"];
          if (supportedExts.includes(ext)) {
            // Auto-detect language and load plugin on first file if not done yet
            if (!SESSION._depGraph.detectedLanguage && SESSION.cwd) {
              SESSION._depGraph.autoDetectAndLoadPlugin(SESSION.cwd);
            }
            // Ensure tree has all existing project files
            // Rebuild on first write, then every 5th write to stay current
            const needsRebuild = !SESSION._depGraphRebuilt || (SESSION._fileCreatesWithoutBuild > 0 && SESSION._fileCreatesWithoutBuild % 5 === 0);
            if (needsRebuild) {
              try { SESSION._depGraph.fullRebuild(SESSION.cwd); SESSION._depGraphRebuilt = true; } catch (_) {}
            }
            SESSION._depGraph.addFile(fp);
            const validation = SESSION._depGraph.validateImports(fp);
            const summary = SESSION._depGraph.getProjectSummary();
            const fileCount = SESSION._depGraph.getFileCount();
            // Get exports from OTHER files (exclude the file just written)
            const allExports = SESSION._depGraph.getAllExports();
            const normalizedFp = path.resolve(fp);
            const availableExports = {};
            for (const [file, syms] of Object.entries(allExports)) {
              if (path.resolve(file) !== normalizedFp && syms.length > 0) {
                availableExports[file] = syms;
              }
            }
            smartFixInfo = "\n\n" + smartFix.buildCreateFileResponse(fp, validation, summary, fileCount, availableExports);
          }
        } catch (err) {
          debugLog("Smart-fix write_file hook: " + err.message + "\n" + err.stack);
          console.log(co(C.bYellow, `  ⚠ Smart-fix error: ${err.message}`));
        }
      }

      // Log smart-fix result
      if (smartFixInfo) {
        const hasAvail = smartFixInfo.includes("Available imports");
        const hasValid = smartFixInfo.includes("Validation");
        console.log(co(C.dim, `  📊 Smart-fix: ${smartFixInfo.length}ch${hasAvail ? " +imports" : ""}${hasValid ? " +validation" : ""}`));
      }

      // Force build nudge after creating many files without building
      let buildNudge = "";
      if (SESSION._fileCreatesWithoutBuild >= 10) {
        buildNudge = `\n\n⚠ You have created ${SESSION._fileCreatesWithoutBuild} files without building. Call build_and_test NOW to check for import errors before creating more files.`;
      }

      if (writeCount === 2) {
        return `✓ Written: ${fp}\n\n⚠ WARNING: This is the 2nd time you wrote "${path.basename(fp)}" with different content. Further changes MUST use edit_file, not write_file.${smartFixInfo}${buildNudge}`;
      }
      return `✓ Written: ${fp}${writeValidation ? "\n\n⚠ VALIDATION WARNING:\n" + writeValidation + "\nFix these issues before building." : ""}${smartFixInfo}${buildNudge}`;
    }

    case "edit_file": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) return `Error: Not found: ${fp}`;
      // Block editing files inside CLI's own directory
      const editInstallDir = path.resolve(__dirname);
      const normalizedEditFp = path.resolve(fp).replace(/\\/g, "/").toLowerCase();
      const normalizedEditInstall = editInstallDir.replace(/\\/g, "/").toLowerCase();
      if (normalizedEditFp.startsWith(normalizedEditInstall + "/") || normalizedEditFp === normalizedEditInstall) {
        const relPath = normalizedEditFp.slice(normalizedEditInstall.length + 1);
        const allowedPrefixes = ["defaults/", "docs/", "smart-fix/fixtures/"];
        if (!allowedPrefixes.some(p => relPath.startsWith(p))) {
          return `❌ BLOCKED: Cannot edit files inside the CLI's source directory.\nFile: ${fp}\nCLI dir: ${editInstallDir}\nProject files must be in a separate directory.`;
        }
      }
      // Edit loop detection — prevent fixing same file endlessly
      if (!SESSION._editCounts) SESSION._editCounts = {};
      SESSION._editCounts[fp] = (SESSION._editCounts[fp] || 0) + 1;
      if (SESSION._editCounts[fp] >= 6) {
        const parsed = SESSION._buildState?.lastParsed;
        const basename = path.basename(fp);

        // Check if multiple files have the SAME error (shared root cause)
        const sigs = SESSION._buildState?._errorSignatures;
        if (sigs) {
          for (const [sig, files] of sigs) {
            if (files.length >= 2 && files.some(f => f.endsWith(basename) || fp.endsWith(f))) {
              const missingModule = sig.match(/(?:Cannot find module|ModuleNotFoundError|No module named|ImportError).*?['"]([^'"]+)['"]/i);
              if (missingModule) {
                return `❌ EDIT LOOP + SHARED ROOT CAUSE: "${basename}" edited ${SESSION._editCounts[fp]} times.\n${files.length} files have this SAME error: "${sig}"\n\n⚡ ROOT CAUSE: Module '${missingModule[1]}' does NOT EXIST.\nSTOP editing individual files. CREATE the missing module '${missingModule[1]}' first, then rebuild.\nDo NOT touch any of the ${files.length} affected files until the missing module exists.`;
              }
              return `❌ EDIT LOOP + SHARED ROOT CAUSE: "${basename}" edited ${SESSION._editCounts[fp]} times.\n${files.length} OTHER files have the SAME error: "${sig}"\n\nSTOP editing files individually. This is a structural problem.\nFix the ROOT CAUSE (a missing file, wrong config, or broken dependency), then rebuild.\nCall build_and_test and READ the error output to find what's actually missing.`;
            }
          }
        }

        // Fallback: suggest next file (original behavior)
        const others = parsed?.sorted?.filter(e => !fp.endsWith(e.file) && !e.file.endsWith(basename)) || [];
        if (others.length > 0) {
          const next = others[0];
          return `❌ EDIT LOOP: "${basename}" edited ${SESSION._editCounts[fp]} times without build success.\nSTOP. Fix the next file instead: ${next.file} (${next.count} errors)\n${next.errors.slice(0, 3).join("\n")}\nUse read_file("${next.file}") then fix those errors.`;
        }
      }
      const approved = await askPermission("edit_file", fp, { old_str: args.old_str, new_str: args.new_str });
      if (!approved) return "Permission denied.";

      // Auto checkpoint before editing
      createCheckpoint(`before-edit-${path.basename(fp)}`);

      const original = fs.readFileSync(fp, "utf-8");
      const count    = original.split(args.old_str).length - 1;
      if (count === 0) return `Error: old_str not found. Make sure it matches exactly (newlines, spaces, etc.)`;
      if (count > 1)   return `Error: old_str found ${count} times — make it more unique.`;
      fs.writeFileSync(fp, original.replace(args.old_str, args.new_str), "utf-8");
      trackFile(fp);
      // Track edits between builds (Recommendation 1)
      if (SESSION._buildState) SESSION._buildState.editsBetweenBuilds = (SESSION._buildState.editsBetweenBuilds || 0) + 1;
      // Track recent edits for feedback loop — stores the actual code change (fix recipe)
      if (!SESSION._recentEdits) SESSION._recentEdits = [];
      SESSION._recentEdits.push({
        file: fp,
        oldStr: (args.old_str || "").slice(0, 300),
        newStr: (args.new_str || "").slice(0, 300),
        timestamp: Date.now(),
      });
      // Keep only last 10 edits to avoid memory bloat
      if (SESSION._recentEdits.length > 10) SESSION._recentEdits.shift();
      printToolRunning("edit_file", fp);
      printToolDone("1 replacement made");

      // Smart-fix: update dependency tree + enrich response (ALL languages)
      let smartFixEditInfo = "";
      if (smartFix && SESSION._depGraph) {
        try {
          const ext = path.extname(fp).toLowerCase();
          const supportedExts = [".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".pyi",".go",".rs",".java",".kt",".cs",".php",".swift"];
          if (supportedExts.includes(ext)) {
            const updateResult = SESSION._depGraph.updateFile(fp);
            if (updateResult.structuralChange) {
              smartFixEditInfo = "\n\n" + smartFix.buildEditFileResponse(fp, updateResult);
            }
            // Also validate imports after every edit (catches broken require/import paths)
            const validation = SESSION._depGraph.validateImports(fp);
            const importErrors = validation.filter(v => v.status === "error");
            if (importErrors.length > 0) {
              smartFixEditInfo += "\n\n⚠ IMPORT ISSUES after edit:\n" + importErrors.map(e => `  Line ${e.line}: ${e.message}`).join("\n");
            }
          }
        } catch (err) { debugLog("Smart-fix edit_file hook: " + err.message); }
      }

      // Post-edit syntax verification (universal, all languages)
      const editedExt = path.extname(fp).toLowerCase();
      const syntaxChecks = {
        '.js': `node --check "${fp}"`, '.mjs': `node --check "${fp}"`, '.cjs': `node --check "${fp}"`,
        '.py': `python -m py_compile "${fp}"`,
        '.rb': `ruby -c "${fp}"`,
        '.php': `php -l "${fp}"`,
      };
      const syntaxCmd = syntaxChecks[editedExt];
      if (syntaxCmd) {
        try {
          execSync(syntaxCmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe","pipe","pipe"] });
        } catch (syntaxErr) {
          const syntaxOutput = ((syntaxErr.stderr || "") + (syntaxErr.stdout || "")).slice(0, 500);
          return `✓ Edited: ${fp}\n\n⚠ SYNTAX ERROR introduced by this edit:\n${syntaxOutput}\nFix the syntax error before continuing.`;
        }
      }

      // Also set detected tech from edited file if not set
      if (!SESSION._lastDetectedTech) {
        const extToTech = { '.js': 'Node.js', '.mjs': 'Node.js', '.ts': 'Node.js/TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.php': 'PHP', '.rb': 'Ruby', '.cs': 'C#', '.swift': 'Swift', '.kt': 'Kotlin' };
        SESSION._lastDetectedTech = extToTech[editedExt] || null;
      }

      // Recommendation 1: Nudge to build after 15+ edits without building
      const editsSinceBuild = SESSION._buildState?.editsBetweenBuilds || 0;
      if (editsSinceBuild >= 15) {
        return `✓ Edited: ${fp}\n\n⚠ You've made ${editsSinceBuild} edits since the last build. Call build_and_test NOW.${smartFixEditInfo}`;
      }
      return `✓ Edited: ${fp}${smartFixEditInfo}`;
    }

    case "get_project_structure": {
      const dir   = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      const depth = args.depth || 4;
      const SKIP  = new Set(["node_modules",".git",".next","dist","build","__pycache__",".gradle",".idea","venv","target","coverage",".lama"]);

      function walk(d, indent=0) {
        if (indent >= depth) return "";
        let out = "";
        try {
          const entries = fs.readdirSync(d, { withFileTypes:true })
            .sort((a,b) => b.isDirectory()-a.isDirectory() || a.name.localeCompare(b.name));
          for (const e of entries) {
            if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
            const p = "  ".repeat(indent);
            if (e.isDirectory()) {
              out += `${p}📁 ${e.name}/\n` + walk(path.join(d,e.name), indent+1);
            } else {
              const sz = fs.statSync(path.join(d,e.name)).size;
              out += `${p}📄 ${e.name} (${sz>1024?(sz/1024).toFixed(0)+"KB":sz+"B"})\n`;
            }
          }
        } catch (err) { debugLog(err.message); }
        return out;
      }

      printToolRunning("project_structure", dir);
      const tree = `📂 ${dir}\n\n${walk(dir)||"(empty)"}`;
      printToolDone(tree.split("\n").slice(0,5).join("\n") + "...");
      return tree;
    }

    case "todo_write": {
      // Cap: max 10 pending tasks to prevent context bloat
      const pendingCount = SESSION.todoList.filter(t => t.status !== "done").length;
      if (pendingCount >= 10) {
        return `⚠ Too many pending tasks (${pendingCount}). Complete existing tasks before adding more. Use todo_done to mark tasks complete.`;
      }
      // Total cap: max 15 tasks per session (including done)
      if (SESSION.todoList.length >= 15) {
        return `⚠ Task limit reached (${SESSION.todoList.length}). Stop adding tasks and start implementing. For simple operations, use run_bash directly instead of planning.`;
      }
      // Extract phase from [phase] prefix if present
      let taskText = args.text;
      let phase = "implement";
      const phaseMatch = taskText.match(/^\[(understand|design|implement|verify)\]\s*/i);
      if (phaseMatch) {
        phase = phaseMatch[1].toLowerCase();
        taskText = taskText.replace(phaseMatch[0], "").trim();
      }
      // Dedup: skip if same task already exists
      const existing = SESSION.todoList.find(t => t.text.toLowerCase() === taskText.toLowerCase());
      if (existing) {
        return `Task already exists: #${existing.id} "${existing.text}"`;
      }
      const id = addTodo(taskText, { phase });
      printToolRunning("todo_write", taskText);
      printToolDone(`Task #${id} added`);
      return `✓ Task #${id} added: "${taskText}"${phase !== "implement" ? ` [${phase}]` : ""}`;
    }

    case "todo_done": {
      const t = SESSION.todoList.find(t => t.id === args.id);
      if (!t) return `Task #${args.id} not found`;

      // TaskCompleted hook — can block completion
      if (hookEngine) {
        try {
          const tcResult = await hookEngine.fire("TaskCompleted", {
            session_id: SESSION.id, cwd: SESSION.cwd,
            task_id: args.id, task_text: t.text,
            task_phase: t.phase, task_status: t.status,
          });
          if (tcResult.blocked) {
            printToolRunning("todo_done", `#${args.id} BLOCKED`);
            return `⊘ Task #${args.id} completion blocked: ${tcResult.reason || "by hook"}. Complete the required checks first.`;
          }
        } catch (err) { debugLog(err.message); }
      }

      doneTodo(args.id);
      printToolRunning("todo_done", `#${args.id} ${t.text}`);
      printToolDone("Done");
      return `✓ Task #${args.id} marked done`;
    }

    case "todo_list": {
      printToolRunning("todo_list", "");
      if (SESSION.todoList.length === 0) {
        printToolDone("No tasks");
        return "No tasks in the TODO list.";
      }
      const list = SESSION.todoList.map(t =>
        `${t.done ? "✓" : "○"} #${t.id} ${t.text}${t.done ? " (done)" : ""}`
      ).join("\n");
      printToolDone(`${SESSION.todoList.length} tasks`);
      return list;
    }

    case "memory_write": {
      writeMemory(args.content, args.scope || "global");
      return `✓ Memory saved (${args.scope || "global"})`;
    }

    case "memory_read": {
      if (!memoryStore) initMemoryStore();
      const entries = memoryStore.getAll();
      if (entries.length === 0) return "(no memories stored)";
      const output = entries.map((e, i) =>
        `${i + 1}. [${e.type}] ${e.content}${e.tags.length ? ` (tags: ${e.tags.join(", ")})` : ""}`
      ).join("\n");
      return `${entries.length} memories:\n${output}`;
    }

    case "memory_edit": {
      if (!memoryStore) initMemoryStore();
      const cmd = (args.command || "").toLowerCase();
      if (cmd === "remove" && args.id) {
        memoryStore.remove(args.id);
        return `✓ Memory removed: ${args.id}`;
      }
      if (cmd === "search" && args.query) {
        const results = memoryStore.selectRelevant(args.query, 3000);
        if (results.length === 0) return `No memories matching "${args.query}"`;
        return results.map((e, i) => `${i + 1}. [${e.type}] ${e.content} (id: ${e.id})`).join("\n");
      }
      return "Usage: command='remove' with id, or command='search' with query";
    }

    case "session_search": {
      printToolRunning("session_search", args.query);
      try {
        const sessFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        const results = [];
        const query = (args.query || "").toLowerCase();
        const maxResults = args.max_results || 5;

        for (const f of sessFiles.slice(-50)) { // Search last 50 sessions
          try {
            const sess = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
            const messages = sess.session?.messages || [];
            const matchingMsgs = messages.filter(m =>
              m.content && m.content.toLowerCase().includes(query)
            );
            if (matchingMsgs.length > 0) {
              results.push({
                id: sess.session?.id || f.replace(".json", ""),
                name: sess.session?.name || null,
                date: sess.session?.startTime ? new Date(sess.session.startTime).toISOString().slice(0, 19) : "unknown",
                matches: matchingMsgs.length,
                preview: matchingMsgs[0].content.slice(0, 150),
              });
            }
          } catch (err) { debugLog(err.message); }
        }

        results.sort((a, b) => b.matches - a.matches);
        const topResults = results.slice(0, maxResults);

        if (topResults.length === 0) {
          printToolDone("No matches");
          return `No past sessions found matching "${args.query}".`;
        }
        const output = topResults.map((r, i) =>
          `${i + 1}. [${r.date}] ${r.name || r.id} — ${r.matches} matches\n   Preview: ${r.preview}`
        ).join("\n\n");
        printToolDone(`${topResults.length} sessions found`);
        return output;
      } catch (e) {
        return `Error searching sessions: ${e.message}`;
      }
    }

    case "recent_sessions": {
      printToolRunning("recent_sessions", "");
      try {
        const sessFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
        const count = Math.min(args.count || 5, 20);
        const results = [];

        for (const f of sessFiles.slice(0, count)) {
          try {
            const sess = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
            const messages = sess.session?.messages || [];
            const userMsgs = messages.filter(m => m.role === "user");
            results.push({
              id: sess.session?.id || f.replace(".json", ""),
              name: sess.session?.name || null,
              date: sess.session?.startTime ? new Date(sess.session.startTime).toISOString().slice(0, 19) : "unknown",
              messageCount: messages.length,
              firstMessage: userMsgs[0]?.content?.slice(0, 100) || "(empty)",
            });
          } catch (err) { debugLog(err.message); }
        }

        if (results.length === 0) {
          printToolDone("No sessions");
          return "No saved sessions found.";
        }
        const output = results.map((r, i) =>
          `${i + 1}. [${r.date}] ${r.name || r.id} (${r.messageCount} msgs)\n   First: ${r.firstMessage}`
        ).join("\n\n");
        printToolDone(`${results.length} sessions`);
        return output;
      } catch (e) {
        return `Error listing sessions: ${e.message}`;
      }
    }

    // ── Search & Knowledge tools ──────────────────────────────────────────────

    case "web_search": {
      printToolRunning("web_search", args.query);
      const res = await proxyPost("/search", { query: args.query, num: args.num || 5 });
      if (res.error) return `Search proxy error: ${res.error}\nMake sure search-proxy is running: node search-proxy.js`;
      const lines = (res.results || []).map((r, i) =>
        `${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`
      ).join("\n\n");
      printToolDone(lines.slice(0, 150) + "...");
      return lines || "No results found.";
    }

    case "web_fetch": {
      printToolRunning("web_fetch", args.url);

      // Auto-detect docs sites and check for sitemap.xml
      let sitemapHint = "";
      try {
        const urlObj = new URL(args.url);
        const isDocs = /docs?\.|\/docs|sdk\.|api\.|reference|guide|learn|tutorial/i.test(urlObj.hostname + urlObj.pathname);
        if (isDocs && !args._skipSitemap) {
          const sitemapUrl = `${urlObj.protocol}//${urlObj.hostname}/sitemap.xml`;
          try {
            const sitemapRes = await proxyPost("/smart-fetch", { url: sitemapUrl, max_chars: 50000 });
            if (sitemapRes.text && sitemapRes.text.includes("<loc>")) {
              // Extract ALL routes from sitemap — no cap
              const allRoutes = [...sitemapRes.text.matchAll(/<loc>([^<]+)<\/loc>/g)]
                .map(m => m[1])
                .filter(u => !u.includes("sitemap.xml")); // skip nested sitemap index files

              // Check for nested sitemaps (sitemap index → fetch children)
              const nestedSitemaps = [...sitemapRes.text.matchAll(/<loc>([^<]+sitemap[^<]*\.xml)<\/loc>/g)].map(m => m[1]);
              for (const nested of nestedSitemaps.slice(0, 5)) {
                try {
                  const nestedRes = await proxyPost("/smart-fetch", { url: nested, max_chars: 50000 });
                  if (nestedRes.text) {
                    const nestedRoutes = [...nestedRes.text.matchAll(/<loc>([^<]+)<\/loc>/g)]
                      .map(m => m[1]).filter(u => !u.includes("sitemap"));
                    allRoutes.push(...nestedRoutes);
                  }
                } catch (_) {}
              }

              if (allRoutes.length > 0) {
                // Filter routes relevant to the current page path
                const pathWords = urlObj.pathname.split(/[/\-_.]/).filter(w => w.length > 2).map(w => w.toLowerCase());
                const relevant = pathWords.length > 0
                  ? allRoutes.filter(r => pathWords.some(w => r.toLowerCase().includes(w)))
                  : allRoutes;

                // Show relevant routes first, then total count
                const display = relevant.length > 0 && relevant.length < allRoutes.length
                  ? relevant.slice(0, 30)
                  : allRoutes.slice(0, 50);

                sitemapHint = `\n\n## Sitemap (${allRoutes.length} total pages, showing ${display.length} ${relevant.length < allRoutes.length ? "relevant" : ""}):\n` +
                  display.map(r => `- ${r}`).join("\n") +
                  (allRoutes.length > display.length ? `\n... and ${allRoutes.length - display.length} more pages` : "") +
                  `\n\nTip: Use web_fetch on any URL above. For full sitemap: web_fetch("${sitemapUrl}")`;
                debugLog(`Sitemap found: ${allRoutes.length} total routes from ${sitemapUrl}`);
              }
            }
          } catch (_) { /* No sitemap — that's fine */ }
        }
      } catch (_) {}

      // Use smart-fetch to get BOTH text AND code blocks
      const res = await proxyPost("/smart-fetch", { url: args.url, max_chars: args.max_chars || 12000 });
      if (res.error) return `Fetch error: ${res.error}`;
      let out = res.text || "(empty page)";
      if (res.codeBlocks?.length) {
        out += "\n\n## Code Examples:\n";
        for (const cb of res.codeBlocks.slice(0, 5)) {
          out += `\n\`\`\`${cb.language}\n${cb.code.slice(0, 1500)}\n\`\`\`\n`;
        }
      }
      // Append sitemap if found
      if (sitemapHint) out += sitemapHint;
      printToolDone(`${(out.length / 1024).toFixed(1)}KB + ${res.codeBlocks?.length || 0} code blocks${sitemapHint ? " + sitemap" : ""}`);
      return out.slice(0, 10000);
    }

    case "search_docs": {
      const techKey = (args.tech || "").toLowerCase().trim();
      const tech = TECH_DOCS.find(t => t.name.toLowerCase() === techKey || t.prefix.toLowerCase() === techKey);
      if (!tech) return `Unknown tech: "${args.tech}". Supported: ${TECH_DOCS.map(t => t.name).join(", ")}. Use web_search instead.`;
      const q = `${tech.prefix} ${args.query} site:${tech.site}`;
      printToolRunning("search_docs", `${tech.name}: ${args.query}`);

      // Auto-check for sitemap on first search per tech (cached per session)
      if (!SESSION._sitemapCache) SESSION._sitemapCache = {};
      let sitemapRoutes = "";
      if (!SESSION._sitemapCache[tech.site]) {
        try {
          const sitemapUrl = `https://${tech.site}/sitemap.xml`;
          const sitemapRes = await proxyPost("/smart-fetch", { url: sitemapUrl, max_chars: 50000 });
          if (sitemapRes.text && sitemapRes.text.includes("<loc>")) {
            // Extract ALL routes — no cap
            const allRoutes = [...sitemapRes.text.matchAll(/<loc>([^<]+)<\/loc>/g)]
              .map(m => m[1]).filter(u => !u.includes("sitemap.xml"));

            // Check for nested sitemaps
            const nested = [...sitemapRes.text.matchAll(/<loc>([^<]+sitemap[^<]*\.xml)<\/loc>/g)].map(m => m[1]);
            for (const ns of nested.slice(0, 5)) {
              try {
                const nsRes = await proxyPost("/smart-fetch", { url: ns, max_chars: 50000 });
                if (nsRes.text) {
                  allRoutes.push(...[...nsRes.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => !u.includes("sitemap")));
                }
              } catch (_) {}
            }

            SESSION._sitemapCache[tech.site] = allRoutes;
            debugLog(`Sitemap for ${tech.site}: ${allRoutes.length} total routes`);
          } else {
            SESSION._sitemapCache[tech.site] = [];
          }
        } catch (_) { SESSION._sitemapCache[tech.site] = []; }
      }
      const cached = SESSION._sitemapCache[tech.site] || [];
      if (cached.length > 0) {
        // Filter ALL sitemap routes relevant to the query — no arbitrary cap
        const queryWords = args.query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
        const relevant = cached.filter(r => queryWords.some(w => r.toLowerCase().includes(w)));
        if (relevant.length > 0) {
          sitemapRoutes = `\n\nRelevant docs pages (${relevant.length} of ${cached.length} total, from sitemap):\n${relevant.slice(0, 15).map(r => `- ${r}`).join("\n")}`;
          if (relevant.length > 15) sitemapRoutes += `\n... and ${relevant.length - 15} more matching pages`;
        }
      }

      const res = await proxyPost("/search", { query: q, num: 5 });
      if (res.error) return `Search error: ${res.error}`;
      const out = (res.results || []).map((r, i) => `${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`).join("\n\n");
      printToolDone(`${tech.name} — ${res.results?.length || 0} results`);
      return `Official ${tech.name} docs: ${tech.url}\n\n${out || "No results. Try web_fetch on the docs URL directly."}${sitemapRoutes}`;
    }

    case "deep_search": {
      const numResults = Math.min(args.num_results || 3, 5);
      printToolRunning("deep_search", args.query);

      // Step 1: Search
      const searchRes = await proxyPost("/search", { query: args.query, num: numResults + 2 });
      if (searchRes.error) return `Search error: ${searchRes.error}`;
      const results = searchRes.results || [];
      if (results.length === 0) return `No results found for: "${args.query}"`;

      const sections = [`## Search: "${args.query}" (${results.length} results)\n`];

      // Step 2: Fetch top N pages in full
      const fetchPromises = results.slice(0, numResults).map(async (r) => {
        try {
          const fetched = await proxyPost("/smart-fetch", { url: r.url, max_chars: 8000 });
          return { ...r, fullText: fetched.text?.slice(0, 3000) || "", codeBlocks: fetched.codeBlocks || [] };
        } catch (_) { return { ...r, fullText: "", codeBlocks: [] }; }
      });
      const fetched = await Promise.all(fetchPromises);

      for (const [i, page] of fetched.entries()) {
        sections.push(`### ${i + 1}. ${page.title}\n   ${page.url}`);
        if (page.fullText) {
          sections.push(page.fullText.slice(0, 1500));
        }
        if (page.codeBlocks?.length) {
          sections.push("Code examples:");
          for (const cb of page.codeBlocks.slice(0, 3)) {
            sections.push("```" + (cb.language || "") + "\n" + cb.code.slice(0, 800) + "\n```");
          }
        }
        sections.push("");
      }

      // Step 3: Follow-up search if provided
      if (args.follow_up_query) {
        const followRes = await proxyPost("/search", { query: args.follow_up_query, num: 3 });
        if (followRes.results?.length) {
          sections.push(`## Follow-up: "${args.follow_up_query}"\n`);
          for (const r of followRes.results) {
            sections.push(`- ${r.title}\n  ${r.url}\n  ${r.snippet || ""}`);
          }
        }
      }

      const output = sections.join("\n").slice(0, 6000);
      printToolDone(`${fetched.length} pages fetched`);
      return output;
    }

    case "kb_search": {
      printToolRunning("kb_search", args.query);

      // Always execute the search — never block it
      const body = { query: args.query, num: args.num || 5 };
      if (args.language) body.language = args.language;
      if (args.doc_type) body.doc_type = args.doc_type;
      if (args.collection) body.collection = args.collection;
      const res = await proxyPost("/kb/search", body);
      if (res.error) return `KB search error: ${res.error}\nMake sure search-proxy is running: node search-proxy.js`;

      // Track search for repetition detection
      const resultCount = res.count || res.results?.length || 0;
      const topHash = (res.results?.[0]?.text || res.formatted || '').slice(0, 50);
      let repetitionWarning = '';
      if (workingMemory) {
        // Check for repetition AFTER getting results (so we still return data)
        const warning = workingMemory.getSearchRepetitionWarning(args.query, topHash);
        if (warning) {
          repetitionWarning = '\n\n⚠ You have searched similar queries multiple times with the same results. USE the results above to proceed. Try a DIFFERENT search approach or move on to the next step.';
          workingMemory.addDoNot(`Repeat search for "${args.query.split(' ').slice(0, 3).join(' ')}"`);
        }
        workingMemory.recordSearch(args.query, resultCount, topHash);
      }

      if (res.formatted) {
        printToolDone(`Found ${resultCount} results from knowledge base`);
        return res.formatted + repetitionWarning;
      }
      if (!res.results?.length) return "No results in knowledge base. Add files with /kb add <file> or kb_add tool.";
      const lines = res.results.map((r, i) =>
        `[${i+1}] Score: ${r.score} | Source: ${r.filename || r.source || "?"}\n${r.text || r.content || ""}`
      ).join("\n\n---\n\n");
      printToolDone(`Found ${res.results.length} chunks from knowledge base`);
      return lines + repetitionWarning;
    }

    case "kb_add": {
      printToolRunning("kb_add", args.filepath);
      const res = await proxyPost("/kb/add", { filepath: args.filepath });
      if (res.error) return `KB add error: ${res.error}`;
      printToolDone(`Indexed: ${res.filepath}`);
      return `✓ Added to knowledge base: ${res.filepath}\nChunks indexed: ${res.data?.added || "?"}`;
    }

    case "kb_list": {
      printToolRunning("kb_list", "listing...");
      // Try new Qdrant-based endpoint first
      try {
        const r = await fetch(`${CONFIG.proxyUrl}/kb/collections`, { signal: AbortSignal.timeout(5000) });
        const cols = await r.json();
        const items = Array.isArray(cols) ? cols : cols.collections || [];
        if (items.length > 0) {
          const nonEmpty = items.filter(c => (c.points_count || 0) > 0);
          const totalChunks = items.reduce((s, c) => s + (c.points_count || 0), 0);
          const lines = items.map(c => {
            const count = c.points_count || 0;
            return `  ${c.name}: ${count > 0 ? count + " chunks" : "empty"}`;
          });
          printToolDone(`${items.length} collections, ${totalChunks} total chunks`);
          return `📚 Knowledge Base (${items.length} collections, ${totalChunks} chunks):\n\n${lines.join("\n")}\n\nCollections with content: ${nonEmpty.map(c => c.name + " (" + c.points_count + ")").join(", ") || "none"}`;
        }
      } catch (_) {}
      // Fallback to legacy
      try {
        const r = await fetch(`${CONFIG.proxyUrl}/kb/list`);
        const data = await r.json();
        const docs = data.docs || [];
        if (!docs.length) return "Knowledge base is empty. Add files with: kb_add or /kb add <filepath>";
        const lines = docs.map((d, i) =>
          `${i+1}. ${d.filename || d.doc_id} [${d.type || "?"}] — source: ${d.source || "?"}`
        );
        printToolDone(`${docs.length} documents`);
        return `📚 Knowledge Base Contents (${docs.length} documents):\n\n${lines.join("\n")}`;
      } catch (e) {
        return `KB list error: Cannot connect to search-proxy. Start it with: node search-proxy.js`;
      }
    }

    case "research": {
      printToolRunning("research", args.query);
      const res = await proxyPost("/research", {
        query: args.query,
        num_search: args.num_search || 5,
        num_fetch: args.num_fetch || 2
      });
      if (res.error) return `Research error: ${res.error}\nMake sure search-proxy is running.`;
      const parts = [];
      if (res.searchResults?.length) {
        parts.push("## Search Results:\n" + res.searchResults.map((r, i) =>
          `${i+1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`
        ).join("\n"));
      }
      // Fix: proxy returns deepResults, not fetchedContent
      const deepContent = res.deepResults || res.fetchedContent || [];
      if (deepContent.length) {
        parts.push("## Deep Content (full pages fetched):\n" + deepContent.map(r =>
          `### ${r.title || r.url}\n${(r.summary || r.text || r.content || "").slice(0, 1500)}${r.codeExamples?.length ? "\n\nCode examples:\n" + r.codeExamples.slice(0, 3).map(c => "```" + (c.language || "") + "\n" + c.code.slice(0, 500) + "\n```").join("\n") : ""}`
        ).join("\n\n"));
      }
      const output = parts.join("\n\n") || "No results found.";
      printToolDone(`${res.searchResults?.length || 0} results, ${deepContent.length} pages fetched`);
      return output;
    }

    case "search_all": {
      printToolRunning("search_all", args.query);
      const res = await proxyPost("/search-all", {
        query: args.query,
        web_num: args.num || 3,
        kb_num: args.num || 3
      });
      if (res.error) return `Search error: ${res.error}`;
      const parts = [];
      if (res.web?.length) {
        parts.push("## Web Results:\n" + res.web.map((r, i) =>
          `${i+1}. ${r.title} — ${r.snippet || ""}\n   ${r.url}`
        ).join("\n"));
      }
      // Fix: proxy returns "knowledge", not "kb"
      const kbResults = res.knowledge || res.kb || [];
      if (kbResults.length) {
        parts.push("## Knowledge Base:\n" + kbResults.map((r, i) =>
          `${i+1}. [${r.source || r.filename || "doc"}] (score: ${r.score?.toFixed(2) || "?"}) ${(r.text || r.content || "").slice(0, 300)}`
        ).join("\n"));
      }
      const output = parts.join("\n\n") || "No results found.";
      printToolDone(`web: ${res.web?.length || 0}, kb: ${kbResults.length}`);
      return output;
    }

    case "github_search": {
      printToolRunning("github_search", args.query);
      const res = await proxyPost("/github/search", {
        query: args.query,
        type: args.type === "code" ? "code" : "repositories"
      });
      if (res.error) return `GitHub search error: ${res.error}`;
      const items = res.results || res.items || [];
      if (items.length === 0) return "No GitHub results found.";
      const output = items.slice(0, 5).map((r, i) =>
        `${i+1}. ${r.full_name || r.name} ${r.stars ? `⭐${r.stars}` : ""}\n   ${r.description || ""}\n   ${r.html_url || r.url || ""}`
      ).join("\n\n");
      printToolDone(`${items.length} results`);
      return output;
    }

    case "present_file": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      if (!fs.existsSync(fp)) return `❌ File not found: ${fp}`;
      if (fs.statSync(fp).isDirectory()) return `❌ "${fp}" is a directory, not a file. Use get_project_structure to show directory contents.`;
      const basename = path.basename(fp);
      const outPath = path.join(OUTPUTS_DIR, basename);
      try {
        fs.copyFileSync(fp, outPath);
        const size = fs.statSync(outPath).size;
        const sizeStr = size < 1024 ? `${size}B` : size < 1048576 ? `${(size/1024).toFixed(1)}KB` : `${(size/1048576).toFixed(1)}MB`;
        printToolRunning("present_file", basename);
        console.log(co(C.bGreen, `\n  📄 Output: `) + co(C.bold, outPath) + co(C.dim, ` (${sizeStr})`));
        if (args.description) console.log(co(C.dim, `     ${args.description}`));
        printToolDone(basename);
        return `✓ File presented: ${outPath} (${sizeStr})${args.description ? "\n" + args.description : ""}`;
      } catch (e) {
        return `❌ Error presenting file: ${e.message}`;
      }
    }

    case "start_server": {
      const cwd  = args.cwd ? path.resolve(SESSION.cwd, args.cwd) : SESSION.cwd;
      const port = args.port || 3000;
      const approved = await askPermission("start_server", args.command);
      if (!approved) return "Permission denied.";

      // Universal pre-start check: does this framework need a build step first?
      const cmd = args.command || "";
      let preStartWarning = "";
      if (/npm\s+start|next\s+start/.test(cmd)) {
        const nextDir = cwd;
        if (!fs.existsSync(path.join(nextDir, ".next", "BUILD_ID")) && !fs.existsSync(path.join(nextDir, ".next", "build-manifest.json"))) {
          preStartWarning = "\n⚠ Next.js production server requires a build first. Run: npm run build";
        }
      }
      if (/cargo\s+run/.test(cmd) && !fs.existsSync(path.join(cwd, "target", "debug"))) {
        preStartWarning = "\n⚠ Rust project needs to be compiled first. Run: cargo build";
      }
      if (/go\s+run/.test(cmd)) {
        // Go run compiles on the fly, but check if go.mod exists
        if (!fs.existsSync(path.join(cwd, "go.mod"))) {
          preStartWarning = "\n⚠ No go.mod found. Run: go mod init <module-name>";
        }
      }
      if (preStartWarning) {
        return `⚠ Cannot start server: ${preStartWarning}\nFix this first, then call start_server again.`;
      }

      // Check if port is already in use (platform-aware)
      try {
        if (IS_WIN) {
          const netstat = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8", shell: true, stdio: ["pipe","pipe","pipe"] }).trim();
          if (netstat) {
            const pid = netstat.split(/\s+/).pop();
            if (pid && /^\d+$/.test(pid)) {
              printToolRunning("start_server", `Killing existing process on port ${port} (PID ${pid})`);
              execSync(`taskkill /F /PID ${pid}`, { shell: true, stdio: ["pipe","pipe","pipe"] });
              await new Promise(r => setTimeout(r, 500));
            }
          }
        } else {
          const lsof = execSync(`lsof -ti:${port}`, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }).trim();
          if (lsof) {
            printToolRunning("start_server", `Killing existing process on port ${port}`);
            execSync(`kill -9 ${lsof}`, { stdio: ["pipe","pipe","pipe"] });
            await new Promise(r => setTimeout(r, 500));
          }
        }
      } catch (_) { /* port is free */ }

      printToolRunning("start_server", `${args.command} (port ${port})`);

      return new Promise((resolve) => {
        const proc = spawn(args.command, [], { cwd, shell: true, env: process.env, detached: true, stdio: ["ignore","pipe","pipe"] });
        let output = "";

        // Track background server so we can stop it later
        if (!SESSION._servers) SESSION._servers = {};
        SESSION._servers[port] = proc;

        const done = (msg) => {
          proc.stdout.removeAllListeners();
          proc.stderr.removeAllListeners();
          proc.unref();
          resolve(msg);
        };

        if (!SESSION._serverLogs) SESSION._serverLogs = {};
        SESSION._serverLogs[port] = [];
        proc.stdout.on("data", d => {
          output += d.toString();
          const logLines = d.toString().split("\n").filter(Boolean);
          SESSION._serverLogs[port].push(...logLines);
          if (SESSION._serverLogs[port].length > 500) SESSION._serverLogs[port] = SESSION._serverLogs[port].slice(-500);
        });
        proc.stderr.on("data", d => {
          output += d.toString();
          const logLines = d.toString().split("\n").filter(Boolean);
          SESSION._serverLogs[port].push(...logLines);
          if (SESSION._serverLogs[port].length > 500) SESSION._serverLogs[port] = SESSION._serverLogs[port].slice(-500);
        });

        proc.on("error", (e) => {
          printToolError(e.message);
          done(`❌ Failed to start server: ${e.message}`);
        });

        // Wait for server to start (check port every 300ms, max 10s)
        let checks = 0;
        const checkReady = setInterval(async () => {
          checks++;
          try {
            const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
            clearInterval(checkReady);
            // Record fix outcome: server started after previous crash
            if (SESSION._serverCrashCount && SESSION._serverCrashCount > 0) {
              try {
                const FixLearner = require("./smart-fix/fix-engine/fix-learner").FixLearner;
                const learner = new FixLearner();
                // Auto-detect language if not already set
                if (!SESSION._lastDetectedTech) {
                  const cwd = SESSION.cwd;
                  if (fs.existsSync(path.join(cwd, "package.json"))) {
                    try {
                      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
                      SESSION._lastDetectedTech = pkg.devDependencies?.typescript ? "Node.js/TypeScript" : "Node.js";
                    } catch (_) { SESSION._lastDetectedTech = "Node.js"; }
                  } else if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) {
                    SESSION._lastDetectedTech = "Python";
                  } else if (fs.existsSync(path.join(cwd, "go.mod"))) {
                    SESSION._lastDetectedTech = "Go";
                  } else if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
                    SESSION._lastDetectedTech = "Rust";
                  } else if (fs.existsSync(path.join(cwd, "pom.xml")) || fs.existsSync(path.join(cwd, "build.gradle"))) {
                    SESSION._lastDetectedTech = "Java";
                  } else if (fs.existsSync(path.join(cwd, "composer.json"))) {
                    SESSION._lastDetectedTech = "PHP";
                  } else if (fs.existsSync(path.join(cwd, "Gemfile"))) {
                    SESSION._lastDetectedTech = "Ruby";
                  }
                }
                const lastEdit = (SESSION._recentEdits || []).slice(-1)[0];
                // Get last crash error from server logs
                const crashLog = Object.values(SESSION._serverLogs || {}).flat().filter(l => /Error|Exception|Traceback|TypeError|crash/i.test(l)).slice(-2).join(" ").slice(0, 200);
                learner.recordOutcome({
                  errorCode: "SERVER_CRASH_FIX",
                  strategy: "llm_server_fix",
                  language: SESSION._lastDetectedTech || "unknown",
                  file: "server",
                  passed: true,
                  confidence: 0.6,
                  errorMessage: crashLog || "server crash",
                  trigger: `Server crash on port ${port}`,
                  fixFile: lastEdit?.file || null,
                  fixDiff: lastEdit ? `- ${lastEdit.oldStr}\n+ ${lastEdit.newStr}` : null,
                  fixDescription: lastEdit ? `Fixed server crash by editing ${path.basename(lastEdit.file)}` : "LLM server fix",
                });
                debugLog("Feedback: recorded server crash fix with recipe");
              } catch (err) {}
              SESSION._serverCrashCount = 0;
            }
            printToolDone(`Server running on port ${port}`);
            done(`✅ Server started on port ${port}!\nOutput: ${output.slice(0, 500)}`);
          } catch (_) {
            if (checks > 30) { // 9 seconds
              clearInterval(checkReady);
              if (output.toLowerCase().includes("listening") || output.toLowerCase().includes("running") || output.toLowerCase().includes("started")) {
                // Record fix outcome: server started after previous crash
                if (SESSION._serverCrashCount && SESSION._serverCrashCount > 0) {
                  try {
                    const FixLearner = require("./smart-fix/fix-engine/fix-learner").FixLearner;
                    const learner = new FixLearner();
                    // Auto-detect language if not already set
                    if (!SESSION._lastDetectedTech) {
                      const cwd = SESSION.cwd;
                      if (fs.existsSync(path.join(cwd, "package.json"))) {
                        try {
                          const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
                          SESSION._lastDetectedTech = pkg.devDependencies?.typescript ? "Node.js/TypeScript" : "Node.js";
                        } catch (_) { SESSION._lastDetectedTech = "Node.js"; }
                      } else if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) {
                        SESSION._lastDetectedTech = "Python";
                      } else if (fs.existsSync(path.join(cwd, "go.mod"))) {
                        SESSION._lastDetectedTech = "Go";
                      } else if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
                        SESSION._lastDetectedTech = "Rust";
                      } else if (fs.existsSync(path.join(cwd, "pom.xml")) || fs.existsSync(path.join(cwd, "build.gradle"))) {
                        SESSION._lastDetectedTech = "Java";
                      } else if (fs.existsSync(path.join(cwd, "composer.json"))) {
                        SESSION._lastDetectedTech = "PHP";
                      } else if (fs.existsSync(path.join(cwd, "Gemfile"))) {
                        SESSION._lastDetectedTech = "Ruby";
                      }
                    }
                    const lastEdit2 = (SESSION._recentEdits || []).slice(-1)[0];
                    const crashLog2 = Object.values(SESSION._serverLogs || {}).flat().filter(l => /Error|Exception|Traceback|TypeError|crash/i.test(l)).slice(-2).join(" ").slice(0, 200);
                    learner.recordOutcome({
                      errorCode: "SERVER_CRASH_FIX",
                      strategy: "llm_server_fix",
                      language: SESSION._lastDetectedTech || "unknown",
                      file: "server",
                      passed: true,
                      confidence: 0.6,
                      errorMessage: crashLog2 || "server crash",
                      trigger: `Server crash on port ${port}`,
                      fixFile: lastEdit2?.file || null,
                      fixDiff: lastEdit2 ? `- ${lastEdit2.oldStr}\n+ ${lastEdit2.newStr}` : null,
                      fixDescription: lastEdit2 ? `Fixed server crash by editing ${path.basename(lastEdit2.file)}` : "LLM server fix",
                    });
                    debugLog("Feedback: recorded server crash fix with recipe");
                  } catch (err) {}
                  SESSION._serverCrashCount = 0;
                }
                printToolDone(`Server appears running on port ${port}`);
                done(`✅ Server started on port ${port}!\nOutput: ${output.slice(0, 500)}`);
              } else {
                printToolError(`Server may not have started. Output: ${output.slice(0, 300)}`);
                // Track server startup failures + auto-search
                if (!SESSION._serverStartFailures) SESSION._serverStartFailures = 0;
                SESSION._serverStartFailures++;
                let serverHint = "";
                if (SESSION._serverStartFailures >= 2) {
                  serverHint = `\n\n⚠ Server failed to start ${SESSION._serverStartFailures} times. STOP and diagnose:\n1. Read the error in the output above carefully\n2. Use web_search with the exact error message\n3. Fix the root cause with edit_file BEFORE trying start_server again`;
                  // Auto-search on repeated failures
                  const errorLine = output.split("\n").find(l => /error|traceback|exception|failed/i.test(l)) || output.slice(0, 150);
                  if (CONFIG.proxyUrl && errorLine) {
                    autoSearchForSolution(errorLine, "start_server").then(hint => {
                      if (hint) SESSION.messages.push({ role: "user", content: `[AUTO-SEARCH] Server failed to start ${SESSION._serverStartFailures}x.\n${hint}\nApply these findings.` });
                    }).catch(err => debugLog(err.message));
                  }
                }
                // Extract the actual error from output for clear diagnosis
                const outputLines = output.split("\n");
                const tracebackStart = outputLines.findIndex(l => /Traceback|Error:|Exception:|ModuleNotFoundError|ImportError|TypeError|NameError|AttributeError/i.test(l));
                let errorDiagnosis = "";
                if (tracebackStart >= 0) {
                  const errorSection = outputLines.slice(Math.max(0, tracebackStart - 2)).join("\n").slice(0, 600);
                  errorDiagnosis = `\n\n═══ STARTUP ERROR ═══\n${errorSection}\n═══ END ═══\n\nFix this error with edit_file, then try start_server again.`;
                }
                done(`⚠️ Server failed to start on port ${port}.\n${errorDiagnosis || `Output: ${output.slice(0, 500)}`}${serverHint}`);
              }
            }
          }
        }, 300);
      });
    }

    case "test_endpoint": {
      const method = (args.method || "GET").toUpperCase();
      const timeout = args.timeout || 5000;
      const expectedStatus = args.expected_status || 200;
      printToolRunning("test_endpoint", `${method} ${args.url}`);

      let reqHeaders = { "Content-Type": "application/json" };
      if (args.headers) { try { Object.assign(reqHeaders, JSON.parse(args.headers)); } catch (e) { return `❌ Invalid headers JSON: ${e.message}`; } }

      // Enhancement 1: Auto-attach stored auth token (domain-agnostic)
      // Only skip for explicitly public endpoints (auth, login, register, health, docs)
      // All other endpoints get the token — if the server doesn't need it, it ignores it
      if (!reqHeaders["Authorization"] && SESSION._lastAuthToken) {
        const urlPath = new URL(args.url).pathname.toLowerCase();
        const isAuthEndpoint = /\/(auth|login|register|signup|sign-up|sign-in|health|docs|openapi|swagger|public)\b/i.test(urlPath);
        // GET requests without explicit body are typically public — attach token anyway, server ignores if unneeded
        const isGetPublic = false; // Don't assume any GET is public — let the server decide
        if (!isAuthEndpoint && !isGetPublic) {
          reqHeaders["Authorization"] = `Bearer ${SESSION._lastAuthToken}`;
          console.log(co(C.dim, `  💡 Auto-attached stored auth token`));
        }
      }

      const fetchOpts = { method, headers: reqHeaders, signal: AbortSignal.timeout(timeout) };
      if (args.body && ["POST","PUT","PATCH"].includes(method)) fetchOpts.body = args.body;

      const startTime = Date.now();
      try {
        const res = await fetch(args.url, fetchOpts);
        const elapsed = Date.now() - startTime;
        const actualStatus = res.status;
        const responseText = await res.text();
        let responseBody = null;
        try { responseBody = JSON.parse(responseText); } catch (err) { debugLog(err.message); }

        // Enhancement 1: Extract and store auth token from login/register responses (ALL frameworks)
        if (responseBody && actualStatus >= 200 && actualStatus < 300) {
          const token = responseBody.token || responseBody.data?.token || responseBody.access_token ||
            responseBody.data?.access_token || responseBody.accessToken || responseBody.jwt ||
            responseBody.data?.jwt || responseBody.auth_token || responseBody.data?.auth_token;
          if (token && typeof token === "string" && token.length > 20) {
            SESSION._lastAuthToken = token;
            console.log(co(C.dim, `  💡 Auth token stored (${token.slice(0, 15)}...)`));
          }
        }

        const statusPass = actualStatus === expectedStatus;
        const bodyFailures = [];
        if (args.expected_body && responseBody) {
          try {
            const expected = JSON.parse(args.expected_body);
            for (const [key, val] of Object.entries(expected)) {
              if (responseBody[key] === undefined) bodyFailures.push(`missing "${key}"`);
              else if (val !== null && JSON.stringify(responseBody[key]) !== JSON.stringify(val)) bodyFailures.push(`"${key}": expected ${JSON.stringify(val)}, got ${JSON.stringify(responseBody[key])}`);
            }
          } catch (err) { debugLog(err.message); }
        }

        const allPass = statusPass && bodyFailures.length === 0;
        const lines = [`${allPass ? "✅ PASS" : "❌ FAIL"} — ${method} ${args.url}`, `Status: ${actualStatus} (expected ${expectedStatus}) ${statusPass ? "✓" : "✗"}`, `Time: ${elapsed}ms`];
        if (bodyFailures.length > 0) { lines.push("Failures:"); bodyFailures.forEach(f => lines.push(`  - ${f}`)); }
        lines.push(`Response: ${responseText.slice(0, 500)}`);

        // Enhancement 2: Duplicate record detection (ALL databases)
        if (!allPass && (actualStatus === 400 || actualStatus === 409)) {
          const dupPattern = /unique|duplicate|already exists|UNIQUE constraint|conflict|E11000|23505|1062/i;
          if (dupPattern.test(responseText)) {
            lines.push(`\n⚠ DUPLICATE RECORD: The data you sent already exists in the database.`);
            lines.push(`Use DIFFERENT values in your request body. Do NOT retry with the same data.`);
          }
        }

        // Enhancement 1b: Auth error guidance when token is missing or invalid (ALL frameworks)
        if (!allPass && (actualStatus === 401 || actualStatus === 403 || actualStatus === 500)) {
          const authErrPattern = /req\.user|request\.user|current_user|get_current_user|unauthorized|unauthenticated|jwt|token.*required|token.*invalid|token.*expired|not authenticated|Access denied|Forbidden|AnonymousUser|SecurityContext|Auth::user|User\.Identity|Cannot read.*(?:user|userId|id)/i;
          if (authErrPattern.test(responseText) || (SESSION._serverLogs && Object.values(SESSION._serverLogs).flat().some(l => authErrPattern.test(l)))) {
            if (SESSION._lastAuthToken) {
              lines.push(`\n⚠ AUTH REQUIRED: This endpoint needs authentication. A token is stored from your last login.`);
              lines.push(`The token was auto-attached but may be expired or invalid. Try logging in again.`);
            } else {
              lines.push(`\n⚠ AUTH REQUIRED: This endpoint needs a JWT token.`);
              lines.push(`STEPS: 1) POST /auth/login to get a token 2) The token will be auto-stored 3) Retry this endpoint`);
            }
          }
        }

        // Enhancement 5: Auto-search on FIRST 500 error (don't wait for 3 retries)
        if (!allPass && actualStatus >= 500 && CONFIG.proxyUrl) {
          const serverErr = SESSION._serverLogs ? Object.values(SESSION._serverLogs).flat().filter(l => /Error|Exception|Traceback|TypeError|Cannot/i.test(l)).slice(-3).join("\n") : responseText.slice(0, 200);
          if (serverErr.length > 10) {
            autoSearchForSolution(serverErr, "test_endpoint").then(hint => {
              if (hint) SESSION.messages.push({ role: "user", content: `[AUTO-SEARCH] Server returned 500.\n${hint}\nUse these findings to fix the issue.` });
            }).catch(_ => {});
          }
        }

        // AUTO-INCLUDE server logs on FAIL — don't make the model call a separate tool
        if (!allPass && SESSION._serverLogs && actualStatus >= 400) {
          const allLogEntries = Object.entries(SESSION._serverLogs);
          if (allLogEntries.length > 0) {
            lines.push("\n═══ SERVER-SIDE ERROR (from server logs) ═══");
            for (const [port, logLines] of allLogEntries) {
              // Find the error section: last traceback or error lines
              const recent = (logLines || []).slice(-30);
              const errorStart = recent.findIndex(l => /Traceback|Error:|Exception:|STDERR|TypeError|ReferenceError|SyntaxError|Cannot |cannot |ENOENT|EACCES|ValidationError|BadRequest|Unauthorized|Forbidden|NotFound|failed|400|401|403|404|500/i.test(l));
              const errorSection = errorStart >= 0 ? recent.slice(errorStart) : recent.slice(-10);
              if (errorSection.length > 0) {
                lines.push(`[Port ${port}]`);
                lines.push(errorSection.join("\n").slice(0, 800));
              }
            }
            lines.push("═══ END SERVER LOGS ═══");
            lines.push("\nFix the error shown above. The traceback tells you exactly which file and line to fix.");
          }
        } else if (!allPass && SESSION._serverLogs) {
          // Non-500 errors (4xx): still show hint but less urgently
          lines.push("\nHint: call get_server_logs if you need more context on the error");
        }

        // Track repeated endpoint failures for auto-search
        if (!allPass) {
          if (!SESSION._endpointFailures) SESSION._endpointFailures = { count: 0, lastError: "", sameCount: 0 };
          SESSION._endpointFailures.count++;
          // Track by status code + URL path (not response body which changes)
          const errSig = `${actualStatus}:${new URL(args.url).pathname}`;
          if (errSig === SESSION._endpointFailures.lastError) {
            SESSION._endpointFailures.sameCount++;
          } else {
            SESSION._endpointFailures.lastError = errSig;
            SESSION._endpointFailures.sameCount = 1;
          }
          // After 2+ same failures: trigger auto-search + force read server logs
          if (SESSION._endpointFailures.sameCount >= 2) {
            lines.push(`\n⚠ SAME ENDPOINT ERROR ${SESSION._endpointFailures.sameCount} TIMES. Your edits are not fixing the root cause.`);
            lines.push(`REQUIRED STEPS:`);
            lines.push(`1. Call get_server_logs to read the ACTUAL server-side error`);
            lines.push(`2. Use web_search with the exact error message from the server logs`);
            lines.push(`3. Read the search results before attempting another fix`);
            lines.push(`Do NOT edit files again until you have read the server logs and searched for the error.`);
            // Auto-search using SERVER LOGS (not HTTP response) for accurate error context
            if (CONFIG.proxyUrl) {
              // Get the actual server-side error from logs
              let searchText = responseText.slice(0, 150);
              if (SESSION._serverLogs) {
                const allLogs = Object.values(SESSION._serverLogs).flat().join("\n");
                // Find the actual traceback/error line
                const errorLines = allLogs.split("\n").filter(l =>
                  /Error|Exception|Traceback|TypeError|ImportError|NameError|AttributeError|ModuleNotFoundError|KeyError|ValueError/i.test(l)
                );
                if (errorLines.length > 0) {
                  searchText = errorLines.slice(-3).join("\n"); // Last 3 error lines from server
                }
              }
              autoSearchForSolution(searchText, "test_endpoint").then(hint => {
                if (hint) SESSION.messages.push({ role: "user", content: `[AUTO-SEARCH] Endpoint test failed ${SESSION._endpointFailures.sameCount}x.\n${hint}\nRead these results and apply the fix.` });
              }).catch(err => debugLog(err.message));
            }
          }
        } else {
          // Reset only when the SAME endpoint that was failing now passes
          if (SESSION._endpointFailures) {
            // Record fix outcome: endpoint passed after previous failure
            if (SESSION._endpointFailures.sameCount > 0) {
              try {
                const FixLearner = require("./smart-fix/fix-engine/fix-learner").FixLearner;
                const learner = new FixLearner();
                // Auto-detect language if not already set
                if (!SESSION._lastDetectedTech) {
                  const cwd = SESSION.cwd;
                  if (fs.existsSync(path.join(cwd, "package.json"))) {
                    try {
                      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
                      SESSION._lastDetectedTech = pkg.devDependencies?.typescript ? "Node.js/TypeScript" : "Node.js";
                    } catch (_) { SESSION._lastDetectedTech = "Node.js"; }
                  } else if (fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) {
                    SESSION._lastDetectedTech = "Python";
                  } else if (fs.existsSync(path.join(cwd, "go.mod"))) {
                    SESSION._lastDetectedTech = "Go";
                  } else if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
                    SESSION._lastDetectedTech = "Rust";
                  } else if (fs.existsSync(path.join(cwd, "pom.xml")) || fs.existsSync(path.join(cwd, "build.gradle"))) {
                    SESSION._lastDetectedTech = "Java";
                  } else if (fs.existsSync(path.join(cwd, "composer.json"))) {
                    SESSION._lastDetectedTech = "PHP";
                  } else if (fs.existsSync(path.join(cwd, "Gemfile"))) {
                    SESSION._lastDetectedTech = "Ruby";
                  }
                }
                // Capture the fix recipe: what was the error and what edit fixed it
                const lastEdit = (SESSION._recentEdits || []).slice(-1)[0];
                const lastError = SESSION._endpointFailures.lastError || "";
                learner.recordOutcome({
                  errorCode: "ENDPOINT_FIX",
                  strategy: "llm_endpoint_fix",
                  language: SESSION._lastDetectedTech || "unknown",
                  file: args.url,
                  passed: true,
                  confidence: 0.6,
                  // Enhanced: actual fix recipe
                  errorMessage: lastError.slice(0, 200),
                  trigger: `${method} ${args.url} → ${actualStatus || "failed"}`,
                  fixFile: lastEdit?.file || null,
                  fixDiff: lastEdit ? `- ${lastEdit.oldStr}\n+ ${lastEdit.newStr}` : null,
                  fixDescription: lastEdit ? `Fixed endpoint by editing ${path.basename(lastEdit.file)}` : "LLM endpoint fix (diff not captured)",
                });
                debugLog(`Feedback: recorded endpoint fix with recipe for ${args.url}`);
              } catch (err) { debugLog("Feedback endpoint record: " + err.message); }
            }
            try {
              const successSig = `${actualStatus}:${new URL(args.url).pathname}`;
              // Only reset if this was the endpoint that was failing
              if (SESSION._endpointFailures.lastError && SESSION._endpointFailures.lastError.split(":").slice(1).join(":") === new URL(args.url).pathname) {
                SESSION._endpointFailures.sameCount = 0;
              }
            } catch (_) { SESSION._endpointFailures.sameCount = 0; }
          }
        }

        // Auto-search KB for fix recipe on endpoint failure
        if (!allPass && CONFIG.proxyUrl && actualStatus >= 400) {
          try {
            const kbResult = await proxyPost("/kb/recipe/search", { query: `${actualStatus} ${responseText.slice(0, 100)}` });
            if (kbResult.count > 0) {
              lines.push("\n📚 SIMILAR FIX FROM KB:\n" + (kbResult.formatted || "").slice(0, 500));
            }
          } catch (_) {}
        }

        printToolDone(allPass ? "PASS" : "FAIL");
        return lines.join("\n");
      } catch (err) {
        printToolError(err.message);
        // Track fetch failures (server not responding)
        if (!SESSION._endpointFailures) SESSION._endpointFailures = { count: 0, lastError: "", sameCount: 0 };
        SESSION._endpointFailures.count++;
        SESSION._endpointFailures.sameCount++;
        // Track server crashes for fix outcome recording
        if (!SESSION._serverCrashCount) SESSION._serverCrashCount = 0;
        SESSION._serverCrashCount++;

        // Auto-include server logs when server is not responding (likely crashed)
        let crashLogs = "";
        if (SESSION._serverLogs) {
          const allLogEntries = Object.entries(SESSION._serverLogs);
          for (const [port, logLines] of allLogEntries) {
            const recent = (logLines || []).slice(-20);
            const errorLines = recent.filter(l => /Error|Exception|Traceback|failed|STDERR/i.test(l));
            if (errorLines.length > 0) {
              crashLogs = `\n\n═══ SERVER CRASH LOG (port ${port}) ═══\n${recent.slice(-15).join("\n").slice(0, 600)}\n═══ END CRASH LOG ═══\n\nThe server crashed. Fix the error above, then restart with start_server.`;
              break;
            }
          }
        }

        let fetchHint = "";
        if (!crashLogs && SESSION._endpointFailures.sameCount >= 2) {
          fetchHint = "\n\n⚠ SERVER NOT RESPONDING after 2+ attempts.\nREQUIRED STEPS:\n1. Call get_server_logs to see the crash error\n2. Fix the root cause. Common causes by language:\n   - JavaScript/Node.js: unhandled promise rejection, async DB init, missing require()\n   - Python: unhandled exception, missing import, DB not connected\n   - Go: panic, nil pointer, port already in use\n   - Java: NullPointerException, bean initialization failure\n   - Rust: unwrap() on None/Err, missing dependency\n   - PHP: fatal error, class not found\n3. Restart server with start_server\n4. Re-test the endpoint";
        }
        return `❌ FAIL — ${method} ${args.url}\nError: ${err.message}${crashLogs}${fetchHint}`;
      }
    }

    case "get_server_logs": {
      const n = args.lines || 50;
      printToolRunning("get_server_logs", args.port ? `port ${args.port}` : "all");
      if (!SESSION._serverLogs || Object.keys(SESSION._serverLogs).length === 0) {
        printToolDone("No servers");
        return "No server logs. Logs only available for servers started with start_server in this session.";
      }
      const ports = args.port ? [String(args.port)] : Object.keys(SESSION._serverLogs);
      const sections = ports.map(p => {
        const logs = SESSION._serverLogs[p] || [];
        return `=== Server port ${p} (${logs.length} lines) ===\n${logs.slice(-n).join("\n") || "(no output)"}`;
      });
      printToolDone(`${ports.length} server(s)`);
      return sections.join("\n\n");
    }

    case "detect_build_system": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      printToolRunning("detect_build_system", dir);
      const detectors = [
        // Framework-specific detectors BEFORE generic package.json
        { marker: "nest-cli.json", fn: () => {
          const hasPnpm = fs.existsSync(path.join(dir, "pnpm-lock.yaml"));
          const hasYarn = fs.existsSync(path.join(dir, "yarn.lock"));
          const pm = hasPnpm ? "pnpm" : hasYarn ? "yarn" : "npm";
          return { tech: "NestJS", pm, install: `${pm} install`, build: "nest build", test: `${pm} run test`, start: "nest start --watch", lint: `${pm} run lint`, config: "nest-cli.json" };
        }},
        { marker: "next.config.*", fn: () => {
          const hasPnpm = fs.existsSync(path.join(dir, "pnpm-lock.yaml"));
          const hasYarn = fs.existsSync(path.join(dir, "yarn.lock"));
          const pm = hasPnpm ? "pnpm" : hasYarn ? "yarn" : "npm";
          const configFile = ["next.config.ts", "next.config.mjs", "next.config.js"].find(f => fs.existsSync(path.join(dir, f))) || "next.config.js";
          return { tech: "Next.js", pm, install: `${pm} install`, build: "next build", test: `${pm} test`, start: "next dev", lint: "next lint", config: configFile };
        }},
        { marker: "package.json", fn: () => {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
          const s = pkg.scripts || {};
          const hasYarn = fs.existsSync(path.join(dir, "yarn.lock"));
          const hasPnpm = fs.existsSync(path.join(dir, "pnpm-lock.yaml"));
          const pm = hasPnpm ? "pnpm" : hasYarn ? "yarn" : "npm";
          return { tech: pkg.devDependencies?.typescript ? "Node.js/TypeScript" : "Node.js", pm,
            install: `${pm} install`, build: s.build ? `${pm} run build` : "(none)",
            test: s.test ? `${pm} test` : "(none)", start: s.start ? `${pm} start` : s.dev ? `${pm} run dev` : "(none)",
            lint: s.lint ? `${pm} run lint` : "(none)", config: "package.json" };
        }},
        { marker: "Cargo.toml", fn: () => ({ tech:"Rust", install:"(none)", build:"cargo build", test:"cargo test", start:"cargo run", lint:"cargo clippy", config:"Cargo.toml" }) },
        { marker: "go.mod", fn: () => ({ tech:"Go", install:"go mod download", build:"go build ./...", test:"go test ./...", start:"go run .", lint:"golint ./...", config:"go.mod" }) },
        { marker: "pom.xml", fn: () => ({ tech:"Java/Maven", install:"mvn dependency:resolve", build:"mvn package -DskipTests", test:"mvn test", start:"mvn spring-boot:run", lint:"mvn checkstyle:check", config:"pom.xml" }) },
        { marker: "build.gradle", fn: () => ({ tech:"Java/Gradle", install:"gradle dependencies", build:"gradle build -x test", test:"gradle test", start:"gradle bootRun", lint:"gradle checkstyleMain", config:"build.gradle" }) },
        { marker: "pyproject.toml", fn: () => ({ tech:"Python", install:"pip install -e .", build:"python -m build", test:"python -m pytest", start:"python main.py", lint:"flake8 .", config:"pyproject.toml" }) },
        { marker: "requirements.txt", fn: () => ({ tech:"Python", install:"pip install -r requirements.txt", build:"(none)", test:"python -m pytest", start:"python main.py", lint:"flake8 .", config:"requirements.txt" }) },
        { marker: "Makefile", fn: () => ({ tech:"C/C++", install:"(none)", build:"make", test:"make test", start:"make run", lint:"make lint", config:"Makefile" }) },
        { marker: "CMakeLists.txt", fn: () => ({ tech:"C/C++", install:"(none)", build:"cmake --build build", test:"ctest --test-dir build", start:"./build/main", lint:"(none)", config:"CMakeLists.txt" }) },
        { marker: "*.csproj", fn: () => {
          const csproj = fs.readdirSync(dir).find(f => f.endsWith(".csproj"));
          return { tech: "C#", install: "dotnet restore", build: "dotnet build", test: "dotnet test", start: "dotnet run", lint: "(none)", config: csproj || "*.csproj" };
        }},
        { marker: "*.sln", fn: () => {
          const sln = fs.readdirSync(dir).find(f => f.endsWith(".sln"));
          return { tech: "C#", install: "dotnet restore", build: "dotnet build", test: "dotnet test", start: "dotnet run", lint: "(none)", config: sln || "*.sln" };
        }},
        { marker: "composer.json", fn: () => {
          const comp = JSON.parse(fs.readFileSync(path.join(dir, "composer.json"), "utf-8"));
          const isLaravel = fs.existsSync(path.join(dir, "artisan"));
          const isSymfony = fs.existsSync(path.join(dir, "symfony.lock"));
          const fw = isLaravel ? "Laravel" : isSymfony ? "Symfony" : "";
          return { tech: fw ? `PHP/${fw}` : "PHP", install: "composer install", build: isLaravel ? "php artisan optimize" : "(none)",
            test: isLaravel ? "php artisan test" : "./vendor/bin/phpunit", start: isLaravel ? "php artisan serve" : (isSymfony ? "symfony server:start" : "php -S localhost:8000 -t public"),
            lint: "./vendor/bin/phpstan analyze", config: "composer.json" };
        }},
      ];
      let d = null;
      for (const det of detectors) {
        let found = false;
        if (det.marker.includes("*")) {
          // Glob pattern — supports "*.csproj" (suffix) and "next.config.*" (prefix)
          try {
            const prefix = det.marker.split("*")[0];
            const suffix = det.marker.split("*")[1] || "";
            found = fs.readdirSync(dir).some(f =>
              (prefix ? f.startsWith(prefix) : true) && (suffix ? f.endsWith(suffix) : true) && f !== det.marker
            );
          } catch { found = false; }
        } else {
          found = fs.existsSync(path.join(dir, det.marker));
        }
        if (found) { try { d = det.fn(); } catch (err) { debugLog(err.message); } if (d) break; }
      }
      if (!d) { printToolDone("Unknown"); return `No build system detected in ${dir}. Searched: ${detectors.map(x=>x.marker).join(", ")}`; }
      printToolDone(d.tech);
      return `Technology: ${d.tech}\nConfig: ${d.config}\nInstall: ${d.install}\nBuild: ${d.build}\nTest: ${d.test}\nStart: ${d.start}\nLint: ${d.lint}${d.pm ? `\nPackage manager: ${d.pm}` : ""}`;
    }

    case "build_and_test": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      printToolRunning("build_and_test", dir);
      const info = await executeTool("detect_build_system", { dirpath: dir });
      const techMatch = info.match(/Technology:\s*(.+)/);
      if (techMatch) SESSION._lastDetectedTech = techMatch[1].trim();
      if (info.includes("No build system")) return `❌ ${info}`;

      // ── Pre-flight environment check via plugin system ──
      if (pluginRegistry && SESSION._lastDetectedTech) {
        const plugin = pluginRegistry.pluginForTech(SESSION._lastDetectedTech);
        if (plugin) {
          try {
            const envCheck = plugin.checkEnvironment(dir);
            SESSION._envCheck = [{ language: plugin.id, displayName: plugin.displayName, ...envCheck }];
            if (envCheck.runtime && !envCheck.runtime.installed) {
              return `❌ ENVIRONMENT ERROR: ${plugin.displayName} runtime is not installed.\nInstall: ${envCheck.missing?.[0]?.installCmd || 'See check_environment for details.'}`;
            }
            if (envCheck.runtime && !envCheck.runtime.compatible) {
              sections.push(`⚠ VERSION WARNING: ${plugin.displayName} ${envCheck.runtime.version} is below minimum ${envCheck.runtime.minVersion}`);
            }
            // Auto-create Python venv if needed
            if (plugin.id === 'python' && envCheck.virtualEnv && !envCheck.virtualEnv.exists && !envCheck.virtualEnv.active) {
              const setupResult = plugin.setupEnvironment(dir);
              if (setupResult.activateCmd) {
                if (!SESSION._envSetup) SESSION._envSetup = {};
                SESSION._envSetup.python = { activateCmd: setupResult.activateCmd, venvPath: setupResult.venvPath };
                sections.push(`✓ Auto-created Python venv (${envCheck.strategy || 'venv'})`);
              }
            }
          } catch (e) { debugLog(`Pre-flight check failed: ${e.message}`); }
        }
      }
      const getCmd = (label) => { const m = info.match(new RegExp(`${label}:\\s*(.+)`)); return m?.[1]?.trim(); };
      const installCmd = getCmd("Install"); let buildCmd = getCmd("Build"); const testCmd = getCmd("Test");

      // For projects with no build script: auto-detect language and run syntax check
      // This triggers the smart-fix pipeline for ANY language without a compiler
      let syntaxCheckMode = null; // track which language syntax check is used
      if (!buildCmd || buildCmd === "(none)") {
        // Collect source files by language
        const sourceFiles = { js: [], py: [], php: [], rb: [] };
        const skipDirs = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "vendor", ".bundle"]);
        const walkDir = (baseDir, prefix) => {
          try {
            const entries = fs.readdirSync(path.join(dir, baseDir));
            for (const f of entries) {
              if (skipDirs.has(f) || f.startsWith(".")) continue;
              const rel = prefix ? `${prefix}/${f}` : f;
              const full = path.join(dir, baseDir, f);
              try {
                if (fs.statSync(full).isDirectory()) {
                  walkDir(path.join(baseDir, f), rel);
                } else {
                  if (f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs")) sourceFiles.js.push(rel);
                  else if (f.endsWith(".py")) sourceFiles.py.push(rel);
                  else if (f.endsWith(".php")) sourceFiles.php.push(rel);
                  else if (f.endsWith(".rb")) sourceFiles.rb.push(rel);
                }
              } catch (_) {}
            }
          } catch (_) {}
        };
        // Scan src/ first, then root
        if (fs.existsSync(path.join(dir, "src"))) walkDir("src", "src");
        else if (fs.existsSync(path.join(dir, "app"))) walkDir("app", "app");
        else if (fs.existsSync(path.join(dir, "lib"))) walkDir("lib", "lib");
        else walkDir(".", "");

        // Pick the dominant language and generate appropriate syntax check
        if (sourceFiles.js.length > 0) {
          // JavaScript: use vm.Script for syntax checking
          const tmpScript = path.join(dir, ".attar-syntax-check.js");
          const scriptContent = `const fs=require("fs"),vm=require("vm");const files=${JSON.stringify(sourceFiles.js)};let errs=0;for(const f of files){try{new vm.Script(fs.readFileSync(f,"utf-8"),{filename:f})}catch(e){errs++;console.error(f+":"+(e.lineNumber||1));console.error(e.message)}}if(errs){process.exit(1)}else{console.log("All "+files.length+" files passed syntax check")}`;
          try { fs.writeFileSync(tmpScript, scriptContent); } catch (_) {}
          buildCmd = `node .attar-syntax-check.js`;
          syntaxCheckMode = "javascript";
          setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch (_) {} }, 5000);
          debugLog(`JavaScript: syntax-checking ${sourceFiles.js.length} files`);
        } else if (sourceFiles.py.length > 0) {
          // Python: use py_compile for syntax checking (works on all platforms)
          const filesList = sourceFiles.py.map(f => `"${f}"`).join(" ");
          buildCmd = `python -m py_compile ${sourceFiles.py.join(" ")}`;
          // py_compile checks one file at a time; for multiple files use a script
          if (sourceFiles.py.length > 1) {
            const tmpScript = path.join(dir, ".attar-syntax-check.py");
            const pyFiles = sourceFiles.py.map(f => `"${f.replace(/\\/g, "/")}"`).join(", ");
            const scriptContent = `import py_compile, sys\nerrs = 0\nfor f in [${pyFiles}]:\n    try:\n        py_compile.compile(f, doraise=True)\n    except py_compile.PyCompileError as e:\n        errs += 1\n        print(str(e), file=sys.stderr)\nif errs:\n    sys.exit(1)\nelse:\n    print(f"All {len([${pyFiles}])} files passed syntax check")`;
            try { fs.writeFileSync(tmpScript, scriptContent); } catch (_) {}
            buildCmd = `python .attar-syntax-check.py`;
            setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch (_) {} }, 5000);
          }
          syntaxCheckMode = "python";
          debugLog(`Python: syntax-checking ${sourceFiles.py.length} files`);
        } else if (sourceFiles.php.length > 0) {
          // PHP: use php -l for syntax checking
          if (sourceFiles.php.length === 1) {
            buildCmd = `php -l ${sourceFiles.php[0]}`;
          } else {
            // Check all PHP files, collect errors
            const cmds = sourceFiles.php.map(f => `php -l "${f}"`);
            buildCmd = IS_WIN
              ? `cmd /c "(${cmds.join(" & ")}) 2>&1"`
              : `sh -c '${cmds.join("; ")} 2>&1'`;
          }
          syntaxCheckMode = "php";
          debugLog(`PHP: syntax-checking ${sourceFiles.php.length} files`);
        } else if (sourceFiles.rb.length > 0) {
          // Ruby: use ruby -c for syntax checking
          if (sourceFiles.rb.length === 1) {
            buildCmd = `ruby -c ${sourceFiles.rb[0]}`;
          } else {
            const cmds = sourceFiles.rb.map(f => `ruby -c "${f}"`);
            buildCmd = IS_WIN
              ? `cmd /c "(${cmds.join(" & ")}) 2>&1"`
              : `sh -c '${cmds.join("; ")} 2>&1'`;
          }
          syntaxCheckMode = "ruby";
          debugLog(`Ruby: syntax-checking ${sourceFiles.rb.length} files`);
        } else {
          // Fallback: check common entry points
          const entryFiles = ["src/index.js", "src/app.js", "index.js", "app.js", "main.js", "server.js", "main.py", "app.py", "manage.py"];
          const entry = entryFiles.find(f => fs.existsSync(path.join(dir, f)));
          if (entry) {
            const ext = entry.split(".").pop();
            if (ext === "py") buildCmd = `python -m py_compile ${entry}`;
            else buildCmd = `node -c ${entry}`;
          }
        }
      }

      // Smart-fix: rebuild dependency tree before build
      if (smartFix && SESSION._depGraph) {
        try {
          SESSION._depGraph.fullRebuild(dir);
          debugLog(`Smart-fix: tree rebuilt with ${SESSION._depGraph.getFileCount()} files`);
        } catch (err) { debugLog("Smart-fix pre-build: " + err.message); }
      }

      // Reset file-creates counter (model is now building)
      SESSION._fileCreatesWithoutBuild = 0;

      const runStep = (cmd, label, t=120000) => {
        if (!cmd || cmd === "(none)") return { ok: null, out: `(no ${label} command)` };
        try { return { ok: true, out: execSync(cmd, { cwd: dir, encoding: "utf-8", timeout: t, shell: IS_WIN ? true : "/bin/bash", stdio:["pipe","pipe","pipe"] }).slice(0,1500) };
        } catch (e) { return { ok: false, out: ((e.stderr||"")+(e.stdout||"")).slice(0,1500) }; }
      };
      const results = [info.split("\n")[0]];
      if (!args.skip_build && installCmd && installCmd !== "(none)") {
        console.log(co(C.dim, "  Installing deps..."));
        const inst = runStep(installCmd, "install", 180000);
        if (inst.ok === false) { return `❌ INSTALL FAILED\n${installCmd}\n${inst.out}`; }
      }
      if (!args.skip_build) {
        console.log(co(C.dim, syntaxCheckMode ? "  Checking syntax..." : "  Building..."));
        const build = runStep(buildCmd, "build");

        // After syntax check passes: try importing entry file to catch missing module errors
        if (syntaxCheckMode && build.ok) {
          let importCmd = null;
          if (syntaxCheckMode === "javascript") {
            const jsEntries = ["src/index.js", "src/app.js", "index.js", "app.js", "main.js", "server.js"];
            const entry = jsEntries.find(f => fs.existsSync(path.join(dir, f)));
            if (entry) importCmd = `node -e "setTimeout(()=>process.exit(0),2000);require('./${entry}')"`;
          } else if (syntaxCheckMode === "python") {
            const pyEntries = ["main.py", "app.py", "manage.py", "src/main.py", "src/app.py"];
            const entry = pyEntries.find(f => fs.existsSync(path.join(dir, f)));
            if (entry) {
              const module = entry.replace(/\.py$/, "").replace(/\//g, ".");
              importCmd = `python -c "import ${module}"`;
            }
          }
          if (importCmd) {
            console.log(co(C.dim, "  Checking imports..."));
            const importCheck = runStep(importCmd, "import-check", 5000);
            if (importCheck.ok === false && /Cannot find module|MODULE_NOT_FOUND|ModuleNotFoundError|No module named|ImportError|LoadError|require.*cannot load/i.test(importCheck.out)) {
              build.ok = false;
              build.out = importCheck.out;
            }
          }
        }

        results.push(`\n[BUILD] ${build.ok === null ? "skipped" : build.ok ? "✅ PASS" : "❌ FAIL"}`);
        if (build.ok === false) {
        const parsed = pluginParseBuildErrors(build.out, SESSION._lastDetectedTech);
        const docsHint = getTechDocsHint(build.out);
        if (!SESSION._buildState) SESSION._buildState = { fingerprint: null, repeatCount: 0, lastParsed: null, errorHistory: [], editsBetweenBuilds: 0 };
        const fp = build.out.slice(0, 200);
        SESSION._buildState.repeatCount = (fp === SESSION._buildState.fingerprint) ? SESSION._buildState.repeatCount + 1 : 1;
        SESSION._buildState.fingerprint = fp;
        SESSION._buildState.lastParsed = parsed;
        SESSION._buildState._pendingErrors = parsed.sorted.map(f => ({
          file: f.file,
          errors: f.errors.slice(0, 5),
          count: f.count,
        }));

        // Track error count history for convergence detection
        const currentErrorCount = parsed?.totalErrors || 0;
        SESSION._buildState.errorHistory.push(currentErrorCount);
        SESSION._buildState.editsBetweenBuilds = 0; // Reset edit counter

        // Recommendation 2: Error convergence check — if errors go UP, change strategy
        const hist = SESSION._buildState.errorHistory;
        const isOscillating = hist.length >= 3 &&
          hist[hist.length - 1] >= hist[hist.length - 2] &&
          hist[hist.length - 2] >= hist[hist.length - 3];

        results.push(`\n[BUILD] ❌ FAIL (${currentErrorCount} errors${hist.length > 1 ? `, was ${hist[hist.length - 2]}` : ""})`);
        results.push(parsed ? `\n${parsed.summary}` : build.out.slice(0, 1500));

        // Recommendation 3: Rewrite-from-scratch threshold — if a file has 20+ errors, rewrite it
        if (parsed) {
          const rewriteCandidates = parsed.sorted.filter(f => f.count >= 15);
          if (rewriteCandidates.length > 0) {
            results.push(`\n⚠ REWRITE RECOMMENDED: These files have too many errors to fix individually:`);
            for (const f of rewriteCandidates) {
              results.push(`  - ${f.file} (${f.count} errors) → use write_file to REWRITE this file completely`);
            }
            results.push(`Read the file first, understand its purpose, then write_file with a clean implementation.`);
          }
        }

        // Auto-rollback: if errors INCREASED after edits, revert to last checkpoint
        if (hist.length >= 2 && hist[hist.length - 1] > hist[hist.length - 2]) {
          const prevErrors = hist[hist.length - 2];
          const newErrors = hist[hist.length - 1];
          const increase = newErrors - prevErrors;
          results.push(`\n⚠ ERRORS INCREASED: ${prevErrors} → ${newErrors} (+${increase}). Your last edits made things WORSE.`);
          // Auto-revert files that were edited since last build
          if (SESSION.checkpoints && SESSION.checkpoints.length > 0) {
            const revertIdx = SESSION._buildState._lastBuildCheckpointIdx || 0;
            const lastCp = SESSION.checkpoints[Math.max(0, revertIdx - 1)] || SESSION.checkpoints[SESSION.checkpoints.length - 1];
            if (lastCp && lastCp.files) {
              let reverted = 0;
              for (const [filePath, content] of Object.entries(lastCp.files)) {
                if (fs.existsSync(filePath)) {
                  try {
                    fs.writeFileSync(filePath, content, "utf-8");
                    reverted++;
                  } catch (_) {}
                }
              }
              if (reverted > 0) {
                results.push(`⚡ AUTO-REVERTED ${reverted} file(s) to last checkpoint (before the bad edits).`);
                results.push(`The files are now back to the state with ${prevErrors} errors.`);
                results.push(`Try a DIFFERENT fix approach. Do NOT repeat the same edits.`);
                console.log(co(C.bYellow, `  ⚡ Auto-reverted ${reverted} files (errors increased ${prevErrors}→${newErrors})`));
                // Remove the last error count since we reverted
                hist.pop();
              }
            }
          }
          if (!results.some(r => r.includes("AUTO-REVERTED"))) {
            results.push(`⚡ Could not auto-revert (no checkpoint). Try a DIFFERENT approach — do NOT repeat the same edits.`);
          }
        }

        // Recommendation 2: If oscillating, force different strategy
        if (isOscillating) {
          results.push(`\n⚠ ERRORS NOT CONVERGING (${hist.slice(-3).join(" → ")}). Your edits are introducing new errors.`);
          results.push(`CHANGE STRATEGY: Instead of editing individual lines, REWRITE the most-broken file completely with write_file.`);
          results.push(`Focus on ONE file at a time. Get that file to 0 errors before moving to the next.`);
        }

        const prescriptionText = prescribeFixesForBuild(parsed, build.out, dir);
        results.push(prescriptionText);

        // ── Cross-file error pattern detection ──
        // Group errors by their normalized message to detect "7 files, same root cause"
        if (parsed && parsed.sorted.length >= 3) {
          const errorSignatures = new Map();
          for (const { file: f, errors: errs } of parsed.sorted) {
            for (const e of errs) {
              // Normalize: strip line numbers, file paths, keep error essence
              const sig = e.replace(/line\s+\d+:\s*/, "").replace(/['"][^'"]+['"]/g, "'...'").trim().slice(0, 120);
              if (!errorSignatures.has(sig)) errorSignatures.set(sig, []);
              errorSignatures.get(sig).push(f);
            }
          }
          // Find patterns affecting 3+ files
          for (const [sig, files] of errorSignatures) {
            if (files.length >= 3) {
              results.push(`\n⚠ SHARED ROOT CAUSE DETECTED: ${files.length} files have the same error:`);
              results.push(`  Error: "${sig}"`);
              results.push(`  Files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`);
              // Detect missing module/file pattern
              const missingModule = sig.match(/(?:Cannot find module|ModuleNotFoundError|No module named|ImportError).*?['"]([^'"]+)['"]/i);
              if (missingModule) {
                results.push(`  ⚡ ROOT CAUSE: Module '${missingModule[1]}' does not exist. CREATE THIS FILE FIRST.`);
                results.push(`  Do NOT edit the ${files.length} files individually — create the missing module, then rebuild.`);
              } else {
                results.push(`  ⚡ These files share the same underlying issue. Fix the ROOT CAUSE once, don't fix each file separately.`);
              }
            }
          }
          // Merge patterns for edit loop detection (don't overwrite richer symbol groups)
          if (!SESSION._buildState) SESSION._buildState = {};
          if (SESSION._buildState._errorSignatures) {
            for (const [key, files] of errorSignatures) {
              const existing = SESSION._buildState._errorSignatures.get(key);
              if (existing) { for (const f of files) { if (!existing.includes(f)) existing.push(f); } }
              else { SESSION._buildState._errorSignatures.set(key, files); }
            }
          } else {
            SESSION._buildState._errorSignatures = errorSignatures;
          }
        }

        // Smart-fix: enhanced fix ordering replaces default ordering (ALL languages)
        if (smartFix && SESSION._depGraph && parsed) {
          try {
            // Auto-detect plugin from language
            const detectedLang = SESSION._depGraph.detectedLanguage;
            const pluginMap = { "TypeScript": "typescript", "Python": "python", "Go": "go", "Rust": "rust", "Java / Kotlin": "java", "C# / .NET": "csharp", "PHP": "php", "Swift": "swift" };
            const pluginName = pluginMap[detectedLang] || (SESSION._lastDetectedTech?.includes("Node") ? "typescript" : SESSION._lastDetectedTech?.includes("Python") ? "python" : null);
            let plugin = SESSION._depGraph.plugin || null;
            if (!plugin && pluginName) {
              const pluginPath = path.join(HOME_DIR, "plugins", `${pluginName}.json`);
              try { plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8")); } catch (e) { /* no plugin */ }
            }

            // Use PluginRegistry plugin for classifyErrors if available (exposes get errorCatalog)
            if (pluginRegistry) {
              const regPlugin = pluginRegistry.pluginForTech(SESSION._lastDetectedTech);
              if (regPlugin) plugin = regPlugin; // JS plugin with .errorCatalog getter
            }

            if (plugin) {
              const { classifyErrors } = require("./smart-fix/error-classifier");

              // If pluginParseBuildErrors already produced structured errors, use them directly
              let structuredErrors;
              if (parsed._pluginErrors && parsed._pluginErrors.length > 0) {
                structuredErrors = parsed._pluginErrors.map(e => ({
                  file: path.resolve(dir, e.file), line: e.line, code: e.code, message: e.message,
                }));
              } else {
              // Fallback: Universal error parser from parseBuildErrors string output
              structuredErrors = parsed.sorted.flatMap(({ file: f, errors: errs }) =>
                errs.map(e => {
                  const trimmed = e.trim();
                  const resolvedFile = path.resolve(dir, f);

                  // TypeScript: "line 12: TS2339: Property 'x' does not exist"
                  let m = trimmed.match(/line\s+(\d+):\s*(TS\d+):\s*(.*)/);
                  if (m) return { file: resolvedFile, line: parseInt(m[1]), code: m[2], message: m[3].trim() };

                  // Rust: "line 5: error[E0425]" or "line 5: E0425: message"
                  m = trimmed.match(/line\s+(\d+):\s*(?:error\[)?(E\d{4})\]?:?\s*(.*)/);
                  if (m) return { file: resolvedFile, line: parseInt(m[1]), code: m[1] ? m[2] : m[2], message: m[3]?.trim() || `Rust error ${m[2]}` };

                  // C#: "line 5: CS0246: type not found"
                  m = trimmed.match(/line\s+(\d+):\s*(CS\d{4}):\s*(.*)/);
                  if (m) return { file: resolvedFile, line: parseInt(m[1]), code: m[2], message: m[3].trim() };

                  // Python mypy: "line 10: error: message [code]" or just "line 10"
                  m = trimmed.match(/line\s+(\d+)(?::\s*(?:error:\s*)?(.*))?/);
                  if (m) {
                    const msg = m[2]?.trim() || "";
                    // Extract mypy code from brackets [import] [arg-type] etc.
                    const mypyCode = msg.match(/\[([^\]]+)\]/)?.[1];
                    // Extract Python error type from message
                    const pyType = msg.match(/^(TypeError|ImportError|ModuleNotFoundError|AttributeError|NameError|ValueError|SyntaxError):/)?.[1];
                    const code = mypyCode ? `MYPY_${mypyCode.toUpperCase().replace(/-/g, "_")}` : pyType || "ERROR";
                    return { file: resolvedFile, line: parseInt(m[1]), code, message: msg || `Error at line ${m[1]}` };
                  }

                  // Go: "undefined: X" or "cannot use X" (no line number from parseBuildErrors)
                  m = trimmed.match(/^(undefined|cannot use|imported and not used|does not implement|missing return)(.*)$/i);
                  if (m) {
                    const goErrors = {
                      "undefined": "GO_UNDEFINED", "cannot use": "GO_TYPE_MISMATCH",
                      "imported and not used": "GO_UNUSED_IMPORT", "does not implement": "GO_INTERFACE",
                      "missing return": "GO_MISSING_RETURN",
                    };
                    const code = goErrors[m[1].toLowerCase()] || "GO_ERROR";
                    return { file: resolvedFile, line: 0, code, message: trimmed };
                  }

                  // Java: "cannot find symbol" "incompatible types" etc.
                  m = trimmed.match(/line\s+(\d+):\s*(cannot find symbol|incompatible types|package .* does not exist|method .* not found)(.*)/i);
                  if (m) {
                    const javaErrors = {
                      "cannot find symbol": "JAVA_CANNOT_FIND_SYMBOL",
                      "incompatible types": "JAVA_INCOMPATIBLE_TYPES",
                    };
                    const code = Object.entries(javaErrors).find(([k]) => m[2].includes(k))?.[1] || "JAVA_ERROR";
                    return { file: resolvedFile, line: parseInt(m[1]), code, message: (m[2] + (m[3] || "")).trim() };
                  }

                  // PHP: various error formats
                  m = trimmed.match(/line\s+(\d+):\s*(.*)/);
                  if (m && m[2]) {
                    const phpCode = /Class .* not found/i.test(m[2]) ? "PHP_CLASS_NOT_FOUND"
                      : /Call to undefined/i.test(m[2]) ? "PHP_UNDEFINED_METHOD"
                      : /Undefined variable/i.test(m[2]) ? "PHP_UNDEFINED_VARIABLE"
                      : "PHP_ERROR";
                    return { file: resolvedFile, line: parseInt(m[1]), code: phpCode, message: m[2].trim() };
                  }

                  // Fallback: any error text > 5 chars
                  if (trimmed.length > 5) return { file: resolvedFile, line: 0, code: "ERROR", message: trimmed.slice(0, 150) };
                  return null;
                }).filter(Boolean)
              );
              } // end else (fallback parser)
              if (structuredErrors.length > 0) {
                const classified = classifyErrors(structuredErrors, SESSION._depGraph, plugin);
                const fixPlan = smartFix.computeFixOrder(classified, SESSION._depGraph.getRanks());

                // v2: Run fix engine — auto-fix what we can before LLM sees errors
                try {
                  const fixResult = await smartFix.runFixEngine(
                    fixPlan, SESSION._depGraph,
                    SESSION._depGraph.detectedLanguage || "TypeScript", dir
                  );
                  if (fixResult.autoFixed.length > 0) {
                    results.push(`\n⚡ AUTO-FIXED ${fixResult.autoFixed.length} error(s) without LLM:`);
                    for (const af of fixResult.autoFixed) {
                      results.push(`  ✓ ${path.basename(af.file)}: ${af.description} (${af.strategy}, confidence: ${af.confidence})`);
                    }
                    results.push(`Remaining: ${fixResult.stats.complex} error(s) need LLM attention.`);
                    console.log(co(C.bGreen, `  ⚡ Fix engine: auto-fixed ${fixResult.autoFixed.length} errors`));
                  }
                  // Tier 2: show candidate choices for LLM
                  if (fixResult.candidatesForLLM && fixResult.candidatesForLLM.length > 0) {
                    results.push(`\n🔧 ${fixResult.candidatesForLLM.length} error(s) have fix CANDIDATES — choose the best:`);
                    for (const cf of fixResult.candidatesForLLM) {
                      results.push(cf.promptBlock);
                    }
                  }
                  // Tier 3: show rich context for complex errors
                  if (fixResult.complexForLLM.length > 0) {
                    // Use plugin.buildFixPrompt() if available, else fall back to fix engine's promptBlock
                    const regPlugin = pluginRegistry ? pluginRegistry.pluginForTech(SESSION._lastDetectedTech) : null;
                    const withPrompt = fixResult.complexForLLM.map(c => {
                      if (regPlugin && c.error) {
                        try {
                          const pluginPrompt = regPlugin.buildFixPrompt(c.error, {
                            codeSnippet: c.fullContext || '',
                            functionName: c.error.captures?.functionName || null,
                            env: { version: SESSION._envCheck?.[0]?.runtime?.version, packageManager: SESSION._envCheck?.[0]?.packageManager?.name },
                          });
                          return { ...c, promptBlock: pluginPrompt };
                        } catch { /* fall through to original */ }
                      }
                      return c;
                    }).filter(c => c.promptBlock);
                    if (withPrompt.length > 0) {
                      results.push(`\n📋 ${withPrompt.length} complex error(s) — fix with full context:`);
                      for (const cf of withPrompt.slice(0, 5)) {
                        results.push(cf.promptBlock);
                      }
                      if (withPrompt.length > 5) {
                        results.push(`... and ${withPrompt.length - 5} more errors. Fix the above first, then rebuild.`);
                      }
                    } else {
                      const analysis = smartFix.buildBuildErrorAnalysis(fixPlan, parsed.totalErrors - fixResult.autoFixed.length);
                      results.push("\n" + analysis);
                    }
                    const defaultOrderIdx = results.findIndex(r => typeof r === "string" && r.includes("Fix IN THIS ORDER"));
                    if (defaultOrderIdx >= 0) results[defaultOrderIdx] = results[defaultOrderIdx].split("Fix IN THIS ORDER")[0] + "(see dependency-aware analysis below)";
                  }
                } catch (fixErr) {
                  debugLog("Fix engine error: " + fixErr.message);
                  // Fallback to existing analysis
                  const analysis = smartFix.buildBuildErrorAnalysis(fixPlan, parsed.totalErrors);
                  const defaultOrderIdx = results.findIndex(r => typeof r === "string" && r.includes("Fix IN THIS ORDER"));
                  if (defaultOrderIdx >= 0) results[defaultOrderIdx] = results[defaultOrderIdx].split("Fix IN THIS ORDER")[0] + "(see dependency-aware analysis below)";
                  results.push("\n" + analysis);
                }
              }
            }
          } catch (err) { debugLog("Smart-fix build analysis: " + err.message); }
        }

        if (SESSION._buildState.repeatCount >= 3 && CONFIG.proxyUrl) {
          // Extract only the error lines from build output (not the "Technology: Node.js" header)
          const errorLines = build.out.split("\n").filter(l => /error|Error|failed|FAIL|cannot|undefined|not found/i.test(l)).join("\n") || build.out.slice(-500);
          autoSearchForSolution(errorLines, "build_and_test").then(hint => {
            if (hint) SESSION.messages.push({ role: "user", content: `[AUTO-SEARCH] Build error repeated ${SESSION._buildState.repeatCount}x.\n${hint}\nApply these findings.` });
          }).catch(err => debugLog(err.message));
        }

        // Auto-search KB for relevant docs + fix recipes
        if (CONFIG.proxyUrl && parsed?.totalErrors > 0) {
          try {
            const errorSample = parsed.sorted[0]?.errors[0] || "";
            const kbResult = await proxyPost("/kb/recipe/search", { query: errorSample.slice(0, 200), num: 3 });
            if (kbResult.formatted && !kbResult.formatted.includes("No relevant")) {
              results.push("\n\n📚 KB DOCS (from documentation + past fixes):\n" + kbResult.formatted.slice(0, 800));
            }
          } catch (_) {}
        }

        printToolDone("BUILD FAIL"); return results.join("\n");
      }
      if (!SESSION._buildState) SESSION._buildState = {};
      SESSION._buildState.lastBuildSuccess = Date.now();
      SESSION._buildState._lastBuildCheckpointIdx = SESSION.checkpoints?.length || 0;
      SESSION._buildState._errorSignatures = null; // Clear stale error state on success
      SESSION._buildState.errorHistory = [];
      errorDoctorLearnFromSuccess();
      // Record fix outcome: build succeeded after previous failure
      if (SESSION._buildState && SESSION._buildState.lastParsed && SESSION._buildState.lastParsed.totalErrors > 0) {
        // The model fixed the errors — record this in the learner
        try {
          const FixLearner = require("./smart-fix/fix-engine/fix-learner").FixLearner;
          const learner = new FixLearner();
          const prevErrors = SESSION._buildState._pendingErrors || [];
          const recentEdits = SESSION._recentEdits || [];
          for (const fileGroup of prevErrors) {
            // Find the edit that fixed this file (match by filename)
            const relatedEdit = recentEdits.find(e => e.file && fileGroup.file && (e.file.includes(path.basename(fileGroup.file)) || fileGroup.file.includes(path.basename(e.file))));
            const errorMsg = fileGroup.errors[0] || "";
            learner.recordOutcome({
              errorCode: errorMsg.match(/^  line \d+: (\S+)/)?.[1] || "UNKNOWN",
              strategy: "llm_edit",
              language: SESSION._lastDetectedTech || "unknown",
              file: fileGroup.file,
              passed: true,
              confidence: 0.7,
              // Enhanced: actual fix recipe
              errorMessage: errorMsg.slice(0, 200),
              fixFile: relatedEdit?.file || fileGroup.file,
              fixDiff: relatedEdit ? `- ${relatedEdit.oldStr}\n+ ${relatedEdit.newStr}` : null,
              fixDescription: relatedEdit ? `Replaced code in ${path.basename(relatedEdit.file)}` : "LLM edit (diff not captured)",
            });
          }
          debugLog(`Feedback: recorded ${prevErrors.length} fix outcomes with diffs (build succeeded after failure)`);
        } catch (err) { debugLog("Feedback record error: " + err.message); }
        // Clear pending errors
        SESSION._buildState._pendingErrors = null;
        SESSION._buildState.lastParsed = null;
      }
      if (SESSION._editCounts) SESSION._editCounts = {};
      }
      if (!args.skip_test) {
        console.log(co(C.dim, "  Testing..."));
        const test = runStep(testCmd, "test");
        results.push(`\n[TEST] ${test.ok === null ? "skipped" : test.ok ? "✅ PASS" : "❌ FAIL"}`);
        if (test.out) results.push(test.out.slice(0, 800));
        if (test.ok === false) results.push("\nFix failing tests: read output above, grep_search for test file, edit_file to fix, then retry.");
      }
      printToolDone("Done");
      return results.join("\n");
    }

    case "find_files": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      const pattern = args.pattern || "*";
      printToolRunning("find_files", pattern);
      try {
        // Use find command with name pattern
        const globToFind = pattern.includes("**")
          ? `-name "${pattern.replace(/\*\*\//g, '')}"`
          : `-name "${pattern}" -maxdepth 3`;
        const out = execSync(
          `find "${dir}" ${globToFind} -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/__pycache__/*" 2>/dev/null | head -50`,
          { encoding:"utf-8", timeout:10000, stdio:["pipe","pipe","pipe"] }
        ).trim();
        const files = out ? out.split("\n").map(f => f.replace(dir + "/", "")) : [];
        printToolDone(`Found ${files.length} files`);
        return files.length ? files.join("\n") : "No files found matching: " + pattern;
      } catch (e) {
        return `No files found matching: ${pattern}`;
      }
    }

    case "grep_search": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      const maxResults = args.max_results || 20;

      // Loop detection for repeated searches
      if (!SESSION._searchCounts) SESSION._searchCounts = {};
      const searchKey = `${args.pattern}:${dir}`;
      SESSION._searchCounts[searchKey] = (SESSION._searchCounts[searchKey] || 0) + 1;
      if (SESSION._searchCounts[searchKey] > 2) {
        return `⚠ You already searched for "${args.pattern}" ${SESSION._searchCounts[searchKey]} times with the same results. Try a DIFFERENT search term or approach.`;
      }

      printToolRunning("grep_search", args.pattern);
      try {
        let cmd = `grep -rn --include="${args.include || '*'}" "${args.pattern}" "${dir}" 2>/dev/null | head -${maxResults}`;
        const out = execSync(cmd, { encoding:"utf-8", timeout:10000, stdio:["pipe","pipe","pipe"] }).trim();
        const lines = out ? out.split("\n").map(l => l.replace(dir + "/", "")) : [];
        printToolDone(`Found ${lines.length} matches`);
        return lines.length ? lines.join("\n") : "No matches found for: " + args.pattern;
      } catch (_) {
        return `No matches found for: ${args.pattern}`;
      }
    }

    case "create_pdf": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_pdf", fp);

      // Write content and metadata to temp files (avoids string escaping issues)
      const tmpContent = path.join(os.tmpdir(), `ml_pdf_content_${Date.now()}.txt`);
      const tmpMeta = path.join(os.tmpdir(), `ml_pdf_meta_${Date.now()}.json`);
      fs.writeFileSync(tmpContent, args.content || "", "utf-8");
      fs.writeFileSync(tmpMeta, JSON.stringify({ title: args.title || "", author: args.author || "", filepath: fp }));

      const pyCode = `
import sys, json, os

try:
    from fpdf import FPDF
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "fpdf2", "-q"])
    from fpdf import FPDF

with open(${JSON.stringify(tmpMeta)}, "r") as f:
    meta = json.load(f)
with open(${JSON.stringify(tmpContent)}, "r", encoding="utf-8") as f:
    content = f.read()

pdf = FPDF()
pdf.set_auto_page_break(auto=True, margin=15)
pdf.add_page()

if meta["title"]:
    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 12, meta["title"], new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(5)
if meta["author"]:
    pdf.set_font("Helvetica", "I", 10)
    pdf.cell(0, 6, "By " + meta["author"], new_x="LMARGIN", new_y="NEXT", align="C")
    pdf.ln(8)

pdf.set_font("Helvetica", "", 11)
in_code = False
for line in content.split("\\n"):
    stripped = line.strip()
    if stripped.startswith("\`\`\`") or stripped == "\`\`\`":
        in_code = not in_code
        if in_code:
            pdf.set_font("Courier", "", 9)
            pdf.set_fill_color(240, 240, 240)
        else:
            pdf.set_font("Helvetica", "", 11)
        continue
    if in_code:
        safe = line.encode("latin-1", "replace").decode("latin-1")
        pdf.cell(0, 5, "  " + safe, new_x="LMARGIN", new_y="NEXT", fill=True)
        continue
    if stripped.startswith("# "):
        pdf.ln(4)
        pdf.set_font("Helvetica", "B", 16)
        pdf.cell(0, 10, stripped[2:], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped.startswith("## "):
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 14)
        pdf.cell(0, 8, stripped[3:], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped.startswith("### "):
        pdf.ln(2)
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 7, stripped[4:], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped.startswith("- ") or stripped.startswith("* "):
        safe = ("    " + stripped[2:]).encode("latin-1", "replace").decode("latin-1")
        pdf.cell(0, 6, safe, new_x="LMARGIN", new_y="NEXT")
    elif stripped.startswith("**") and stripped.endswith("**"):
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 6, stripped[2:-2], new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
    elif stripped == "":
        pdf.ln(3)
    else:
        try:
            safe = stripped.encode("latin-1", "replace").decode("latin-1")
            pdf.multi_cell(0, 6, safe)
        except Exception:
            pdf.cell(0, 6, stripped[:80], new_x="LMARGIN", new_y="NEXT")

pdf.output(meta["filepath"])
print(json.dumps({"ok": True, "pages": pdf.page}))
`;
      const tmp = path.join(os.tmpdir(), `ml_pdf_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); fs.unlinkSync(tmpContent); fs.unlinkSync(tmpMeta); } catch (err) { debugLog(err.message); }
        const result = JSON.parse(out);
        printToolDone(`${result.pages} pages`);
        return `✅ PDF created: ${fp} (${result.pages} pages)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); fs.unlinkSync(tmpContent); fs.unlinkSync(tmpMeta); } catch (err) { debugLog(err.message); }
        return `❌ PDF creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_excel": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_excel", fp);

      // Auto-detect data format: array of objects → convert to sheets format
      let sheets;
      if (args.data) {
        try {
          const data = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
          if (Array.isArray(data) && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
            const headers = Object.keys(data[0]);
            const rows = data.map(obj => headers.map(h => obj[h] ?? ""));
            sheets = [{ name: args.sheet_name || "Sheet1", headers, rows }];
          } else {
            sheets = data;
          }
        } catch(e) { return `❌ Invalid data JSON: ${e.message}`; }
      } else if (args.sheets) {
        try { sheets = typeof args.sheets === "string" ? JSON.parse(args.sheets) : args.sheets; } catch(e) { return `❌ Invalid sheets JSON: ${e.message}`; }
      } else {
        return `❌ Missing required: either data (array of objects) or sheets (array of sheet definitions)`;
      }

      const pyCode = `
import sys, json
try:
    import openpyxl
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q"])
    import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

sheets = ${JSON.stringify(sheets)}
filepath = ${JSON.stringify(fp)}
wb = openpyxl.Workbook()
wb.remove(wb.active)

for s in sheets:
    ws = wb.create_sheet(title=s.get("name", "Sheet"))
    headers = s.get("headers", [])
    rows = s.get("rows", [])
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")
        ws.column_dimensions[cell.column_letter].width = max(len(str(h)) + 4, 12)
    for r, row in enumerate(rows, 2):
        for c, val in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=val)
            if isinstance(val, str) and val.startswith("="):
                cell.value = val

wb.save(filepath)
print(json.dumps({"ok": True, "sheets": len(sheets)}))
`;
      const tmp = path.join(os.tmpdir(), `ml_xlsx_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        const result = JSON.parse(out);
        printToolDone(`${result.sheets} sheets`);
        return `✅ Excel created: ${fp} (${result.sheets} sheets)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        return `❌ Excel creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_docx": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_docx", fp);
      const pyCode = `
import sys, json
try:
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx", "-q"])
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

content = ${JSON.stringify(args.content)}
title = ${JSON.stringify(args.title || "")}
filepath = ${JSON.stringify(fp)}

doc = Document()

if title:
    t = doc.add_heading(title, level=0)
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER

in_code = False
in_list = False
for line in content.split("\\n"):
    stripped = line.strip()
    if stripped.startswith("\`\`\`"):
        in_code = not in_code
        continue
    if in_code:
        p = doc.add_paragraph(line)
        p.style.font.name = "Courier New"
        p.style.font.size = Pt(9)
        continue
    if stripped.startswith("# "):
        doc.add_heading(stripped[2:], level=1)
    elif stripped.startswith("## "):
        doc.add_heading(stripped[3:], level=2)
    elif stripped.startswith("### "):
        doc.add_heading(stripped[4:], level=3)
    elif stripped.startswith("- ") or stripped.startswith("* "):
        doc.add_paragraph(stripped[2:], style="List Bullet")
    elif stripped and stripped[0].isdigit() and ". " in stripped[:4]:
        doc.add_paragraph(stripped.split(". ", 1)[1], style="List Number")
    elif stripped == "---":
        doc.add_page_break()
    elif stripped == "":
        doc.add_paragraph("")
    else:
        p = doc.add_paragraph()
        # Handle bold
        parts = stripped.split("**")
        for i, part in enumerate(parts):
            run = p.add_run(part)
            if i % 2 == 1:
                run.bold = True

doc.save(filepath)
paras = len(doc.paragraphs)
print(json.dumps({"ok": True, "paragraphs": paras}))
`;
      const tmp = path.join(os.tmpdir(), `ml_docx_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        const result = JSON.parse(out);
        printToolDone(`${result.paragraphs} paragraphs`);
        return `✅ Word document created: ${fp} (${result.paragraphs} paragraphs)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        return `❌ DOCX creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_pptx": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_pptx", fp);
      let slides;
      try { slides = JSON.parse(args.slides); } catch(e) { return `❌ Invalid slides JSON: ${e.message}`; }

      const pyCode = `
import sys, json
try:
    from pptx import Presentation
    from pptx.util import Inches, Pt
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-pptx", "-q"])
    from pptx import Presentation
    from pptx.util import Inches, Pt

slides_data = ${JSON.stringify(slides)}
title_text = ${JSON.stringify(args.title || "")}
author = ${JSON.stringify(args.author || "")}
filepath = ${JSON.stringify(fp)}

prs = Presentation()

# Title slide
if title_text:
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = title_text
    if author and slide.placeholders[1]:
        slide.placeholders[1].text = author

# Content slides
for s in slides_data:
    slide_title = s.get("title", "")
    bullets = s.get("bullets", [])
    layout = prs.slide_layouts[1]  # Title + Content
    slide = prs.slides.add_slide(layout)
    if slide_title:
        slide.shapes.title.text = slide_title
    if bullets and slide.placeholders[1]:
        tf = slide.placeholders[1].text_frame
        tf.clear()
        for i, bullet in enumerate(bullets):
            if i == 0:
                tf.text = bullet
            else:
                p = tf.add_paragraph()
                p.text = bullet
                p.level = 0

prs.save(filepath)
print(json.dumps({"ok": True, "slides": len(slides_data) + (1 if title_text else 0)}))
`;
      const tmp = path.join(os.tmpdir(), `ml_pptx_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        const result = JSON.parse(out);
        printToolDone(`${result.slides} slides`);
        return `✅ PowerPoint created: ${fp} (${result.slides} slides)`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        return `❌ PPTX creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "create_chart": {
      const fp = path.isAbsolute(args.filepath) ? args.filepath : path.resolve(SESSION.cwd, args.filepath);
      printToolRunning("create_chart", `${args.type} chart`);
      let labels, values, legend;
      try { labels = JSON.parse(args.labels); } catch(e) { return `❌ Invalid labels JSON: ${e.message}`; }
      try { values = JSON.parse(args.values); } catch(e) { return `❌ Invalid values JSON: ${e.message}`; }
      try { legend = args.legend ? JSON.parse(args.legend) : null; } catch(_) { legend = null; }

      const pyCode = `
import sys, json
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "matplotlib", "-q"])
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
import numpy as np

chart_type = ${JSON.stringify(args.type)}
labels = ${JSON.stringify(labels)}
values = ${JSON.stringify(values)}
title = ${JSON.stringify(args.title || "")}
xlabel = ${JSON.stringify(args.xlabel || "")}
ylabel = ${JSON.stringify(args.ylabel || "")}
legend_names = ${JSON.stringify(legend)}
filepath = ${JSON.stringify(fp)}

plt.figure(figsize=(10, 6))
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'ggplot')

multi = isinstance(values[0], list) if values else False

if chart_type == "bar":
    if multi:
        x = np.arange(len(labels))
        width = 0.8 / len(values)
        for i, series in enumerate(values):
            plt.bar(x + i * width, series, width, label=legend_names[i] if legend_names else f"Series {i+1}")
        plt.xticks(x + width * (len(values)-1) / 2, labels)
    else:
        colors = plt.cm.Set2(np.linspace(0, 1, len(labels)))
        plt.bar(labels, values, color=colors)
elif chart_type == "line":
    if multi:
        for i, series in enumerate(values):
            plt.plot(labels, series, marker='o', label=legend_names[i] if legend_names else f"Series {i+1}")
    else:
        plt.plot(labels, values, marker='o', linewidth=2, markersize=8)
elif chart_type == "pie":
    plt.pie(values, labels=labels, autopct='%1.1f%%', startangle=90)
elif chart_type == "scatter":
    if multi and len(values) == 2:
        plt.scatter(values[0], values[1], s=100, alpha=0.7)
    else:
        plt.scatter(range(len(values)), values, s=100, alpha=0.7)

if title: plt.title(title, fontsize=14, fontweight='bold')
if xlabel: plt.xlabel(xlabel)
if ylabel: plt.ylabel(ylabel)
if (multi or legend_names) and chart_type != "pie": plt.legend()
plt.tight_layout()
plt.savefig(filepath, dpi=150, bbox_inches='tight')
plt.close()
print(json.dumps({"ok": True}))
`;
      const tmp = path.join(os.tmpdir(), `ml_chart_${Date.now()}.py`);
      fs.writeFileSync(tmp, pyCode);
      try {
        const out = execSync(`${PYTHON} "${tmp}"`, { cwd: SESSION.cwd, encoding:"utf-8", timeout:30000, stdio:["pipe","pipe","pipe"] });
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        printToolDone("Chart saved!");
        return `✅ Chart created: ${fp}`;
      } catch(e) {
        try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
        return `❌ Chart creation failed: ${(e.stderr || e.message).slice(0, 500)}`;
      }
    }

    case "use_skill": {
      const name = args.name?.toLowerCase().replace(/\s+/g, "-");
      printToolRunning("use_skill", name);
      const content = loadSkill(name);
      if (!content) {
        // List available skills
        const available = [];
        try { for (const f of fs.readdirSync(SKILLS_DIR)) { if (f.endsWith(".md")) available.push(f.replace(".md","")); } } catch (err) { debugLog(err.message); }
        printToolDone("Not found");
        return `Skill "${name}" not found. Available skills: ${available.join(", ") || "(none installed)"}.\n\nYou can also try: backend, frontend, code-review, ui-design, testing, security, database, devops, performance, documentation`;
      }
      if (!SESSION._injectedSkills) SESSION._injectedSkills = new Set();
      SESSION._injectedSkills.add(name);
      printToolDone(`Loaded: ${name}`);
      return `✓ Skill "${name}" activated. Here is the expert knowledge:\n\n${content.slice(0, 3000)}`;
    }

    // ── Environment & Plugin Tools ──────────────────────────────────────────
    case "check_environment": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      printToolRunning("check_environment", dir);

      if (!pluginRegistry) {
        printToolDone("N/A");
        return "Plugin system not available. check_environment requires the plugins/ directory.";
      }

      let reports;
      if (args.technology || SESSION._lastDetectedTech) {
        const tech = args.technology || SESSION._lastDetectedTech;
        const plugin = pluginRegistry.pluginForTech(tech);
        if (plugin) {
          reports = [{ language: plugin.id, displayName: plugin.displayName, ...plugin.checkEnvironment(dir) }];
        } else {
          reports = pluginRegistry.checkAllEnvironments(dir);
        }
      } else {
        reports = pluginRegistry.checkAllEnvironments(dir);
      }

      if (reports.length === 0) {
        printToolDone("No languages detected");
        return "No known languages detected in this project. Supported: Python, TypeScript/Node.js, Rust, Go, Java, C/C++, PHP, C#, NestJS, Next.js, React Native.\n\nTip: If you're creating a NEW project, pass the technology parameter (e.g., check_environment with technology='nestjs').";
      }

      // Cache in session
      SESSION._envCheck = reports;
      // Update working memory if available
      if (workingMemory && reports[0]?.runtime?.installed) {
        workingMemory._detectedEnv = {
          tech: reports[0].displayName,
          version: reports[0].runtime.version,
          venv: reports[0].virtualEnv?.path || null,
          strategy: reports[0].strategy || null,
        };
      }

      printToolDone(reports.map(r => `${r.displayName}: ${r.ready ? "READY" : "NOT READY"}`).join(", "));
      let envReport = pluginRegistry.formatEnvReport(reports);

      // Append latest version info for the detected technology
      const tech = args.technology || SESSION._lastDetectedTech;
      if (tech) {
        const plugin = pluginRegistry.pluginForTech(tech);
        if (plugin) {
          try {
            const versions = await plugin.getLatestVersions();
            if (versions && (versions.runtime || Object.keys(versions.frameworks || {}).length > 0)) {
              envReport += "\n\nLatest Stable Versions:";
              if (versions.runtime) envReport += `\n  Runtime: ${plugin.displayName} ${versions.runtime}`;
              for (const [fw, ver] of Object.entries(versions.frameworks || {})) {
                envReport += `\n  ${fw}: ${ver}`;
              }
              envReport += "\n\nIMPORTANT: Use these exact versions when creating the project. Do NOT guess.";
            }
          } catch { /* version resolution failed — offline */ }

          // Append scaffold CLI command from plugin
          try {
            const scaffoldData = plugin.scaffold("project-name", {});
            if (scaffoldData.postCreate && scaffoldData.postCreate.length > 0) {
              envReport += "\n\nScaffold Command (recommended):";
              for (const cmd of scaffoldData.postCreate) {
                envReport += `\n  ${cmd.replace("project-name", "<name>")}`;
              }
            } else if (scaffoldData.files && scaffoldData.files.length > 0) {
              envReport += `\n\nProject Files: ${scaffoldData.files.map(f => f.path || f).join(", ")}`;
            }
            if (scaffoldData.deps && Object.keys(scaffoldData.deps).length > 0) {
              const depList = Object.entries(scaffoldData.deps).map(([k, v]) => `${k}@${v}`).join(" ");
              envReport += `\n\nDependencies: ${depList}`;
            }
          } catch { /* scaffold data not available */ }
        }
      }

      return envReport;
    }

    case "setup_environment": {
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      printToolRunning("setup_environment", dir);

      if (!pluginRegistry) {
        printToolDone("N/A");
        return "Plugin system not available.";
      }

      const tech = args.technology || SESSION._lastDetectedTech;
      const plugin = tech ? pluginRegistry.pluginForTech(tech) : (pluginRegistry.detectLanguages(dir)[0] || null);
      if (!plugin) {
        printToolDone("No language detected");
        return "Cannot determine technology. Specify technology parameter or run check_environment first.";
      }

      const result = plugin.setupEnvironment(dir);
      const lines = [`Environment Setup: ${plugin.displayName}`, "─".repeat(40)];

      for (const step of result.steps) {
        const status = step.success !== false ? "✓" : "✗";
        lines.push(`  ${status} ${step.action}: ${step.command || step.path || ""}`);
        if (step.error) lines.push(`    Error: ${step.error}`);
      }

      // Store venv activation prefix in session for build_and_test
      if (result.activateCmd) {
        if (!SESSION._envSetup) SESSION._envSetup = {};
        SESSION._envSetup[plugin.id] = {
          venvPath: result.venvPath,
          activateCmd: result.activateCmd,
          strategy: (plugin.getStrategyOrder() || [])[0] || null,
        };
        lines.push("", `Virtual environment: ${result.venvPath}`);
        lines.push(`Activation: ${result.activateCmd}`);
      }

      printToolDone("Done");
      return lines.join("\n");
    }

    case "generate_tests": {
      const filePath = args.filepath ? path.resolve(SESSION.cwd, args.filepath) : null;
      if (!filePath || !fs.existsSync(filePath)) {
        return `❌ File not found: ${args.filepath || "(none specified)"}`;
      }
      const dir = args.dirpath ? path.resolve(SESSION.cwd, args.dirpath) : SESSION.cwd;
      printToolRunning("generate_tests", path.basename(filePath));

      if (!pluginRegistry) {
        printToolDone("N/A");
        return "Plugin system not available.";
      }

      const plugin = pluginRegistry.pluginForFile(filePath);
      if (!plugin) {
        printToolDone("Unsupported");
        return `No plugin available for ${path.extname(filePath)} files. Supported: .py, .ts, .js, .rs, .go, .java, .cpp`;
      }

      let TestGenerator;
      try { ({ TestGenerator } = require("./plugins/test-generator")); } catch { printToolDone("N/A"); return "Test generator not available."; }
      const generator = new TestGenerator({ ollamaUrl: CONFIG.ollamaUrl || "http://localhost:11434", model: CONFIG.model });

      const skeleton = generator.generateSkeleton(plugin, filePath, dir);
      if (skeleton.error || !skeleton.cases.length) {
        printToolDone("No cases");
        return `No test cases generated for ${path.basename(filePath)}. ${skeleton.error || "No exportable functions or classes found."}`;
      }

      // Phase 2: LLM completion
      const testContent = await generator.completeSkeleton(skeleton);

      printToolDone(`${skeleton.cases.length} cases`);
      return `${generator.formatSkeletonSummary(skeleton)}\n\n--- Generated Test File ---\n\n${testContent}`;
    }

    default: {
      // Minimal aliases — only the most common mistakes
      const aliases = {
        "create_file": "write_file", "save_file": "write_file",
        "grep": "grep_search", "search": "grep_search",
        "bash": "run_bash", "run_command": "run_bash", "exec": "run_bash", "shell": "run_bash",
        "cat": "read_file", "read": "read_file",
        "find": "find_files",
        "search_kb": "kb_search", "list_kb": "kb_list", "add_kb": "kb_add",
      };

      if (aliases[name]) {
        console.log(co(C.bYellow, `  ⚡ Auto-corrected: ${name} → ${aliases[name]}`));
        return executeTool(aliases[name], args);
      }

      const allToolNames = TOOLS.map(t => t.function.name);
      return `❌ Unknown tool: "${name}". Available tools: ${allToolNames.join(", ")}`;
    }
  }
  } catch (toolErr) {
    _actionEntry.outcome = "error";
    throw toolErr;
  } finally {
    // Record action in history
    if (SESSION._actionHistory) {
      SESSION._actionHistory.push(_actionEntry);
      if (SESSION._actionHistory.length > 100) SESSION._actionHistory.shift();
    }
  }
}

function tryCmd(cmd) {
  try { return execSync(cmd, { encoding:"utf-8", timeout:3000, stdio:["pipe","pipe","pipe"] }).trim().split("\n")[0]; }
  catch (_) { return "not found"; }
}
// Note: execSync here runs trusted, hardcoded version-check commands only (e.g. "python3 --version"), not user input.

// ─── Search-Proxy Manager ─────────────────────────────────────────────────────
// Auto-starts search-proxy.js when CLI opens. Stops when CLI closes.
// Works on Windows, macOS, and Linux.
let _proxyProcess = null;
let _proxyStartedByUs = false; // Track if WE started it (so we know to stop it)

async function isProxyRunning() {
  try {
    const res = await fetch(`${CONFIG.proxyUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_) { return false; }
}

async function ensureSearchProxy() {
  // Check if already running (started externally or from a previous CLI session)
  if (await isProxyRunning()) {
    // Check if proxy code changed since last start — warn user
    let codeChanged = false;
    try {
      const proxyPath = path.join(__dirname, "search-proxy.js");
      const kbDir = path.join(__dirname, "kb-engine");
      const proxyMtime = fs.statSync(proxyPath).mtimeMs;
      const kbFiles = ["embedder.js", "store.js", "collections.js", "config.js", "ingestion/index.js"]
        .map(f => { try { return fs.statSync(path.join(kbDir, f)).mtimeMs; } catch (_) { return 0; } });
      const latestMtime = Math.max(proxyMtime, ...kbFiles);
      const healthRes = await fetch(`${CONFIG.proxyUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const health = await healthRes.json();
      const proxyStartTime = health.startTime || 0;
      if (proxyStartTime > 0 && latestMtime > proxyStartTime) {
        codeChanged = true;
      }
    } catch (_) {}

    _proxyStartedByUs = false;
    console.log(co(C.bGreen, "  ✓") + co(C.dim, " Search-proxy running on " + CONFIG.proxyUrl));
    if (codeChanged) {
      console.log(co(C.bYellow, "  ⚠") + co(C.dim, " Code changed since proxy started — run ") + co(C.bGreen, "/proxy restart") + co(C.dim, " to pick up changes"));
    }
    try {
      const kbStatus = await proxyGet("/kb/status");
      if (kbStatus?.qdrant?.running) {
        const colCount = kbStatus.collections?.length || 0;
        console.log(co(C.bGreen, "  ✓") + co(C.dim, ` Qdrant: ${colCount} collections`));
      }
      const models = kbStatus?.models;
      if (models?.codeModel || models?.textModel || models?.model) {
        console.log(co(C.bGreen, "  ✓") + co(C.dim, ` Embedding models: ready`));
      }
    } catch (_) {}
    return true;
  }

  // Find search-proxy.js relative to attar-code.js
  const proxyScript = path.join(__dirname, "search-proxy.js");
  if (!fs.existsSync(proxyScript)) {
    console.log(co(C.bYellow, "  ⚠") + co(C.dim, " search-proxy.js not found — KB and web search disabled"));
    return false;
  }

  // Start search-proxy in background
  console.log(co(C.dim, "  Starting search-proxy..."));
  try {
    const { spawn } = require("child_process");
    // process.execPath gives the correct Node.js binary on all platforms
    _proxyProcess = spawn(process.execPath, [proxyScript], {
      cwd: __dirname,
      stdio: "ignore",
      detached: false, // Tied to CLI process — dies when CLI dies
      env: { ...process.env, PORT: "3001" },
      shell: false,
      // Windows: create in same process group so it gets killed on exit
      // Unix: child inherits SIGTERM from parent
      windowsHide: true,
    });

    _proxyStartedByUs = true;

    // Handle proxy unexpected exit
    _proxyProcess.on("exit", (code) => {
      debugLog(`Search-proxy exited with code ${code}`);
      _proxyProcess = null;
    });

    // Wait up to 8 seconds for proxy to become healthy
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isProxyRunning()) {
        console.log(co(C.bGreen, "  ✓") + co(C.dim, " Search-proxy started (PID " + _proxyProcess.pid + ") on " + CONFIG.proxyUrl));
        try {
          const kbStatus = await proxyGet("/kb/status");
          if (kbStatus?.qdrant?.running) {
            const colCount = kbStatus.collections?.length || 0;
            console.log(co(C.bGreen, "  ✓") + co(C.dim, ` Qdrant: ${colCount} collections`));
          }
          const models = kbStatus?.models;
          if (models?.codeModel || models?.textModel) {
            const names = [models.codeModel && "code", models.textModel && "text"].filter(Boolean);
            console.log(co(C.bGreen, "  ✓") + co(C.dim, ` Embedding models: ${names.join(" + ")}`));
          }
        } catch (_) {}
        return true;
      }
    }
    console.log(co(C.bYellow, "  ⚠") + co(C.dim, " Search-proxy started but not responding yet"));
    return false;
  } catch (err) {
    console.log(co(C.bYellow, "  ⚠") + co(C.dim, ` Failed to start search-proxy: ${err.message}`));
    return false;
  }
}

function stopSearchProxy() {
  // Only stop if WE started it
  if (_proxyProcess && _proxyStartedByUs) {
    debugLog("Stopping search-proxy (PID " + _proxyProcess.pid + ")");
    try {
      // Cross-platform kill
      if (IS_WIN) {
        // Windows: taskkill works for both tree and single process
        try { execSync(`taskkill /F /PID ${_proxyProcess.pid}`, { stdio: "ignore" }); } catch (_) {}
      } else {
        // Unix/macOS: SIGTERM for graceful, SIGKILL after 2s
        _proxyProcess.kill("SIGTERM");
        setTimeout(() => { try { _proxyProcess?.kill("SIGKILL"); } catch (_) {} }, 2000);
      }
    } catch (_) {}
    _proxyProcess = null;
  }
}

async function getProxyStatus() {
  const running = await isProxyRunning();
  if (!running) return { running: false, message: "Search-proxy is NOT running" };
  try {
    const health = await fetch(`${CONFIG.proxyUrl}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await health.json();
    const kbCount = await proxyGet("/kb/count");
    return {
      running: true,
      url: CONFIG.proxyUrl,
      managedByUs: _proxyStartedByUs,
      pid: _proxyProcess?.pid || "external",
      kbDocuments: kbCount.count || kbCount.data?.count || 0,
      message: `Search-proxy running on ${CONFIG.proxyUrl}`,
    };
  } catch (_) {
    return { running: true, url: CONFIG.proxyUrl, message: "Running (health check partial)" };
  }
}

// ─── Proxy helper ─────────────────────────────────────────────────────────────
async function proxyPost(endpoint, body, timeoutMs = 60000) {
  try {
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    // 0 = no timeout (for long-running ingest operations)
    if (timeoutMs > 0) opts.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${CONFIG.proxyUrl}${endpoint}`, opts);
    return await res.json();
  } catch (e) {
    if (e.name === 'TimeoutError') {
      return { error: `Request to ${endpoint} timed out after ${Math.round(timeoutMs/1000)}s.` };
    }
    return { error: `Cannot connect to search-proxy at ${CONFIG.proxyUrl}. Start it with: node search-proxy.js` };
  }
}

async function proxyGet(endpoint) {
  try {
    const res = await fetch(`${CONFIG.proxyUrl}${endpoint}`);
    return await res.json();
  } catch (e) {
    return { error: `Cannot connect to search-proxy at ${CONFIG.proxyUrl}` };
  }
}

// ══════════════════════════════════════════════════════════════════
// TOOL UI
// ══════════════════════════════════════════════════════════════════
function printToolRunning(name, detail) {
  const icons = { run_bash:"💻", read_file:"📄", write_file:"💾", edit_file:"✏️",
    grep_search:"🔍", find_files:"📁", get_project_structure:"📁", start_server:"🚀",
    web_search:"🔎", web_fetch:"🌐", kb_search:"📚", kb_add:"📥", kb_list:"📚",
    research:"🔬", search_all:"🔎", github_search:"🐙", deep_search:"🔬", present_file:"📄",
    create_pdf:"📝", create_docx:"📝", create_excel:"📊", create_pptx:"📝", create_chart:"📊",
    test_endpoint:"🧪", get_server_logs:"📋", detect_build_system:"🔍", build_and_test:"🏗️",
    todo_write:"📋", todo_done:"✅", memory_write:"🧠", memory_read:"🧠",
    search_docs:"📖" };
  const icon = icons[name] || "⚙";
  process.stdout.write(`\n  ${icon} ` + co(C.yellow, name) + co(C.dim, `  ${String(detail).slice(0,W()-20)}\n`));
}

function printToolDone(result) {
  const lines = String(result).split("\n").filter(Boolean).slice(0, 5);
  for (const l of lines) console.log(co(C.dim, "     ") + co(C.gray, l.slice(0, W()-6)));
}

function printToolError(err) {
  const lines = String(err).split("\n").filter(Boolean).slice(0, 4);
  for (const l of lines) console.log(co(C.bRed, "  ✗ ") + co(C.dim, l.slice(0, W()-6)));
}

// ══════════════════════════════════════════════════════════════════
// OLLAMA CHAT
// ══════════════════════════════════════════════════════════════════
const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
let spinnerInterval = null;

function startSpinner(label="thinking") {
  let i = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r  ${co(C.cyan, SPINNER[i++%SPINNER.length])} ${co(C.dim, label+"...")}`);
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; process.stdout.write("\r\x1b[K"); }
}

// ══════════════════════════════════════════════════════════════════
// BUILD ERROR PARSER — extracts per-file error counts and messages
// ══════════════════════════════════════════════════════════════════
function parseBuildErrors(output) {
  const fileMap = {};
  const hintMap = {};

  function detectLangFromFile(f) {
    const ext = (f || "").split(".").pop()?.toLowerCase();
    const map = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python", go: "Go", rs: "Rust", java: "Java", cs: "CSharp", php: "PHP", swift: "Swift", kt: "Java" };
    return map[ext] || "JavaScript";
  }

  function addHint(file, lineNum, msg) {
    if (!extractHints) return;
    const hint = extractHints(msg, output, detectLangFromFile(file));
    if (hint) {
      if (!hintMap[file]) hintMap[file] = {};
      hintMap[file][lineNum] = hint;
    }
  }

  // TypeScript: src/foo.ts(12,5): error TS2749: ...
  let m;
  const tsRe = /^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+:.+)$/gm;
  while ((m = tsRe.exec(output)) !== null) { const k = m[1].trim(); const msg = m[3].trim(); if (!fileMap[k]) fileMap[k] = []; fileMap[k].push(`  line ${m[2]}: ${msg}`); addHint(k, m[2], msg); }
  // Go: ./foo.go:12:5: ...
  const goRe = /^(\.?\/?\S+\.go):(\d+):\d+:\s+(.+)$/gm;
  while ((m = goRe.exec(output)) !== null) { const k = m[1]; const msg = m[3].trim(); if (!fileMap[k]) fileMap[k] = []; fileMap[k].push(`  line ${m[2]}: ${msg}`); addHint(k, m[2], msg); }
  // Rust: error[E0425] --> src/main.rs:5:9
  const rustRe = /error\[([^\]]+)\][^\n]*\n\s*--> ([^:]+):(\d+)/gm;
  while ((m = rustRe.exec(output)) !== null) { const msg = `error[${m[1]}]`; if (!fileMap[m[2]]) fileMap[m[2]] = []; fileMap[m[2]].push(`  line ${m[3]}: ${msg}`); addHint(m[2], m[3], msg); }
  // Java: src/Foo.java:12: error: ...
  const javaRe = /^(\S+\.java):(\d+):\s*error:\s+(.+)$/gm;
  while ((m = javaRe.exec(output)) !== null) { const msg = m[3].trim(); if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}: ${msg}`); addHint(m[1], m[2], msg); }
  // Python traceback: File "foo.py", line 12 + next line has the error type
  const pyRe = /File "([^"]+\.py)", line (\d+)/gm;
  const pyLines = output.split("\n");
  while ((m = pyRe.exec(output)) !== null) {
    if (!fileMap[m[1]]) fileMap[m[1]] = [];
    // Find the error message — typically the last line of the traceback (ErrorType: message)
    const afterIdx = output.indexOf(m[0]) + m[0].length;
    const remaining = output.slice(afterIdx, afterIdx + 500);
    const errLine = remaining.split("\n").find(l => /^(TypeError|ImportError|ModuleNotFoundError|AttributeError|NameError|ValueError|KeyError|IndexError|SyntaxError|IndentationError|FileNotFoundError|RuntimeError):/.test(l.trim()));
    const msg = errLine ? errLine.trim() : "";
    fileMap[m[1]].push(`  line ${m[2]}${msg ? ": " + msg : ""}`);
    addHint(m[1], m[2], msg);
  }
  // Python mypy: foo.py:10: error: message [code]
  const mypyRe = /^(\S+\.py):(\d+):\s*error:\s*(.+)$/gm;
  while ((m = mypyRe.exec(output)) !== null) { const msg = m[3].trim(); if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}: ${msg}`); addHint(m[1], m[2], msg); }
  // Python ruff/pylint: file.py:10:5: E401 message
  const ruffRe = /^(\S+\.py):(\d+):\d+:\s*(\w+\d+)\s+(.+)$/gm;
  while ((m = ruffRe.exec(output)) !== null) { const msg = `${m[3]}: ${m[4].trim()}`; if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}: ${msg}`); addHint(m[1], m[2], msg); }
  // C#: file.cs(10,5): error CS0246: message
  const csRe = /^(.+\.cs)\((\d+),\d+\):\s*error\s+(CS\d+:.+)$/gm;
  while ((m = csRe.exec(output)) !== null) { const msg = m[3].trim(); if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}: ${msg}`); addHint(m[1], m[2], msg); }
  // PHP: file.php on line 10 / Parse error: ... in file.php on line 10
  const phpRe = /(?:in\s+)?(\S+\.php)(?:\s+on)?\s+line\s+(\d+)/gm;
  while ((m = phpRe.exec(output)) !== null) { if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}`); addHint(m[1], m[2], ""); }
  // Swift: file.swift:10:5: error: message
  const swiftRe = /^(\S+\.swift):(\d+):\d+:\s*error:\s+(.+)$/gm;
  while ((m = swiftRe.exec(output)) !== null) { const msg = m[3].trim(); if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}: ${msg}`); addHint(m[1], m[2], msg); }
  // Kotlin: file.kt:10:5: error: message
  const ktRe = /^(\S+\.kt):(\d+):\d+:\s*(.+)$/gm;
  while ((m = ktRe.exec(output)) !== null) { const msg = m[3].trim(); if (!fileMap[m[1]]) fileMap[m[1]] = []; fileMap[m[1]].push(`  line ${m[2]}: ${msg}`); addHint(m[1], m[2], msg); }
  // Node.js --check / runtime errors: /path/to/file.js:10 or file.js:10
  // Format: "path/file.js:LINE\n  code\n  ^^^^\nSyntaxError: message"
  const nodeCheckRe = /^(.+\.(?:js|mjs|cjs)):(\d+)\b/gm;
  while ((m = nodeCheckRe.exec(output)) !== null) {
    const file = m[1].trim();
    const lineNum = m[2];
    // Look for the SyntaxError/ReferenceError/TypeError line after this
    const afterIdx = output.indexOf(m[0], m.index) + m[0].length;
    const remaining = output.slice(afterIdx, afterIdx + 500);
    const errLine = remaining.split("\n").find(l => l.trim() && !/^\s*[\^~]+\s*$/.test(l) && !/^\s*\|/.test(l) && !/^\s*at /.test(l) && !/^\s*$/.test(l));
    const msg = errLine ? errLine.trim() : "SyntaxError";
    // Normalize path: strip absolute prefix, keep relative
    const relFile = file.replace(/^.*[/\\](?=src[/\\]|lib[/\\]|routes[/\\]|controllers[/\\]|middleware[/\\])/, "");
    if (!fileMap[relFile]) fileMap[relFile] = [];
    fileMap[relFile].push(`  line ${lineNum}: ${msg}`);
    addHint(relFile, lineNum, msg);
  }

  const sorted = Object.entries(fileMap).map(([file, errors]) => ({ file, errors, count: errors.length })).sort((a, b) => b.count - a.count);
  const totalErrors = sorted.reduce((s, e) => s + e.count, 0);
  if (sorted.length === 0) return null;

  const lines = [`BUILD FAILED: ${totalErrors} error(s) in ${sorted.length} file(s). Fix IN THIS ORDER:`];
  sorted.forEach(({ file, errors, count }, i) => {
    lines.push(`${i + 1}. ${file} — ${count} error(s):`);
    errors.slice(0, 3).forEach(e => lines.push(e));
    if (errors.length > 3) lines.push(`  ... and ${errors.length - 3} more`);
  });
  return { summary: lines.join("\n"), sorted, totalErrors, fileCount: sorted.length, topFile: sorted[0]?.file, topCount: sorted[0]?.count, hintMap };
}

// ── Plugin-aware error parsing dispatcher ────────────────────────────────────
// Tries plugin.parseErrors() first, converts to parseBuildErrors shape.
// Falls back to the original regex-based parseBuildErrors() if no plugin.
function pluginParseBuildErrors(output, tech) {
  if (!pluginRegistry || !tech) return parseBuildErrors(output);
  const plugin = pluginRegistry.pluginForTech(tech);
  if (!plugin) return parseBuildErrors(output);

  try {
    const pluginErrors = plugin.parseErrors(output, 'compiler');
    if (!pluginErrors || pluginErrors.length === 0) return parseBuildErrors(output);

    // Convert PluginError[] → parseBuildErrors shape: { summary, sorted, totalErrors, ... }
    const fileMap = {};
    for (const e of pluginErrors) {
      const file = e.file || '(unknown)';
      if (!fileMap[file]) fileMap[file] = [];
      const msg = e.code ? `${e.code}: ${e.message}` : e.message;
      fileMap[file].push(`  line ${e.line || 0}: ${msg}`);
    }

    const sorted = Object.entries(fileMap)
      .map(([file, errors]) => ({ file, errors, count: errors.length }))
      .sort((a, b) => b.count - a.count);
    const totalErrors = sorted.reduce((s, e) => s + e.count, 0);
    if (sorted.length === 0) return parseBuildErrors(output); // fallback

    const lines = [`BUILD FAILED: ${totalErrors} error(s) in ${sorted.length} file(s). Fix IN THIS ORDER:`];
    sorted.forEach(({ file, errors, count }, i) => {
      lines.push(`${i + 1}. ${file} — ${count} error(s):`);
      errors.slice(0, 3).forEach(e => lines.push(e));
      if (errors.length > 3) lines.push(`  ... and ${errors.length - 3} more`);
    });

    return {
      summary: lines.join("\n"),
      sorted,
      totalErrors,
      fileCount: sorted.length,
      topFile: sorted[0]?.file,
      topCount: sorted[0]?.count,
      hintMap: (() => {
        const h = {};
        for (const e of pluginErrors) {
          if (e.prescription && e.file) {
            if (!h[e.file]) h[e.file] = {};
            h[e.file][e.line || 0] = { suggestion: e.prescription, applicability: 0.8 };
          }
        }
        return h;
      })(),
      _pluginErrors: pluginErrors, // preserve structured errors for smart-fix
    };
  } catch (e) {
    debugLog("Plugin parseErrors failed: " + e.message);
    return parseBuildErrors(output);
  }
}

// ══════════════════════════════════════════════════════════════════
// EXTERNAL ERROR PATTERN LOADER — loads from JSON files
// ══════════════════════════════════════════════════════════════════
function loadPatternFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return (data.patterns || []).map(p => ({
      ...p,
      _compiledMatch: new RegExp(p.match),
      _source: path.basename(filePath)
    }));
  } catch (e) {
    debugLog(`Failed to load pattern file ${filePath}: ${e.message}`);
    return [];
  }
}

// Load unified plugin files (new format) and convert to legacy pattern format
function loadPluginAsPatterns(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!data.errorCatalog?.categories) return [];
    const patterns = [];
    for (const cat of data.errorCatalog.categories) {
      for (const err of cat.errors || []) {
        // Only include entries that have prescription fields (the merged format)
        if (!err.rootCause && !err.match) continue;
        const matchRegex = err.match || (err.code + ":.*?" + (err.messagePattern || "").replace(/\(\?<\w+>/g, "("));
        try {
          patterns.push({
            id: err.code,
            category: err.category || cat.id,
            severity: err.severity || "error",
            match: matchRegex,
            captures: (err.captures || []).map(c => c.name),
            rootCause: err.rootCause || `Error ${err.code}`,
            prescription: err.prescription || `Fix the ${err.code} error.`,
            codeBlock: err.codeBlock || null,
            conditions: err.conditions || [],
            // Preserve new fields for smart-fix
            baseCrossFileProbability: err.baseCrossFileProbability,
            refinements: err.refinements,
            fixHint: err.fixHint,
            coOccurrence: err.coOccurrence,
            _compiledMatch: new RegExp(matchRegex),
            _source: path.basename(filePath),
            _isPlugin: true,
          });
        } catch (e) { debugLog(`Bad regex in plugin ${err.code}: ${e.message}`); }
      }
    }
    return patterns;
  } catch (e) {
    debugLog(`Failed to load plugin file ${filePath}: ${e.message}`);
    return [];
  }
}

function loadErrorPatternsExternal(projectType) {
  if (SESSION._errorPatterns) return SESSION._errorPatterns;

  const patterns = [];

  // 1. Always load general.json
  patterns.push(...loadPatternFile(path.join(ERROR_PATTERNS_DIR, "general.json")));

  // 2. Load tech-specific files based on project type
  const techMap = {
    "Node.js": ["typescript", "nodejs"],
    "Node.js/TypeScript": ["typescript", "nodejs"],
    "Python": ["python"],
    "Go": ["go"],
    "Rust": ["rust"],
    "Java": ["java"],
    "Java/Maven": ["java"],
    "Java/Gradle": ["java"],
    "C/C++": ["cpp"],
    "PHP": ["php"],
    "PHP/Laravel": ["php"],
    "PHP/Symfony": ["php"],
    "C#": ["csharp"],
    "NestJS": ["nestjs", "typescript", "nodejs"],
    "Next.js": ["nextjs", "typescript", "nodejs"],
    "React Native": ["reactnative", "typescript", "nodejs"],
  };
  const techs = techMap[projectType] || [];
  for (const tech of techs) {
    patterns.push(...loadPatternFile(path.join(ERROR_PATTERNS_DIR, `${tech}.json`)));
  }

  // 3. Load custom.json if exists
  patterns.push(...loadPatternFile(path.join(ERROR_PATTERNS_DIR, "custom.json")));

  // 3.5. Load unified plugin files (new format with both dependency analysis + prescriptions)
  const pluginTechMap = {
    "Node.js": "typescript", "Node.js/TypeScript": "typescript",
    "Python": "python", "Go": "go", "Rust": "rust",
    "Java": "java", "Java/Maven": "java", "Java/Gradle": "java",
    "C/C++": "cpp", "PHP": "php", "PHP/Laravel": "php", "PHP/Symfony": "php", "C#": "csharp",
    "NestJS": "typescript", "Next.js": "typescript", "React Native": "typescript",
  };
  const pluginName = pluginTechMap[projectType];
  if (pluginName) {
    // Check user home first, then bundled defaults
    const userPluginPath = path.join(HOME_DIR, "plugins", `${pluginName}.json`);
    const defaultPluginPath = path.join(__dirname, "defaults", "plugins", `${pluginName}.json`);
    const pluginPath = fs.existsSync(userPluginPath) ? userPluginPath : defaultPluginPath;
    if (fs.existsSync(pluginPath)) {
      const pluginPatterns = loadPluginAsPatterns(pluginPath);
      // Only add plugin patterns for error codes not already covered by old patterns
      const existingIds = new Set(patterns.map(p => p.id));
      const newPatterns = pluginPatterns.filter(p => !existingIds.has(p.id));
      patterns.push(...newPatterns);
      debugLog(`Loaded ${newPatterns.length} additional patterns from plugin ${pluginName}.json`);
    }
  }

  // 4. Load project-local patterns
  try {
    const localDir = path.join(SESSION.cwd, ".attar-code", "error-patterns");
    if (fs.existsSync(localDir)) {
      for (const f of fs.readdirSync(localDir).filter(f => f.endsWith(".json"))) {
        patterns.push(...loadPatternFile(path.join(localDir, f)));
      }
    }
  } catch (err) { debugLog(err.message); }

  if (patterns.length > 0) {
    SESSION._errorPatterns = patterns;
    debugLog(`Loaded ${patterns.length} error patterns for ${projectType || "unknown"} (${techs.join(", ") || "general only"})`);
    return patterns;
  }

  // 5. Fallback: if no external patterns loaded, return null to use hardcoded
  return null;
}

function interpolateTemplate(template, captures, matchGroups) {
  if (!template) return null;
  let result = template;
  for (let i = 0; i < captures.length; i++) {
    result = result.replaceAll(`{${captures[i]}}`, matchGroups[i + 1] || "");
  }
  return result;
}

function evaluateConditionDSL(when, captures, matchGroups) {
  // DSL: "capture contains value"
  let m = when.match(/^(\w+)\s+contains\s+(.+)$/i);
  if (m) { const idx = captures.indexOf(m[1]); return (matchGroups[idx + 1] || "").includes(m[2].trim()); }
  // DSL: "capture startsWith value"
  m = when.match(/^(\w+)\s+startsWith\s+(.+)$/i);
  if (m) { const idx = captures.indexOf(m[1]); return (matchGroups[idx + 1] || "").startsWith(m[2].trim()); }
  // DSL: "capture equals value"
  m = when.match(/^(\w+)\s+equals\s+(.+)$/i);
  if (m) { const idx = captures.indexOf(m[1]); return (matchGroups[idx + 1] || "") === m[2].trim(); }
  // DSL: "capture endsWith value"
  m = when.match(/^(\w+)\s+endsWith\s+(.+)$/i);
  if (m) { const idx = captures.indexOf(m[1]); return (matchGroups[idx + 1] || "").endsWith(m[2].trim()); }
  return false;
}

function diagnoseFromExternalPattern(pattern, match, fileLines, lineContent, filePath) {
  const captures = pattern.captures || [];

  // Check conditions first
  if (pattern.conditions) {
    for (const cond of pattern.conditions) {
      if (evaluateConditionDSL(cond.when, captures, match)) {
        return {
          rootCause: interpolateTemplate(cond.rootCause || pattern.rootCause, captures, match),
          prescription: interpolateTemplate(cond.prescription || pattern.prescription, captures, match),
          codeBlock: interpolateTemplate(cond.codeBlock || null, captures, match)
        };
      }
    }
  }

  // Check fileCheck (search file content)
  if (pattern.fileCheck && fileLines.length > 0) {
    const content = fileLines.join("\n");
    const searchStr = interpolateTemplate(pattern.fileCheck.search, captures, match);
    const found = searchStr ? new RegExp(searchStr).test(content) : false;
    const branch = found ? pattern.fileCheck.ifTrue : (pattern.fileCheck.ifFalse || null);
    if (branch) {
      return {
        rootCause: interpolateTemplate(branch.rootCause, captures, match),
        prescription: interpolateTemplate(branch.prescription, captures, match),
        codeBlock: interpolateTemplate(branch.codeBlock || null, captures, match)
      };
    }
  }

  // Default
  return {
    rootCause: interpolateTemplate(pattern.rootCause, captures, match),
    prescription: interpolateTemplate(pattern.prescription, captures, match),
    codeBlock: interpolateTemplate(pattern.codeBlock, captures, match)
  };
}

// ══════════════════════════════════════════════════════════════════
// ERROR DOCTOR — Auto-diagnosis + prescription for common errors
// ══════════════════════════════════════════════════════════════════
const ERROR_PATTERNS = {
  TS2339: {
    match: /TS2339:.*Property '(\w+)' does not exist on type '(\w+)'/,
    diagnose: (m, lines, line, fp) => {
      const [, prop, type] = m;
      if (type === "Request" || type.includes("Request")) {
        return {
          rootCause: `Express Request type doesn't include '${prop}'. Need TypeScript declaration merging.`,
          prescription: `Create or update a declaration file to extend Express Request type. Use edit_file to add '${prop}' to the Request interface.`,
          codeBlock: `// Add to src/types/express.d.ts (create if not exists):\nimport { JwtPayload } from 'jsonwebtoken';\ndeclare global {\n  namespace Express {\n    interface Request {\n      ${prop}?: any;\n    }\n  }\n}\nexport {};`
        };
      }
      return { rootCause: `'${prop}' not defined on '${type}'.`, prescription: `Add '${prop}' to the '${type}' interface definition.`, codeBlock: null };
    }
  },
  TS2304: {
    match: /TS2304:.*Cannot find name '(\w+)'/,
    diagnose: (m, lines) => {
      const name = m[1];
      const hasImport = lines.some(l => l.includes(name) && /import/.test(l));
      return {
        rootCause: hasImport ? `'${name}' is imported but the source doesn't export it.` : `'${name}' is not imported.`,
        prescription: hasImport ? `Check the source file — ensure '${name}' is exported.` : `Add: import { ${name} } from '<source>';`,
        codeBlock: null
      };
    }
  },
  TS2749: {
    match: /TS2749:.*'(\w+)' refers to a value.*used as a type/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is a value (variable/class instance) being used where a type is expected.`,
      prescription: `Use 'typeof ${m[1]}' instead of '${m[1]}' for the type, OR use 'import type { ${m[1]} }' if it's a type export.`,
      codeBlock: `// Change:\nconst x: ${m[1]} = ...\n// To:\nconst x: typeof ${m[1]} = ...\n// Or use the interface/type name instead of the class name`
    })
  },
  TS6133: {
    match: /TS6133:.*'(\w+)' is declared but.*never read/,
    diagnose: (m, lines) => {
      const name = m[1];
      const importLine = lines.findIndex(l => l.includes(name) && /import/.test(l));
      return {
        rootCause: `'${name}' is imported/declared but never used.`,
        prescription: importLine >= 0 ? `Remove '${name}' from the import on line ${importLine + 1}.` : `Remove or use the '${name}' declaration.`,
        codeBlock: null
      };
    }
  },
  TS2306: {
    match: /TS2306:.*File '([^']+)' is not a module/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' has no exports — TypeScript can't import from it.`,
      prescription: `Add 'export {}' at the bottom of the file, or add proper exports.`,
      codeBlock: `// Add at the end of ${path.basename(m[1])}:\nexport {};`
    })
  },
  TS2717: {
    match: /TS2717:.*Property '(\w+)' must be of type '([^']+)'.*has type '([^']+)'/,
    diagnose: (m) => ({
      rootCause: `Duplicate property '${m[1]}' with conflicting types: '${m[2]}' vs '${m[3]}'.`,
      prescription: `Remove the duplicate declaration. Keep only one '${m[1]}' property with the correct type.`,
      codeBlock: null
    })
  },
  TS2345: {
    match: /TS2345:.*Argument of type '([^']+)'.*not assignable to.*'([^']+)'/,
    diagnose: (m) => ({
      rootCause: `Type mismatch: '${m[1]}' is not assignable to '${m[2]}'.`,
      prescription: `Either fix the value to match type '${m[2]}', or add a type assertion: '(value as ${m[2]})'.`,
      codeBlock: null
    })
  },
  TS2693: {
    match: /TS2693:.*'(\w+)' only refers to a type.*used as a value/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is a type/interface, but the code tries to use it as a value (e.g., calling 'new ${m[1]}' or using it in runtime logic).`,
      prescription: `Types can't be used at runtime. Create a factory function, use a class instead, or create the object manually with the type annotation.`,
      codeBlock: `// Instead of: const x = new ${m[1]}()\n// Use: const x: ${m[1]} = { /* properties */ }`
    })
  },
  MODULE_NOT_FOUND: {
    match: /Cannot find module '([^']+)'/,
    diagnose: (m, lines, line, fp) => {
      const mod = m[1];
      if (mod.startsWith(".") || mod.startsWith("/")) {
        return {
          rootCause: `Relative import '${mod}' — file doesn't exist at the resolved path.`,
          prescription: `Create the missing file, or fix the import path.`,
          codeBlock: null
        };
      }
      return {
        rootCause: `npm package '${mod}' not installed.`,
        prescription: `Run: npm install ${mod}`,
        codeBlock: null
      };
    }
  },

  // ── Go Error Patterns ──
  GO_UNDEFINED: {
    match: /undefined:\s+(\w+)/,
    diagnose: (m, lines) => {
      const name = m[1];
      const hasImport = lines.some(l => /^import/.test(l) && l.includes(name));
      return {
        rootCause: `'${name}' is used but not defined or imported.`,
        prescription: hasImport ? `'${name}' is imported but not exported from the source package.` : `Add '${name}' to the import block, or define it in this package.`,
        codeBlock: null
      };
    }
  },
  GO_UNUSED_IMPORT: {
    match: /imported and not used:\s*"([^"]+)"/,
    diagnose: (m) => ({
      rootCause: `Package "${m[1]}" is imported but never used. Go requires all imports to be used.`,
      prescription: `Remove the import "${m[1]}" or use it. Go does not allow unused imports.`,
      codeBlock: null
    })
  },
  GO_UNUSED_VAR: {
    match: /(\w+) declared (?:and|but) not used/,
    diagnose: (m) => ({
      rootCause: `Variable '${m[1]}' is declared but never used. Go requires all variables to be used.`,
      prescription: `Remove '${m[1]}' or use it. If you need to ignore a value, use '_' as the variable name.`,
      codeBlock: `// Change:\n${m[1]} := someFunc()\n// To:\n_ = someFunc()\n// Or remove the declaration entirely`
    })
  },
  GO_TYPE_MISMATCH: {
    match: /cannot use (\w+).*as.*type\s+(\S+)/,
    diagnose: (m) => ({
      rootCause: `Type mismatch: '${m[1]}' cannot be used as type '${m[2]}'.`,
      prescription: `Convert '${m[1]}' to type '${m[2]}' using a type conversion: ${m[2]}(${m[1]})`,
      codeBlock: null
    })
  },
  GO_NO_PACKAGE: {
    match: /package (\w+) is not in/,
    diagnose: (m) => ({
      rootCause: `Package '${m[1]}' is not installed or not in GOPATH/module.`,
      prescription: `Run: go get ${m[1]} or check your go.mod file.`,
      codeBlock: null
    })
  },

  // ── Rust Error Patterns ──
  RUST_E0425: {
    match: /E0425.*cannot find value `(\w+)`/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is not defined in the current scope.`,
      prescription: `Import it with 'use', define it, or check for typos. Common: 'use crate::${m[1]};' or 'use std::${m[1]};'`,
      codeBlock: null
    })
  },
  RUST_E0382: {
    match: /E0382.*borrow of moved value.*`(\w+)`/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' was moved and can no longer be used. Rust's ownership system prevents this.`,
      prescription: `Clone '${m[1]}' before the move: '${m[1]}.clone()', or borrow it with '&${m[1]}' instead of moving.`,
      codeBlock: `// Option 1: Clone before move\nlet ${m[1]}_copy = ${m[1]}.clone();\n// Option 2: Borrow instead\nfn takes_ref(val: &Type) { ... }`
    })
  },
  RUST_E0308: {
    match: /E0308.*expected `([^`]+)`.*found `([^`]+)`/,
    diagnose: (m) => ({
      rootCause: `Type mismatch: expected '${m[1]}' but found '${m[2]}'.`,
      prescription: `Convert the value: use '.into()', 'as ${m[1]}', or fix the function signature.`,
      codeBlock: null
    })
  },
  RUST_E0433: {
    match: /E0433.*failed to resolve.*use of undeclared.*`(\w+)`/,
    diagnose: (m) => ({
      rootCause: `Module or crate '${m[1]}' not found.`,
      prescription: `Add to Cargo.toml: [dependencies]\n${m[1]} = "*"\nOr use the correct path: 'use crate::${m[1]};'`,
      codeBlock: null
    })
  },
  RUST_E0277: {
    match: /E0277.*trait bound.*`([^`]+)`.*is not satisfied/,
    diagnose: (m) => ({
      rootCause: `Type doesn't implement required trait: '${m[1]}'.`,
      prescription: `Add '#[derive(${m[1].split("::").pop()})]' to the struct, or implement the trait manually.`,
      codeBlock: `#[derive(Debug, Clone, ${m[1].split("::").pop()})]\nstruct YourStruct { ... }`
    })
  },

  // ── Java Error Patterns ──
  JAVA_SYMBOL: {
    match: /cannot find symbol.*symbol:\s*(?:variable|method|class)\s+(\w+)/s,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is not defined — missing import, typo, or wrong scope.`,
      prescription: `Add the correct import statement, or check spelling. Common: 'import java.util.${m[1]};'`,
      codeBlock: null
    })
  },
  JAVA_INCOMPATIBLE: {
    match: /incompatible types:.*(\w+) cannot be converted to (\w+)/,
    diagnose: (m) => ({
      rootCause: `Type mismatch: '${m[1]}' cannot be converted to '${m[2]}'.`,
      prescription: `Cast explicitly: '(${m[2]}) value' or use the correct type.`,
      codeBlock: null
    })
  },
  JAVA_PACKAGE: {
    match: /package (\S+) does not exist/,
    diagnose: (m) => ({
      rootCause: `Package '${m[1]}' not found — missing dependency or wrong import.`,
      prescription: `Add the dependency to pom.xml or build.gradle. Check the groupId and artifactId.`,
      codeBlock: `<!-- pom.xml -->\n<dependency>\n  <groupId>${m[1].split(".").slice(0, 2).join(".")}</groupId>\n  <artifactId>${m[1].split(".").pop()}</artifactId>\n  <version>LATEST</version>\n</dependency>`
    })
  },
  JAVA_ABSTRACT: {
    match: /(\w+) is abstract.*cannot be instantiated/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is abstract and cannot be created with 'new'. Need a concrete implementation.`,
      prescription: `Use a concrete subclass instead of '${m[1]}', or create an anonymous class/lambda.`,
      codeBlock: null
    })
  },
  JAVA_ACCESS: {
    match: /(\w+) has private access in (\w+)/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is private in '${m[2]}' — can't access from outside the class.`,
      prescription: `Use a public getter/setter, or change the access modifier to 'public' or 'protected'.`,
      codeBlock: null
    })
  },

  // ── Python Error Patterns ──
  PY_NAME_ERROR: {
    match: /NameError: name '(\w+)' is not defined/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' is not defined — missing import or typo.`,
      prescription: `Add 'import ${m[1]}' or 'from <module> import ${m[1]}'. Check spelling.`,
      codeBlock: null
    })
  },
  PY_IMPORT_ERROR: {
    match: /ImportError: cannot import name '(\w+)' from '([^']+)'/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' doesn't exist in module '${m[2]}'.`,
      prescription: `Check the module '${m[2]}' — '${m[1]}' may be renamed, removed, or in a different submodule.`,
      codeBlock: null
    })
  },
  PY_MODULE_NOT_FOUND: {
    match: /ModuleNotFoundError: No module named '([^']+)'/,
    diagnose: (m) => ({
      rootCause: `Python package '${m[1]}' is not installed.`,
      prescription: `Run: pip install ${m[1].split(".")[0]}`,
      codeBlock: null
    })
  },
  PY_TYPE_ERROR: {
    match: /TypeError: (\w+)\(\) (?:takes|got|missing) (\d+|no) (?:positional )?argument/,
    diagnose: (m) => ({
      rootCause: `Wrong number of arguments passed to '${m[1]}()'.`,
      prescription: `Check the function signature of '${m[1]}' — it expects a different number of arguments than provided.`,
      codeBlock: null
    })
  },
  PY_ATTRIBUTE_ERROR: {
    match: /AttributeError: '(\w+)' object has no attribute '(\w+)'/,
    diagnose: (m) => ({
      rootCause: `'${m[1]}' doesn't have attribute '${m[2]}'. The object type is wrong or the attribute name is misspelled.`,
      prescription: `Check if '${m[2]}' exists on '${m[1]}'. Use dir(${m[1].toLowerCase()}) to see available attributes.`,
      codeBlock: null
    })
  },
  PY_INDENT: {
    match: /IndentationError: (unexpected indent|expected an indented block)/,
    diagnose: (m) => ({
      rootCause: `Python indentation error: ${m[1]}. Python requires consistent indentation (4 spaces recommended).`,
      prescription: `Fix the indentation — use 4 spaces per level. Don't mix tabs and spaces.`,
      codeBlock: null
    })
  },
  PY_SYNTAX: {
    match: /SyntaxError: (.+)/,
    diagnose: (m) => ({
      rootCause: `Python syntax error: ${m[1]}`,
      prescription: `Check for missing colons, parentheses, quotes, or brackets near the error line.`,
      codeBlock: null
    })
  },

  // ── General Patterns (any language) ──
  PERMISSION_DENIED: {
    match: /permission denied|EACCES|access denied/i,
    diagnose: () => ({
      rootCause: `File or command permission denied.`,
      prescription: `Check file permissions. On Unix: chmod +x file. On Windows: run as admin. Or write to a different directory.`,
      codeBlock: null
    })
  },
  PORT_IN_USE: {
    match: /EADDRINUSE|address already in use.*:(\d+)/,
    diagnose: (m) => ({
      rootCause: `Port ${m[1] || "?"} is already in use by another process.`,
      prescription: `Kill the process using the port, or use a different port. Use get_server_logs to check what's running.`,
      codeBlock: null
    })
  },
  OUT_OF_MEMORY: {
    match: /ENOMEM|out of memory|heap.*limit/i,
    diagnose: () => ({
      rootCause: `Process ran out of memory.`,
      prescription: `Increase Node.js memory: NODE_OPTIONS="--max-old-space-size=4096". Or optimize the code to use less memory.`,
      codeBlock: null
    })
  },
};

function prescribeFixesForBuild(parsed, rawOutput, cwd) {
  if (!parsed || parsed.sorted.length === 0) {
    return `\nACTION REQUIRED:\n1. Read the build errors above.\n2. Fix the most-errored file first.\n3. Call build_and_test again.`;
  }

  const prescriptions = [];
  const parseErrStr = (s) => {
    const m = s.match(/line\s+(\d+):\s*(TS\d+):\s*(.*)/);
    if (m) return { lineNo: parseInt(m[1]), code: m[2], message: m[3].trim() };
    const m2 = s.match(/line\s+(\d+):\s*(.*)/);
    if (m2) return { lineNo: parseInt(m2[1]), code: null, message: m2[2].trim() };
    return null;
  };

  // Process top 3 files (most errors first)
  for (const { file, errors } of parsed.sorted.slice(0, 3)) {
    const filePath = path.resolve(cwd, file);
    let fileLines = [];
    try { fileLines = fs.readFileSync(filePath, "utf-8").split("\n"); } catch (err) { debugLog(err.message); }

    for (const errStr of errors.slice(0, 2)) { // Max 2 errors per file
      const errParsed = parseErrStr(errStr);
      if (!errParsed) continue;

      const lineContent = fileLines[errParsed.lineNo - 1] || "";
      const fullErrStr = `${errParsed.code || ""}: ${errParsed.message}`;

      // Try external patterns first (loaded from JSON files)
      const projectType = SESSION._lastDetectedTech || "";
      const externalPatterns = loadErrorPatternsExternal(projectType);

      if (externalPatterns) {
        for (const pattern of externalPatterns) {
          const match = fullErrStr.match(pattern._compiledMatch);
          if (match) {
            try {
              const rx = diagnoseFromExternalPattern(pattern, match, fileLines, lineContent, filePath);
              prescriptions.push({ file, line: errParsed.lineNo, code: errParsed.code || pattern.id, ...rx });
            } catch (err) { debugLog(err.message); }
            break;
          }
        }
      } else {
        // Fallback to hardcoded ERROR_PATTERNS
        for (const [key, pattern] of Object.entries(ERROR_PATTERNS)) {
          const match = fullErrStr.match(pattern.match);
          if (match) {
            try {
              const rx = pattern.diagnose(match, fileLines, lineContent, filePath);
              prescriptions.push({ file, line: errParsed.lineNo, code: errParsed.code || key, ...rx });
            } catch (err) { debugLog(err.message); }
            break;
          }
        }
      }
    }
  }

  // Store for learning
  if (!SESSION._errorDoctor) SESSION._errorDoctor = {};
  SESSION._errorDoctor.lastPrescriptions = prescriptions;
  SESSION._errorDoctor.timestamp = Date.now();

  if (prescriptions.length === 0) {
    const searchLine = (parsed.sorted[0]?.errors[0] || "").replace(/[^\w\s.]/g, " ").trim().slice(0, 100);
    return `\nACTION REQUIRED:\n1. Fix "${parsed.topFile}" first (${parsed.topCount} errors).\n2. web_search: "${searchLine}"\n3. Call build_and_test again.`;
  }

  // Auto-search for missing symbols in "Cannot find name" errors
  for (const rx of prescriptions) {
    if (/Cannot find name|not defined|is not exported|does not exist/i.test(rx.rootCause || rx.prescription || "")) {
      const symbolMatch = (rx.rootCause || rx.prescription || "").match(/['"](\w{2,50})['"]/);
      if (symbolMatch && cwd) {
        const found = findSymbolInProject(symbolMatch[1], cwd);
        if (found && found.length > 0) {
          const sourceFile = found.find(f => !f.includes(rx.file)) || found[0];
          if (sourceFile) {
            const relPath = path.relative(path.dirname(path.resolve(cwd, rx.file)), sourceFile).replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx)$/, "");
            const rel = relPath.startsWith(".") ? relPath : "./" + relPath;
            rx.prescription += `\n   ⚡ AUTO-FOUND: '${symbolMatch[1]}' is defined in ${path.basename(sourceFile)}. Add: import ${symbolMatch[1]} from '${rel}';`;
            if (!rx.codeBlock) rx.codeBlock = `import ${symbolMatch[1]} from '${rel}';`;
          }
        }
      }
    }
  }

  const rxText = ["\n🩺 ERROR DOCTOR PRESCRIPTIONS (apply these fixes):"];
  for (const rx of prescriptions) {
    rxText.push(`\n📋 ${rx.file} line ${rx.line} (${rx.code}):`);
    rxText.push(`   Cause: ${rx.rootCause}`);
    rxText.push(`   Fix: ${rx.prescription}`);
    if (rx.codeBlock) rxText.push(`\n${rx.codeBlock}`);
  }
  rxText.push(`\nAfter applying fixes, call build_and_test again.`);
  return rxText.join("\n");
}

// Universal: find where a symbol is defined/exported in the project
function findSymbolInProject(symbolName, cwd) {
  if (!cwd || !symbolName || symbolName.length < 2) return null;
  try {
    // Universal patterns that work across languages
    const patterns = [
      `export.*\\b${symbolName}\\b`,            // JS/TS: export function/class/const X
      `\\bclass ${symbolName}\\b`,               // Python/Java/C#/PHP: class X
      `\\bdef ${symbolName}\\b`,                  // Python: def X
      `\\bfunc ${symbolName}\\b`,                 // Go/Swift: func X
      `\\bpub fn ${symbolName}\\b`,               // Rust: pub fn X
      `\\bpub struct ${symbolName}\\b`,            // Rust: pub struct X
      `\\bpublic.*\\b${symbolName}\\b`,           // Java/C#: public class/method X
      `\\bfunction ${symbolName}\\b`,             // PHP/JS: function X
      `\\binterface ${symbolName}\\b`,            // TS/Java/C#: interface X
      `\\btype ${symbolName}\\b`,                 // TS/Go: type X
    ];
    const grepPattern = patterns.join("|");
    const cmd = IS_WIN
      ? `findstr /s /r /c:"${symbolName}" "${cwd}\\*.ts" "${cwd}\\*.tsx" "${cwd}\\*.js" "${cwd}\\*.jsx" "${cwd}\\*.py" "${cwd}\\*.go" "${cwd}\\*.rs" "${cwd}\\*.java" "${cwd}\\*.cs" "${cwd}\\*.php" 2>nul`
      : `grep -rl "\\b${symbolName}\\b" "${cwd}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.cs" --include="*.php" 2>/dev/null | head -10`;
    const result = execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!result) return null;
    const files = result.split("\n").map(l => l.split(":")[0].trim()).filter(Boolean);
    // Deduplicate and filter out node_modules, dist, etc.
    const unique = [...new Set(files)].filter(f => !f.includes("node_modules") && !f.includes("dist") && !f.includes("__pycache__") && !f.includes(".git"));
    return unique.length > 0 ? unique : null;
  } catch (_) { return null; }
}

function validateFileAfterWrite(filepath, content) {
  const ext = path.extname(filepath).toLowerCase();
  if (![".ts",".tsx",".js",".jsx"].includes(ext)) return null;

  const warnings = [];

  // Check brace balance (skip strings by ignoring lines that are purely string content)
  let braces = 0, parens = 0, brackets = 0;
  for (const ch of content) {
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
  }
  if (Math.abs(braces) > 1) warnings.push(`Unbalanced braces: ${braces > 0 ? braces + " unclosed {" : Math.abs(braces) + " extra }"}`);
  if (Math.abs(parens) > 1) warnings.push(`Unbalanced parentheses: ${parens > 0 ? parens + " unclosed (" : Math.abs(parens) + " extra )"}`);

  // Check import paths exist
  const importMatches = [...content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)];
  for (const m of importMatches.slice(0, 10)) {
    const importPath = m[1];
    const dir = path.dirname(filepath);
    const resolved = path.resolve(dir, importPath);
    const exists = fs.existsSync(resolved) || fs.existsSync(resolved + ".ts") || fs.existsSync(resolved + ".js") ||
                   fs.existsSync(resolved + "/index.ts") || fs.existsSync(resolved + "/index.js");
    if (!exists) warnings.push(`Import not found: '${importPath}' — file doesn't exist`);
  }

  return warnings.length > 0 ? warnings.join("\n") : null;
}

function errorDoctorLearnFromSuccess() {
  if (!SESSION._errorDoctor?.lastPrescriptions?.length) return;
  if (!memoryStore) return;

  const prescriptions = SESSION._errorDoctor.lastPrescriptions;
  for (const rx of prescriptions.slice(0, 3)) {
    const content = `[ERROR FIX] ${rx.code}: ${rx.rootCause}\nFix: ${rx.prescription}`;
    const existing = memoryStore.getAll().find(e => e.content.includes(rx.code) && e.tags.includes("error-doctor"));
    if (!existing) {
      memoryStore.add(content, { type: "error_solution", tags: ["error-doctor", rx.code], source: "error-doctor" });
    }
  }
  SESSION._errorDoctor.lastPrescriptions = [];
}

// ══════════════════════════════════════════════════════════════════
// TECH DOCS MAPPER — routes errors to official documentation
// ══════════════════════════════════════════════════════════════════
const TECH_DOCS = [
  { name: "TypeScript", match: /\bTS\d{4}\b|\.ts\(\d/i, url: "https://www.typescriptlang.org/tsconfig", site: "typescriptlang.org", prefix: "TypeScript" },
  { name: "React", match: /react|jsx|tsx|useEffect|useState/i, url: "https://react.dev/reference", site: "react.dev", prefix: "React" },
  { name: "Express", match: /express|middleware|router\.use|app\.use/i, url: "https://expressjs.com/en/api.html", site: "expressjs.com", prefix: "Express.js" },
  { name: "Node.js", match: /node:|require\(|__dirname|process\./i, url: "https://nodejs.org/en/docs", site: "nodejs.org", prefix: "Node.js" },
  { name: "Next.js", match: /next\.js|nextjs|next\//i, url: "https://nextjs.org/docs", site: "nextjs.org", prefix: "Next.js" },
  { name: "Go", match: /\.go:\d+|go build/i, url: "https://pkg.go.dev", site: "pkg.go.dev", prefix: "Go" },
  { name: "Rust", match: /error\[E\d{4}\]|rustc/i, url: "https://doc.rust-lang.org", site: "doc.rust-lang.org", prefix: "Rust" },
  { name: "Python", match: /\.py.*line \d|pip install|ModuleNotFoundError/i, url: "https://docs.python.org/3", site: "docs.python.org", prefix: "Python" },
  { name: "Java", match: /\.java:\d+|maven|gradle|spring/i, url: "https://docs.oracle.com/javase/", site: "docs.oracle.com", prefix: "Java" },
  { name: "Prisma", match: /prisma|@prisma/i, url: "https://www.prisma.io/docs", site: "prisma.io", prefix: "Prisma" },
];

function getTechDocsHint(errorText) {
  for (const tech of TECH_DOCS) {
    if (tech.match.test(errorText)) {
      const code = errorText.match(/\bTS\d{4}\b/)?.[0] || errorText.match(/\bE\d{4}\b/)?.[0] || "";
      const firstErr = errorText.split("\n").find(l => /error/i.test(l))?.replace(/[^\w\s.]/g, " ").trim().slice(0, 80) || "";
      return { tech: tech.name, docsUrl: tech.url, site: tech.site, searchQuery: `${tech.prefix} ${code || firstErr}` };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// ERROR ANALYZER — understands WHAT went wrong and HOW to fix it
// ══════════════════════════════════════════════════════════════════
function analyzeError(errorText) {
  const e = errorText.toLowerCase();

  // Missing library (NOT "is not recognized" — that's command_not_found)
  if (/modulenotfounderror|importerror|no module named|cannot find module/.test(e)) {
    const match = errorText.match(/No module named ['"]([^'"]+)['"]/) ||
                  errorText.match(/ModuleNotFoundError: ([^\n]+)/) ||
                  errorText.match(/Cannot find module ['"]([^'"]+)['"]/);
    const pkg = match?.[1]?.split(".")[0] || "the missing package";
    return {
      type: "missing_library",
      fix:  `use run_bash to install "${pkg}" first, then retry`,
      nudge: `Missing library: "${pkg}". Use run_bash to install it (e.g., npm install ${pkg} or pip install ${pkg}), then retry.`
    };
  }

  // Syntax error
  if (/syntaxerror|unexpected (token|indent)|invalid syntax/.test(e)) {
    const line = errorText.match(/line (\d+)/i)?.[1];
    return {
      type: "syntax_error",
      fix:  `fix the syntax error${line ? ` at line ${line}` : ""} — rewrite only the broken part`,
      nudge: `Syntax error${line ? ` at line ${line}` : ""}. Read the error carefully, rewrite the broken code, and run again.`
    };
  }

  // Permission denied
  if (/permission denied|eacces|access is denied/.test(e)) {
    return {
      type: "permission",
      fix:  "try adding sudo, or change the file path to a writable location like /tmp",
      nudge: `Permission denied. Try using sudo, or write to /tmp instead, then retry.`
    };
  }

  // Spawn/exec failure (ENOENT = executable not found)
  if (/enoent|spawn.*enoent|spawnSync.*enoent/i.test(e)) {
    return {
      type: "spawn_error",
      fix:  "the command or shell could not be found. Check if the program is installed and in PATH",
      nudge: `Spawn error (ENOENT): The command executable was not found. The required tool is not installed. Either install it first, or use a completely different approach that doesn't need this tool. Do NOT retry the same command.`
    };
  }

  // PowerShell Measure-Object / file analysis error
  if (/measure-object|PSInvalidOperationException|NonNumericInputObject|Select-String.*error/i.test(e)) {
    return {
      type: "powershell_error",
      fix: "PowerShell command failed on code files. Use read_file or grep_search instead of PowerShell for file analysis",
      nudge: `PowerShell Measure-Object error — this happens when PowerShell tries to parse source code files numerically.\n\nDo NOT use PowerShell for file analysis. Use CLI tools instead:\n- read_file: read file contents with line numbers\n- grep_search: search for patterns across files\n- find_files: find files by name\n- get_project_structure: see the directory tree\n\nStop using run_bash with PowerShell for file analysis.`
    };
  }

  // Windows syntax error (invalid command flags like mkdir -p)
  if (/the syntax of the command is incorrect/i.test(e)) {
    return {
      type: "win_syntax",
      fix:  "the command used Linux syntax that doesn't work on Windows. Use Windows-compatible commands (mkdir without -p, dir instead of ls, etc.)",
      nudge: `Windows syntax error. This command used Linux-specific flags. On Windows:\n- Use "mkdir folder\\subfolder" (no -p flag)\n- Use "dir" instead of "ls"\n- Use "type" instead of "cat"\n- Use backslashes in paths\nRewrite the command for Windows.`
    };
  }

  // Command not found
  if (/command not found|could not find files for the given pattern|no such file or directory|is not recognized as an internal or external command/.test(e)) {
    const cmd = errorText.match(/([a-zA-Z0-9_-]+): command not found/)?.[1] ||
                errorText.match(/([a-zA-Z0-9_-]+): not found/)?.[1] ||
                errorText.match(/'([^']+)' is not recognized/)?.[1] ||
                // Extract from "where X" command when output is "Could not find files"
                errorText.match(/where\s+(\S+)/)?.[1] ||
                // Extract from STDERR that mentions the command
                errorText.match(/STDERR:.*?(\b(?:java|javac|mvn|gradle|python3?|pip|node|npm|cargo|go|docker|ruby|gcc|make)\b)/i)?.[1];
    const pkgInstall = (win, mac, linux) => IS_WIN ? win : IS_MAC ? mac : linux;
    const installHints = {
      java:    pkgInstall("choco install temurin17 -y", "brew install --cask temurin@17", "sudo apt install openjdk-17-jdk -y"),
      javac:   pkgInstall("choco install temurin17 -y", "brew install --cask temurin@17", "sudo apt install openjdk-17-jdk -y"),
      mvn:     pkgInstall("choco install maven -y", "brew install maven", "sudo apt install maven -y"),
      gradle:  pkgInstall("choco install gradle -y", "brew install gradle", "sudo apt install gradle -y"),
      python3: pkgInstall("choco install python3 -y", "brew install python3", "sudo apt install python3 -y"),
      pip:     pkgInstall("choco install python3 -y", "brew install python3", "sudo apt install python3-pip -y"),
      cargo:   "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      go:      pkgInstall("choco install golang -y", "brew install go", "sudo apt install golang -y"),
      docker:  pkgInstall("choco install docker-desktop -y", "brew install --cask docker", "sudo apt install docker.io -y"),
      node:    pkgInstall("choco install nodejs -y", "brew install node", "sudo apt install nodejs -y"),
      npm:     pkgInstall("choco install nodejs -y", "brew install node", "sudo apt install nodejs npm -y"),
      ruby:    pkgInstall("choco install ruby -y", "brew install ruby", "sudo apt install ruby -y"),
      gcc:     pkgInstall("choco install mingw -y", "brew install gcc", "sudo apt install gcc -y"),
      make:    pkgInstall("choco install make -y", "xcode-select --install", "sudo apt install build-essential -y"),
      git:     pkgInstall("choco install git -y", "brew install git", "sudo apt install git -y"),
      curl:    pkgInstall("choco install curl -y", "brew install curl", "sudo apt install curl -y"),
    };
    const installCmd = cmd ? installHints[cmd.toLowerCase()] : null;
    const osName = IS_WIN ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
    const pkgMgr = IS_WIN ? "choco" : process.platform === "darwin" ? "brew" : "apt";
    return {
      type: "command_not_found",
      fix:  cmd ? `"${cmd}" is not installed on ${osName}. ${installCmd ? `Suggested install: ${installCmd}` : `Search web for install instructions.`}` : "the command is not installed",
      nudge: `Command not found${cmd ? `: "${cmd}"` : ""}. It is NOT installed on ${osName}. FOLLOW THESE STEPS IN ORDER:

STEP 1: Check if the package manager (${pkgMgr}) is available:
  run_bash: ${IS_WIN ? "where choco" : process.platform === "darwin" ? "which brew" : "which apt"}

STEP 2: If package manager EXISTS${installCmd ? `:
  run_bash: ${installCmd}` : `:
  use web_search with query: "how to install ${cmd || "tool"} on ${osName} using ${pkgMgr}"
  Then install using the command from search results.`}

STEP 3: If package manager does NOT exist:
  use web_search with query: "install ${cmd || "tool"} on ${osName} without ${pkgMgr}"
  Then use the download/install method from search results.

STEP 4: After installing, verify with:
  run_bash: ${IS_WIN ? `where ${cmd || "tool"}` : `which ${cmd || "tool"}`}

STEP 5: If verified, retry the original command.

IMPORTANT: Do NOT skip steps. Do NOT guess install commands — search the web first if unsure.`
    };
  }

  // Type / attribute error
  if (/typeerror|attributeerror|nameerror/.test(e)) {
    return {
      type: "code_error",
      fix:  "fix the variable/type error — read the traceback line numbers carefully",
      nudge: `Code error in your logic. Read the traceback, identify the exact line, fix it, and run again.`
    };
  }

  // Network error
  if (/connection refused|network|timeout|econnrefused|ssl/.test(e)) {
    return {
      type: "network",
      fix:  "check network, try a different URL or approach, or use a fallback",
      nudge: `Network error. Try a different URL, add error handling, or use an alternative approach.`
    };
  }

  // Build/compile failed
  if (/build failed|compilation error|\bTS\d{4}\b|error\[E\d|\.java:\d+.*error|\.go:\d+.*error/i.test(e)) {
    const parsed = pluginParseBuildErrors(errorText, SESSION._lastDetectedTech);
    const docsHint = getTechDocsHint(errorText);
    const topFile = parsed?.topFile || "(see errors above)";
    const topCount = parsed?.topCount || "?";
    const searchLine = (parsed?.sorted[0]?.errors[0] || errorText.split("\n").find(l => /error/i.test(l)) || "").replace(/[^\w\s.]/g, " ").trim().slice(0, 90);
    return {
      type: "build_error",
      fix: `fix ${parsed ? `${parsed.fileCount} file(s) — start with "${topFile}" (${topCount} errors)` : "the build errors"}, then rebuild`,
      nudge: `Build failed.${parsed ? `\n${parsed.summary}` : ""}\n\nSTEPS:\n1. Fix "${topFile}" first (${topCount} errors)\n2. web_search: "${searchLine}"\n${docsHint ? `3. ${docsHint.tech} docs: ${docsHint.docsUrl}\n` : ""}4. Call build_and_test to verify.`
    };
  }

  // HTTP 500 / Server error in API response
  if (/500|internal server error|statuscode.*500|status.*500/i.test(e)) {
    return {
      type: "server_500",
      fix: "server-side error — check server logs first, not the request",
      nudge: `API returned 500 Internal Server Error. The bug is SERVER-SIDE. Steps:
1. Call get_server_logs to see the server's error/stack trace
2. Find the file and line number from the stack trace
3. Call read_file on that file
4. Fix the bug with edit_file
5. Restart with start_server
6. Re-test with test_endpoint`
    };
  }

  // Test failure
  if (/test.*fail|fail.*test|\d+ failing|\d+ failed|assertion.*error|expect.*received|assert.*equal/i.test(e)) {
    return {
      type: "test_failure",
      fix: "read the test output to find what failed, fix the implementation (not the test)",
      nudge: `Tests failed. Steps:
1. Read the failure output — it shows EXPECTED vs ACTUAL
2. Use grep_search to find the failing test file
3. Read the test to understand what it expects
4. Fix the implementation code with edit_file
5. Re-run build_and_test to verify`
    };
  }

  // Connection refused (server not running)
  if (/econnrefused|connection refused|could not connect|failed to connect/i.test(e)) {
    return {
      type: "connection_refused",
      fix: "server is not running — start it with start_server first",
      nudge: `Connection refused — server not running. Steps:
1. Call detect_build_system to find the start command
2. Call start_server with the correct command and port
3. Re-run test_endpoint after server starts`
    };
  }

  // Build/compile timeout
  if (/etimedout|timed out|killed.*timeout/i.test(e)) {
    return {
      type: "build_timeout",
      fix: "build timed out — use run_bash directly for slow builds",
      nudge: `Build/command timed out. For slow builds, use run_bash with the command directly (longer timeout).`
    };
  }

  // Generic
  return {
    type: "unknown",
    fix:  "read the full error carefully, understand what went wrong, and try a completely different approach",
    nudge: `Something went wrong. Read the full error carefully and try a different approach.`
  };
}

function suggestErrorAction(analysis, errorText) {
  switch (analysis.type) {
    case "missing_library": {
      const pkg = errorText.match(/No module named ['"]([^'"]+)['"]|Cannot find module ['"]([^'"]+)['"]/);
      const name = pkg?.[1] || pkg?.[2] || "";
      if (name) return `💡 Auto-fix available: install "${name}"`;
      return null;
    }
    case "permission":
      return "💡 Try: use /tmp for output, or prefix command with sudo";
    case "command_not_found": {
      const cmd = errorText.match(/([a-zA-Z0-9_-]+): command not found/)?.[1];
      if (cmd) return `💡 Install "${cmd}" first: npm install -g ${cmd} or apt install ${cmd}`;
      return null;
    }
    case "syntax_error":
      return "💡 I'll read the file and fix the syntax error";
    default:
      return null;
  }
}

async function autoSearchForSolution(errorText, toolName) {
  if (!CONFIG.proxyUrl) return null;
  try {
    const analysis = analyzeError(errorText);
    if (["unknown", "network"].includes(analysis.type)) return null;

    const osName = IS_WIN ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
    let query;

    // For command_not_found, search specifically for install instructions
    if (analysis.type === "command_not_found") {
      const cmd = errorText.match(/'([^']+)' is not recognized/)?.[1] ||
                  errorText.match(/([a-zA-Z0-9_-]+): command not found/)?.[1] || toolName;
      query = `install ${cmd} ${osName} command line`;
    } else {
      // Try model-driven summarization first (fast, non-streaming)
      query = await modelSummarizeError(errorText);
      // Fall back to regex extraction if model fails
      if (!query) query = buildSmartSearchQuery(errorText, toolName, analysis);
    }

    // Use deep research for runtime/server errors, basic search for others
    const isRuntimeError = /TypeError|ImportError|ModuleNotFoundError|AttributeError|NameError|startup failed|server error|500|Internal Server Error|Cannot read|ECONNREFUSED|ENOENT|permission denied/i.test(errorText);
    let hints;

    if (isRuntimeError) {
      // Deep research: search + fetch top URLs + extract code examples
      const res = await proxyPost("/research", { query, num: 3 });
      if (res.error) {
        // Fall back to basic search
        const basicRes = await proxyPost("/search", { query, num: 5 });
        if (basicRes.error || !basicRes.results?.length) return null;
        hints = basicRes.results.slice(0, 3).map((r, i) =>
          `   ${i + 1}. ${r.title}\n      ${r.snippet || ""}\n      ${r.url}`
        ).join("\n");
      } else {
        // Format deep research results with code examples
        const parts = [];
        if (res.searchResults?.length) {
          parts.push("Search results:");
          for (const r of res.searchResults.slice(0, 2)) {
            parts.push(`   - ${r.title}: ${r.snippet || ""}`);
          }
        }
        if (res.deepResults?.length) {
          parts.push("\nDetailed findings:");
          for (const d of res.deepResults.slice(0, 2)) {
            if (d.content) parts.push(`   ${d.content.slice(0, 300)}`);
            if (d.codeBlocks?.length) {
              parts.push("   Code example:");
              parts.push(`   ${d.codeBlocks[0].code?.slice(0, 200) || ""}`);
            }
          }
        }
        hints = parts.join("\n") || null;
      }
    } else {
      const res = await proxyPost("/search", { query, num: 5 });
      if (res.error || !res.results?.length) return null;
      hints = res.results.slice(0, 3).map((r, i) =>
        `   ${i + 1}. ${r.title}\n      ${r.snippet || ""}\n      ${r.url}`
      ).join("\n");
    }

    if (!hints) return null;
    return `💡 ${isRuntimeError ? "Deep research" : "Web search"} for: "${query}"\n${hints}`;
  } catch (_) { return null; }
}

// Ask the model to summarize an error into a clean search query
async function modelSummarizeError(errorText) {
  try {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.model,
        messages: [
          { role: "system", content: "You convert programming errors into web search queries. Reply with ONLY the search query (5-15 words). No explanation, no thinking, no analysis — just the query." },
          { role: "user", content: `Convert this error to a search query:\n${errorText.slice(0, 400)}` },
        ],
        stream: false,
        options: { temperature: 0.1, num_predict: 40 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rawOutput = (data.message?.content || "").trim();
    // Extract the actual query — strip markdown, quotes, prefixes
    const lines = rawOutput.split("\n").map(l => l.trim()).filter(l => l.length > 5 && !l.startsWith("*") && !l.startsWith("#") && !l.startsWith("-"));
    const query = (lines[0] || "").replace(/^["'`]|["'`]$/g, "").replace(/^(Query|Search|search query|Here)[\s:]+/i, "").trim();
    if (query.length > 5 && query.length < 200 && !query.includes("**")) {
      debugLog(`Model-summarized search query: "${query}"`);
      return query;
    }
    return null;
  } catch (err) {
    debugLog("Model summarize error: " + err.message);
    return null;
  }
}

function buildSmartSearchQuery(errorText, toolName, analysis) {
  const lines = errorText.split("\n").map(l => l.trim()).filter(Boolean);

  // Enhancement 3: Auth-specific search queries (ALL frameworks)
  const authPattern = /req\.user|request\.user|current_user|get_current_user|unauthorized|jwt.*(?:invalid|expired|malformed)|token.*required|Cannot read.*(?:user|userId)/i;
  if (authPattern.test(errorText)) {
    const framework = detectFrameworkFromError(errorText);
    return `${framework || "REST API"} JWT authentication middleware req.user undefined 401 fix`;
  }

  // Extract error and generate targeted search query per language
  let errorMessage = "";

  // ── Python: targeted queries for common error types ──
  const pyError = lines.find(l => /^(TypeError|ImportError|ModuleNotFoundError|AttributeError|NameError|ValueError|KeyError|IndexError|SyntaxError|RuntimeError|FileNotFoundError|PermissionError|ConnectionError|OSError|RecursionError):/.test(l));
  if (pyError) {
    const errType = pyError.split(":")[0];
    const errMsg = pyError.slice(errType.length + 1).trim();
    const sym = errMsg.match(/'([^']+)'/)?.[1] || "";
    const pyQueryMap = {
      "TypeError": sym ? `Python TypeError ${sym} ${errMsg.includes("argument") ? "wrong arguments" : errMsg.includes("not callable") ? "not callable" : "type error"} fix` : `Python TypeError ${errMsg.slice(0, 60)}`,
      "ImportError": `Python ImportError cannot import ${sym || errMsg.slice(0, 40)} fix`,
      "ModuleNotFoundError": `Python install ${sym || errMsg.match(/module named '?(\w+)/)?.[1] || ""} pip`,
      "AttributeError": `Python ${sym ? `'${sym}' has no attribute` : "AttributeError"} ${errMsg.match(/attribute '(\w+)'/)?.[1] || ""} fix`,
      "NameError": `Python NameError ${sym || ""} not defined ${errMsg.includes("import") ? "missing import" : "fix"}`,
      "KeyError": `Python KeyError ${sym || ""} dictionary key not found fix`,
      "IndexError": `Python IndexError list index out of range fix`,
      "SyntaxError": `Python SyntaxError ${errMsg.slice(0, 50)} fix`,
      "ValueError": `Python ValueError ${errMsg.slice(0, 50)} fix`,
    };
    // mypy errors: [error-code] format
    const mypyError = lines.find(l => /\[[\w-]+\]\s*$/.test(l));
    if (mypyError) {
      const mypyCode = mypyError.match(/\[([\w-]+)\]/)?.[1] || "";
      errorMessage = `Python mypy ${mypyCode} ${mypyError.replace(/.*error:\s*/, "").replace(/\[.*/, "").trim().slice(0, 60)} fix`;
    } else {
      errorMessage = pyQueryMap[errType] || `Python ${errType}: ${errMsg.slice(0, 60)}`;
    }
  }

  // ── Node.js: targeted queries ──
  if (!errorMessage) {
    const nodeError = lines.find(l => /^(Error|TypeError|SyntaxError|ReferenceError|RangeError|URIError):/.test(l));
    if (nodeError) {
      const errType = nodeError.split(":")[0];
      const errMsg = nodeError.slice(errType.length + 1).trim();
      const sym = errMsg.match(/'([^']+)'/)?.[1] || errMsg.match(/(\w+) is not/)?.[1] || "";
      const nodeQueryMap = {
        "TypeError": sym ? `Node.js TypeError ${sym} ${errMsg.includes("not a function") ? "not a function" : errMsg.includes("cannot read") ? "cannot read property" : ""} fix` : null,
        "ReferenceError": `Node.js ReferenceError ${sym} is not defined ${errMsg.includes("require") ? "CommonJS ESM" : ""} fix`,
        "SyntaxError": `Node.js SyntaxError ${errMsg.includes("import") ? "ESM import" : errMsg.includes("await") ? "top-level await" : ""} ${errMsg.slice(0, 40)} fix`,
      };
      errorMessage = nodeQueryMap[errType] || `Node.js ${errType}: ${errMsg.slice(0, 60)}`;
    }
  }

  // ── TypeScript: targeted queries with error code ──
  if (!errorMessage) {
    const tsError = lines.find(l => /error TS\d+:/.test(l));
    if (tsError) {
      const tsCode = tsError.match(/TS(\d+)/)?.[0] || "";
      const tsMsg = tsError.replace(/^.*error TS\d+:\s*/, "").trim();
      const tsQueryMap = {
        "TS2769": `TypeScript TS2769 no overload matches this call fix`,
        "TS2345": `TypeScript TS2345 argument not assignable ${tsMsg.match(/'([^']+)'/)?.[1] || ""} fix`,
        "TS2322": `TypeScript TS2322 type not assignable ${tsMsg.match(/'([^']+)'/)?.[1] || ""} fix`,
        "TS2339": `TypeScript TS2339 property does not exist on type ${tsMsg.match(/type '([^']+)'/)?.[1] || ""} fix`,
        "TS2307": `TypeScript TS2307 cannot find module ${tsMsg.match(/'([^']+)'/)?.[1] || ""} install`,
        "TS2304": `TypeScript TS2304 cannot find name ${tsMsg.match(/'([^']+)'/)?.[1] || ""} missing import`,
        "TS2305": `TypeScript TS2305 has no exported member ${tsMsg.match(/'([^']+)'/)?.[1] || ""} fix`,
        "TS2554": `TypeScript TS2554 expected arguments ${tsMsg.match(/Expected (\d+)/)?.[1] || ""} got ${tsMsg.match(/got (\d+)/)?.[1] || ""} fix`,
        "TS7016": `TypeScript TS7016 could not find declaration file ${tsMsg.match(/'([^']+)'/)?.[1] || ""} install @types`,
        "TS1005": `TypeScript TS1005 ${tsMsg.match(/'([^']+)'/)?.[1] || ""} expected syntax error fix`,
      };
      errorMessage = tsQueryMap[tsCode] || `TypeScript ${tsCode}: ${tsMsg.slice(0, 80)}`;
    }
  }

  // ── Go: targeted queries for common patterns ──
  if (!errorMessage) {
    const goError = lines.find(l => /undefined:|cannot use|imported and not used|declared and not used|too many|too few|missing return|does not implement|cannot convert/.test(l));
    if (goError) {
      const cleaned = goError.replace(/^.*\.go:\d+:\d+:\s*/, "").trim();
      if (/^undefined:/.test(cleaned)) {
        const sym = cleaned.match(/undefined:\s*(\w+)/)?.[1] || "";
        errorMessage = `Go undefined ${sym} not defined missing import fix`;
      } else if (/cannot use/.test(cleaned)) {
        const types = cleaned.match(/type (\w+).*as type (\w+)/);
        errorMessage = types ? `Go cannot use type ${types[1]} as ${types[2]} type conversion fix` : `Go ${cleaned.slice(0, 60)} fix`;
      } else if (/imported and not used/.test(cleaned)) {
        errorMessage = `Go imported and not used remove unused import fix`;
      } else if (/declared and not used/.test(cleaned)) {
        errorMessage = `Go variable declared and not used fix`;
      } else if (/does not implement/.test(cleaned)) {
        const iface = cleaned.match(/implement (\w+)/)?.[1] || "";
        errorMessage = `Go does not implement interface ${iface} missing method fix`;
      } else if (/missing return/.test(cleaned)) {
        errorMessage = `Go missing return at end of function fix`;
      } else {
        errorMessage = `Go error: ${cleaned.slice(0, 60)} fix`;
      }
    }
  }

  // ── Rust: targeted queries with error code ──
  if (!errorMessage) {
    const rustError = lines.find(l => /error\[E\d+\]:/.test(l));
    if (rustError) {
      const rustCode = rustError.match(/E(\d+)/)?.[0] || "";
      const rustMsg = rustError.replace(/^error\[E\d+\]:\s*/, "").trim();
      const rustQueryMap = {
        "E0382": `Rust E0382 use of moved value ${rustMsg.match(/`(\w+)`/)?.[1] || ""} borrow fix`,
        "E0308": `Rust E0308 mismatched types ${rustMsg.match(/expected `([^`]+)`/)?.[1] || ""} fix`,
        "E0433": `Rust E0433 failed to resolve ${rustMsg.match(/`([^`]+)`/)?.[1] || ""} use import fix`,
        "E0277": `Rust E0277 trait bound not satisfied ${rustMsg.match(/`([^`]+)`/)?.[1] || ""} implement fix`,
        "E0599": `Rust E0599 no method named ${rustMsg.match(/`(\w+)`/)?.[1] || ""} fix`,
        "E0499": `Rust E0499 cannot borrow as mutable more than once fix`,
        "E0502": `Rust E0502 cannot borrow immutable because mutable borrow fix`,
        "E0106": `Rust E0106 missing lifetime specifier fix`,
        "E0425": `Rust E0425 cannot find value ${rustMsg.match(/`(\w+)`/)?.[1] || ""} fix`,
      };
      errorMessage = rustQueryMap[rustCode] || `Rust ${rustCode}: ${rustMsg.slice(0, 60)}`;
    }
  }

  // ── Java/Kotlin: targeted queries ──
  if (!errorMessage) {
    const javaError = lines.find(l => /cannot find symbol|incompatible types|package .* does not exist|Unresolved reference|Type mismatch/.test(l));
    if (javaError) {
      const cleaned = javaError.replace(/^.*\.java:\d+:\s*error:\s*/, "").replace(/^.*\.kt:\d+:\d+:\s*/, "").trim();
      if (/cannot find symbol/.test(cleaned)) {
        const sym = lines.find(l => /symbol:\s*(class|method|variable)\s+\w+/.test(l));
        const symName = sym?.match(/\s(\w+)\s*$/)?.[1] || "";
        const symType = sym?.match(/symbol:\s*(\w+)/)?.[1] || "";
        errorMessage = `Java cannot find symbol ${symType} ${symName} missing import fix`;
      } else if (/incompatible types/.test(cleaned)) {
        errorMessage = `Java incompatible types ${cleaned.match(/(\w+) cannot be converted to (\w+)/)?.[0] || ""} fix`;
      } else if (/package.*does not exist/.test(cleaned)) {
        const pkg = cleaned.match(/package (\S+)/)?.[1] || "";
        errorMessage = `Java package ${pkg} does not exist maven gradle dependency fix`;
      } else if (/Unresolved reference/.test(cleaned)) {
        const ref = cleaned.match(/Unresolved reference:\s*(\w+)/)?.[1] || "";
        errorMessage = `Kotlin unresolved reference ${ref} missing import fix`;
      } else if (/Type mismatch/.test(cleaned)) {
        errorMessage = `Kotlin type mismatch ${cleaned.slice(0, 60)} fix`;
      } else {
        errorMessage = `Java error: ${cleaned.slice(0, 60)} fix`;
      }
    }
  }

  // ── C#/.NET: targeted queries with CS error codes ──
  if (!errorMessage) {
    const csError = lines.find(l => /error CS\d+:/.test(l));
    if (csError) {
      const csCode = csError.match(/CS(\d+)/)?.[0] || "";
      const csMsg = csError.replace(/^.*error CS\d+:\s*/, "").trim();
      const csQueryMap = {
        "CS0246": `C# CS0246 type or namespace ${csMsg.match(/'([^']+)'/)?.[1] || ""} could not be found using fix`,
        "CS1061": `C# CS1061 does not contain definition for ${csMsg.match(/'([^']+)'/)?.[1] || ""} fix`,
        "CS0103": `C# CS0103 name ${csMsg.match(/'([^']+)'/)?.[1] || ""} does not exist in context fix`,
        "CS0029": `C# CS0029 cannot implicitly convert type fix`,
        "CS8600": `C# CS8600 converting null to non-nullable type fix`,
        "CS8618": `C# CS8618 non-nullable property must contain non-null value fix`,
        "CS0535": `C# CS0535 does not implement interface member fix`,
      };
      errorMessage = csQueryMap[csCode] || `C# ${csCode}: ${csMsg.slice(0, 60)}`;
    }
  }

  // ── PHP: targeted queries ──
  if (!errorMessage) {
    const phpError = lines.find(l => /Fatal error|Parse error|PHPStan|Psalm|Class .* not found|Call to undefined|Undefined variable/.test(l));
    if (phpError) {
      if (/Class '([^']+)' not found/.test(phpError)) {
        errorMessage = `PHP class ${phpError.match(/Class '([^']+)'/)?.[1] || ""} not found autoload namespace fix`;
      } else if (/Call to undefined (method|function) (\S+)/.test(phpError)) {
        const match = phpError.match(/Call to undefined (method|function) (\S+)/);
        errorMessage = `PHP call to undefined ${match?.[1]} ${match?.[2] || ""} fix`;
      } else if (/Undefined variable/.test(phpError)) {
        errorMessage = `PHP undefined variable ${phpError.match(/\$(\w+)/)?.[1] || ""} fix`;
      } else if (/Parse error/.test(phpError)) {
        errorMessage = `PHP parse error syntax ${phpError.match(/expecting '?([^']+)'?/)?.[1] || ""} fix`;
      } else if (/PHPStan/.test(phpError)) {
        errorMessage = `PHPStan ${phpError.replace(/.*PHPStan[^:]*:\s*/, "").slice(0, 60)} fix`;
      } else {
        errorMessage = `PHP error: ${phpError.replace(/^.*(?:Fatal|Parse) error:\s*/, "").slice(0, 60)} fix`;
      }
    }
  }

  // ── Swift: targeted queries ──
  if (!errorMessage) {
    const swiftError = lines.find(l => /error:.*(?:use of unresolved|cannot convert|has no member|does not conform|missing return|cannot assign|ambiguous use)/.test(l));
    if (swiftError) {
      const cleaned = swiftError.replace(/^.*\.swift:\d+:\d+:\s*error:\s*/, "").trim();
      if (/use of unresolved identifier/.test(cleaned)) {
        errorMessage = `Swift use of unresolved identifier ${cleaned.match(/'([^']+)'/)?.[1] || ""} missing import fix`;
      } else if (/cannot convert/.test(cleaned)) {
        errorMessage = `Swift cannot convert value type ${cleaned.match(/type '([^']+)'/)?.[1] || ""} fix`;
      } else if (/has no member/.test(cleaned)) {
        errorMessage = `Swift value has no member ${cleaned.match(/'([^']+)'/)?.[1] || ""} fix`;
      } else if (/does not conform to protocol/.test(cleaned)) {
        errorMessage = `Swift does not conform to protocol ${cleaned.match(/'([^']+)'/)?.[1] || ""} implement fix`;
      } else if (/missing return/.test(cleaned)) {
        errorMessage = `Swift missing return in function fix`;
      } else {
        errorMessage = `Swift error: ${cleaned.slice(0, 60)} fix`;
      }
    }
  }

  // ── Generic fallback: find the most informative line ──
  if (!errorMessage) {
    errorMessage = lines.find(l =>
      l.length > 10 && l.length < 200 &&
      !/^\s*(at |File |  File |    |Traceback|During handling|The above)/.test(l) &&
      !/^[A-Z]:\\|^\/[a-z]/.test(l)
    ) || lines[0] || "";
  }

  // Clean the message: remove file paths, keep the error essence
  errorMessage = errorMessage
    .replace(/['"]?[A-Z]:\\[^\s'"]+['"]?/g, "") // Windows paths
    .replace(/['"]?\/[^\s'"]+['"]?/g, "")        // Unix paths
    .replace(/line \d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // Detect framework/technology from error context
  const framework = detectFrameworkFromError(errorText);

  // Build structured query: "framework errorType: clean message"
  const parts = [];
  if (framework) parts.push(framework);
  if (analysis.type && analysis.type !== "unknown") parts.push(analysis.type);
  parts.push(errorMessage);

  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 150);
}

function detectFrameworkFromError(text) {
  if (/fastapi|starlette|uvicorn/i.test(text)) return "FastAPI";
  if (/express|koa|hapi|nestjs/i.test(text)) return "Node.js";
  if (/django|flask|pyramid/i.test(text)) return "Python";
  if (/spring|quarkus|micronaut/i.test(text)) return "Java Spring";
  if (/gin|echo|fiber|gorilla/i.test(text)) return "Go";
  if (/actix|rocket|axum|warp/i.test(text)) return "Rust";
  if (/laravel|symfony|codeigniter/i.test(text)) return "PHP";
  if (/asp\.net|dotnet/i.test(text)) return ".NET";
  if (/next\.js|nuxt|svelte/i.test(text)) return "Next.js";
  if (/react|angular|vue/i.test(text)) return "React";
  return null;
}

// ── Strategy escalation — each retry uses a stronger approach ────────────────
function buildRetryNudge(errorText, retryCount, errorHistory) {
  const analysis = analyzeError(errorText);

  // Track what tools/approaches were tried
  const triedTools = [];
  for (const msg of SESSION.messages.slice(-15)) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        triedTools.push(fn.name);
      }
    }
  }
  const uniqueTriedTools = [...new Set(triedTools)];

  // Detect repeated same-error patterns
  const lastErrors = errorHistory.slice(-3).map(e => analyzeError(e).type);
  const sameErrorRepeated = lastErrors.length >= 2 && lastErrors.every(t => t === analysis.type);

  let nudge = "";

  // Unrecoverable errors — stop immediately, don't burn retries
  const unrecoverable = ["spawn_error"];
  if (unrecoverable.includes(analysis.type) && retryCount >= 1) {
    nudge = `STOP IMMEDIATELY. "${analysis.type}" — this tool/command is NOT INSTALLED on this system.
Do NOT retry the same command or any variation of it.
Instead, respond to the user:
1. Explain what tool is missing (e.g., java, mvn, python3, etc.)
2. Tell them how to install it
3. Ask if they want you to try installing it or use a different approach
Do NOT call run_bash with the same missing command again.`;

  } else if (sameErrorRepeated && retryCount >= 2) {
    nudge = `STOP: Same error "${analysis.type}" occurred ${retryCount} times in a row.
You MUST use a COMPLETELY DIFFERENT approach.
Tools already tried: ${uniqueTriedTools.join(", ")}
REQUIRED: Use a tool you have NOT used yet, or change your approach entirely.
${analysis.nudge}`;

  } else if (retryCount === 1) {
    nudge = `Error: ${analysis.type}
${analysis.fix}
Read the error carefully. Fix the SPECIFIC issue. Do NOT repeat what you just tried.`;

  } else if (retryCount === 2) {
    nudge = `Error "${analysis.type}" persists after ${retryCount} attempts.
Tools tried so far: ${uniqueTriedTools.join(", ")}
Try a COMPLETELY DIFFERENT approach:
- If writing files failed → rewrite the entire file with write_file
- If a port is busy → use run_bash: lsof -i :PORT
- If a command failed → use a different command
- If code has syntax errors → read the file first, then fix with edit_file
${analysis.fix}`;

  } else if (retryCount === 3) {
    nudge = `3 retries failed. Tools tried: ${uniqueTriedTools.join(", ")}
STOP and think differently:
1. What is the user's ACTUAL goal?
2. What is the SIMPLEST way to achieve it?
3. Can you use run_bash to scaffold with npm init, go mod init, etc.?
4. Can you break this into smaller steps?
Do NOT repeat any previous approach.`;

  } else if (retryCount === 4) {
    nudge = `4 retries. Last chance.
- Do NOT call any tool you already called with similar arguments
- Previously tried: ${uniqueTriedTools.join(", ")}
- Explain to the user what's going wrong
- Ask if they want a different approach
- If you can partially complete, do that`;

  } else {
    nudge = `STOP. You have retried ${retryCount} times. Do NOT call any more tools.
Tell the user briefly: what you completed successfully and what didn't work.
Keep it to 2-3 sentences. Do NOT list numbered diagnostic steps.`;
  }

  return nudge;
}

// ══════════════════════════════════════════════════════════════════
// AUTO-MEMORY EXTRACTION — learns from conversations
// ══════════════════════════════════════════════════════════════════
function extractAutoMemories(messages) {
  if (!memoryStore) return;
  const existingContent = new Set(memoryStore.getAll().map(e => e.content.toLowerCase().slice(0, 50)));

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content) continue;
    const content = msg.content;

    // Extract user preferences
    const prefMatch = content.match(/(?:user |you )(prefer|want|like|asked for|require|always use|never use)s?\s+(.{10,100})/i);
    if (prefMatch && !existingContent.has(prefMatch[0].toLowerCase().slice(0, 50))) {
      memoryStore.add(prefMatch[0].trim(), { type: "user_pref", tags: ["auto-extracted"], source: "auto" });
    }

    // Extract error solutions
    if (msg.tool_calls?.length && /(?:fixed|solved|resolved|the (?:issue|problem|error) was)/i.test(content)) {
      const solution = content.slice(0, 200).trim();
      if (solution.length > 20 && !existingContent.has(solution.toLowerCase().slice(0, 50))) {
        memoryStore.add(solution, { type: "error_solution", tags: ["auto-extracted"], source: "auto" });
      }
    }

    // Extract project facts
    const factMatch = content.match(/(?:this project |the codebase |the app |the system )(uses|is built with|requires|depends on|runs on)\s+(.{10,100})/i);
    if (factMatch && !existingContent.has(factMatch[0].toLowerCase().slice(0, 50))) {
      memoryStore.add(factMatch[0].trim(), { type: "project_fact", tags: ["auto-extracted"], source: "auto" });
    }
  }

  // Auto-save solved errors to KB for future reference
  if (CONFIG.proxyUrl) {
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i];
      const next = messages[i + 1];
      if (msg.role === "tool" && msg.content?.includes("STDERR") && next?.role === "assistant" && next.content) {
        const errorSnippet = (msg.content.match(/STDERR:\n(.{20,200})/)?.[1] || "").trim();
        const solutionSnippet = next.content.slice(0, 200).trim();
        if (errorSnippet && solutionSnippet && /fixed|solved|resolved|working/i.test(solutionSnippet)) {
          proxyPost("/kb/recipe/store", {
            errorCode: "RUNTIME_FIX",
            errorMessage: errorSnippet,
            language: SESSION._lastDetectedTech || "unknown",
            strategy: "llm_conversation_fix",
            fixDescription: solutionSnippet,
            fixDiff: null,
            trigger: "conversation error→fix pattern",
          }).catch(err => debugLog(err.message));
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// DEEP CONTEXT AWARENESS — project intelligence
// ══════════════════════════════════════════════════════════════════
function detectProject(dir) {
  const project = { type: null, name: null, version: null, scripts: [], deps: [], devDeps: [], entry: null };

  // Node.js
  const pkgPath = path.join(dir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      project.type = "Node.js";
      project.name = pkg.name;
      project.version = pkg.version;
      project.scripts = Object.keys(pkg.scripts || {});
      project.deps = Object.keys(pkg.dependencies || {});
      project.devDeps = Object.keys(pkg.devDependencies || {});
      project.entry = pkg.main || (fs.existsSync(path.join(dir, "src/index.ts")) ? "src/index.ts" :
                       fs.existsSync(path.join(dir, "src/index.js")) ? "src/index.js" : pkg.main);
    } catch (err) { debugLog(err.message); }
  }

  // Python
  if (!project.type) {
    for (const marker of ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"]) {
      if (fs.existsSync(path.join(dir, marker))) {
        project.type = "Python";
        try {
          if (marker === "pyproject.toml") {
            const content = fs.readFileSync(path.join(dir, marker), "utf-8");
            const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
            if (nameMatch) project.name = nameMatch[1];
          }
          if (marker === "requirements.txt") {
            const lines = fs.readFileSync(path.join(dir, marker), "utf-8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
            project.deps = lines.map(l => l.split(/[=<>!]/)[0].trim()).filter(Boolean).slice(0, 20);
          }
        } catch (err) { debugLog(err.message); }
        break;
      }
    }
  }

  // Go
  if (!project.type && fs.existsSync(path.join(dir, "go.mod"))) {
    project.type = "Go";
    try {
      const mod = fs.readFileSync(path.join(dir, "go.mod"), "utf-8");
      const modName = mod.match(/^module\s+(.+)/m);
      if (modName) project.name = modName[1].trim();
    } catch (err) { debugLog(err.message); }
  }

  // Rust
  if (!project.type && fs.existsSync(path.join(dir, "Cargo.toml"))) {
    project.type = "Rust";
    try {
      const cargo = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf-8");
      const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) project.name = nameMatch[1];
    } catch (err) { debugLog(err.message); }
  }

  // Java
  if (!project.type && (fs.existsSync(path.join(dir, "pom.xml")) || fs.existsSync(path.join(dir, "build.gradle")))) {
    project.type = "Java";
  }

  // Docker
  if (fs.existsSync(path.join(dir, "docker-compose.yml")) || fs.existsSync(path.join(dir, "Dockerfile"))) {
    project.hasDocker = true;
  }

  return project.type ? project : null;
}

function getGitContext(dir) {
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return null;
    const git = {};
    try { git.branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, timeout: 3000, shell: IS_WIN ? true : "/bin/bash" }).toString().trim(); } catch (err) { debugLog(err.message); }
    try {
      const status = execSync("git status --porcelain", { cwd: dir, timeout: 3000, shell: IS_WIN ? true : "/bin/bash" }).toString().trim();
      git.uncommitted = status ? status.split("\n").length : 0;
      git.clean = git.uncommitted === 0;
    } catch (_) { git.uncommitted = 0; git.clean = true; }
    try {
      const log = execSync("git log --oneline -3", { cwd: dir, timeout: 3000, shell: IS_WIN ? true : "/bin/bash" }).toString().trim();
      git.recentCommits = log.split("\n").filter(Boolean);
    } catch (_) { git.recentCommits = []; }
    return git;
  } catch (_) { return null; }
}

function buildProjectContext(dir) {
  const project = detectProject(dir);
  const git = getGitContext(dir);
  if (!project && !git) return "";

  let ctx = "\n\n## Project Context (auto-detected)\n";

  if (project) {
    ctx += `Type: ${project.type}`;
    if (project.name) ctx += ` (${project.name}${project.version ? " v" + project.version : ""})`;
    ctx += "\n";
    if (project.entry) ctx += `Entry: ${project.entry}\n`;
    if (project.scripts.length > 0) ctx += `Scripts: ${project.scripts.slice(0, 8).join(", ")}${project.scripts.length > 8 ? ` (+${project.scripts.length - 8} more)` : ""}\n`;
    if (project.deps.length > 0) ctx += `Dependencies: ${project.deps.slice(0, 8).join(", ")} (${project.deps.length} total)\n`;
    if (project.devDeps.length > 0) ctx += `Dev Dependencies: ${project.devDeps.slice(0, 5).join(", ")} (${project.devDeps.length} total)\n`;
  }

  if (git) {
    ctx += `Git: ${git.branch || "unknown"} branch`;
    if (git.uncommitted > 0) ctx += `, ${git.uncommitted} uncommitted changes`;
    else ctx += ", clean";
    ctx += "\n";
  }

  // Quick structure summary
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map(e => e.name);
    const topFiles = entries.filter(e => e.isFile()).map(e => e.name).slice(0, 5);
    if (dirs.length > 0) ctx += `Dirs: ${dirs.slice(0, 8).join(", ")}\n`;
  } catch (err) { debugLog(err.message); }

  return ctx;
}

function suggestRelevantFiles(userMessage, dir) {
  if (!userMessage) return "";
  const words = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (words.length === 0) return "";

  const matches = [];
  try {
    const walkFlat = (d, depth = 0) => {
      if (depth > 2) return;
      const skip = new Set(["node_modules", ".git", "dist", "build", "__pycache__", "venv", ".next", "coverage"]);
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) { walkFlat(full, depth + 1); }
          else {
            const name = entry.name.toLowerCase();
            for (const w of words) {
              if (name.includes(w)) {
                matches.push(path.relative(dir, full));
                break;
              }
            }
          }
        }
      } catch (err) { debugLog(err.message); }
    };
    walkFlat(dir);
  } catch (err) { debugLog(err.message); }

  if (matches.length === 0) return "";
  return `\nPossibly relevant files: ${matches.slice(0, 5).join(", ")}`;
}

// ══════════════════════════════════════════════════════════════════
// ADAPTIVE TOOL SELECTION — reduce tool set for 30B models
// ══════════════════════════════════════════════════════════════════
function selectToolsForContext(userMessage, messages) {
  const msg = (userMessage || "").toLowerCase();
  const alwaysInclude = new Set(["run_bash", "read_file", "write_file", "edit_file", "grep_search", "find_files", "get_project_structure"]);
  const selected = new Set(alwaysInclude);

  // Planning tools — only when complex tasks or explicitly requested
  if (/\b(plan|todo|task|step|phase|complex|multi.?step|organize|checklist)\b/i.test(msg) || msg.length > 300) {
    selected.add("todo_write");
    selected.add("todo_done");
    selected.add("todo_list");
  }

  // Web tools if research-related
  if (/\b(search|web|google|find online|look up|documentation|docs|how to|tutorial|example)\b/i.test(msg)) {
    selected.add("web_search");
    selected.add("web_fetch");
    selected.add("research");
    selected.add("search_all");
    selected.add("search_docs");
    selected.add("deep_search");
  }

  // GitHub tools if building/coding
  if (/\b(github|example code|reference|implementation|library|framework|boilerplate|template)\b/i.test(msg)) {
    selected.add("github_search");
  }

  // KB tools — always include kb_search when KB has content, or user mentions it
  if (/\b(knowledge|kb|my docs|my notes|my books|local docs|book|chapter|summarize.*book)\b/i.test(msg)) {
    selected.add("kb_search");
    selected.add("kb_add");
    selected.add("kb_list");
  }
  // Also always include kb_search if search-proxy is running and KB has data
  // This ensures the model can find ingested books/docs even without explicit "kb" mention
  if (CONFIG.proxyUrl) {
    selected.add("kb_search");
  }

  // Document creation tools
  if (/\b(pdf|word|excel|pptx|report|document|spreadsheet|chart|presentation|slide|graph)\b/i.test(msg)) {
    selected.add("create_pdf");
    selected.add("create_docx");
    selected.add("create_excel");
    selected.add("create_pptx");
    selected.add("create_chart");
    selected.add("present_file");
  }

  // Server tools
  if (/\b(server|serve|start|run|deploy|port|localhost|express|flask|http)\b/i.test(msg)) {
    selected.add("start_server");
  }

  // Testing and build tools
  if (/\b(test|endpoint|api|verify|validate|check|curl|build|compile|package|tsc|mvn|gradle|cargo)\b/i.test(msg)) {
    selected.add("test_endpoint");
    selected.add("get_server_logs");
    selected.add("build_and_test");
    selected.add("detect_build_system");
  }

  // Environment & plugin tools
  if (/\b(create|scaffold|new project|setup|environment|install|version|venv|virtual.?env|nvm|pyenv|toolchain|uv\b|poetry|nestjs|nest\.?js|next\.?js|react.?native|expo|django|fastapi|flask|laravel|symfony|spring.?boot|express|dotnet|\.net|blazor|rails)\b/i.test(msg)) {
    selected.add("check_environment");
    selected.add("setup_environment");
  }
  if (selected.has("build_and_test")) {
    selected.add("check_environment");
  }

  // Test generation
  if (/\b(generate tests|write tests|add tests|test generation|test skeleton|create tests)\b/i.test(msg)) {
    selected.add("generate_tests");
  }
  // Auto-include when server is running
  if (SESSION._servers && Object.keys(SESSION._servers).length > 0) {
    selected.add("test_endpoint");
    selected.add("get_server_logs");
  }

  // Memory tools if memory-related
  if (/\b(remember|memory|forget|save.*note|persistent)\b/i.test(msg)) {
    selected.add("memory_write");
    selected.add("memory_read");
  }

  // Session history tools if referencing past work
  if (/\b(previous|past|last time|we discussed|continue|before|history|session|earlier)\b/i.test(msg)) {
    selected.add("session_search");
    selected.add("recent_sessions");
  }

  // Include tools used recently (keep them available for multi-step flows)
  for (const m of messages.slice(-6)) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        const tName = tc.function?.name || tc.name;
        if (tName) selected.add(tName);
      }
    }
  }

  // Auto-include search tools when recent errors occurred (broader detection)
  const hasRecentErrors = messages.slice(-8).some(m =>
    m.role === "tool" && m.content && (
      m.content.includes("STDERR") || m.content.includes("❌") || m.content.includes("Error") ||
      m.content.includes("is not recognized") || m.content.includes("not found") ||
      m.content.includes("command not found") || m.content.includes("ENOENT") ||
      m.content.includes("not installed")
    )
  );
  if (hasRecentErrors) {
    selected.add("web_search");
    selected.add("web_fetch");
    selected.add("research");
    selected.add("get_server_logs");
    selected.add("detect_build_system");
    selected.add("search_docs");
    selected.add("deep_search");
  }

  // Memory tools only when relevant (not always — saves tool slots)
  if (/\b(remember|memory|note|save|persistent)\b/i.test(msg)) {
    selected.add("memory_write");
    selected.add("memory_read");
  }

  // ── Tool count cap for 30B models ──
  // Research: Qwen3-Coder breaks at ~5 tools, GLM handles 8-10.
  // Cap at 12 to stay safe. Priority: core file ops > build/test > search > docs
  const MAX_TOOLS = 12;
  const activeTools = getToolsForModel();
  const allSelected = activeTools.filter(t => selected.has(t.function.name));

  if (allSelected.length > MAX_TOOLS) {
    // Priority tiers: higher = kept first
    const priority = {
      read_file: 100, write_file: 100, edit_file: 100, run_bash: 100, grep_search: 95,
      find_files: 90, get_project_structure: 85,
      build_and_test: 80, detect_build_system: 78,
      start_server: 75, test_endpoint: 75, get_server_logs: 73,
      web_search: 70, web_fetch: 68, search_docs: 65,
      todo_write: 60, todo_done: 58, todo_list: 55,
      research: 50, deep_search: 48, search_all: 45,
      check_environment: 77, setup_environment: 76, generate_tests: 74,
      kb_search: 72, kb_add: 40, kb_list: 38, github_search: 36,
      memory_write: 25, memory_read: 23,
      create_pdf: 20, create_docx: 18, create_excel: 16, create_pptx: 14, create_chart: 12,
      present_file: 10, session_search: 8, recent_sessions: 6, use_skill: 5,
    };
    allSelected.sort((a, b) => (priority[b.function.name] || 0) - (priority[a.function.name] || 0));
    const capped = allSelected.slice(0, MAX_TOOLS);
    debugLog(`Tool cap: ${allSelected.length} → ${capped.length} (dropped: ${allSelected.slice(MAX_TOOLS).map(t => t.function.name).join(", ")})`);
    return capped;
  }

  return allSelected;
}

// ══════════════════════════════════════════════════════════════════
// MAIN CHAT FUNCTION — Never Give Up Loop
// ══════════════════════════════════════════════════════════════════
async function chat(userMessage) {
  if (!memoryStore) initMemoryStore();

  // Reset loop counters — but KEEP build state and error signatures across turns
  SESSION._readCounts = {};
  SESSION._readContentHash = {};
  SESSION._writeCounts = {};
  SESSION._editCounts = {};
  SESSION._searchCounts = {};
  SESSION._toolCallPattern = [];
  SESSION._thinkingWithoutActing = 0;
  SESSION._fileCreatesWithoutBuild = 0;
  // DON'T reset: _buildState (error history persists), _errorSignatures (shared root cause), _serverLogs, _endpointFailures, _serverStartFailures

    // Detect user corrections — only when message is clearly correcting the model
    // Must start with negation OR be a short corrective statement (not a long task request)
    if (workingMemory && userMessage && sessionManager && sessionManager.getCurrentTurn() > 1) {
      const trimMsg = userMessage.trim();
      const startsWithNegation = /^(no[,.]?\s|don'?t|do not|stop|wrong|incorrect|not what|I said|I meant|that'?s not)/i.test(trimMsg);
      const isShortCorrection = trimMsg.length < 80 && /\b(instead|rather|use .+ not|prefer .+ over|without)\b/i.test(trimMsg);
      if (startsWithNegation || isShortCorrection) {
        workingMemory.addCorrection(
          trimMsg.length > 100 ? trimMsg.slice(0, 100) + '...' : trimMsg,
          sessionManager.getCurrentTurn()
        );
      }
    }

    // Auto-detect task from first substantial user message
    if (workingMemory && userMessage && userMessage.length > 10) {
      // Update task on every substantial user message
      // Skip short confirmations ("yes", "ok", "continue") — they continue the current task
      // Skip ONLY if entire message is a short confirmation (< 20 chars)
      const trimmed = userMessage.trim();
      const isShortConfirmation = trimmed.length < 20 && /^(yes|ok|no|continue|go ahead|sure|please|thanks|good|great|yep|yeah)$/i.test(trimmed);
      if (!isShortConfirmation) {
        workingMemory.setTask(userMessage.length > 120 ? userMessage.slice(0, 120) + '...' : userMessage);
      }
    }

  let sysPrompt = CONFIG.systemPrompt;

  // Adjust system prompt based on reasoning effort
  if (CONFIG._effort !== undefined) {
    if (CONFIG._effort <= 0.3) {
      sysPrompt += "\n\nEFFORT: LOW — Be extremely brief. Answer in 1-2 sentences. Call tools with minimal explanation. Skip planning for simple tasks.";
    } else if (CONFIG._effort >= 0.9) {
      sysPrompt += "\n\nEFFORT: HIGH — Be thorough. Think step by step. Plan before executing. Verify your work. Use todo_write for complex tasks. Explain your reasoning.";
    }
  }

  // ── Universal architecture discovery ──
  if (!SESSION._discoveredCwd || SESSION._discoveredCwd !== SESSION.cwd) {
    SESSION._discoveredCwd = SESSION.cwd;
    const cwd = SESSION.cwd;
    const archNotes = [];
    // Detect backend servers (any language)
    const serverFiles = [
      { file: "server.js", type: "Express/Node.js" }, { file: "server.ts", type: "Node.js/TS" },
      { file: "app.js", type: "Express/Node.js" }, { file: "app.py", type: "Python (Flask/FastAPI)" },
      { file: "main.py", type: "Python" }, { file: "manage.py", type: "Django" },
      { file: "main.go", type: "Go" }, { file: "main.rs", type: "Rust" },
      { file: "Program.cs", type: "C#/.NET" }, { file: "index.php", type: "PHP" },
    ].filter(s => fs.existsSync(path.join(cwd, s.file)) || fs.existsSync(path.join(cwd, "..", s.file)));

    // Detect frontends
    const hasFrontendDir = ["frontend", "client", "web", "app"].some(d =>
      fs.existsSync(path.join(cwd, d, "package.json")) || fs.existsSync(path.join(cwd, "..", d, "package.json")));
    const hasNextConfig = fs.existsSync(path.join(cwd, "next.config.js")) || fs.existsSync(path.join(cwd, "next.config.mjs")) || fs.existsSync(path.join(cwd, "next.config.ts"));

    if (serverFiles.length > 0 && (hasFrontendDir || hasNextConfig)) {
      archNotes.push(`⚠ ARCHITECTURE: This project has a ${serverFiles[0].type} backend AND a frontend. They likely need DIFFERENT ports.`);
      // Try to detect backend port
      try {
        const sContent = fs.readFileSync(path.join(cwd, serverFiles[0].file), "utf-8").slice(0, 1000);
        const portM = sContent.match(/(?:listen|PORT|port)\s*(?:\(|=|:)\s*(\d{4})/i);
        if (portM) archNotes.push(`Backend (${serverFiles[0].file}) uses port ${portM[1]}.`);
      } catch (_) {}
    }
    if (archNotes.length > 0) {
      sysPrompt += "\n\n" + archNotes.join("\n");
    }
  }

  // ── Context-aware memory injection ──
  // Use new memory system (per-project) if available; skip old global noisy memoryStore
  if (!memoryFileStore) {
    // Fallback to old system only if new one is unavailable
    const relevantMemories = memoryStore.selectRelevant(userMessage, 1500);
    if (relevantMemories.length > 0) {
      const memBlock = relevantMemories.map(e => `- [${e.type}] ${e.content}`).join("\n");
      sysPrompt += `\n\n## Relevant Memory:\n${memBlock}`;
    }
  }
  // New memory system injection happens later (Layer 3: Persistent Memory)
  // Also read project-local memory (LAMA.md)
  const localMemPath = path.join(SESSION.cwd, "LAMA.md");
  try {
    const localMem = fs.readFileSync(localMemPath, "utf-8").trim();
    if (localMem) sysPrompt += `\n\n## Project Notes:\n${localMem}`;
  } catch (err) { debugLog(err.message); }
  // Auto-inject project context
  sysPrompt += buildProjectContext(SESSION.cwd);
  // Suggest relevant files based on user message
  const fileSuggestions = suggestRelevantFiles(userMessage, SESSION.cwd);
  if (fileSuggestions) sysPrompt += fileSuggestions;
  // ── Skill injection — expert knowledge based on task context ──
  if (!SESSION._injectedSkills) SESSION._injectedSkills = new Set();
  // Match against user message AND recent tool results (errors trigger debugging/search skills)
  let skillMatchText = userMessage;
  const recentToolResults = SESSION.messages.slice(-6).filter(m => m.role === "tool").map(m => m.content || "").join(" ");
  skillMatchText += " " + recentToolResults;
  const matchedSkills = matchSkills(skillMatchText);
  // Limit: only inject 1 NEW skill per turn to save context for small models
  // Skills already injected this session are in _injectedSkills — don't re-add
  let skillsInjectedThisTurn = 0;
  for (const skill of matchedSkills) {
    if (!SESSION._injectedSkills.has(skill.name) && skillsInjectedThisTurn < 1) {
      // Truncate skill to 2KB max (was 4KB — too much for small models)
      sysPrompt += `\n\n## Skill: ${skill.name}\n${skill.content.slice(0, 2000)}`;
      SESSION._injectedSkills.add(skill.name);
      skillsInjectedThisTurn++;
      console.log(co(C.dim, `  📚 Skill activated: ${skill.name}`));
    }
  }
  const pending = SESSION.todoList.filter(t => t.status !== "done");
  if (pending.length > 0) {
    // Only inject first 10 pending todos to save context for small models
    sysPrompt += `\n\n## Current TODO list:\n` + pending.slice(0, 10).map(t => {
      const icon = t.status === "in_progress" ? "►" : t.status === "blocked" ? "⊘" : "○";
      return `- [${icon}] #${t.id} ${t.text}${t.phase !== "implement" ? ` [${t.phase}]` : ""}`;
    }).join("\n");
    if (pending.length > 10) sysPrompt += `\n... and ${pending.length - 10} more tasks`;
    const doneCount = SESSION.todoList.filter(t => t.status === "done").length;
    if (doneCount > 0) sysPrompt += `\n(${doneCount} tasks completed)`;
  }
  // Inject plan phase prompt if plan is active
  if (SESSION.plan && SESSION.planMode) {
    sysPrompt += getPlanPhasePrompt(SESSION.plan);
  }

    // Layer 1: Working Memory — inject task anchor at START of prompt
    if (workingMemory) {
      const anchor = workingMemory.getAnchorBlock();
      if (anchor) {
        sysPrompt += '\n\n## Current Task Context:\n' + anchor;
      }
    }

    // Layer 3: Memory Store — inject persistent instructions
    if (memoryFileStore) {
      const instructions = memoryFileStore.getInstructionsBlock();
      if (instructions) {
        sysPrompt += '\n\n## Persistent Memory:\n' + instructions;
      }
    }

  SESSION.messages.push({ role:"user", content: userMessage });
  startSpinner("thinking");

  // ── State ─────────────────────────────────────────────────────────
  let retryCount    = 0;
  let lastError     = null;
  let errorHistory  = [];   // track all errors this turn
  let successStreak = 0;    // consecutive successful tool calls
  let totalSteps    = 0;
  let stopHookActive = false; // prevents Stop hook infinite loops

  // ── Never-Give-Up Loop ────────────────────────────────────────────
  let _lastRealWorkStep = 0; // step number when last REAL work was done (write/edit/bash/build)

  while (true) {
    totalSteps++;

    // ════════════════════════════════════════════════════════════════
    // ABSOLUTE HARD WALL — checked FIRST, impossible to bypass
    // If N steps pass without any relevant work, the model is stuck.
    // In plan mode (design phase): todo_write/check_environment count
    // In normal/implement mode: only write_file/edit_file/run_bash count
    // ════════════════════════════════════════════════════════════════
    {
      const isPlanDesignPhase = SESSION.planMode && SESSION.plan &&
        (SESSION.plan.status === "planning" || SESSION.plan.status === "awaiting_approval" ||
         !SESSION._completedPhases || !SESSION._completedPhases.has("design"));
      const hardWallLimit = isPlanDesignPhase ? 15 : 8; // More slack for planning
      if (totalSteps - _lastRealWorkStep > hardWallLimit) {
        console.log(co(C.bRed, `\n  ⚡ No progress: ${totalSteps - _lastRealWorkStep} steps without ${isPlanDesignPhase ? "planning actions" : "real work"} — stopping.`));
        console.log(co(C.dim, "  The model is stuck. Try rephrasing or use a different model.\n"));
        process.stdout.write("\n");
        printDivider();
        return;
      }
    }

    // Safety valve — after 30 steps ask user if they want to continue
    if (totalSteps === 30 || (totalSteps > 30 && totalSteps % 20 === 0)) {
      if (isAutoMode()) {
        // In --auto mode, hard stop at 60 steps to prevent infinite loops
        if (totalSteps >= 60) {
          console.log(co(C.bRed, `\n  ⚡ ${totalSteps} steps — hard stop (max reached)`));
          process.stdout.write("\n\n");
          printDivider();
          return;
        }
        console.log(co(C.dim, `\n  ⚡ ${totalSteps} steps — auto-continuing...`));
      } else {
        stopSpinner();
        console.log();
        console.log(co(C.bYellow, `  ⚠ ${totalSteps} steps reached. Continue? [y/N] `));
        const cont = await new Promise(r => { pendingApproval = r; });
        if (!cont) { console.log(co(C.dim, "\n  Stopped.\n")); return; }
        startSpinner("continuing");
      }
    }

    let responseText = "";
    let toolCalls    = [];
    let started      = false;
    let thinkingChars = 0;

    // ── Inject nudge if AI gave up last step ──────────────────────────
    if (lastError) {
      const lastMsg = SESSION.messages[SESSION.messages.length - 1];
      const aiGaveUp = lastMsg?.role === "assistant" &&
                       !(lastMsg?.tool_calls?.length) &&
                       /error|fail|cannot|sorry|unable|unfortunately|apologize/i.test(lastMsg?.content || "");

      if (aiGaveUp || (lastMsg?.role === "tool" && String(lastMsg?.content || "").includes("Error"))) {
        retryCount++;
        errorHistory.push(lastError);

        // Remove the give-up response
        if (aiGaveUp) SESSION.messages.pop();

        const nudge = buildRetryNudge(lastError, retryCount, errorHistory);

        SESSION.messages.push({ role:"user", content: nudge });

        // Force auto-search after 3+ retries — don't wait for the model to decide
        if (retryCount >= 3 && CONFIG.proxyUrl && lastError) {
          autoSearchForSolution(lastError, "retry").then(hint => {
            if (hint) {
              SESSION.messages.push({ role: "user", content: `[AUTO-SEARCH] After ${retryCount} failed attempts, here are web results:\n${hint}\nUse these findings to fix the issue. Do NOT retry without applying what you learned.` });
              console.log(co(C.dim, "  💡 Auto-search injected after repeated failures"));
            }
          }).catch(err => debugLog(err.message));
        }

        console.log();
        const retryLabel = retryCount <= 2 ? C.bYellow : retryCount <= 4 ? C.bRed : C.bgRed + C.bWhite;
        console.log(co(retryLabel, ` ↺ RETRY #${retryCount} — ${analyzeError(lastError).type} `));
        lastError = null;
      }
    }

    // ── Call Ollama ───────────────────────────────────────────────────
    try {
      // All tools always available — model selects from descriptions
      const selectedTools = selectToolsForContext(userMessage, SESSION.messages);
      // Context management: sync SESSION.messages → sessionManager → compress → output
      let compressedMessages;
      if (sessionManager) {
        // Sync from SESSION.messages (handles /rewind, /load, /clear, and all tool pushes)
        sessionManager.syncFromSession(SESSION.messages);

        // Apply tiered compression
        const sysTokens = estimateTokens(sysPrompt);
        const toolTokens = estimateTokens(JSON.stringify(selectedTools));
        const { action, tokensSaved } = sessionManager.compress(sysTokens, toolTokens, hookEngine);
        if (action) {
          debugLog(`Context ${action}: saved ${tokensSaved} tokens`);
        }

        compressedMessages = sessionManager.getMessagesForOllama();
        // Write back compressed state to SESSION.messages
        SESSION.messages = sessionManager.getMessages();
      } else {
        // Fallback to old system
        compressedMessages = compressContext(SESSION.messages);
        enforceContextBudget(sysPrompt, compressedMessages, selectedTools);
      }

      // Layer 1: End-of-context reinforcement
      if (workingMemory) {
        const endAnchor = workingMemory.getAnchorBlock();
        if (endAnchor) {
          compressedMessages.push({ role: "user", content: `[CONTEXT REMINDER]\n${endAnchor}\n[END REMINDER]` });
        }
      }

      debugLog(`Sending: ${estimateTokens(sysPrompt)} sys + ${compressedMessages.length} msgs + ${selectedTools.length} tools`);

      // ── Model-specific sampling profiles ──
      // Each model family has optimal params. User overrides (e.g., /temp 0.5) take precedence.
      const _modelProfiles = {
        nemotron: { temperature: 1.0, top_k: 40, top_p: 0.95, repeat_penalty: 1.1, repeat_last_n: 256, presence_penalty: 0.0, frequency_penalty: 0.0, num_predict: 8192, preferredCtx: 32768 },
        qwen:     { temperature: 0.15, top_k: 20, top_p: 0.8, repeat_penalty: 1.3, repeat_last_n: 128, presence_penalty: 1.5, frequency_penalty: 0.0, num_predict: 4096, preferredCtx: 40960 },
        glm:      { temperature: 0.15, top_k: 20, top_p: 0.8, repeat_penalty: 1.3, repeat_last_n: 128, presence_penalty: 1.5, frequency_penalty: 0.0, num_predict: 4096, preferredCtx: 40960 },
        deepseek: { temperature: 0.6, top_k: 40, top_p: 0.95, repeat_penalty: 1.1, repeat_last_n: 256, presence_penalty: 0.0, frequency_penalty: 0.0, num_predict: 8192, preferredCtx: 65536 },
        _default: { temperature: 0.7, top_k: 40, top_p: 0.9, repeat_penalty: 1.2, repeat_last_n: 128, presence_penalty: 0.0, frequency_penalty: 0.0, num_predict: 4096, preferredCtx: 40960 },
      };
      const _mn = (CONFIG.model || "").toLowerCase();
      const _mp = _mn.includes("nemotron") ? _modelProfiles.nemotron
        : _mn.includes("qwen") ? _modelProfiles.qwen
        : _mn.includes("glm") ? _modelProfiles.glm
        : _mn.includes("deepseek") ? _modelProfiles.deepseek
        : _modelProfiles._default;

      // User-set temperature overrides profile; retry logic bumps temperature up
      const effectiveTemp = retryCount > 2
        ? Math.min((CONFIG._userSetTemp || _mp.temperature) + (retryCount * 0.05), _mp.temperature + 0.3)
        : (CONFIG._userSetTemp || _mp.temperature);
      const effectiveCtx = CONFIG.numCtx !== 40960 ? CONFIG.numCtx : _mp.preferredCtx;

      // Nemotron thinking mode control:
      // - Plan mode: let it think (no prefix) → better reasoning for plans
      // - Normal mode: force instruct mode (prepend <think></think>) → fast tool calling
      let ollMessages = [{ role:"system", content: sysPrompt }, ...compressedMessages];
      const isNemotronModel = _mn.includes("nemotron");
      if (isNemotronModel && !SESSION.planMode) {
        // Instruct mode: add partial assistant message with empty think block
        ollMessages.push({ role: "assistant", content: "<think>\n</think>\n" });
      }

      const reqBody = {
        model:    CONFIG.model,
        messages: ollMessages,
        ...(selectedTools.length > 0 ? { tools: selectedTools } : {}),
        options:  {
          temperature:       effectiveTemp,
          num_ctx:           retryCount > 3 ? effectiveCtx * 2 : effectiveCtx,
          repeat_penalty:    _mp.repeat_penalty,
          repeat_last_n:     _mp.repeat_last_n,
          presence_penalty:  _mp.presence_penalty,
          frequency_penalty: _mp.frequency_penalty,
          top_k:             _mp.top_k,
          top_p:             _mp.top_p,
          num_predict:       _mp.num_predict,
        },
        stream: true,
      };

      debugLog("→ POST /api/chat model=" + CONFIG.model, "msgs=" + reqBody.messages.length, "tools=" + selectedTools.length);

      const res = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });

      debugLog("← status:", res.status, res.statusText);

      if (!res.ok) {
        stopSpinner();
        const errText = await res.text();
        debugLog("← error body:", errText);
        console.log(co(C.bRed, "\n  ✗ Ollama error: ") + errText);
        SESSION.messages.pop();
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";
      let   chunkCount = 0;

      let streamStartTime = Date.now();
      // Nemotron in plan mode needs more thinking time (complex reasoning)
      const THINKING_TIMEOUT = (isNemotronModel && SESSION.planMode) ? 300000 : 120000; // 5min plan, 2min normal
      let hasProducedContent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream:true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const rawLine of lines) {
          if (!rawLine.trim()) continue;
          chunkCount++;
          try {
            const chunk = JSON.parse(rawLine);
            const msg   = chunk.message || {};
            debugLog("chunk#" + chunkCount, JSON.stringify(msg).slice(0, 200));

            // Handle thinking/reasoning tokens — suppress garbled display
            if (msg.thinking) {
              thinkingChars += msg.thinking.length;
              // Don't display thinking tokens — they appear garbled in terminal
              // Just track them silently for timeout detection
            }

            // Thinking timeout — abort if model thinks too long without producing content
            if (!hasProducedContent && (Date.now() - streamStartTime > THINKING_TIMEOUT)) {
              console.log(co(C.bYellow, "\n\n  ⚡ Thinking timeout (2min) — forcing response"));
              try { reader.cancel(); } catch (err) { debugLog(err.message); }
              break;
            }

            if (msg.tool_calls?.length > 0) {
              hasProducedContent = true;
              debugLog("tool_calls:", JSON.stringify(msg.tool_calls).slice(0, 300));
              toolCalls = [...toolCalls, ...msg.tool_calls];
            }
            if (msg.content) {
              hasProducedContent = true;
              // thinking display disabled — no cleanup needed
              if (!started) { stopSpinner(); printAiStart(); started = true; }
              renderStreamToken(msg.content);
              responseText += msg.content;

              // Repetition detection — abort if model is looping
              if (responseText.length > 100) {
                // Method 1: Short phrase repeated 3+ times (catches "Now let me X:Now let me X:")
                const tail = responseText.slice(-400);
                const phraseMatch = tail.match(/(.{10,60}?)\1{2,}/);
                if (phraseMatch) {
                  console.log(co(C.bYellow, "\n\n  ⚡ Repetition detected — cutting off"));
                  try { reader.cancel(); } catch (err) { debugLog(err.message); }
                  const repIdx = responseText.lastIndexOf(phraseMatch[1] + phraseMatch[1]);
                  if (repIdx > 30) responseText = responseText.slice(0, repIdx).trim();
                  break;
                }
                // Method 2: Sliding window — same 80-char block appears twice
                if (responseText.length > 250) {
                  const lastChunk = responseText.slice(-80);
                  const earlier = responseText.slice(-250, -80);
                  if (earlier.includes(lastChunk)) {
                    console.log(co(C.bYellow, "\n\n  ⚡ Repetition detected — cutting off"));
                    try { reader.cancel(); } catch (err) { debugLog(err.message); }
                    responseText = responseText.slice(0, responseText.length - 80).trim();
                    break;
                  }
                }
              }
              // Abort if response is too long without tool calls
              if (responseText.length > 2000 && toolCalls.length === 0) {
                console.log(co(C.bYellow, "\n\n  ⚡ Response too long — cutting off"));
                try { reader.cancel(); } catch (err) { debugLog(err.message); }
                break;
              }
            }
          } catch (parseErr) {
            debugLog("parse error:", parseErr.message, "raw:", rawLine.slice(0, 200));
          }
        }
      }

      debugLog("stream done. chunks=" + chunkCount, "response=" + responseText.length + "chars", "toolCalls=" + toolCalls.length);
      // Flush any remaining buffered content (model may not end with newline)
      if (renderState.lineBuffer) {
        // thinking display disabled — no cleanup needed
        if (!started) { stopSpinner(); printAiStart(); started = true; }
        process.stdout.write(renderState.lineBuffer + C.reset);
        responseText += renderState.lineBuffer;
        renderState.lineBuffer = "";
      }

      if (!started) stopSpinner();

    } catch (err) {
      stopSpinner();
      if (err.message.includes("ECONNREFUSED")) {
        console.log(co(C.bRed, "\n  ✗ Cannot connect to Ollama. Run: ") + co(C.yellow, "ollama serve"));
      } else {
        console.log(co(C.bRed, "\n  ✗ ") + err.message);
      }
      SESSION.messages.pop();
      return;
    }

    // ── Fallback: parse text-based tool calls from models with broken templates ──
    if (toolCalls.length === 0 && responseText) {
      // Pattern 1: <function=tool_name><parameter=key>value</parameter></function>
      const xmlToolPattern = /<function=(\w+)>([\s\S]*?)<\/function>/g;
      let xmlMatch;
      while ((xmlMatch = xmlToolPattern.exec(responseText)) !== null) {
        const fnName = xmlMatch[1];
        const paramBlock = xmlMatch[2];
        const args = {};
        const paramPattern = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
        let pMatch;
        while ((pMatch = paramPattern.exec(paramBlock)) !== null) {
          args[pMatch[1]] = pMatch[2].trim();
        }
        toolCalls.push({ function: { name: fnName, arguments: JSON.stringify(args) } });
      }

      // Pattern 2: ```json {"name":"tool","arguments":{...}} ``` in response
      if (toolCalls.length === 0) {
        const jsonToolPattern = /\{"(?:name|function)":\s*"(\w+)"[\s\S]*?"arguments":\s*(\{[\s\S]*?\})\s*\}/g;
        let jMatch;
        while ((jMatch = jsonToolPattern.exec(responseText)) !== null) {
          try {
            const args = JSON.parse(jMatch[2]);
            toolCalls.push({ function: { name: jMatch[1], arguments: JSON.stringify(args) } });
          } catch (err) { debugLog(err.message); }
        }
      }

      if (toolCalls.length > 0) {
        debugLog(`Fallback parser found ${toolCalls.length} tool calls from text`);
        console.log(co(C.dim, `\n  ⚡ Parsed ${toolCalls.length} tool call(s) from text output`));
        // Strip the tool call XML/JSON from the displayed response
        responseText = responseText.replace(/<function=[\s\S]*?<\/function>/g, "").replace(/<\/tool_call>/g, "").trim();
      }
    }

    // ── No tool calls → check if done or gave up ──────────────────────
    if (toolCalls.length === 0) {
      SESSION.messages.push({ role:"assistant", content: responseText });

      // Layer 3: Async memory extraction (non-blocking)
      if (memoryExtractor && userMessage) {
        const responseTextForExtract = typeof responseText === 'string' ? responseText : '';
        if (responseTextForExtract.length > 20) {
          const toolSummary = SESSION.messages.slice(-10)
            .filter(m => m.role === 'tool')
            .map(m => (m._toolName || 'tool') + ': ' + (m.content || '').slice(0, 50))
            .join('; ');
          memoryExtractor.enqueue({ userMessage, assistantResponse: responseTextForExtract, toolSummary });
        }
      }

      // Task completion detection — if model says "done" with no pending tool calls, mark task complete
      if (workingMemory && responseText && !toolCalls?.length) {
        const completionSignals = /\b(I've created|I've successfully|project is ready|here's what's included|how to use|you can now|all files created|task complete|done!)\b/i;
        if (completionSignals.test(responseText)) {
          workingMemory.updateStatus('Task completed');
          workingMemory.setNextStep('Waiting for next instruction');
        }
      }

      // Response validation — catch empty/garbage responses
      const cleanResponse = responseText.replace(/[·•…\s\n]/g, '').trim();
      if (cleanResponse.length < 3 && retryCount < 3) {
        SESSION.messages.pop(); // remove the empty response
        retryCount++;
        // Check if the user's message implies a task needing tools
        const lastUserMsg = SESSION.messages.filter(m => m.role === "user").pop()?.content || "";
        const hasAction = /\b(create|build|fix|test|deploy|add|install|run|start|make|generate|search|find|write|edit|delete|summarize|read)\b/i.test(lastUserMsg);
        if (hasAction) {
          SESSION.messages.push({ role:"user", content: "Your last response was empty. You need to USE A TOOL to complete this task. Look at the available tools and call the right one. Do NOT just respond with text — take ACTION." });
        } else {
          SESSION.messages.push({ role:"user", content: "Your last response was empty. Please respond with actual text answering the question." });
        }
        console.log(co(C.bYellow, "\n  ⚡ Empty response detected — regenerating..."));
        startSpinner("regenerating");
        continue;
      }

      // Compact todo_write/todo_done messages to save context
      // Replace old tool results for todo_write/todo_done with short summaries
      if (SESSION.messages.length > 30) {
        for (let i = 0; i < SESSION.messages.length - 10; i++) {
          const m = SESSION.messages[i];
          if (m.role === "tool" && m.content && (m.content.includes("Task #") || m.content.includes("todo_write") || m.content.includes("todo_done"))) {
            if (m.content.length > 50) m.content = m.content.slice(0, 50);
          }
          // Also compact old skill activation messages
          if (m.role === "user" && m.content?.startsWith("[SKILL ACTIVATED:")) {
            m.content = m.content.slice(0, 100) + "...";
          }
        }
      }

      // Trim history if too long
      if (SESSION.messages.length > CONFIG.historySize * 2) {
        // Keep first message (original request) + last N messages
        const first = SESSION.messages[0];
        SESSION.messages = [first, ...SESSION.messages.slice(-CONFIG.historySize)];
      }

      // If there's still a pending error → loop will inject nudge next iteration
      if (lastError) continue;

      // ── Detect: task completion — STOP the loop ──────────────
      // If model says "done"/"completed"/"ready for next" without tool calls, it's finished.
      // This MUST be checked BEFORE the planning detection to prevent false continuation.
      const completionSignals = /\b(task completed|successfully created|project is ready|all files are ready|ready for your next|what would you like|what else|is there anything else|i'm ready for|ready for any future|what can i help|how can i help|do you approve|approve this plan|waiting for approval|waiting for your approval|ready for approval|once you say|once approved|plan saved|approve\?)\b/i;
      const isCompletion = completionSignals.test(responseText) && toolCalls.length === 0;
      if (isCompletion) {
        // Model is done — don't nudge, don't continue
        debugLog("Completion signal detected — stopping loop");
        // Fall through to "Genuinely done" below
      }

      // ── Count consecutive non-productive responses ────────────────────────
      // After 5 non-productive responses → hard stop.
      // In plan mode: todo_write/check_environment count as productive.
      {
        const productiveTools = new Set(["write_file", "edit_file", "run_bash", "build_and_test",
          "start_server", "test_endpoint", "setup_environment", "generate_tests",
          "create_pdf", "create_docx", "create_excel", "create_pptx"]);
        // During planning, planning tools are productive
        if (SESSION.planMode && SESSION.plan) {
          for (const t of ["todo_write","todo_done","check_environment","detect_build_system","project_structure"]) {
            productiveTools.add(t);
          }
        }
        const hasProductiveCall = toolCalls.some(tc => {
          const fn = tc.function || tc;
          return productiveTools.has(fn.name);
        });

        if (!SESSION._nonProductiveCount) SESSION._nonProductiveCount = 0;

        if (hasProductiveCall) {
          SESSION._nonProductiveCount = 0; // Real work done — reset
        } else {
          SESSION._nonProductiveCount++;
          if (SESSION._nonProductiveCount >= 5) {
            console.log(co(C.bRed, `\n  ⚡ Model stuck — ${SESSION._nonProductiveCount} responses without productive action. Stopping.`));
            console.log(co(C.dim, "  The model is not making progress. Try rephrasing or use a different model.\n"));
            process.stdout.write("\n");
            printDivider();
            return;
          }
        }
      }

      // ── Detect: model is PLANNING but not ACTING ──────────────
      // 4B models often spiral in thinking ("let me create X, then Y, then Z...")
      // consuming all output tokens without producing a tool call.
      // If the response mentions FUTURE actions (not past tense), nudge it to act.
      // IMPORTANT: "created" / "completed" / "installed" are PAST tense = task done, don't nudge.
      const planningWords = /\b(let me|i need to|i'll|i will|now i|next i|let's|going to|should|set up)\b/i;
      const pastTenseCompletion = /\b(created|completed|installed|finished|done|ready|set up successfully|built successfully)\b/i;
      const isStillPlanning = planningWords.test(responseText) && !pastTenseCompletion.test(responseText)
        && !isCompletion && retryCount < 4;
      const hasToolHistory = SESSION.messages.some(m => m.tool_calls?.length > 0);

      if (isStillPlanning && hasToolHistory) {
        if (!SESSION._thinkingWithoutActing) SESSION._thinkingWithoutActing = 0;
        SESSION._thinkingWithoutActing++;

        // HARD STOP after 5 failed nudges — model is stuck, stop wasting tokens
        if (SESSION._thinkingWithoutActing >= 5) {
          console.log(co(C.bRed, `\n  ⚡ Model stuck after ${SESSION._thinkingWithoutActing} nudges — stopping`));
          console.log(co(C.dim, "  The model is unable to proceed. Try rephrasing your request or using a different model.\n"));
          process.stdout.write("\n");
          printDivider();
          return;
        }

        // Model was working on a multi-step task but stopped mid-plan
        SESSION.messages.pop(); // remove the thinking-only response
        retryCount++;
        let thinkNudge;
        if (SESSION._thinkingWithoutActing <= 2) {
          thinkNudge = "You were thinking but didn't call a tool. STOP THINKING and CALL THE NEXT TOOL NOW. Pick the single most important next step and execute it.";
        } else {
          thinkNudge = `FINAL WARNING (attempt ${SESSION._thinkingWithoutActing}/5): Call a tool RIGHT NOW or I will stop. Use todo_write, write_file, run_bash, or web_search. Do NOT respond with text only.`;
        }
        SESSION.messages.push({ role: "user", content: thinkNudge });
        console.log(co(C.bYellow, `\n  ⚡ Model thinking without acting (${SESSION._thinkingWithoutActing}x) — nudging...`));
        startSpinner("continuing");
        continue;
      }

      // ── Stop hook — can force continuation ──
      if (hookEngine && !stopHookActive) {
        try {
          const stopResult = await hookEngine.fire("Stop", {
            session_id: SESSION.id, cwd: SESSION.cwd,
            stop_hook_active: false,
            last_assistant_message: responseText,
          });
          if (stopResult.blocked) {
            stopHookActive = true;
            SESSION.messages.push({
              role: "user",
              content: stopResult.reason || "Continue working — task is not complete yet."
            });
            console.log(co(C.bYellow, "\n  ⚡ Stop hook: ") + co(C.dim, stopResult.reason || "forcing continuation"));
            startSpinner("continuing");
            continue;
          }
        } catch (err) { debugLog(err.message); }
      }
      stopHookActive = false;

      // Genuinely done ✅
      process.stdout.write("\n\n");
      if (retryCount > 0) {
        console.log(co(C.bGreen, `  ✓ Solved after ${retryCount} retries and ${totalSteps} steps`));
      }
      // Auto-extract learnings from this conversation
      try { extractAutoMemories(SESSION.messages.slice(-20)); } catch (err) { debugLog(err.message); }
      printDivider();
      return;
    }

    // ── Execute tools ─────────────────────────────────────────────────
    process.stdout.write("\n");
    // Clean repeated phrases from response before storing in history
    let cleanedResponse = responseText.replace(/(.{10,60}?)\1{2,}/g, "$1").trim();
    if (cleanedResponse.length < 5) cleanedResponse = "(tool call)";
    SESSION.messages.push({ role:"assistant", content: cleanedResponse, tool_calls: toolCalls });

    // ── Tool-call pattern loop detection (catches read→read→read loops) ──
    if (!SESSION._toolCallPattern) SESSION._toolCallPattern = [];
    for (const tc of toolCalls) {
      const fn = tc.function || tc;
      const toolArgs = (typeof fn.arguments === "string" ? JSON.parse(fn.arguments || "{}") : fn.arguments) || {};
      const toolFile = toolArgs.filepath || toolArgs.directory || toolArgs.path || toolArgs.query || "";
      SESSION._toolCallPattern.push(`${fn.name}:${path.basename(toolFile || "")}`);
    }
    // Keep last 20 tool calls
    if (SESSION._toolCallPattern.length > 20) SESSION._toolCallPattern = SESSION._toolCallPattern.slice(-20);
    // Check for repeating patterns (e.g., read_file:page.tsx appearing 5+ times in last 10 calls)
    const recent = SESSION._toolCallPattern.slice(-10);
    const patternCounts = {};
    for (const p of recent) { patternCounts[p] = (patternCounts[p] || 0) + 1; }
    const stuckPattern = Object.entries(patternCounts).find(([, count]) => count >= 3);
    if (stuckPattern) {
      const [pattern, count] = stuckPattern;
      const [stuckTool, stuckFile] = pattern.split(":");
      const nudge = `\n⚠ LOOP DETECTED: You've called ${stuckTool}("${stuckFile}") ${count} times in the last 10 actions.\nYou are STUCK. Change your approach:\n- If you keep reading the same file → use edit_file to change it\n- If you keep editing without progress → use web_search for the error\n- If you keep starting servers → check get_server_logs first\nDo something DIFFERENT on your next action.`;
      SESSION.messages.push({ role: "user", content: nudge });
      SESSION._toolCallPattern = []; // Reset after warning
    }

    const toolResults = [];
    for (const tc of toolCalls) {
      const fn   = tc.function || tc;
      const name = fn.name;
      let   args;
      try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments; }
      catch (parseErr) {
        toolResults.push({ role:"tool", content: formatToolResult(name, `❌ Invalid JSON arguments: ${parseErr.message}. Call ${name} again with valid JSON arguments.`) });
        lastError = `Invalid JSON arguments for ${name}`;
        continue;
      }
      args = args || {};

      // Validate args against tool schema
      const toolDef = TOOLS.find(t => t.function.name === name);
      if (toolDef) {
        const required = toolDef.function.parameters.required || [];
        const missing = required.filter(r => args[r] === undefined || args[r] === null || args[r] === "");
        if (missing.length > 0) {
          toolResults.push({ role:"tool", content: formatToolResult(name, `❌ Missing required arguments: ${missing.join(", ")}. Required: ${required.join(", ")}`) });
          lastError = `Missing args for ${name}: ${missing.join(", ")}`;
          continue;
        }
        // Auto-coerce string numbers
        const props = toolDef.function.parameters.properties || {};
        for (const [key, val] of Object.entries(args)) {
          if (props[key]?.type === "number" && typeof val === "string") {
            args[key] = Number(val);
          }
        }
      }

      // Fire PreToolUse hook — can block tool execution
      if (hookEngine) {
        const hookResult = await hookEngine.fire("PreToolUse", {
          tool_name: name, tool_input: args, cwd: SESSION.cwd,
          session_id: SESSION.id, model: CONFIG.model,
          plan_phase: SESSION.plan?.status, retry_count: retryCount,
        });
        if (hookResult.blocked) {
          toolResults.push({ role:"tool", content: formatToolResult(name, `⊘ Blocked by hook: ${hookResult.reason}`) });
          lastError = `Hook blocked ${name}: ${hookResult.reason}`;
          continue;
        }
      }

      const result    = await executeTool(name, args);
      let   resultStr = String(result);

      // Update real work tracker for the hard wall check
      const _realWorkTools = new Set(["write_file","edit_file","run_bash","build_and_test",
        "start_server","test_endpoint","setup_environment","generate_tests",
        "create_pdf","create_docx","create_excel","create_pptx"]);
      // In plan mode, planning tools also count as progress
      const _planWorkTools = new Set(["todo_write","todo_done","check_environment",
        "detect_build_system","project_structure","read_file"]);
      const isPlanPhase = SESSION.planMode && SESSION.plan;
      if ((_realWorkTools.has(name) || (isPlanPhase && _planWorkTools.has(name)))
          && !resultStr.includes("BLOCKED") && !resultStr.includes("Permission denied")) {
        _lastRealWorkStep = totalSteps;
      }

      // Validate tool result
      if (resultStr.length < 5 && !["todo_done","todo_write","todo_list","memory_write"].includes(name)) {
        resultStr += "\n⚠ Warning: Result is very short — verify the operation succeeded.";
      }
      // Filter binary content
      if (/[\x00-\x08\x0e-\x1f]/.test(resultStr.slice(0, 500))) {
        resultStr = `[Binary content detected — ${resultStr.length} bytes. Use a different approach to handle this file.]`;
      }

      toolResults.push({ role:"tool", content: formatToolResult(name, resultStr) });

      // ── Error detection ─────────────────────────────────────────────
      // Skip error detection for KB search/list results — they may contain
      // error examples in documentation text (e.g., "TypeError: ..." in a tutorial)
      const isKBResult = name === "kb_search" || name === "kb_list" || name === "kb_add";
      const isError = !isKBResult && (
        resultStr.startsWith("STDERR:") ||
        resultStr.startsWith("❌") ||
        resultStr.startsWith("ERROR") ||
        resultStr.startsWith("Error") ||
        resultStr.includes("Traceback (most recent call last)") ||
        resultStr.includes("SyntaxError:") ||
        resultStr.includes("ModuleNotFoundError:") ||
        resultStr.includes("ImportError:") ||
        resultStr.includes("TypeError:") ||
        resultStr.includes("NameError:") ||
        resultStr.includes("AttributeError:") ||
        resultStr.includes("Build failed") ||
        resultStr.includes("FAILED") ||
        (/^error:/im).test(resultStr)
      ) && !resultStr.includes("✓"); // don't flag success messages

      if (isError) {
        lastError = resultStr.slice(0, 1000);
        successStreak = 0;
        const analysis = analyzeError(lastError);
        console.log(co(C.bYellow, `  ⚠ `) +
          co(C.yellow, analysis.type) +
          co(C.dim, ` — retry #${retryCount + 1} coming up`));
        const actionHint = suggestErrorAction(analysis, lastError);
        if (actionHint) console.log(co(C.dim, `  ${actionHint}`));
        // Auto-search for solution (non-blocking)
        autoSearchForSolution(lastError, name).then(hint => {
          if (hint) {
            console.log(co(C.dim, `  ${hint}`));
            // Also inject into model context so it can use the search results
            if (retryCount >= 2) {
              SESSION.messages.push({ role: "user", content: `[AUTO-SEARCH] Web search found these results for the error:\n${hint}\nUse these findings to fix the issue.` });
            }
          }
        }).catch(err => debugLog(err.message));
      } else {
        lastError = null;
        successStreak++;
      }

      // Fire PostToolUse / PostToolUseFailure hook
      if (hookEngine) {
        const hookEvent = isError ? "PostToolUseFailure" : "PostToolUse";
        hookEngine.fire(hookEvent, {
          tool_name: name, tool_input: args, tool_result: resultStr.slice(0, 500),
          cwd: SESSION.cwd, session_id: SESSION.id, is_error: isError,
        }).catch(err => debugLog(err.message)); // fire-and-forget for post hooks
      }

        if (workingMemory) {
          try {
            workingMemory.updateFromToolResult(
              name,
              typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {}),
              typeof resultStr === 'string' ? resultStr : JSON.stringify(resultStr || '')
            );
          } catch (_wmErr) { debugLog('WorkingMemory update error:', _wmErr.message); }
        }
    }

    SESSION.messages.push(...toolResults);

    // ── Dynamic skill injection from tool results ──
    const toolResultText = toolResults.map(r => r.content || "").join(" ");
    const newSkills = matchSkills(toolResultText);
    for (const skill of newSkills) {
      if (!SESSION._injectedSkills.has(skill.name)) {
        // Inject as a system-level context for next model call
        SESSION.messages.push({
          role: "user",
          content: `[SKILL ACTIVATED: ${skill.name}] The following expert knowledge has been loaded to help you:\n${skill.content.slice(0, 2000)}`
        });
        SESSION._injectedSkills.add(skill.name);
        console.log(co(C.dim, `  📚 Skill activated: ${skill.name}`));
      }
    }

    // ── Plan phase transition check ──
    if (SESSION.plan && SESSION.planMode) {
      if (!SESSION._completedPhases) SESSION._completedPhases = new Set();
      const phaseOrder = ["understand", "design", "implement", "verify"];
      for (const phaseName of phaseOrder) {
        if (SESSION._completedPhases.has(phaseName)) continue; // Already transitioned
        const phaseTasks = SESSION.todoList.filter(t => t.phase === phaseName);
        if (phaseTasks.length > 0 && phaseTasks.every(t => t.status === "done")) {
          SESSION._completedPhases.add(phaseName); // Mark as transitioned
          const nextPhaseIdx = phaseOrder.indexOf(phaseName) + 1;
          if (nextPhaseIdx < phaseOrder.length) {
            const nextPhase = phaseOrder[nextPhaseIdx];
            const nextPhaseTasks = SESSION.todoList.filter(t => t.phase === nextPhase);
            if (nextPhaseTasks.some(t => t.status !== "done")) {
              // ── APPROVAL GATE: pause before "implement" phase ──
              // After design is done, show the plan and ask user to approve before coding starts.
              if (phaseName === "design" && nextPhase === "implement" && !isAutoMode()
                && SESSION.plan.status !== "executing" && SESSION.plan.status !== "verifying") {
                SESSION.plan.status = "awaiting_approval";
                savePlan(SESSION.plan);
                console.log(co(C.bCyan, `\n  📋 Phase "design" complete — plan ready for review\n`));
                // Show todo summary
                const implTasks = SESSION.todoList.filter(t => t.phase === "implement");
                const verifyTasks = SESSION.todoList.filter(t => t.phase === "verify");
                console.log(co(C.bold, "  Implementation Plan:"));
                for (const t of implTasks) {
                  console.log(co(C.dim, `    ${t.status === "done" ? "✓" : "○"} ${t.text}`));
                }
                if (verifyTasks.length > 0) {
                  console.log(co(C.bold, "\n  Verification Steps:"));
                  for (const t of verifyTasks) {
                    console.log(co(C.dim, `    ${t.status === "done" ? "✓" : "○"} ${t.text}`));
                  }
                }
                console.log();
                stopSpinner();
                console.log(co(C.bYellow, "  ⚠ Start implementation? [Y/n/edit] "));
                const approval = await new Promise(r => { pendingApproval = r; });
                if (approval === false) {
                  console.log(co(C.dim, "\n  Plan paused. Use /plan status to see tasks, /plan off to cancel.\n"));
                  return;
                }
                // User approved (or typed 'y'/Enter) — continue to implement
                console.log(co(C.bGreen, "  ✓ Approved — starting implementation\n"));
                startSpinner("implementing");
              }

              // Transition to next phase
              SESSION.plan.status = nextPhase === "verify" ? "verifying" : "executing";
              savePlan(SESSION.plan);
              console.log(co(C.bCyan, `\n  📋 Phase "${phaseName}" complete → moving to "${nextPhase}"`));

              // If transitioning to verify, auto-create verification tasks from implement tasks
              if (nextPhase === "verify" && nextPhaseTasks.length === 0) {
                const implTasks = SESSION.todoList.filter(t => t.phase === "implement" && t.verification);
                for (const t of implTasks) {
                  addTodo(`Verify: ${t.verification}`, { phase: "verify" });
                }
                if (implTasks.length > 0) {
                  console.log(co(C.dim, `  Created ${implTasks.length} verification tasks`));
                }
              }
              break;
            }
          }
        }
      }
    }

    const spinLabel = lastError
      ? `fixing (attempt ${retryCount + 1})`
      : successStreak > 1 ? "making progress..." : "processing";

    startSpinner(spinLabel);
  }
}

// ══════════════════════════════════════════════════════════════════
// AI RESPONSE RENDERER  (streams tokens as they arrive)
// ══════════════════════════════════════════════════════════════════
let renderState = { inCode: false, lang: "", lineBuffer: "" };

function printAiStart() {
  renderState = { inCode: false, lang: "", lineBuffer: "", firstLine: true };
  console.log();
  const name = SESSION.name ? `${CONFIG.model} (${SESSION.name})` : CONFIG.model;
  console.log(co(C.bCyan, "  ✦ ") + co(C.bold, C.bCyan, name));
  process.stdout.write(co(C.cyan, "  ╰─ "));
}

function renderStreamToken(token) {
  // Buffer by line for code block detection
  renderState.lineBuffer += token;
  const lines = renderState.lineBuffer.split("\n");
  renderState.lineBuffer = lines.pop() || "";

  for (const line of lines) renderLine(line);
}

function renderLine(line) {
  const prefix = co(C.gray, "  │  ");

  if (line.startsWith("```")) {
    renderState.inCode = !renderState.inCode;
    if (renderState.inCode) {
      renderState.lang = line.slice(3).trim() || "code";
      process.stdout.write("\n" + co(C.gray, "  │  ┌─ ") + co(C.yellow, renderState.lang) + "\n");
    } else {
      process.stdout.write(co(C.gray, "  │  └" + "─".repeat(Math.min(38,W()-10))) + "\n");
    }
    return;
  }

  if (renderState.inCode) {
    process.stdout.write(co(C.gray, "  │  │ ") + co(C.bGreen, line) + "\n");
    return;
  }

  // Format prose
  let out = line
    .replace(/\*\*(.*?)\*\*/g, C.bold + "$1" + C.reset)
    .replace(/`([^`]+)`/g, co(C.bgBlack, C.bYellow, " $1 "))
    .replace(/^### (.+)/, co(C.bold, C.bMagenta, "$1"))
    .replace(/^## (.+)/,  co(C.bold, C.bCyan,    "$1"))
    .replace(/^# (.+)/,   co(C.bold, C.bWhite,   "$1"))
    .replace(/^[-•] /,    co(C.bCyan, "• "))
    .replace(/^(\d+)\. /, co(C.bMagenta, "$1. "));

  process.stdout.write(prefix + out + C.reset + "\n");
}

// ══════════════════════════════════════════════════════════════════
// UI
// ══════════════════════════════════════════════════════════════════
function printBanner() {
  console.clear();
  const w = W();
  console.log();
  console.log(co(C.bCyan, "  " + "╔" + "═".repeat(w-4) + "╗"));
  const t1 = "  ✦  attar-code  v2  —  Claude Code Edition  ";
  const t2 = "  Local AI CLI • Any Ollama Model • Full Tool Suite  ";
  console.log(co(C.bCyan, "  ║") + co(C.bold, C.bWhite, pad("", Math.floor((w-4-t1.length)/2)) + t1 + pad("", Math.ceil((w-4-t1.length)/2))) + co(C.bCyan, "║"));
  console.log(co(C.bCyan, "  ║") + co(C.dim, pad("", Math.floor((w-4-t2.length)/2)) + t2 + pad("", Math.ceil((w-4-t2.length)/2))) + co(C.bCyan, "║"));
  console.log(co(C.bCyan, "  " + "╚" + "═".repeat(w-4) + "╝"));
  console.log();
  printStatusBar();
  console.log();
  console.log(co(C.dim, "  /help  /model  /models  /cp  /rewind  /todo  /memory  /plan  /proxy  /save  /exit"));
  console.log(co(C.dim, "  !command  — run shell directly  |  Type naturally to chat"));
  console.log(co(C.gray, "  " + "─".repeat(w-4)));
  console.log();
}

function printStatusBar() {
  const model    = co(C.bGreen, " ✦ ", CONFIG.model, " ");
  const temp     = co(C.dim, "  🌡 ", String(CONFIG.temperature));
  const ctx      = co(C.dim, "  📐 ", String(CONFIG.numCtx));
  const cwd      = co(C.dim, "  📂 ", SESSION.cwd.replace(os.homedir(),"~").slice(0,40));
  const msgs     = co(C.dim, "  💬 ", String(SESSION.messages.length));
  const cps      = co(C.dim, "  📸 ", String(SESSION.checkpoints.length));
  const todos    = co(C.dim, "  📋 ", String(SESSION.todoList.filter(t=>!t.done).length), " pending");
  const autoA    = isAutoMode() ? co(C.bYellow, `  ⚡${CONFIG.permissionMode?.toUpperCase() || "AUTO"}`) : co(C.dim, `  ${CONFIG.permissionMode || "supervised"}`);
  console.log("  " + model + temp + ctx + cwd + msgs + cps + todos + autoA);
}

function printDivider() {
  console.log(co(C.gray, "  └" + "─".repeat(Math.min(50,W()-6))));
  console.log();
}

function printHelp() {
  // Contextual tips based on current state
  const tips = [];
  if (SESSION.plan) tips.push(co(C.bCyan, "  📋 Plan active") + co(C.dim, " — /plan status, /plan off"));
  if (SESSION.todoList.filter(t => t.status !== "done").length > 0) tips.push(co(C.bYellow, "  ○ Pending tasks") + co(C.dim, " — /todo"));
  if (SESSION.checkpoints.length > 0) tips.push(co(C.dim, `  ↺ ${SESSION.checkpoints.length} checkpoints`) + co(C.dim, " — /rewind, /checkpoints"));
  if (tips.length > 0) {
    console.log(co(C.bold, "\n  Current State:"));
    tips.forEach(t => console.log(t));
  }

  console.log();
  console.log(co(C.bold, C.bCyan, "  ╔═ Commands ══════════════════════════════════╗"));

  const W2 = 32; // wider padding for commands

  const sections = [
    ["Models & Config", [
      ["/model <name>",       "Switch to a different Ollama model"],
      ["",                     "  e.g.  /model qwen2.5:32b   /model glm-4.7-flash"],
      ["/models",              "List all installed Ollama models"],
      ["/temp <0-2>",          "Set temperature (0.15=precise, 0.7=creative)"],
      ["",                     "  e.g.  /temp 0.15   /temp 0.5"],
      ["/ctx <n>",             "Set context window size in tokens"],
      ["",                     "  e.g.  /ctx 65536   /ctx 16384"],
      ["/effort low|med|hi",   "Set reasoning effort level"],
      ["/system <text>",       "Override system prompt for this session"],
      ["/auto on|off",         "Toggle auto-approve for all tool calls"],
    ]],
    ["Session", [
      ["/clear",               "Clear conversation + reset memory (fresh start)"],
      ["/save [file]",         "Save session to JSON file"],
      ["",                     "  e.g.  /save   /save my-session.json"],
      ["/load <file>",         "Load a previously saved session"],
      ["",                     "  e.g.  /load session-abc123.json"],
      ["/name <name>",         "Name this session for easy identification"],
      ["/status",              "Show model, tokens, tools used, session info"],
    ]],
    ["Checkpoints & Rewind", [
      ["/cp [label]",          "Create a checkpoint (snapshot of files + conversation)"],
      ["",                     "  e.g.  /cp   /cp before-refactor"],
      ["/rewind [n|time]",     "Rewind to a checkpoint (restores files + conversation)"],
      ["",                     "  e.g.  /rewind   /rewind 2   /rewind 5m   /rewind 1h"],
      ["/checkpoints",         "List all checkpoints with timestamps"],
      ["/diff [n]",            "Show file changes since checkpoint n"],
      ["",                     "  e.g.  /diff   /diff 3"],
    ]],
    ["Tasks & Planning", [
      ["/todo",                "Show all tasks with status"],
      ["/todo add <text>",     "Add a new task"],
      ["/todo done <id>",      "Mark a task as completed"],
      ["",                     "  e.g.  /todo add Fix login bug   /todo done 3"],
      ["/plan <goal>",         "Enter plan mode — AI plans before executing"],
      ["",                     "  e.g.  /plan Build a REST API with auth"],
      ["/plan status",         "Show current plan progress"],
      ["/plan off",            "Exit plan mode"],
    ]],
    ["Memory (persistent across sessions)", [
      ["/memory",              "Show all memory: global + project + session extractions"],
      ["/memory set <text>",   "Save a global preference (applies to all projects)"],
      ["",                     "  e.g.  /memory set prefer async/await, no semicolons"],
      ["",                     "  Memory auto-extracts facts as you work:"],
      ["",                     "  • user.json — global prefs (shared across projects)"],
      ["",                     "  • project.json — per-project facts (build cmds, tech stack)"],
      ["",                     "  • Archived to Qdrant on /exit for cross-session search"],
    ]],
    ["Knowledge Base (KB)", [
      ["/kb",                  "Show KB status: collections, models, chunk counts"],
      ["/kb add <file> [col]", "Ingest a file into KB (auto-detects collection)"],
      ["",                     "  e.g.  /kb add book.pdf"],
      ["",                     "        /kb add book.pdf python"],
      ["",                     "        /kb add book.pdf python --deep"],
      ["",                     "        /kb add https://docs.express.com nodejs"],
      ["/kb add-dir <path>",   "Bulk ingest all files in a directory"],
      ["",                     "  e.g.  /kb add-dir C:\\docs\\python-books"],
      ["",                     "        /kb add-dir C:\\docs --deep"],
      ["/kb search <query>",   "Search KB (hybrid: semantic + keyword + rerank)"],
      ["",                     "  e.g.  /kb search how to validate data in python"],
      ["",                     "        /kb search Chapter 2 overview"],
      ["/kb collections",      "List all collections with chunk counts"],
      ["/kb remove <name>",    "Delete a collection and all its chunks"],
      ["",                     "  e.g.  /kb remove python"],
      ["/kb stats",            "Show KB retrieval metrics and health"],
      ["",                     ""],
      ["",                     "  Collections: nodejs, python, go, rust, java, csharp,"],
      ["",                     "  php, ruby, swift, css_html, devops, databases, general, personal"],
      ["",                     "  --deep: LLM enriches each chunk with context (~2-3s/chunk,"],
      ["",                     "          better search quality, recommended for books)"],
    ]],
    ["Web Search", [
      ["/search <query>",      "Search the web via DuckDuckGo"],
      ["",                     "  e.g.  /search how to fix CORS in Express"],
    ]],
    ["Search Proxy", [
      ["/proxy",               "Show proxy status (KB + web search server)"],
      ["/proxy start",         "Start the search-proxy server"],
      ["/proxy stop",          "Stop the search-proxy server"],
      ["/proxy restart",       "Restart proxy (needed after code changes)"],
    ]],
    ["Smart Fix & Debugging", [
      ["/errors",              "Show recent build errors with fix prescriptions"],
      ["/mode <mode>",         "Set permission mode: supervised|balanced|autonomous|locked"],
      ["/trust",               "Show trust state (approvals, denials, error budget)"],
      ["/history",             "Show recent tool actions taken this session"],
      ["/env",                 "Check environment / setup / versions / update cache"],
      ["/skills",              "List available expert skills (auto-injected by topic)"],
      ["/hooks",               "Show active lifecycle hooks and their status"],
    ]],
    ["Tools & Shell", [
      ["/tools",               "List all 30+ available AI tools"],
      ["/commands",            "List custom slash commands"],
      ["!<command>",           "Run any shell command directly"],
      ["",                     "  e.g.  !ls -la   !git status   !npm test"],
    ]],
    ["Directory & Files", [
      ["/cd <path>",           "Change working directory"],
      ["",                     "  e.g.  /cd C:\\Users\\me\\project"],
      ["",                     "        /cd .."],
      ["/outputs",             "Show files generated during this session"],
    ]],
    ["Exit", [
      ["/exit",                "Exit CLI (syncs memory to Qdrant, proxy keeps running)"],
      ["",                     "  Aliases: /quit, /q"],
    ]],
  ];

  for (const [section, cmds] of sections) {
    console.log(co(C.bYellow, `\n  ── ${section} `));
    for (const [cmd, desc] of cmds) {
      if (!cmd && desc) {
        // Example/info line — indent more, dimmer
        console.log(co(C.dim, `  ${desc}`));
      } else if (cmd) {
        console.log("  " + co(C.bGreen, pad(cmd, W2)) + co(C.dim, desc));
      }
    }
  }

  console.log(co(C.dim, "\n  Tip: Just type naturally — the AI uses tools automatically."));
  console.log(co(C.dim, "  The KB is searched on build errors and when you ask about docs.\n"));
}

// ══════════════════════════════════════════════════════════════════
// COMMAND HANDLER
// ══════════════════════════════════════════════════════════════════
async function handleCommand(input) {
  let parts = input.trim().split(/\s+/);
  let cmd   = parts[0].toLowerCase();
  let rest  = parts.slice(1).join(" ");

  // ── Natural language command detection ──
  const NL_PATTERNS = [
    { pattern: /^(switch|change|use)\s+(to\s+)?model\s+(.+)/i, handler: (m) => ({ cmd: "/model", rest: m[3] }) },
    { pattern: /^(go|switch|cd|change)\s+(to|into)\s+(.+)/i, handler: (m) => ({ cmd: "/cd", rest: m[3] }) },
    { pattern: /^save\s*(session|this|progress)?$/i, handler: () => ({ cmd: "/save", rest: "" }) },
    { pattern: /^(undo|go back|revert|rollback)(\s+.*)?$/i, handler: (m) => ({ cmd: "/rewind", rest: (m[2] || "").trim() }) },
    { pattern: /^(show|list)\s+(my\s+)?checkpoints?$/i, handler: () => ({ cmd: "/checkpoints", rest: "" }) },
    { pattern: /^(show|list)\s+(my\s+)?todo(s)?$/i, handler: () => ({ cmd: "/todo", rest: "" }) },
    { pattern: /^clear\s*(chat|history|conversation)?$/i, handler: () => ({ cmd: "/clear", rest: "" }) },
    { pattern: /^search\s+(the\s+)?(web|online|internet)\s+(for\s+)?(.+)/i, handler: (m) => ({ cmd: "/search", rest: m[4] }) },
    { pattern: /^(show|list)\s+hooks?$/i, handler: () => ({ cmd: "/hooks", rest: "list" }) },
    { pattern: /^plan\s+status$/i, handler: () => ({ cmd: "/plan", rest: "status" }) },
  ];

  if (!input.startsWith("/") && !input.startsWith("!")) {
    for (const { pattern, handler } of NL_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        const result = handler(match);
        console.log(co(C.dim, `  → Interpreted as: ${result.cmd} ${result.rest}`));
        cmd = result.cmd;
        rest = result.rest;
        parts = [result.cmd, ...result.rest.split(/\s+/)];
        break;
      }
    }
  }

  // Check custom commands first
  const customs = loadCustomCommands();
  if (customs[cmd]) {
    console.log(co(C.dim, `\n  Running custom command: ${cmd}\n`));
    await chat(customs[cmd] + (rest ? "\n\nContext: " + rest : ""));
    return;
  }

  // !shell shortcut
  if (input.startsWith("!")) {
    const shellCmd = input.slice(1).trim();
    try {
      const out = execSync(shellCmd, { cwd:SESSION.cwd, encoding:"utf-8", shell: IS_WIN ? true : "/bin/bash" });
      console.log(co(C.dim, "\n" + out));
    } catch (e) {
      console.log(co(C.bRed, "\n  ✗ ") + (e.stderr || e.message));
    }
    return;
  }

  switch (cmd) {
    case "/help":     printHelp(); break;
    case "/status":   console.log(); printStatusBar(); console.log(); break;

    case "/model":
      if (!rest) { console.log(co(C.dim, "\n  Model: ") + co(C.bGreen, CONFIG.model) + "\n"); break; }
      CONFIG.model = rest; saveConfig();
      if (sessionManager) sessionManager.updateBudget(CONFIG.numCtx);
      console.log(co(C.bGreen, "\n  ✓ ") + "Model: " + co(C.bold, rest) + "\n"); break;

    case "/models": {
      console.log(co(C.dim, "\n  Fetching models...\n"));
      try {
        const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
        const data = await res.json();
        const models = data.models || [];
        if (!models.length) { console.log(co(C.dim, "  No models. Try: ") + co(C.yellow,"ollama pull llama3") + "\n"); break; }
        console.log(co(C.bold, "  Installed Ollama Models:\n"));
        for (const m of models) {
          const active = m.name === CONFIG.model ? co(C.bGreen, " ← active") : "";
          const size   = m.size ? co(C.dim, ` (${(m.size/1e9).toFixed(1)}GB)`) : "";
          console.log("  " + co(C.bYellow, "  • ") + m.name + size + active);
        }
        console.log();
      } catch (_) { console.log(co(C.bRed, "  ✗ Cannot connect to Ollama.\n")); }
      break;
    }

    case "/temp":
      if (!rest || isNaN(parseFloat(rest))) { console.log(co(C.dim, "\n  Temp: ") + (CONFIG._userSetTemp || CONFIG.temperature) + " (model default varies by family)\n"); break; }
      CONFIG.temperature = parseFloat(rest);
      CONFIG._userSetTemp = parseFloat(rest); // Track explicit user override
      saveConfig();
      console.log(co(C.bGreen, "\n  ✓ ") + "Temperature: " + CONFIG.temperature + "\n"); break;

    case "/ctx":
      if (!rest || isNaN(parseInt(rest))) { console.log(co(C.dim, "\n  Context window: ") + CONFIG.numCtx + " tokens\n"); break; }
      CONFIG.numCtx = parseInt(rest); saveConfig();
      if (sessionManager) sessionManager.updateBudget(CONFIG.numCtx);
      console.log(co(C.bGreen, "\n  ✓ ") + "Context window: " + CONFIG.numCtx + " tokens\n"); break;

    case "/system":
      if (!rest) { console.log(co(C.dim, "\n  System prompt:\n  ") + CONFIG.systemPrompt + "\n"); break; }
      CONFIG.systemPrompt = rest; saveConfig();
      console.log(co(C.bGreen, "\n  ✓ ") + "System prompt updated.\n"); break;

    case "/name":
      if (!rest) { console.log(co(C.dim, "\n  Session name: ") + (SESSION.name || "(unnamed)") + "\n"); break; }
      SESSION.name = rest;
      console.log(co(C.bGreen, "\n  ✓ ") + "Session named: " + co(C.bold, rest) + "\n"); break;

    case "/cd": {
      if (!rest) { console.log(co(C.dim, "\n  CWD: ") + co(C.bGreen, SESSION.cwd) + "\n"); break; }
      const target = path.resolve(SESSION.cwd, rest);
      if (!fs.existsSync(target)) { console.log(co(C.bRed, "\n  ✗ Not found: ") + target + "\n"); break; }
      process.chdir(target); SESSION.cwd = process.cwd();
      SESSION._errorPatterns = null; // Reset error pattern cache for new project
      console.log(co(C.bGreen, "\n  ✓ ") + "CWD: " + SESSION.cwd + "\n"); break;
    }

    case "/clear":
      SESSION.messages = [];
        if (workingMemory) workingMemory.reset();
        if (memoryFileStore) memoryFileStore.clearWorking();
      console.log(co(C.bGreen, "\n  ✓ ") + "Conversation cleared.\n"); break;

    case "/save": {
      const file = rest || `session-${SESSION.id}.json`;
      fs.writeFileSync(file, JSON.stringify({ model:CONFIG.model, session:SESSION }, null, 2));
      console.log(co(C.bGreen, "\n  ✓ ") + "Saved: " + file + "\n"); break;
    }

    case "/load": {
      if (!rest) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /load <file>\n"); break; }
      if (!fs.existsSync(rest)) { console.log(co(C.bRed, "\n  ✗ ") + "Not found: " + rest + "\n"); break; }
      const data = JSON.parse(fs.readFileSync(rest, "utf-8"));
      SESSION.messages = data.session?.messages || [];
      CONFIG.model     = data.model || CONFIG.model;
      console.log(co(C.bGreen, "\n  ✓ ") + `Loaded ${SESSION.messages.length} messages.\n`); break;
    }

    case "/cp":
    case "/checkpoint": {
      const cp = createCheckpoint(rest || undefined);
      console.log(co(C.bGreen, "\n  ✓ ") + `Checkpoint: "${cp.label}" — ${Object.keys(cp.files).length} files\n`); break;
    }

    case "/rewind": {
      let cp;
      // Time-based rewind: /rewind 5m, /rewind 1h
      const timeMatch = rest?.match(/^(\d+)(s|m|h)$/);
      if (timeMatch) {
        const amount = parseInt(timeMatch[1]);
        const unit = timeMatch[2];
        const ms = unit === "h" ? amount * 3600000 : unit === "m" ? amount * 60000 : amount * 1000;
        const targetTime = Date.now() - ms;
        // Find nearest checkpoint to target time
        let nearest = null;
        let nearestDiff = Infinity;
        for (const c of SESSION.checkpoints) {
          const diff = Math.abs(new Date(c.time).getTime() - targetTime);
          if (diff < nearestDiff) { nearestDiff = diff; nearest = c; }
        }
        if (nearest) {
          cp = rewindToCheckpoint(nearest.id);
        }
      } else {
        const n = rest ? parseInt(rest) || 0 : 0;
        cp = rewindToCheckpoint(n);
      }
      if (!cp) { console.log(co(C.bRed, "\n  ✗ ") + "No matching checkpoint found.\n"); break; }
      console.log(co(C.bGreen, "\n  ✓ ") + `Rewound to: "${cp.label}" (${cp.time.slice(0,19)}) — ${Object.keys(cp.files).length} files restored\n`);
      break;
    }

    case "/checkpoints": {
      if (!SESSION.checkpoints.length) { console.log(co(C.dim, "\n  No checkpoints yet.\n")); break; }
      console.log(co(C.bold, "\n  Checkpoints:\n"));
      for (const [i, cp] of SESSION.checkpoints.entries()) {
        console.log(`  ${co(C.dim, String(i))}  ${co(C.bYellow, cp.label)}  ${co(C.dim, cp.time.slice(0,19))}  ${co(C.gray, Object.keys(cp.files).length + " files")}`);
      }
      console.log(); break;
    }

    case "/diff": {
      const args = rest?.split(/\s+/) || [];
      const cp1Idx = parseInt(args[0]) || 0;
      const cp2Idx = args[1] !== undefined ? parseInt(args[1]) : -1; // -1 means current state

      if (SESSION.checkpoints.length === 0) {
        console.log(co(C.dim, "\n  No checkpoints to diff.\n"));
        break;
      }

      const cp1 = SESSION.checkpoints[SESSION.checkpoints.length - 1 - cp1Idx];
      if (!cp1) { console.log(co(C.bRed, "\n  ✗ ") + `Checkpoint #${cp1Idx} not found.\n`); break; }

      // Get comparison state (cp2 or current files)
      let cp2Files = {};
      let cp2Label = "current state";
      if (cp2Idx >= 0 && SESSION.checkpoints[SESSION.checkpoints.length - 1 - cp2Idx]) {
        const cp2 = SESSION.checkpoints[SESSION.checkpoints.length - 1 - cp2Idx];
        cp2Files = cp2.files;
        cp2Label = cp2.label;
      } else {
        // Current state of files
        for (const fp of Object.keys(cp1.files)) {
          try { cp2Files[fp] = fs.readFileSync(fp, "utf-8"); } catch (_) { cp2Files[fp] = null; }
        }
      }

      console.log(co(C.bold, `\n  Diff: "${cp1.label}" vs "${cp2Label}"\n`));

      const allFiles = new Set([...Object.keys(cp1.files), ...Object.keys(cp2Files)]);
      let hasChanges = false;
      for (const fp of allFiles) {
        const old = cp1.files[fp];
        const cur = cp2Files[fp];
        if (old === cur) continue;
        hasChanges = true;

        if (!old && cur) {
          console.log(co(C.bGreen, `  + Added: ${fp}`));
        } else if (old && !cur) {
          console.log(co(C.bRed, `  - Removed: ${fp}`));
        } else {
          const oldLines = (old || "").split("\n");
          const curLines = (cur || "").split("\n");
          const added = curLines.filter(l => !oldLines.includes(l)).length;
          const removed = oldLines.filter(l => !curLines.includes(l)).length;
          console.log(co(C.bYellow, `  ~ Modified: ${fp}`) + co(C.dim, ` (+${added} -${removed} lines)`));
        }
      }
      if (!hasChanges) console.log(co(C.dim, "  No changes between these checkpoints."));
      console.log();
      break;
    }

    case "/todo": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "add") { const id = addTodo(parts.slice(2).join(" ")); console.log(co(C.bGreen, "\n  ✓ ") + `Task #${id} added.\n`); }
      else if (sub === "done") { doneTodo(parseInt(parts[2])); console.log(co(C.bGreen, "\n  ✓ ") + "Done.\n"); }
      else { console.log(co(C.bold, "\n  TODO List:\n")); printTodos(); console.log(); }
      break;
    }

    case "/memory": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "set" && memoryFileStore) {
        const value = parts.slice(2).join(" ");
        memoryFileStore.setUser('manual_' + Date.now(), value);
        console.log(co(C.bGreen, "\n  ✓ ") + "Memory saved to user.json.\n");
      } else if (sub === "set") {
        writeMemory(parts.slice(2).join(" "));
        console.log(co(C.bGreen, "\n  ✓ ") + "Memory saved.\n");
      } else if (memoryFileStore) {
        // Show new memory system
        console.log(co(C.bold, "\n  ── Memory System ──\n"));

        const user = memoryFileStore.getAllUser();
        const userEntries = Object.entries(user).filter(([k]) => k !== 'migrated');
        if (userEntries.length > 0) {
          console.log(co(C.bCyan, "  Global (user.json):"));
          for (const [k, v] of userEntries.slice(-10)) {
            console.log(co(C.dim, `    [${k}] ${String(v).slice(0, 100)}`));
          }
        } else {
          console.log(co(C.dim, "  Global: (empty)"));
        }

        const project = memoryFileStore.getAllProject();
        const projEntries = Object.entries(project).filter(([k]) => k !== 'error_trends');
        console.log();
        if (projEntries.length > 0) {
          console.log(co(C.bYellow, "  Project (project.json):"));
          for (const [k, v] of projEntries.slice(-10)) {
            console.log(co(C.dim, `    [${k}] ${String(v).slice(0, 100)}`));
          }
        } else {
          console.log(co(C.dim, "  Project: (empty — facts will be auto-extracted as you work)"));
        }

        const extractions = memoryFileStore.getExtractions();
        console.log();
        if (extractions.length > 0) {
          console.log(co(C.bGreen, `  Session extractions (${extractions.length}):`));
          for (const e of extractions.slice(-5)) {
            console.log(co(C.dim, `    [${e.type}] ${e.content.slice(0, 100)}`));
          }
        } else {
          console.log(co(C.dim, "  Session: (no extractions yet)"));
        }

        // Show error trends if any
        const trends = memoryFileStore.getProject('error_trends');
        if (trends && Object.keys(trends).length > 0) {
          console.log();
          console.log(co(C.bRed, `  Error trends (${Object.keys(trends).length} patterns):`));
          for (const [code, t] of Object.entries(trends).slice(0, 5)) {
            console.log(co(C.dim, `    ${code}: ${t.total || 0} occurrences, ${((t.success_rate || 0) * 100).toFixed(0)}% success`));
          }
        }

        console.log();
      } else {
        // Fallback to old system
        const m = readMemory();
        console.log("\n" + (m ? co(C.dim, m) : co(C.dim, "  (empty)")) + "\n");
      }
      break;
    }

    case "/plan": {
      if (rest === "off") {
        SESSION.planMode = false;
        SESSION.plan = null;
        console.log(co(C.bGreen, "\n  ✓ ") + "Plan mode off.\n");
        break;
      }
      if (rest === "status") {
        printPlanStatus(SESSION.plan);
        break;
      }
      if (!rest) {
        if (SESSION.plan) { printPlanStatus(SESSION.plan); }
        else { console.log(co(C.dim, "\n  Usage: /plan <goal> | /plan status | /plan off\n")); }
        break;
      }
      // Create new plan
      const plan = createPlan(rest);
      console.log(co(C.bCyan, `\n  🗺  Plan created: "${rest}"`));
      console.log(co(C.dim, "  Phases: understand → design → implement → verify\n"));

      await chat(`GOAL: ${rest}

PLAN MODE — explore, plan, get approval, then implement.

STEP 1: Explore the project (read_file, project_structure, check_environment). Just do it — no todos for exploration.

STEP 2: Present the plan as clear BULLETS. One bullet per logical step. Then ask "Do you approve this plan?" and STOP.
  - If user says "yes" → create matching todos with todo_write, then implement.
  - If user suggests changes → revise the plan, show updated bullets, ask again.
  - If user says "no" → stop.

RULES:
- One todo per LOGICAL STEP (e.g., "Create auth module" not 5 separate file todos).
- Do NOT create todos for exploration, reading files, or checking versions.
- Do NOT create duplicate todos — check if similar task already exists.
- Present the plan BEFORE creating todos. Bullets first, todos after approval.
- Use the RIGHT number of steps for the task — small task = 3 steps, large task = 12+ steps. No artificial limit.`);
      // Auto-exit plan mode ONLY when real implementation is done
      // Keep planMode=true after plan presentation so user can give feedback
      if (SESSION.planMode && SESSION.plan) {
        const hasTodos = SESSION.todoList.length > 0;
        const allDone = hasTodos && SESSION.todoList.every(t => t.status === "done");
        const hasRealWork = SESSION._actionHistory?.some(a =>
          ["write_file","edit_file","run_bash","build_and_test","start_server"].includes(a.tool) && a.outcome === "ok"
        );
        if (allDone && hasRealWork) {
          SESSION.planMode = false;
          SESSION.plan = null;
          console.log(co(C.dim, "  📋 Plan completed — exiting plan mode\n"));
        }
        // If no todos and no real work: keep planMode true (user may modify plan)
      }
      break;
    }

    case "/effort": {
      const level = rest?.toLowerCase();
      if (level === "low") { CONFIG._effort = 0.3; console.log(co(C.dim, "\n  Effort: LOW — brief responses, minimal planning\n")); }
      else if (level === "high") { CONFIG._effort = 1.0; console.log(co(C.bCyan, "\n  Effort: HIGH — thorough, step-by-step\n")); }
      else if (level === "medium") { CONFIG._effort = 0.6; console.log(co(C.dim, "\n  Effort: MEDIUM — balanced\n")); }
      else { console.log(co(C.dim, `\n  Current effort: ${CONFIG._effort <= 0.3 ? "LOW" : CONFIG._effort >= 0.9 ? "HIGH" : "MEDIUM"}\n  Usage: /effort low|medium|high\n`)); }
      break;
    }

    case "/auto":
      if (rest === "on")  { CONFIG.autoApprove = true; CONFIG.permissionMode = "autonomous"; saveConfig(); console.log(co(C.bYellow, "\n  ⚡ Mode: autonomous (auto-approve ON)\n")); }
      else if (rest === "off") { CONFIG.autoApprove = false; CONFIG.permissionMode = "supervised"; saveConfig(); console.log(co(C.bGreen, "\n  ✓ Mode: supervised (auto-approve OFF)\n")); }
      else { console.log(co(C.dim, "\n  Mode: ") + co(C.bold, CONFIG.permissionMode || "supervised") + co(C.dim, " | Auto-approve: ") + (isAutoMode() ? co(C.bYellow,"ON") : co(C.dim,"off")) + "\n"); }
      break;

    case "/outputs": {
      try {
        const files = fs.readdirSync(OUTPUTS_DIR);
        if (files.length === 0) { console.log(co(C.dim, "\n  No outputs yet.\n")); break; }
        console.log(co(C.bold, "\n  Outputs:\n"));
        for (const f of files.slice(-10)) {
          const fp = path.join(OUTPUTS_DIR, f);
          const stat = fs.statSync(fp);
          const sizeStr = stat.size < 1024 ? `${stat.size}B` : `${(stat.size/1024).toFixed(1)}KB`;
          console.log(`  ${co(C.bYellow, "📄")} ${f} ${co(C.dim, `(${sizeStr})`)}`);
        }
        console.log(co(C.dim, `\n  Location: ${OUTPUTS_DIR}\n`));
      } catch (_) { console.log(co(C.dim, "\n  No outputs directory.\n")); }
      break;
    }

    case "/mode": {
      const mode = parts[1]?.toLowerCase();
      const validModes = ["supervised", "balanced", "autonomous", "locked"];
      if (mode && validModes.includes(mode)) {
        CONFIG.permissionMode = mode;
        CONFIG.autoApprove = (mode === "autonomous");
        saveConfig();
        const modeColors = { supervised: C.bGreen, balanced: C.bCyan, autonomous: C.bYellow, locked: C.bRed };
        console.log(co(modeColors[mode], `\n  Permission mode: ${mode}\n`));
        const descriptions = {
          supervised: "All file writes and commands require approval.",
          balanced: "File writes and builds auto-approved. Installs and deletes ask.",
          autonomous: "Everything auto-approved except high-risk (sudo, force-push, global installs). Error budget: 3 strikes.",
          locked: "Only explicitly allowed actions execute. Everything else denied.",
        };
        console.log(co(C.dim, `  ${descriptions[mode]}\n`));
      } else {
        console.log(co(C.bold, "\n  Permission Modes\n"));
        for (const m of validModes) {
          const current = CONFIG.permissionMode === m ? co(C.bGreen, " ← current") : "";
          console.log(`  ${m.padEnd(14)}${current}`);
        }
        console.log(co(C.dim, `\n  Usage: /mode <supervised|balanced|autonomous|locked>\n`));
      }
      return null;
    }

    case "/trust": {
      if (!SESSION._trustState) SESSION._trustState = { approvals: 0, denials: 0, consecutiveDenials: 0, errors: 0, autoFixSuccesses: 0 };
      const sub = parts[1]?.toLowerCase();
      if (sub === "reset") {
        SESSION._trustState = { approvals: 0, denials: 0, consecutiveDenials: 0, errors: 0, autoFixSuccesses: 0 };
        console.log(co(C.bGreen, "\n  ✓ Trust state reset. Error budget restored.\n"));
      } else {
        const ts = SESSION._trustState;
        console.log(co(C.bold, "\n  Trust State\n"));
        console.log(`  Approvals:           ${ts.approvals}`);
        console.log(`  Denials:             ${ts.denials} (${ts.consecutiveDenials} consecutive)`);
        console.log(`  Errors:              ${ts.errors}`);
        console.log(`  Auto-fix successes:  ${ts.autoFixSuccesses}`);
        console.log(`  Error budget:        ${Math.max(0, (PERMISSIONS.autonomousErrorBudget || 3) - ts.errors)} remaining`);
        console.log(`  Permission mode:     ${CONFIG.permissionMode}`);
        console.log(co(C.dim, `\n  /trust reset — reset error budget and counters\n`));
      }
      return null;
    }

    case "/history": {
      if (!SESSION._actionHistory || SESSION._actionHistory.length === 0) {
        console.log(co(C.dim, "\n  No actions recorded yet.\n"));
        return null;
      }
      console.log(co(C.bold, `\n  Action History (${SESSION._actionHistory.length} actions)\n`));
      const recent = SESSION._actionHistory.slice(-20);
      for (const a of recent) {
        const time = new Date(a.time).toLocaleTimeString();
        const icon = a.outcome === "error" ? co(C.bRed, "✗") : co(C.bGreen, "✓");
        const arg = a.arg ? co(C.dim, ` ${String(a.arg).slice(0, 50)}`) : "";
        console.log(`  ${co(C.dim, time)} ${icon} ${a.tool}${arg}`);
      }
      console.log();
      return null;
    }

    case "/env": {
      const sub = parts[1]?.toLowerCase();
      if (!pluginRegistry) {
        console.log(co(C.bRed, "\n  Plugin system not available. Ensure plugins/ directory exists.\n"));
        return null;
      }

      if (!sub) {
        // /env with no args: show ALL installed runtimes system-wide + project detection
        const dir = SESSION.cwd;
        const { OSAbstraction } = require('./plugins/os-abstraction');
        console.log(co(C.bold, "\n  System Runtimes\n"));

        const runtimeChecks = [
          { name: 'Node.js',  bin: 'node',    flag: '--version', pattern: /v(\d+\.\d+\.\d+)/ },
          { name: 'Python',   bin: OSAbstraction.pythonBinary, flag: '--version', pattern: /Python\s+(\d+\.\d+\.\d+)/ },
          { name: 'Rust',     bin: 'rustc',   flag: '--version', pattern: /rustc\s+(\d+\.\d+\.\d+)/ },
          { name: 'Go',       bin: 'go',      flag: 'version',   pattern: /go(\d+\.\d+\.\d+)/ },
          { name: 'Java',     bin: 'java',    flag: '-version',  pattern: /version\s+"(\d+[\d.]*)/ },
          { name: 'C/C++',    bin: 'gcc',     flag: '--version', pattern: /(\d+\.\d+\.\d+)/ },
          { name: 'PHP',      bin: 'php',     flag: '--version', pattern: /PHP\s+(\d+\.\d+\.\d+)/ },
          { name: '.NET',     bin: 'dotnet',  flag: '--version', pattern: /(\d+\.\d+\.\d+)/ },
        ];

        for (const rt of runtimeChecks) {
          const ver = OSAbstraction.getVersion(rt.bin, rt.flag, rt.pattern);
          if (ver) {
            console.log(`  ${co(C.bGreen, '✓')} ${rt.name.padEnd(10)} ${ver.version}`);
          } else {
            console.log(`  ${co(C.dim, '✗')} ${co(C.dim, rt.name.padEnd(10) + 'not installed')}`);
          }
        }

        // Also check common tools
        console.log(co(C.bold, "\n  Package Managers\n"));
        const pmChecks = [
          { name: 'npm',      bin: 'npm' },
          { name: 'pnpm',     bin: 'pnpm' },
          { name: 'yarn',     bin: 'yarn' },
          { name: 'bun',      bin: 'bun' },
          { name: 'pip',      bin: OSAbstraction.isWin ? 'pip' : 'pip3' },
          { name: 'uv',       bin: 'uv' },
          { name: 'cargo',    bin: 'cargo' },
          { name: 'composer',  bin: 'composer' },
          { name: 'dotnet',   bin: 'dotnet' },
        ];
        for (const pm of pmChecks) {
          const ver = OSAbstraction.getVersion(pm.bin);
          if (ver) {
            console.log(`  ${co(C.bGreen, '✓')} ${pm.name.padEnd(10)} ${ver.version}`);
          }
        }

        // Show project detection
        const detected = pluginRegistry.detectLanguages(dir);
        if (detected.length > 0) {
          console.log(co(C.bold, "\n  Detected in Current Project\n"));
          for (const p of detected) {
            console.log(`  ${co(C.bCyan, '→')} ${p.displayName}`);
          }
        } else {
          console.log(co(C.dim, "\n  No languages detected in current directory.\n"));
        }

        console.log(co(C.dim, "\n  /env check   — detailed compatibility check"));
        console.log(co(C.dim, "  /env setup   — set up environment (venv, deps)"));
        console.log(co(C.dim, "  /env versions — latest stable package versions\n"));

      } else if (sub === "check") {
        const dir = parts[2] ? path.resolve(SESSION.cwd, parts[2]) : SESSION.cwd;
        const reports = pluginRegistry.checkAllEnvironments(dir);
        if (reports.length === 0) {
          console.log(co(C.dim, "\n  No known languages detected in this project.\n"));
          console.log(co(C.dim, "  Tip: Use /env to see all installed runtimes system-wide.\n"));
        } else {
          console.log(co(C.bold, "\n  Environment Check\n"));
          console.log(pluginRegistry.formatEnvReport(reports));
          SESSION._envCheck = reports;
        }
        console.log();
      } else if (sub === "setup") {
        const dir = SESSION.cwd;
        const detected = pluginRegistry.detectLanguages(dir);
        if (detected.length === 0) {
          console.log(co(C.dim, "\n  No languages detected.\n"));
        } else {
          for (const plugin of detected) {
            console.log(co(C.bold, `\n  Setting up ${plugin.displayName}...`));
            const result = plugin.setupEnvironment(dir);
            for (const step of result.steps) {
              const icon = step.success !== false ? co(C.bGreen, "✓") : co(C.bRed, "✗");
              console.log(`  ${icon} ${step.action}: ${step.command || step.path || ""}`);
            }
            if (result.activateCmd) {
              if (!SESSION._envSetup) SESSION._envSetup = {};
              SESSION._envSetup[plugin.id] = { activateCmd: result.activateCmd, venvPath: result.venvPath };
              console.log(co(C.bGreen, `  Venv: ${result.venvPath}`));
            }
          }
          console.log();
        }
      } else if (sub === "versions") {
        console.log(co(C.bold, "\n  Resolving latest versions...\n"));
        (async () => {
          const block = await pluginRegistry.getVersionBlock();
          console.log(block || co(C.dim, "  No versions resolved."));
          console.log();
        })();
      } else if (sub === "update") {
        console.log(co(C.bold, "\n  Refreshing version cache...\n"));
        (async () => {
          const count = await pluginRegistry.versionResolver.refreshAll();
          console.log(co(C.bGreen, `  Refreshed ${count} cached versions.\n`));
        })();
      } else {
        console.log(co(C.bold, "\n  /env commands:\n"));
        console.log("  /env              Show environment for current project");
        console.log("  /env check        Run full environment check");
        console.log("  /env setup        Set up environment (venv, deps)");
        console.log("  /env versions     Show latest stable versions");
        console.log("  /env update       Refresh version cache from registries");
        console.log();
      }
      return null;
    }

    case "/skills": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "list") {
        console.log(co(C.bold, "\n  Skills:\n"));
        const globalSkills = [];
        const localSkills = [];
        try { for (const f of fs.readdirSync(SKILLS_DIR)) { if (f.endsWith(".md")) globalSkills.push(f); } } catch (err) { debugLog(err.message); }
        try { for (const f of fs.readdirSync(path.join(SESSION.cwd, ".attar-code", "skills"))) { if (f.endsWith(".md")) localSkills.push(f); } } catch (err) { debugLog(err.message); }
        if (globalSkills.length === 0 && localSkills.length === 0) {
          console.log(co(C.dim, "  No skills installed. Use /skills add <name> to create one.\n"));
        } else {
          for (const s of globalSkills) {
            const content = fs.readFileSync(path.join(SKILLS_DIR, s), "utf-8");
            const desc = content.split("\n").find(l => l.trim() && !l.startsWith("#"))?.slice(0, 60) || "";
            console.log(`  ${co(C.bYellow, "global")} ${co(C.bold, s.replace(".md",""))} ${co(C.dim, desc)}`);
          }
          for (const s of localSkills) {
            console.log(`  ${co(C.bCyan, "local")}  ${co(C.bold, s.replace(".md",""))}`);
          }
        }
        console.log();
      } else if (sub === "show" && parts[2]) {
        const name = parts[2];
        const content = loadSkill(name);
        if (content) {
          console.log(co(C.bold, `\n  Skill: ${name}\n`));
          console.log(co(C.dim, content.slice(0, 2000)));
          if (content.length > 2000) console.log(co(C.dim, `\n  ... (${content.length} chars total)`));
          console.log();
        } else {
          console.log(co(C.bRed, `\n  Skill "${name}" not found.\n`));
        }
      } else if (sub === "add" && parts[2]) {
        const name = parts[2];
        const skillPath = path.join(SKILLS_DIR, `${name}.md`);
        if (fs.existsSync(skillPath)) {
          console.log(co(C.bYellow, `\n  Skill "${name}" already exists. Use /skills edit ${name} to modify.\n`));
        } else {
          const template = `# ${name} Skill\n# trigger: ${name}\n\nAdd your expert knowledge, best practices, and rules here.\nThis content will be injected into the system prompt when the trigger pattern matches.\n\n## Rules\n- Rule 1\n- Rule 2\n\n## Best Practices\n- Practice 1\n- Practice 2\n`;
          fs.writeFileSync(skillPath, template);
          console.log(co(C.bGreen, `\n  ✓ `) + `Skill "${name}" created at: ${skillPath}`);
          console.log(co(C.dim, `  Edit the file to add your expert knowledge.`));
          console.log(co(C.dim, `  The # trigger: line defines when this skill activates.\n`));
        }
      } else if (sub === "remove" && parts[2]) {
        const name = parts[2];
        const skillPath = path.join(SKILLS_DIR, `${name}.md`);
        if (fs.existsSync(skillPath)) {
          fs.unlinkSync(skillPath);
          console.log(co(C.bGreen, `\n  ✓ `) + `Skill "${name}" removed.\n`);
        } else {
          console.log(co(C.bRed, `\n  Skill "${name}" not found.\n`));
        }
      } else if (sub === "edit" && parts[2]) {
        const name = parts[2];
        const skillPath = path.join(SKILLS_DIR, `${name}.md`);
        if (fs.existsSync(skillPath)) {
          console.log(co(C.dim, `\n  Skill file: ${skillPath}`));
          console.log(co(C.dim, `  Open this file in your editor to modify it.\n`));
        } else {
          console.log(co(C.bRed, `\n  Skill "${name}" not found. Use /skills add ${name} first.\n`));
        }
      } else if (sub === "active") {
        if (!SESSION._injectedSkills || SESSION._injectedSkills.size === 0) {
          console.log(co(C.dim, "\n  No skills active in this session.\n"));
        } else {
          console.log(co(C.bold, "\n  Active Skills (injected this session):\n"));
          for (const name of SESSION._injectedSkills) {
            console.log(`  ${co(C.bGreen, "✓")} ${name}`);
          }
          console.log();
        }
      } else {
        console.log(co(C.bold, "\n  Skills System:\n"));
        console.log(co(C.dim, "  /skills list           — Show all installed skills"));
        console.log(co(C.dim, "  /skills show <name>    — View skill content"));
        console.log(co(C.dim, "  /skills add <name>     — Create a new skill"));
        console.log(co(C.dim, "  /skills remove <name>  — Delete a skill"));
        console.log(co(C.dim, "  /skills edit <name>    — Show file path to edit"));
        console.log(co(C.dim, "  /skills active         — Show skills used this session"));
        console.log();
        console.log(co(C.dim, "  Skills are .md files in ~/.attar-code/skills/"));
        console.log(co(C.dim, "  Project skills: .attar-code/skills/ (overrides global)"));
        console.log(co(C.dim, "  Add '# trigger: regex_pattern' to auto-activate on matching prompts.\n"));
      }
      break;
    }

    case "/errors": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "list") {
        console.log(co(C.bold, "\n  Error Patterns:\n"));
        try {
          const files = fs.readdirSync(ERROR_PATTERNS_DIR).filter(f => f.endsWith(".json"));
          let total = 0;
          for (const f of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(ERROR_PATTERNS_DIR, f), "utf-8"));
              const count = data.patterns?.length || 0;
              total += count;
              const active = SESSION._lastDetectedTech && (
                f === "general.json" ||
                (SESSION._lastDetectedTech.includes("Node") && (f === "typescript.json" || f === "nodejs.json")) ||
                (SESSION._lastDetectedTech === "Python" && f === "python.json") ||
                (SESSION._lastDetectedTech === "Go" && f === "go.json") ||
                (SESSION._lastDetectedTech === "Rust" && f === "rust.json") ||
                (SESSION._lastDetectedTech.includes("Java") && f === "java.json")
              );
              console.log(`  ${active ? co(C.bGreen, "●") : co(C.dim, "○")} ${co(C.bold, f.replace(".json","").padEnd(15))} ${count} patterns ${active ? co(C.bGreen, "(active)") : ""}`);
            } catch (_) { console.log(`  ${co(C.bRed, "✗")} ${f} (invalid JSON)`); }
          }
          console.log(co(C.dim, `\n  Total: ${total} patterns`));
          console.log(co(C.dim, `  Location: ${ERROR_PATTERNS_DIR}\n`));
        } catch (_) { console.log(co(C.dim, "  No pattern files found.\n")); }
      } else if (sub === "reload") {
        SESSION._errorPatterns = null;
        console.log(co(C.bGreen, "\n  ✓ ") + "Error pattern cache cleared. Will reload on next build.\n");
      } else if (sub === "test" && parts.slice(2).join(" ")) {
        const testMsg = parts.slice(2).join(" ");
        console.log(co(C.bold, `\n  Testing: "${testMsg}"\n`));
        const projectType = SESSION._lastDetectedTech || "";
        const patterns = loadErrorPatternsExternal(projectType);
        let found = false;
        if (patterns) {
          for (const p of patterns) {
            const match = testMsg.match(p._compiledMatch);
            if (match) {
              const rx = diagnoseFromExternalPattern(p, match, [], "", "");
              console.log(co(C.bGreen, `  ✓ Matched: `) + co(C.bold, p.id) + co(C.dim, ` (${p._source})`));
              console.log(co(C.dim, `  Cause: ${rx.rootCause}`));
              console.log(co(C.dim, `  Fix: ${rx.prescription}`));
              if (rx.codeBlock) console.log(co(C.dim, `  Code:\n${rx.codeBlock}`));
              found = true;
              break;
            }
          }
        }
        if (!found) {
          // Try hardcoded fallback
          for (const [key, pattern] of Object.entries(ERROR_PATTERNS)) {
            const match = testMsg.match(pattern.match);
            if (match) {
              const rx = pattern.diagnose(match, [], "", "");
              console.log(co(C.bGreen, `  ✓ Matched: `) + co(C.bold, key) + co(C.dim, " (hardcoded)"));
              console.log(co(C.dim, `  Cause: ${rx.rootCause}`));
              console.log(co(C.dim, `  Fix: ${rx.prescription}`));
              found = true;
              break;
            }
          }
        }
        if (!found) console.log(co(C.bYellow, "  No pattern matched this error.\n"));
        console.log();
      } else {
        console.log(co(C.bold, "\n  Error Patterns:\n"));
        console.log(co(C.dim, "  /errors list     — Show all installed patterns"));
        console.log(co(C.dim, "  /errors reload   — Clear pattern cache"));
        console.log(co(C.dim, "  /errors test <msg> — Test which pattern matches an error"));
        console.log(co(C.dim, `\n  Patterns dir: ${ERROR_PATTERNS_DIR}\n`));
      }
      break;
    }

    case "/hooks": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "list") {
        if (!hookEngine) { console.log(co(C.dim, "\n  No hooks loaded.\n")); break; }
        const active = hookEngine.getActiveHooks();
        if (active.length === 0) { console.log(co(C.dim, "\n  No hooks configured.\n")); break; }
        console.log(co(C.bold, "\n  Active Hooks:\n"));
        for (const h of active) {
          console.log(`  ${co(C.bYellow, pad(h.event, 20))} ${co(C.dim, h.matcher.padEnd(15))} ${h.command}${h.async ? co(C.dim, " (async)") : ""}`);
        }
        console.log();
      } else if (sub === "reload") {
        if (hookEngine) hookEngine.loadHooks();
        else initHookEngine();
        const count = hookEngine ? hookEngine.getActiveHooks().length : 0;
        console.log(co(C.bGreen, "\n  ✓ ") + `Reloaded hooks (${count} active)\n`);
      } else if (sub === "templates") {
        console.log(co(C.bold, "\n  Hook Templates:\n"));
        console.log(co(C.dim, "  Add to ~/.attar-code/config.json under \"hooks\":\n"));
        console.log(co(C.bYellow, "  block-destructive") + co(C.dim, " — Block rm -rf, drop table, etc."));
        console.log(co(C.bYellow, "  auto-format")      + co(C.dim, " — Run prettier after edits"));
        console.log(co(C.bYellow, "  auto-test")        + co(C.dim, " — Run tests after implementation"));
        console.log(co(C.bYellow, "  audit-log")         + co(C.dim, " — Log all tool calls to file"));
        console.log();
        console.log(co(C.dim, "  Example config:"));
        console.log(co(C.dim, '  {"hooks":{"PreToolUse":[{"matcher":"run_bash","hooks":[{"type":"command","command":"./check.sh"}]}]}}'));
        console.log();
      } else {
        console.log(co(C.bold, "\n  Hooks System:\n"));
        console.log(co(C.dim, "  /hooks list      — Show active hooks"));
        console.log(co(C.dim, "  /hooks reload    — Reload hooks from config"));
        console.log(co(C.dim, "  /hooks templates — Show hook examples"));
        console.log();
        const count = hookEngine ? hookEngine.getActiveHooks().length : 0;
        console.log(co(C.dim, `  ${count} hooks active\n`));
      }
      break;
    }

    case "/tools":
      console.log(co(C.bold, "\n  Tools:\n"));
      for (const t of TOOLS) {
        const fn = t.function;
        console.log("  " + co(C.bYellow, pad("  " + fn.name, 26)) + co(C.dim, fn.description.slice(0,50)));
      }
      console.log(); break;

    case "/commands": {
      const customs2 = loadCustomCommands();
      const keys = Object.keys(customs2);
      if (!keys.length) {
        console.log(co(C.dim, `\n  No custom commands. Add .md files to: ${CMDS_DIR}\n`));
      } else {
        console.log(co(C.bold, "\n  Custom Commands:\n"));
        for (const k of keys) console.log("  " + co(C.bGreen, pad(k, 20)) + co(C.dim, customs2[k].slice(0,50)));
        console.log();
      }
      break;
    }

    case "/kb": {
      const sub = parts[1]?.toLowerCase();

      if (sub === "add") {
        // Parse: /kb add <file|url> [collection] [--deep]
        // Examples: /kb add book.pdf nodejs
        //           /kb add book.pdf --collection python --deep
        //           /kb add https://docs.xyz.com rust
        const rawArgs = parts.slice(2);
        let fp = "";
        let collection = null;
        let deep = false;

        // Check for flags and collection name
        const KNOWN_COLLECTIONS = new Set(["fix_recipes","nodejs","python","go","rust","java","csharp","php","ruby","swift","css_html","devops","databases","general","personal"]);
        for (let ai = 0; ai < rawArgs.length; ai++) {
          if (rawArgs[ai] === "--collection" && rawArgs[ai + 1]) {
            collection = rawArgs[ai + 1]; ai++; // skip next
          } else if (rawArgs[ai] === "--deep") {
            deep = true;
          } else if (KNOWN_COLLECTIONS.has(rawArgs[ai]) && ai === rawArgs.length - 1) {
            collection = rawArgs[ai]; // last arg is a collection name
          } else if (KNOWN_COLLECTIONS.has(rawArgs[ai]) && rawArgs[ai + 1] === "--deep") {
            collection = rawArgs[ai]; // collection before --deep
          } else {
            fp += (fp ? " " : "") + rawArgs[ai];
          }
        }

        if (!fp) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /kb add <file|url> [collection] [--deep]\n  Collections: " + [...KNOWN_COLLECTIONS].join(", ") + "\n  --deep: LLM-enriched chunks (slower, better search quality)\n"); break; }

        const body = { filepath: fp };
        if (collection) body.collection = collection;
        if (deep) body.deep = true;
        const collNote = collection ? ` (→ ${collection})` : " (auto-detected)";
        const deepNote = deep ? " [deep enrichment]" : "";

        // Detect URL vs file path
        if (/^https?:\/\//i.test(fp)) {
          console.log(co(C.dim, `\n  Ingesting URL into knowledge base${collNote}${deepNote}...\n`));
          const urlBody = { url: fp };
          if (collection) urlBody.collection = collection;
          if (deep) urlBody.deep = true;
          const res = await proxyPost("/kb/ingest-url", urlBody, 0);
          if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
          console.log(co(C.bGreen, "  ✓ ") + `Ingested URL: ${fp} → ${res.chunks_stored || res.chunks || "?"} chunks in ${res.collection || "auto"}${collNote}\n`);
        } else {
          console.log(co(C.dim, `\n  Adding to knowledge base${collNote}${deepNote}...\n`));
          if (deep) console.log(co(C.bYellow, "  ⚡ Deep enrichment: LLM generates context for each chunk (~2-3s per chunk)\n"));
          const res = await proxyPost("/kb/ingest", body, 0);
          if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
          console.log(co(C.bGreen, "  ✓ ") + `Added: ${res.title || fp} → ${res.chunks_stored || res.chunks || "?"} chunks in "${res.collection || "auto"}"${collection ? "" : " (auto-detected)"}${deep ? " (deep enriched)" : ""}\n`);
        }

      } else if (sub === "add-dir") {
        const rawArgs = parts.slice(2);
        let dirPath = "";
        let deep = false;
        for (const a of rawArgs) {
          if (a === "--deep") deep = true;
          else dirPath += (dirPath ? " " : "") + a;
        }
        if (!dirPath) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /kb add-dir <path> [--deep]\n"); break; }
        const deepNote = deep ? " [deep enrichment]" : "";
        console.log(co(C.dim, `\n  Bulk ingesting directory${deepNote}...\n`));
        if (deep) console.log(co(C.bYellow, "  ⚡ Deep enrichment: LLM generates context for each chunk (~2-3s per chunk)\n"));
        const body = { dirpath: dirPath };
        if (deep) body.deep = true;
        const res = await proxyPost("/kb/ingest-dir", body, 0);
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        const fileCount = res.indexed || res.ingested || 0;
        const chunkCount = res.details ? res.details.reduce((s, d) => s + (d.chunks_stored || 0), 0) : (res.chunks || 0);
        console.log(co(C.bGreen, "  ✓ ") + `Ingested: ${fileCount} files, ${chunkCount} chunks, Failed: ${res.failed || 0}${deep ? " (deep enriched)" : ""}\n`);

      } else if (sub === "search") {
        const query = parts.slice(2).join(" ");
        if (!query) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /kb search <query>\n"); break; }
        console.log(co(C.dim, `\n  Searching knowledge base for "${query}"...\n`));
        const res = await proxyPost("/kb/search", { query, num: 5 });
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        if (res.formatted) {
          console.log(res.formatted);
        } else if (!res.results?.length) {
          console.log(co(C.dim, "  No results found.\n"));
        } else {
          for (const r of res.results) {
            console.log(co(C.bYellow, `  [${r.rank || r.id || "?"}] `) + co(C.dim, r.filename || r.source || "?") + co(C.gray, ` score:${r.score}`));
            console.log(co(C.dim, "     ") + (r.text || r.content || "").slice(0, 200).replace(/\n/g, " ") + "\n");
          }
        }
        break;

      } else if (sub === "list") {
        const res = await proxyGet("/kb/list");
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        const docs = res.docs || [];
        console.log(co(C.bold, `\n  Knowledge Base (${res.total_chunks || 0} chunks):\n`));
        if (!docs.length) { console.log(co(C.dim, "  Empty. Add files with /kb add <file>\n")); break; }
        for (const d of docs) {
          console.log("  " + co(C.bYellow, "  • ") + co(C.white, d.filename) + co(C.dim, ` [${d.type}]`));
        }
        console.log();

      } else if (sub === "collections") {
        console.log(co(C.dim, "\n  Fetching collections...\n"));
        const res = await proxyGet("/kb/collections");
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        const cols = res.collections || [];
        if (!cols.length) { console.log(co(C.dim, "  No collections found.\n")); break; }
        console.log(co(C.bold, `\n  Collections (${cols.length}):\n`));
        for (const c of cols) {
          console.log("  " + co(C.bYellow, pad(c.name || c.id || "?", 24)) + co(C.dim, `${c.count || c.size || 0} docs`) + (c.model ? co(C.gray, ` [${c.model}]`) : ""));
        }
        console.log();

      } else if (sub === "remove") {
        const name = parts.slice(2).join(" ");
        if (!name) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /kb remove <collection-name>\n"); break; }
        console.log(co(C.dim, `\n  Removing collection "${name}"...\n`));
        try {
          const r = await fetch(`${CONFIG.proxyUrl}/kb/collections/${encodeURIComponent(name)}`, { method: "DELETE", signal: AbortSignal.timeout(10000) });
          const res = await r.json();
          if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
          console.log(co(C.bGreen, "  ✓ ") + `Removed collection: ${name}\n`);
        } catch (e) { console.log(co(C.bRed, "  ✗ ") + `Failed: ${e.message}\n`); }

      } else if (sub === "stats") {
        console.log(co(C.dim, "\n  Fetching KB stats...\n"));
        const res = await proxyGet("/kb/status");
        if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
        const cols = res.collections || [];
        const totalDocs = cols.reduce((s, c) => s + (c.points_count || c.count || c.size || 0), 0);
        console.log(co(C.bold, "\n  KB Statistics:\n"));
        console.log("  " + co(C.dim, "Collections: ") + co(C.white, String(cols.length)));
        console.log("  " + co(C.dim, "Total docs:  ") + co(C.white, String(totalDocs)));
        if (res.qdrant) console.log("  " + co(C.dim, "Qdrant:      ") + co(C.white, res.qdrant.running ? "running" : "stopped"));
        if (res.models) {
          if (res.models.codeModel) console.log("  " + co(C.dim, "Code model:  ") + co(C.white, res.models.codeModel));
          if (res.models.textModel) console.log("  " + co(C.dim, "Text model:  ") + co(C.white, res.models.textModel));
        }
        console.log();

      } else if (sub === "reindex") {
        console.log(co(C.dim, "\n  Re-indexing all files...\n"));
        const res = await proxyPost("/kb/reindex", {});
        console.log(co(C.bGreen, "  ✓ ") + `Indexed: ${res.indexed}, Failed: ${res.failed}\n`);

      } else if (sub === "status" || !sub) {
        // /kb or /kb status → show KB status overview
        console.log(co(C.dim, "\n  Fetching KB status...\n"));
        try {
          const res = await proxyGet("/kb/status");
          if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
          const cols = res.collections || [];
          console.log(co(C.bold, "\n  Knowledge Base Status:\n"));
          if (res.qdrant) {
            console.log("  " + co(C.dim, "Qdrant: ") + (res.qdrant.running ? co(C.bGreen, "running") : co(C.bRed, "stopped")));
          }
          if (res.models) {
            if (res.models.codeModel) console.log("  " + co(C.dim, "Code model: ") + co(C.white, res.models.codeModel));
            if (res.models.textModel) console.log("  " + co(C.dim, "Text model: ") + co(C.white, res.models.textModel));
          }
          if (cols.length > 0) {
            console.log(co(C.bold, `\n  Collections (${cols.length}):`));
            for (const c of cols) {
              const chunkCount = c.points_count || c.count || c.size || 0;
              console.log("    " + co(C.bYellow, pad(c.name || c.id || "?", 22)) + (chunkCount > 0 ? co(C.bGreen, `${chunkCount} chunks`) : co(C.dim, "empty")));
            }
          } else {
            console.log(co(C.dim, "  No collections. Add files with /kb add <file>"));
          }
          console.log();
        } catch (e) {
          console.log(co(C.bRed, "  ✗ ") + `Cannot connect to search-proxy: ${e.message}\n`);
        }

      } else {
        console.log(co(C.bold, "\n  /kb commands:\n"));
        console.log("  " + co(C.bGreen, pad("/kb",                 22)) + co(C.dim, "Show KB status (collections, models, storage)"));
        console.log("  " + co(C.bGreen, pad("/kb add <file> [col]", 24)) + co(C.dim, "Ingest file (auto-detect or specify collection)"));
        console.log("  " + co(C.bGreen, pad("/kb add <url> [col]",  24)) + co(C.dim, "Fetch URL and ingest into KB"));
        console.log("  " + co(C.bGreen, pad("/kb add-dir <path>",   24)) + co(C.dim, "Bulk ingest directory into KB"));
        console.log("  " + co(C.bGreen, pad("/kb search <query>",   24)) + co(C.dim, "Search KB (hybrid: semantic + keyword)"));
        console.log("  " + co(C.bGreen, pad("/kb collections",      24)) + co(C.dim, "List all collections with chunk counts"));
        console.log("");
        console.log(co(C.dim, "  Collections: nodejs, python, go, rust, java, csharp, php, ruby, swift,"));
        console.log(co(C.dim, "    css_html, devops, databases, general, personal, fix_recipes"));
        console.log(co(C.dim, "  Example: /kb add C:\\books\\express.pdf nodejs"));
        console.log("  " + co(C.bGreen, pad("/kb remove <name>",   22)) + co(C.dim, "Remove a collection"));
        console.log("  " + co(C.bGreen, pad("/kb stats",           22)) + co(C.dim, "Show retrieval metrics"));
        console.log("  " + co(C.bGreen, pad("/kb list",            22)) + co(C.dim, "List indexed documents (legacy)"));
        console.log("  " + co(C.bGreen, pad("/kb reindex",         22)) + co(C.dim, "Re-index all files in kb folder"));
        console.log(co(C.dim, `\n  Knowledge base folder: ${path.join(HOME_DIR, "knowledge")}\n`));
      }
      break;
    }

    case "/search": {
      const query = rest;
      if (!query) { console.log(co(C.bRed, "\n  ✗ ") + "Usage: /search <query>\n"); break; }
      console.log(co(C.dim, `\n  Searching web for "${query}"...\n`));
      const res = await proxyPost("/search", { query, num: 5 });
      if (res.error) { console.log(co(C.bRed, "  ✗ ") + res.error + "\n"); break; }
      for (const r of res.results || []) {
        console.log(co(C.bCyan, "  → ") + co(C.bold, r.title));
        console.log(co(C.dim,   "    ") + r.url);
        if (r.snippet) console.log(co(C.dim, "    ") + r.snippet.slice(0, 120));
        console.log();
      }
      break;
    }

    case "/proxy": {
      const proxyArg = rest.trim().toLowerCase();
      if (proxyArg === "start") {
        const ok = await ensureSearchProxy();
        if (ok) console.log(co(C.bGreen, "  ✓ Search-proxy is running"));
        else console.log(co(C.bRed, "  ✗ Failed to start search-proxy"));
      } else if (proxyArg === "stop") {
        // Force stop even if we didn't start it
        const wasManaged = _proxyStartedByUs;
        _proxyStartedByUs = true; // Allow stopSearchProxy to kill it
        stopSearchProxy();
        _proxyStartedByUs = wasManaged;
        // Also kill by port (cross-platform) in case process handle is lost
        try {
          if (IS_WIN) {
            execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3001 ^| findstr LISTENING\') do taskkill /F /PID %a', { stdio: "ignore", shell: true });
          } else {
            execSync("lsof -ti:3001 | xargs kill -9 2>/dev/null", { stdio: "ignore" });
          }
        } catch (_) {}
        console.log(co(C.dim, "  Search-proxy stopped"));
      } else if (proxyArg === "restart") {
        // Force stop
        _proxyStartedByUs = true;
        stopSearchProxy();
        try {
          if (IS_WIN) {
            execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3001 ^| findstr LISTENING\') do taskkill /F /PID %a', { stdio: "ignore", shell: true });
          } else {
            execSync("lsof -ti:3001 | xargs kill -9 2>/dev/null", { stdio: "ignore" });
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1500));
        const ok = await ensureSearchProxy();
        if (ok) console.log(co(C.bGreen, "  ✓ Search-proxy restarted"));
        else console.log(co(C.bRed, "  ✗ Failed to restart"));
      } else {
        // Default: show status
        const status = await getProxyStatus();
        console.log();
        if (status.running) {
          console.log(co(C.bGreen, "  ✓ Search-proxy: RUNNING"));
          console.log(co(C.dim, `    URL: ${status.url}`));
          console.log(co(C.dim, `    Managed by CLI: ${status.managedByUs ? "yes" : "no (external)"}`));
          console.log(co(C.dim, `    PID: ${status.pid}`));
          if (status.kbDocuments !== undefined) console.log(co(C.dim, `    KB documents: ${status.kbDocuments}`));
        } else {
          console.log(co(C.bRed, "  ✗ Search-proxy: NOT RUNNING"));
          console.log(co(C.dim, "    Start with: /proxy start"));
        }
        console.log();
        console.log(co(C.dim, "  Commands: /proxy start | stop | restart"));
        console.log();
      }
      break;
    }

    case "/exit":
    case "/quit":
    case "/q":
      saveSession();
      console.log("\n" + co(C.bCyan, "  ✦ ") + co(C.dim, "Goodbye bro. Stay 🔥\n"));
      process.exit(0);

    default: {
      // Fuzzy command matching
      const allCommands = ["/help","/model","/models","/cd","/clear","/save","/load",
        "/cp","/rewind","/checkpoints","/todo","/memory","/plan","/auto","/tools",
        "/hooks","/search","/kb","/temp","/ctx","/proxy","/exit","/quit"];

      const levenshtein = (a, b) => {
        const m = a.length, n = b.length;
        const dp = Array.from({length: m+1}, (_,i) => Array(n+1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++)
          for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        return dp[m][n];
      };

      const cmdBase = cmd.toLowerCase();
      const suggestions = allCommands
        .map(c => ({ cmd: c, dist: levenshtein(cmdBase, c) }))
        .filter(c => c.dist <= 2)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      if (suggestions.length > 0) {
        console.log(co(C.bYellow, `\n  Unknown command: ${cmd}`));
        console.log(co(C.dim, `  Did you mean: ${suggestions.map(s => co(C.bCyan, s.cmd)).join(", ")}?\n`));
      } else {
        console.log(co(C.bYellow, `\n  Unknown command: ${cmd}`) + co(C.dim, ". Type /help for available commands.\n"));
      }
      break;
    }
  }
}

function saveSession() {
  const f = path.join(SESSIONS_DIR, `${SESSION.id}.json`);
  fs.writeFileSync(f, JSON.stringify({ config: CONFIG, session: SESSION }, null, 2));
}

let _lastAutoSave = 0;
function autoSaveSession() {
  const now = Date.now();
  if (now - _lastAutoSave < 10000) return; // max once per 10s
  _lastAutoSave = now;
  try { saveSession(); } catch (err) { debugLog(err.message); }
}

// ══════════════════════════════════════════════════════════════════
// FILE PASTE DETECTION — extracted as reusable function
// Detects file paths in input, reads them, wraps content in [FILE:] tags.
// Used by both interactive mode and -p one-shot mode.
// ══════════════════════════════════════════════════════════════════
function processFilePaste(input) {
  let message = input;
  const filePatterns = input.match(/(?:^|\s)((?:\/|~\/|\.\/)[^\s]+\.[a-zA-Z0-9]+)/g);
  if (filePatterns) {
    for (let match of filePatterns) {
      match = match.trim();
      let filePath = match.startsWith("~") ? match.replace("~", os.homedir()) : match;
      filePath = path.isAbsolute(filePath) ? filePath : path.resolve(SESSION.cwd, filePath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const size = fs.statSync(filePath).size;
        if (size > 5 * 1024 * 1024) {
          message = message.replace(match, `[File: ${match} — too large (${(size/1048576).toFixed(1)}MB)]`);
          continue;
        }
        let fileContent = "";
        if ([".pdf"].includes(ext)) {
          try {
            const pyCode = `import sys,json\ntry:\n    import fitz\nexcept ImportError:\n    import subprocess;subprocess.check_call([sys.executable,"-m","pip","install","PyMuPDF","-q"]);import fitz\ndoc=fitz.open(${JSON.stringify(filePath)})\ntext="\\n".join([p.get_text() for p in doc])\nprint(json.dumps({"t":text[:4000]}))`;
            const tmp = path.join(os.tmpdir(), `ml_fp_${Date.now()}.py`);
            fs.writeFileSync(tmp, pyCode);
            const out = execSync(`${PYTHON} "${tmp}"`, { encoding:"utf-8", timeout:15000, stdio:["pipe","pipe","pipe"] });
            try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
            fileContent = JSON.parse(out).t;
          } catch(_) { fileContent = "[Could not read PDF]"; }
        } else if ([".docx"].includes(ext)) {
          try {
            const pyCode = `import sys,json\ntry:\n    from docx import Document\nexcept ImportError:\n    import subprocess;subprocess.check_call([sys.executable,"-m","pip","install","python-docx","-q"]);from docx import Document\ndoc=Document(${JSON.stringify(filePath)})\ntext="\\n".join([p.text for p in doc.paragraphs])\nprint(json.dumps({"t":text[:4000]}))`;
            const tmp = path.join(os.tmpdir(), `ml_fp_${Date.now()}.py`);
            fs.writeFileSync(tmp, pyCode);
            const out = execSync(`${PYTHON} "${tmp}"`, { encoding:"utf-8", timeout:15000, stdio:["pipe","pipe","pipe"] });
            try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
            fileContent = JSON.parse(out).t;
          } catch(_) { fileContent = "[Could not read DOCX]"; }
        } else if ([".xlsx",".xls"].includes(ext)) {
          try {
            const pyCode = `import sys,json\ntry:\n    import openpyxl\nexcept ImportError:\n    import subprocess;subprocess.check_call([sys.executable,"-m","pip","install","openpyxl","-q"]);import openpyxl\nwb=openpyxl.load_workbook(${JSON.stringify(filePath)},data_only=True)\nws=wb.active\nrows=[]\nfor row in ws.iter_rows(values_only=True):\n    rows.append([str(v) if v is not None else "" for v in row])\nprint(json.dumps({"t":"\\n".join([" | ".join(r) for r in rows[:100]])}))`;
            const tmp = path.join(os.tmpdir(), `ml_fp_${Date.now()}.py`);
            fs.writeFileSync(tmp, pyCode);
            const out = execSync(`${PYTHON} "${tmp}"`, { encoding:"utf-8", timeout:15000, stdio:["pipe","pipe","pipe"] });
            try { fs.unlinkSync(tmp); } catch (err) { debugLog(err.message); }
            fileContent = JSON.parse(out).t;
          } catch(_) { fileContent = "[Could not read Excel]"; }
        } else if ([".png",".jpg",".jpeg",".gif",".webp",".svg",".bmp"].includes(ext)) {
          fileContent = `[Image file: ${path.basename(filePath)} (${(size/1024).toFixed(1)}KB)]`;
        } else {
          try { fileContent = fs.readFileSync(filePath, "utf-8").slice(0, 4000); }
          catch(_) { fileContent = "[Could not read file]"; }
        }
        if (fileContent) {
          console.log(co(C.bCyan, `  📎 Attached: `) + co(C.dim, `${path.basename(filePath)} (${ext}, ${(size/1024).toFixed(1)}KB)`));
          message = message.replace(match, `\n\n[FILE: ${path.basename(filePath)}]\n${fileContent}\n[END FILE]\n\n`);
        }
      }
    }
  }
  return message;
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" || args[i] === "-m") { CONFIG.model = args[++i]; }
    if (args[i] === "--name"  || args[i] === "-n") { SESSION.name = args[++i]; }
    if (args[i] === "--auto")  { CONFIG.autoApprove = true; CONFIG.permissionMode = "autonomous"; }
    if (args[i] === "--temp")  { CONFIG.temperature = parseFloat(args[++i]); }
    if (args[i] === "--effort" || args[i] === "-e") {
      const level = args[++i];
      if (level === "low") CONFIG._effort = 0.3;
      else if (level === "high") CONFIG._effort = 1.0;
      else CONFIG._effort = 0.6; // medium (default)
    }
    if (args[i] === "--ctx")   { CONFIG.numCtx = parseInt(args[++i]); }
    if (args[i] === "--cwd"  || args[i] === "-d") {
      const target = args[++i];
      if (fs.existsSync(target)) { process.chdir(target); SESSION.cwd = process.cwd(); }
      else { console.log(`  ✗ Directory not found: ${target}`); process.exit(1); }
    }
    if (args[i] === "-p" || args[i] === "--prompt") {
      // Initialize smart-fix before one-shot mode (normally happens later in main())
      if (smartFix && !SESSION._depGraph) {
        try {
          SESSION._depGraph = smartFix.initSmartFix();
          SESSION._depGraph.autoDetectAndLoadPlugin(SESSION.cwd);
        } catch (_) {}
      }
      // Auto-start search-proxy for KB + web search
      await ensureSearchProxy();
      // One-shot mode — run file paste detection first (same as interactive)
      let prompt = args[++i];
      prompt = processFilePaste(prompt);
      await chat(prompt);
      process.exit(0);
    }
  }

  // Auto-detect model from Ollama if not set
  if (!CONFIG.model) {
    try {
      const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
      const data = await res.json();
      if (data.models?.length) {
        CONFIG.model = data.models[0].name;
        saveConfig();
        console.log(co(C.bGreen, `  ✓ Auto-detected model: ${CONFIG.model}`));
      } else {
        console.log(co(C.bRed, "  ✗ No models installed. Run: ollama pull llama3.2"));
        process.exit(1);
      }
    } catch (_) {
      console.log(co(C.bRed, "  ✗ Cannot connect to Ollama. Run: ollama serve"));
      process.exit(1);
    }
  }

  // Warn if CWD is attar-code's own install directory
  if (path.resolve(SESSION.cwd) === path.resolve(__dirname)) {
    console.log();
    console.log(co(C.bYellow, "  ⚠ You are running attar-code from its own directory."));
    console.log(co(C.dim,     "    Files created by the AI will go here. To work in a different project:"));
    console.log(co(C.cyan,    "    • Use /cd <path>  inside attar-code"));
    console.log(co(C.cyan,    "    • Or run: node attar-code.js --cwd /path/to/project"));
    console.log(co(C.cyan,    "    • Or: cd /your/project && node ~/Desktop/Attar-Cli/attar-code.js"));
    console.log();
  }

  printBanner();

  // Auto-start search-proxy (KB + web search + Qdrant)
  await ensureSearchProxy();

  initHookEngine();
  if (hookEngine) hookEngine.fire("SessionStart", { trigger: "startup", cwd: process.cwd(), session_id: SESSION.id }).catch(err => debugLog(err.message));

  // Initialize smart-fix dependency tree
  if (smartFix) {
    try {
      SESSION._depGraph = smartFix.initSmartFix();
      debugLog("Smart-fix dependency tree initialized");
    } catch (err) { debugLog("Smart-fix init failed: " + err.message); }
  }

  // Load checkpoint history from disk
  try {
    const cpFiles = fs.readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith(".json")).sort();
    for (const f of cpFiles.slice(-20)) { // Load last 20
      try {
        const cpData = JSON.parse(fs.readFileSync(path.join(CHECKPOINTS_DIR, f), "utf-8"));
        // Only load metadata, not full file contents (lazy load on rewind)
        if (!SESSION.checkpoints.find(c => c.id === cpData.id)) {
          SESSION.checkpoints.push({
            id: cpData.id, label: cpData.label, time: cpData.time,
            files: cpData.files || {}, // keep files for rewind
            messageCount: cpData.messageCount, cwd: cpData.cwd,
            messages: cpData.messages, todoList: cpData.todoList,
            _fromDisk: true,
          });
        }
      } catch (err) { debugLog(err.message); }
    }
    if (SESSION.checkpoints.length > 0) {
      debugLog(`Loaded ${SESSION.checkpoints.length} checkpoints from history`);
    }
  } catch (err) { debugLog(err.message); }
  pruneCheckpoints();

  // Check Ollama
  try {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
    const data = await res.json();
    const models = (data.models||[]).map(m=>m.name);
    if (!models.includes(CONFIG.model)) {
      console.log(co(C.bYellow, `  ⚠ Model "${CONFIG.model}" not found locally.`));
      console.log(co(C.dim, `  Run: `) + co(C.yellow, `ollama pull ${CONFIG.model}\n`));
    }
  } catch (err) {
    debugLog("Ollama check error:", err.message);
    console.log(co(C.bRed, "  ✗ Ollama not running. Start it: ") + co(C.yellow, "ollama serve\n"));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line) => {
      // All slash commands
      const allCommands = [
        "/help", "/model", "/models", "/cd", "/clear", "/save", "/load",
        "/cp", "/rewind", "/checkpoints", "/todo", "/memory", "/plan",
        "/auto", "/tools", "/hooks", "/skills", "/outputs", "/errors",
        "/search", "/kb", "/exit", "/quit", "/diff", "/effort",
      ];

      if (!line.startsWith("/")) return [[], line];

      const parts = line.split(" ");
      const cmd = parts[0];
      const sub = parts[1] || "";

      // Subcommand completion
      const subcommands = {
        "/skills": ["list", "show", "add", "remove", "edit", "active"],
        "/plan": ["status", "off"],
        "/todo": ["add", "done"],
        "/memory": ["set"],
        "/hooks": ["list", "reload", "templates"],
        "/errors": ["list", "reload", "test"],
        "/kb": ["add", "add-dir", "search", "list", "collections", "remove", "stats", "status", "reindex"],
        "/effort": ["low", "medium", "high"],
        "/auto": ["on", "off"],
      };

      if (parts.length > 1 && subcommands[cmd]) {
        const subs = subcommands[cmd].filter(s => s.startsWith(sub));
        return [subs.map(s => `${cmd} ${s}`), line];
      }

      // Command completion
      const hits = allCommands.filter(c => c.startsWith(line));
      return [hits.length ? hits : allCommands, line];
    },
  });

  const prompt = () => {
    const cwd  = SESSION.cwd.replace(os.homedir(),"~");
    const name = SESSION.name ? co(C.dim, `(${SESSION.name}) `) : "";
    rl.setPrompt(`\n${name}${co(C.bGreen,"  ❯ ")}${co(C.green, cwd)}${co(C.bGreen," ❯❯ ")}${C.bWhite}`);
    rl.prompt();
  };

  prompt();

  rl.on("line", async (input) => {
    input = input.trim();
    if (!input) { prompt(); return; }

    // Handle permission response
    if (pendingApproval) {
      const resolve = pendingApproval;
      pendingApproval = null;
      if (input.toLowerCase() === "always") { CONFIG.autoApprove = true; CONFIG.permissionMode = "autonomous"; saveConfig(); resolve(true); }
      else { resolve(input.toLowerCase() === "y"); }
      prompt(); return;
    }

    if (input.startsWith("/") || input.startsWith("!")) {
      await handleCommand(input);
    } else {
      // ── Step 1: File paste detection FIRST ────────────────────────
      let message = processFilePaste(input);

      // ── UserPromptSubmit hook — can block or inject context ──
      if (hookEngine) {
        try {
          const promptHook = await hookEngine.fire("UserPromptSubmit", {
            session_id: SESSION.id, cwd: SESSION.cwd,
            prompt: message, model: CONFIG.model,
          });
          if (promptHook.blocked) {
            console.log(co(C.bRed, "\n  ⊘ Prompt blocked: ") + co(C.dim, promptHook.reason || "by hook"));
            prompt(); return;
          }
          // Inject additional context from hook output
          if (promptHook.output) {
            message += `\n\n[Hook context]: ${promptHook.output}`;
          }
        } catch (err) { debugLog(err.message); }
      }

      // ── Step 3: Full model chat ────────────────────────────────
      if (SESSION.planMode && SESSION.plan) {
        await chat(`[Plan mode] ${message}`);
      } else {
        await chat(message);
      }
    }

    prompt();
  });

  rl.on("close", () => {
    gracefulShutdown("close");
  });
}

// ══════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — ensures cleanup on exit
// ══════════════════════════════════════════════════════════════════
let _shutdownCalled = false;
async function gracefulShutdown(signal) {
  if (_shutdownCalled) return;
  _shutdownCalled = true;

  debugLog(`Shutdown initiated: ${signal}`);

  // Fire SessionEnd hook
  if (hookEngine) {
    try {
      await hookEngine.fire("SessionEnd", { trigger: signal, cwd: SESSION.cwd, session_id: SESSION.id });
    } catch (err) { debugLog("SessionEnd hook error:", err.message); }
  }

  // Stop search-proxy if we started it
  stopSearchProxy();

  // Kill any background server processes
  if (SESSION._serverProcess) {
    try { SESSION._serverProcess.kill(); }
    catch (err) { debugLog("Server kill error:", err.message); }
  }

  // Persist memory data before exit
  if (workingMemory && memoryFileStore) {
    const corrections = workingMemory.getCorrections();
    if (corrections.length > 0) {
      memoryFileStore.setProject('lastCorrections', corrections.map(c => c.text));
    }
  }
  if (smartFixBridge && memoryFileStore) {
    memoryFileStore.setProject('error_trends', smartFixBridge.exportTrends());
  }

  // Sync extractions to Qdrant (async but we await briefly before exit)
  if (memoryFileStore) {
    try {
      const syncResult = await memoryFileStore.syncToQdrant(CONFIG.proxyUrl || 'http://localhost:3001');
      if (syncResult.synced > 0) {
        debugLog(`Memory sync: ${syncResult.synced} extractions archived to Qdrant`);
      }
      memoryFileStore.clearWorking(); // Clear session file after successful sync
    } catch (_) {
      // Non-fatal — working.json stays for next session retry
    }
  }

  // Auto-save session
  try { saveSession(); }
  catch (err) { debugLog("Session save error:", err.message); }

  console.log("\n" + co(C.bCyan,"  ✦ ") + co(C.dim,"Goodbye bro. 🔥\n"));
  process.exit(0);
}

// Process-level signal handlers
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error(co(C.bRed, "\n  FATAL: ") + err.message);
  debugLog("Uncaught exception stack:", err.stack);
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  debugLog("Unhandled rejection:", reason);
});

main().catch(console.error);
