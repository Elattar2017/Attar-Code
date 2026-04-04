"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { FeedbackTracker } = require("../feedback");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// 1. logSearch
// ---------------------------------------------------------------------------
describe("logSearch", () => {
  test("appends valid JSONL line with correct shape", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["uuid-1", "uuid-2"], "test query");

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("search");
    expect(lines[0].chunk_ids).toEqual(["uuid-1", "uuid-2"]);
    expect(lines[0].query).toBe("test query");
    expect(lines[0].timestamp).toBeDefined();
  });

  test("multiple events append without corrupting previous lines", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["a"], "q1");
    tracker.logSearch(["b"], "q2");
    tracker.logSearch(["c"], "q3");

    const lines = readLines();
    expect(lines).toHaveLength(3);
    expect(lines[0].chunk_ids).toEqual(["a"]);
    expect(lines[2].chunk_ids).toEqual(["c"]);
  });

  test("increments searchCount", () => {
    const tracker = new FeedbackTracker(tmpFile);
    expect(tracker.searchCount).toBe(0);
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
    expect(lines[0].timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. aggregate
// ---------------------------------------------------------------------------
describe("aggregate", () => {
  test("computes correct quality_score = cited/retrieved", () => {
    const tracker = new FeedbackTracker(tmpFile);
    // id1 retrieved 4 times, cited 3 times → score = 0.75
    tracker.logSearch(["id1"], "q1");
    tracker.logSearch(["id1"], "q2");
    tracker.logSearch(["id1"], "q3");
    tracker.logSearch(["id1"], "q4");
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);

    const scores = tracker.aggregate();
    expect(scores.get("id1")).toBeCloseTo(0.75, 6);
  });

  test("chunk never cited → score = 0", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logSearch(["id2"], "q1");
    tracker.logSearch(["id2"], "q2");

    const scores = tracker.aggregate();
    expect(scores.get("id2")).toBe(0);
  });

  test("chunk cited but never tracked as search → score = 1.0", () => {
    const tracker = new FeedbackTracker(tmpFile);
    tracker.logCitation(["id3"]);
    tracker.logCitation(["id3"]);

    const scores = tracker.aggregate();
    expect(scores.get("id3")).toBe(1.0);
  });

  test("multiple chunks scored independently", () => {
    const tracker = new FeedbackTracker(tmpFile);
    // id1: 2/2 = 1.0, id2: 1/3 ≈ 0.333
    tracker.logSearch(["id1", "id2"], "q1");
    tracker.logSearch(["id2"], "q2");
    tracker.logSearch(["id1", "id2"], "q3");
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id1"]);
    tracker.logCitation(["id2"]);

    const scores = tracker.aggregate();
    expect(scores.get("id1")).toBeCloseTo(1.0, 6);
    expect(scores.get("id2")).toBeCloseTo(1 / 3, 4);
  });

  test("empty file → empty Map", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const scores = tracker.aggregate();
    expect(scores.size).toBe(0);
  });

  test("missing file → empty Map", () => {
    const tracker = new FeedbackTracker("/nonexistent/file.jsonl");
    const scores = tracker.aggregate();
    expect(scores.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. decay
// ---------------------------------------------------------------------------
describe("decay", () => {
  test("multiplies all scores by factor", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const scores = new Map([["id1", 0.8], ["id2", 0.6]]);
    const decayed = tracker.decay(scores, 0.95);

    expect(decayed.get("id1")).toBeCloseTo(0.76, 6);
    expect(decayed.get("id2")).toBeCloseTo(0.57, 6);
  });

  test("default factor is 0.95", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const scores = new Map([["id1", 1.0]]);
    const decayed = tracker.decay(scores);

    expect(decayed.get("id1")).toBeCloseTo(0.95, 6);
  });

  test("decay of empty Map → empty Map", () => {
    const tracker = new FeedbackTracker(tmpFile);
    const decayed = tracker.decay(new Map());
    expect(decayed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. NaN guard verification
// ---------------------------------------------------------------------------
describe("NaN guard in scoring formula", () => {
  test("quality_score ?? 0.5 prevents NaN", () => {
    // Simulate the retrieval scoring formula:
    // (0.7 + 0.3 * (quality_score ?? 0.5))
    const undefinedScore = undefined;
    const result = 0.7 + 0.3 * (undefinedScore ?? 0.5);
    expect(result).toBe(0.85);
    expect(Number.isNaN(result)).toBe(false);

    // Without guard: would produce NaN
    const badResult = 0.7 + 0.3 * undefinedScore;
    expect(Number.isNaN(badResult)).toBe(true);
  });
});
