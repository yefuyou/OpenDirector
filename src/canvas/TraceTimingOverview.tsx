import { memo } from "react";
import { useT } from "../i18n/I18nProvider";
import { barPercent, type TimingRow } from "./traceTiming.ts";
import { runtimeName } from "./traceTurns.ts";
import { formatTurnDuration, TURN_STATUS_KEYS } from "./turnTiming.ts";

/**
 * One row. It is memoized on the row object and the stable `reveal`, so a poll that returns the same
 * conversation, or a turn being opened, does not render the list again. A running turn shows a label
 * only: there is no timer, because the browser clock is not an authoritative duration.
 */
const OverviewRow = memo(function OverviewRow({ row, reveal }: { row: TimingRow; reveal: (id: string) => void }) {
  const t = useT();
  const status = t(TURN_STATUS_KEYS[row.status]);
  const value = row.kind === "timed" ? formatTurnDuration(row.durationMs)!
    : row.kind === "running" ? t("trace.overview.running")
    : t("trace.turn.duration.unavailable");
  const runtime = runtimeName(row.runtime);
  return (
    <li>
      <button type="button" className={`cw-trace-overview-row is-${row.kind}`}
        aria-controls={`turn-${row.id}`}
        aria-label={t("trace.overview.row", { number: row.number, runtime, status, duration: value })}
        onClick={() => reveal(row.id)}>
        <span className="cw-trace-overview-name">{t("trace.turn.number", { number: row.number })}</span>
        <span className="cw-trace-overview-runtime" title={runtime}>{runtime}</span>
        <span className={`cw-trace-badge is-turn-${row.status}`}>{status}</span>
        <span className="cw-trace-overview-track" aria-hidden="true">
          <span className={`cw-trace-overview-bar is-${row.status}${row.kind === "timed" ? "" : " is-open-ended"}`}
            style={row.kind === "timed" ? { width: `${barPercent(row.ratio ?? 0)}%` } : undefined} />
        </span>
        <span className="cw-trace-overview-value">{value}</span>
      </button>
    </li>
  );
});

/**
 * Compares the duration of each turn. It is not a timeline: bars share one length scale and are not
 * placed on a clock. Activating a row calls `reveal`, which opens the turn, lazy-loads it, scrolls it
 * below the sticky bars and moves focus to its summary. Activating it again keeps it open.
 */
export default function TraceTimingOverview({ rows, reveal }: {
  rows: TimingRow[]; reveal: (id: string) => void;
}) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <section className="cw-trace-overview" aria-labelledby="cw-trace-overview-title">
      <h2 id="cw-trace-overview-title">{t("trace.overview.title")}</h2>
      <p className="cw-trace-overview-hint">{t("trace.overview.hint")}</p>
      <ol className="cw-trace-overview-list">
        {rows.map((row) => <OverviewRow key={row.id} row={row} reveal={reveal} />)}
      </ol>
    </section>
  );
}
