const fs = require("fs");
const os = require("os");
const path = require("path");
const { FixLearner } = require("../fix-engine/fix-learner");

describe("Stage 6 Verification: Feedback Loop", () => {
  const tmpFile = path.join(os.tmpdir(), "verify-learner-" + Date.now() + ".jsonl");

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    try { fs.unlinkSync(path.join(os.homedir(), ".attar-code", "promoted-strategies.json")); } catch (_) {}
  });

  test("cross-session: learns from past TypeScript fixes", () => {
    const data = Array.from({ length: 10 }, (_, i) => JSON.stringify({
      errorCode: "TS2304", strategy: "add_import", language: "TypeScript",
      file: "f" + i + ".ts", passed: true, confidence: 0.85,
    })).join("\n") + "\n";
    fs.writeFileSync(tmpFile, data);
    const learner = new FixLearner(tmpFile);
    const fix = learner.getSimilarSuccessfulFix("TS2304", {}, "TypeScript");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import");
  });

  test("cross-session: learns from past Python fixes", () => {
    const data = [
      { errorCode: "PY_IMPORT", strategy: "add_import", language: "Python", passed: true },
      { errorCode: "PY_IMPORT", strategy: "update_path", language: "Python", passed: false },
    ].map(o => JSON.stringify(o)).join("\n") + "\n";
    fs.writeFileSync(tmpFile, data);
    const learner = new FixLearner(tmpFile);
    const fix = learner.getSimilarSuccessfulFix("PY_IMPORT", {}, "Python");
    expect(fix).not.toBeNull();
    expect(fix.strategy).toBe("add_import");
  });

  test("promotion after 5 consecutive successes", () => {
    const learner = new FixLearner(tmpFile);
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ errorCode: "TS2551", strategy: "apply_compiler_hint", language: "TypeScript", file: "f" + i + ".ts", passed: true, confidence: 0.95 });
    }
    const promoted = learner.getPromotedStrategies("TypeScript");
    expect(promoted["TS2551"]).toBe("apply_compiler_hint");
  });

  test("promotion persists to disk and reloads", () => {
    const learner1 = new FixLearner(tmpFile);
    for (let i = 0; i < 5; i++) {
      learner1.recordOutcome({ errorCode: "E0308", strategy: "cast_type", language: "Rust", file: "f" + i + ".rs", passed: true, confidence: 0.9 });
    }
    const learner2 = new FixLearner(tmpFile);
    expect(learner2.getPromotedStrategies("Rust")["E0308"]).toBe("cast_type");
  });

  test("no promotion after mixed results", () => {
    const learner = new FixLearner(tmpFile);
    for (let i = 0; i < 3; i++) {
      learner.recordOutcome({ errorCode: "GO_ERR", strategy: "add_import", language: "Go", file: "f" + i + ".go", passed: true, confidence: 0.8 });
    }
    learner.recordOutcome({ errorCode: "GO_ERR", strategy: "add_import", language: "Go", file: "f3.go", passed: false, confidence: 0.5 });
    learner.recordOutcome({ errorCode: "GO_ERR", strategy: "add_import", language: "Go", file: "f4.go", passed: true, confidence: 0.8 });
    const promoted = learner.getPromotedStrategies("Go");
    expect(promoted["GO_ERR"]).toBeUndefined();
  });

  test("handles corrupted JSONL gracefully", () => {
    fs.writeFileSync(tmpFile, '{"valid":true}\n{broken json\n{"also":"valid"}\n');
    const learner = new FixLearner(tmpFile);
    expect(learner.recentOutcomes.length).toBe(2);
  });

  test("caps at 500 most recent outcomes", () => {
    const data = Array.from({ length: 600 }, (_, i) => JSON.stringify({ errorCode: "E" + i, passed: true })).join("\n") + "\n";
    fs.writeFileSync(tmpFile, data);
    const learner = new FixLearner(tmpFile);
    expect(learner.recentOutcomes.length).toBe(500);
    expect(learner.recentOutcomes[0].errorCode).toBe("E100");
  });
});
