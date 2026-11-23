/** Pure model of the Trace Timing Overview (#468 Slice B): one row per turn, bars compare durations only. */
import type { ConversationTurn } from "./traceTurns.ts";

/** Bars never shrink below this share of the track, so a 0 ms turn stays visible and clickable. */
export const MIN_BAR_PERCENT = 2;

export type TimingRow = {
  id: string;
  number: number;
  runtime: string;
  status: ConversationTurn["status"];
  /** timed: recorded duration. running: no end yet. unknown: finished without a recorded duration. */
  kind: "timed" | "running" | "unknown";
  durationMs: number | null;
  /** durationMs / longest recorded duration, 0..1. Null unless kind is "timed". */
  ratio: number | null;
};

const recorded = (ms: number | null | undefined): ms is number =>
  typeof ms === "number" && Number.isFinite(ms) && ms >= 0;

/**
 * Only `durationMs` is compared. `finishedAt - startedAt` is never used, and running or unknown turns
 * are left out of the scale so they cannot rescale the other bars.
 */
export function timingRows(turns: ConversationTurn[]): TimingRow[] {
  const longest = turns.reduce((max, turn) =>
    turn.status !== "streaming" && recorded(turn.durationMs) ? Math.max(max, turn.durationMs) : max, 0);
  return turns.map((turn) => {
    const timed = turn.status !== "streaming" && recorded(turn.durationMs);
    const durationMs = timed ? turn.durationMs as number : null;
    return {
      id: turn.id, number: turn.number, runtime: turn.runtime, status: turn.status,
      kind: turn.status === "streaming" ? "running" : timed ? "timed" : "unknown",
      durationMs,
      ratio: durationMs === null ? null : longest > 0 ? durationMs / longest : 0,
    };
  });
}

/** Bar width in percent of the track. */
export const barPercent = (ratio: number): number =>
  Math.min(100, Math.max(MIN_BAR_PERCENT, ratio * 100));
