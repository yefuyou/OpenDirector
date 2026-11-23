import { useEffect, useState } from "react";
import { useT } from "../i18n/I18nProvider";
import { barPercent, runningElapsedMs, type TimingRow } from "./traceTiming.ts";
import { runtimeName } from "./traceTurns.ts";
import { formatTurnDuration, TURN_STATUS_KEYS } from "./turnTiming.ts";

/** Wall-clock tick while a turn is running, for the approximate elapsed label only. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Compares the duration of each turn. It is not a timeline: bars share one length scale and are not
 * placed on a clock. Clicking a row calls `reveal`, the page's own open, lazy-load and scroll logic.
 */
export default function TraceTimingOverview({ rows, open, reveal }: {
  rows: TimingRow[]; open: ReadonlySet<string>; reveal: (id: string) => void;
}) {
  const t = useT();
  const now = useNow(rows.some((row) => row.kind === "running"));
  if (rows.length === 0) return null;
  return (
    <section className="cw-trace-overview" aria-labelledby="cw-trace-overview-title">
      <h2 id="cw-trace-overview-title">{t("trace.overview.title")}</h2>
      <p className="cw-trace-overview-hint">{t("trace.overview.hint")}</p>
      <ol className="cw-trace-overview-list">
        {rows.map((row) => {
          const status = t(TURN_STATUS_KEYS[row.status]);
          const elapsed = row.kind === "running" ? formatTurnDuration(runningElapsedMs(row.startedAt, now)) : null;
          const value = row.kind === "timed" ? formatTurnDuration(row.durationMs)!
            : row.kind === "running" ? (elapsed ? t("trace.overview.elapsed", { elapsed }) : t("trace.overview.inProgress"))
            : t("trace.turn.duration.unavailable");
          const runtime = runtimeName(row.runtime);
          return (
            <li key={row.id}>
              <button type="button" className={`cw-trace-overview-row is-${row.kind}`}
                aria-controls={`turn-${row.id}`} aria-expanded={open.has(row.id)}
                aria-label={t("trace.overview.row", {
                  number: row.number, runtime, status,
                  duration: value,
                })}
                onClick={() => reveal(row.id)}>
                <span className="cw-trace-overview-name">{t("trace.turn.number", { number: row.number })}</span>
                <span className="cw-trace-overview-runtime">{runtime}</span>
                <span className={`cw-trace-badge is-turn-${row.status}`}>{status}</span>
                <span className="cw-trace-overview-track" aria-hidden="true">
                  <span className={`cw-trace-overview-bar is-${row.status}${row.kind === "timed" ? "" : " is-open-ended"}`}
                    style={row.kind === "timed" ? { width: `${barPercent(row.ratio ?? 0)}%` } : undefined} />
                </span>
                <span className="cw-trace-overview-value">{value}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
