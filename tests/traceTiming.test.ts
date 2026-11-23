import assert from "node:assert/strict";
import test from "node:test";
import { barPercent, MIN_BAR_PERCENT, timingRows } from "../src/canvas/traceTiming.ts";
import type { ConversationTurn } from "../src/canvas/traceTurns.ts";

const turn = (id: string, status: ConversationTurn["status"], durationMs?: number | null, extra = {}): ConversationTurn =>
  ({ id, number: Number(id.slice(1)), text: id, runtime: "codex", model: null, status, durationMs, ...extra });

test("bars share one scale set by the longest recorded duration", () => {
  const rows = timingRows([turn("t1", "complete", 1000), turn("t2", "stopped", 4000), turn("t3", "interrupted", 2000)]);
  assert.deepEqual(rows.map((row) => row.ratio), [0.25, 1, 0.5]);
  assert.deepEqual(rows.map((row) => row.kind), ["timed", "timed", "timed"]);
});

test("running and unknown turns are excluded from the scale and get no ratio", () => {
  const rows = timingRows([
    turn("t1", "complete", 2000),
    turn("t2", "streaming", null, { startedAt: "2026-01-01T00:00:00.000Z" }),
    turn("t3", "streaming", 999999), // a running turn never contributes a duration
    turn("t4", "interrupted", null),
    turn("t5", "complete"), // legacy: field absent
    turn("t6", "complete", -5), // malformed
    turn("t7", "stopped", Number.NaN),
  ]);
  assert.deepEqual(rows.map((row) => row.kind), ["timed", "running", "running", "unknown", "unknown", "unknown", "unknown"]);
  assert.equal(rows[0].ratio, 1);
  assert.ok(rows.slice(1).every((row) => row.ratio === null && row.durationMs === null));
  assert.ok(rows.every((row) => !("startedAt" in row)), "rows carry no browser-clock input");
});

test("durationMs is the only source: startedAt and finishedAt are never subtracted", () => {
  const [row] = timingRows([turn("t1", "complete", null, {
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:09.000Z",
  })]);
  assert.equal(row.kind, "unknown");
  assert.equal(row.durationMs, null);
});

test("zero durations and empty input", () => {
  assert.deepEqual(timingRows([turn("t1", "complete", 0), turn("t2", "complete", 0)]).map((row) => row.ratio), [0, 0]);
  assert.deepEqual(timingRows([]), []);
  assert.equal(barPercent(0), MIN_BAR_PERCENT);
  assert.equal(barPercent(1), 100);
  assert.equal(barPercent(0.5), 50);
});

test("row order and numbers follow the turns, and large conversations stay linear", () => {
  const turns = Array.from({ length: 5000 }, (_, i) => turn(`t${i + 1}`, "complete", (i % 50) * 100));
  const rows = timingRows(turns);
  assert.equal(rows.length, 5000);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.id), ["t1", "t2", "t3"]);
});
