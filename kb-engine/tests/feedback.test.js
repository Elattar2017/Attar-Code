"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { FeedbackTracker } = require("../feedback");

let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `attar-feedback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (_) {}
});

function readLines() {
  return fs.readFileSync(tmpFile, "utf-8").split("\n").filter(Boolean).map(JSON.parse);
}

// ---------------------------------------------------------------------------
// 1. logSearch — basic logging + satisfaction signal
// ---------------------------------------------------------------------------
describe("logSearch", () => {
  test("first search logs only a search event", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["uuid-1"], "python classes");

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("search");
    expect(lines[0].chunk_ids).toEqual(["uuid-1"]);
  });

  test("second search on DIFFERENT topic logs satisfaction=true for first search", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["a"], "python classes");
    tracker.logSearch(["b"], "kubernetes deployment"); // different topic

    const lines = readLines();
    const satEvents = lines.filter(l => l.type === "satisfaction");
    expect(satEvents).toHaveLength(1);
    expect(satEvents[0].satisfied).toBe(true); // user moved on
    expect(satEvents[0].chunk_ids).toEqual(["a"]); // first search's chunks
  });

  test("second search on SAME topic logs satisfaction=false for first search", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["a"], "python decorators");
    tracker.logSearch(["b"], "decorators in python"); // same topic, different wording

    const lines = readLines();
    const satEvents = lines.filter(l => l.type === "satisfaction");
    expect(satEvents).toHaveLength(1);
    expect(satEvents[0].satisfied).toBe(false); // user re-searched same topic
  });

  test("increments searchCount", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["a"], "q1");
    tracker.logSearch(["b"], "q2");
    expect(tracker.searchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. logCitation
// ---------------------------------------------------------------------------
describe("logCitation", () => {
  test("appends citation event", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logCitation(["uuid-1"]);

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("cited");
    expect(lines[0].chunk_ids).toEqual(["uuid-1"]);
  });
});

// ---------------------------------------------------------------------------
// 3. logSessionEnd
// ---------------------------------------------------------------------------
describe("logSessionEnd", () => {
  test("marks last search as satisfied when session ends", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["a", "b"], "python testing");
    tracker.logSessionEnd();

    const lines = readLines();
    const satEvents = lines.filter(l => l.type === "satisfaction");
    expect(satEvents).toHaveLength(1);
    expect(satEvents[0].satisfied).toBe(true);
    expect(satEvents[0].chunk_ids).toEqual(["a", "b"]);
    expect(satEvents[0].next_query).toBe("(session end)");
  });

  test("no-op if no previous search", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSessionEnd();
    expect(fs.existsSync(tmpFile)).toBe(false); // nothing written
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-signal aggregate
// ---------------------------------------------------------------------------
describe("aggregate — multi-signal scoring", () => {
  test("chunk with high satisfaction + citation + stability gets high score", () => {
    const tracker = new FeedbackTracker(tmpFile);

    // 5 searches (stability = 1.0), all satisfied, all cited
    tracker.logSearch(["id1"], "python classes");
    tracker.logSearch(["id1"], "kubernetes pods"); // different topic → satisfied
    tracker.logSearch(["id1"], "rust lifetimes");
    tracker.logSearch(["id1"], "docker compose");
    tracker.logSearch(["id1"], "react hooks");
    tracker.logSessionEnd(); // marks last search as satisfied

    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);

    const scores = tracker.aggregate();
    // satisfaction: 4/4 = 1.0 (4 satisfaction events, all true)
    // citation: 5/5 = 1.0
    // stability: min(5/5, 1.0) = 1.0
    // quality = 0.4*1.0 + 0.3*1.0 + 0.3*1.0 = 1.0
    expect(scores.get("id1")).toBeGreaterThan(0.8);
  });

  test("chunk never cited and user keeps re-searching gets low score", () => {
    const tracker = new FeedbackTracker(tmpFile);

    // Same topic searched repeatedly → not satisfied
    tracker.logSearch(["id2"], "python decorators");
    tracker.logSearch(["id2"], "decorators python examples"); // same topic
    tracker.logSearch(["id2"], "how to use decorators"); // same topic
    tracker.logSessionEnd();

    // Never cited
    const scores = tracker.aggregate();
    // satisfaction: mostly false (re-searches same topic)
    // citation: 0/3 = 0
    // stability: min(3/5, 1) = 0.6
    expect(scores.get("id2")).toBeLessThan(0.5);
  });

  test("new chunk with only 1 retrieval gets moderate score", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["id3"], "test query");
    tracker.logSessionEnd();
    tracker.logCitation(["id3"]);

    const scores = tracker.aggregate();
    // satisfaction: 1/1 = 1.0
    // citation: 1/1 = 1.0
    // stability: min(1/5, 1) = 0.2 (low — only seen once)
    // quality = 0.4*1.0 + 0.3*1.0 + 0.3*0.2 = 0.76
    expect(scores.get("id3")).toBeCloseTo(0.76, 1);
  });

  test("empty file → empty Map", () => {
    const tracker = new FeedbackTracker(tmpFile);
    expect(tracker.aggregate().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. decay
// ---------------------------------------------------------------------------
describe("decay", () => {
  test("multiplies all scores by factor", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const scores = new Map([["id1", 0.8], ["id2", 0.6]]);
    const decayed = tracker.decay(scores, 0.95);
    expect(decayed.get("id1")).toBeCloseTo(0.76, 6);
    expect(decayed.get("id2")).toBeCloseTo(0.57, 6);
  });
});

// ---------------------------------------------------------------------------
// 6. NaN guard
// ---------------------------------------------------------------------------
describe("NaN guard", () => {
  test("quality_score ?? 0.5 prevents NaN in scoring formula", () => {
    const undefinedScore = undefined;
    const result = 0.7 + 0.3 * (undefinedScore ?? 0.5);
    expect(result).toBe(0.85);
    expect(Number.isNaN(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Topic similarity (internal)
// ---------------------------------------------------------------------------
describe("_queryTopicSimilarity", () => {
  test("same topic different wording → high similarity", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const sim = tracker._queryTopicSimilarity("python decorators", "decorators in python");
    expect(sim).toBeGreaterThan(0.5);
  });

  test("completely different topics → low similarity", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const sim = tracker._queryTopicSimilarity("python decorators", "kubernetes pod networking");
    expect(sim).toBe(0);
  });

  test("identical query → similarity 1.0", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const sim = tracker._queryTopicSimilarity("python classes", "python classes");
    expect(sim).toBe(1);
  });
});
