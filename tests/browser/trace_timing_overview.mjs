/** Trace Timing Overview (#468 Slice B): per-turn duration bars on the Conversation Trace page.
 * The conversation trace response is answered by page.route so long, legacy, running and ended turns
 * can be shown; everything else reaches the real fixture API and Vite page.
 * Start creation_server.py with --assistant-fixture before running this check.
 * Set TRACE_OVERVIEW_SCREENSHOTS=<dir> to save desktop, 768 and 360 px screenshots.
 * The final sections lay out five widths per locale and run a 1,000 turn conversation; their measured
 * numbers are printed, and only functional results are asserted.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const shots = process.env.TRACE_OVERVIEW_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const project = crypto.randomUUID();
const conversation = "conversation-overview";
const MANY = 1000;
const WIDTHS = [360, 640, 768, 1024, 1440];
const stats = [];

const copy = {
  "en-US": {
    title: "Turn durations", unavailable: "Unavailable", running: "Running", turns: "Turns",
    row: (n, runtime, status, duration) => `Turn ${n}, ${runtime}, ${status}, ${duration}`,
    done: "Completed", stopped: "Stopped", interrupted: "Interrupted", empty: "This conversation has no executed turns.",
  },
  "zh-CN": {
    title: "各轮耗时", unavailable: "不可用", running: "运行中", turns: "轮次",
    row: (n, runtime, status, duration) => `第 ${n} 轮，${runtime}，${status}，${duration}`,
    done: "已完成", stopped: "已停止", interrupted: "已中断", empty: "该对话还没有已执行的轮次。",
  },
};

const LONG = 80;
const turn = (number, fields = {}) => ({
  id: `turn-${number}`, number, text: `Message ${number}`, runtime: "codex", model: null,
  status: "complete", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000, ...fields,
});
const longConversation = () => Array.from({ length: LONG }, (_, i) =>
  turn(i + 1, { durationMs: 500 + ((i * 37) % 20) * 1000 }));
const mixed = () => [
  turn(1, { durationMs: 2000 }),
  turn(2, { durationMs: 8000, runtime: "default" }),
  turn(3, { status: "stopped", durationMs: 4000, runtime: "claude" }),
  turn(4, { status: "interrupted", durationMs: 1000, runtime: "deepseek" }),
  turn(5, { status: "interrupted", durationMs: null, finishedAt: null }), // restart or crash
  turn(6, { durationMs: undefined, startedAt: undefined, finishedAt: undefined }), // legacy
  turn(7, { durationMs: 0 }),
  turn(8, { status: "streaming", durationMs: null, finishedAt: null }),
];

const browser = await launchBrowser();

/** Measures a 1,000 turn conversation with turn 1000 running; prints numbers, asserts function only. */
async function measureMany() {
  const locale = "en-US";
  const turns = Array.from({ length: MANY }, (_, i) => turn(i + 1, { durationMs: 500 + ((i * 37) % 200) * 100 }));
  turns[MANY - 1] = turn(MANY, { status: "streaming", durationMs: null, finishedAt: null });
  const page = await browser.newPage({ locale, viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => assert.fail(error.message));
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
    window.__longTasks = 0;
    // A minimal DevTools hook: React reports every committed render, so idle commits can be counted.
    window.__commits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject: () => 1,
      checkDCE() {}, onCommitFiberUnmount() {}, onScheduleFiberRoot() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot() { window.__commits += 1; } };
    new PerformanceObserver((list) => { window.__longTasks += list.getEntries().length; }).observe({ entryTypes: ["longtask"] });
  });
  let polls = 0;
  await page.route(/\/assistant\/conversations\/[^/]+\/trace$/, (route) => {
    polls += 1;
    return route.fulfill({ json: { conversationId: conversation, turns } });
  });
  const cdp = browser.browserType().name() === "chromium" ? await page.context().newCDPSession(page) : null;
  const metrics = async () => {
    if (!cdp) return null;
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(list.map((item) => [item.name, item.value]));
  };
  await cdp?.send("Performance.enable");
  const startedAt = Date.now();
  await page.goto(`${base}/?${new URLSearchParams({ traceProject: project, conversation, turn: "turn-1", runtime: "codex" })}`);
  const overview = page.getByRole("region", { name: "Turn durations", exact: true });
  await overview.waitFor();
  await page.locator(".cw-trace-overview-row").nth(MANY - 1).waitFor({ state: "attached" });
  const renderMs = Date.now() - startedAt;
  assert.equal(await page.locator(".cw-trace-overview-row").count(), MANY);
  const before = await metrics();
  const dom = await page.evaluate(() => document.getElementsByTagName("*").length);
  const timing = await page.evaluate(() => performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd);

  // Turn 900: click, then wait for the summary to hold focus below the sticky bars.
  const row900 = page.getByRole("button", { name: /^Turn 900, / });
  await row900.scrollIntoViewIfNeeded();
  const clickStart = await page.evaluate(() => performance.now());
  await row900.click();
  await page.waitForFunction(() => document.activeElement === document.querySelector("#turn-turn-900 > summary") || null);
  const focusMs = Math.round((await page.evaluate(() => performance.now())) - clickStart);
  const at = await page.evaluate(() => {
    const rect = document.querySelector("#turn-turn-900 > summary").getBoundingClientRect();
    const covered = Math.max(...[".cw-trace-header", ".cw-trace-turnnav"].map((s) => document.querySelector(s).getBoundingClientRect().bottom));
    return { top: rect.top, bottom: rect.bottom, covered, height: innerHeight };
  });
  assert.ok(at.top >= at.covered - 1 && at.bottom <= at.height + 1, `turn 900 is visible below the bars: ${JSON.stringify(at)}`);
  assert.equal(await page.locator("#turn-turn-900").evaluate((node) => node.open), true);
  // Keyboard activation of another far row works too, and a repeated activation keeps turn 900 open.
  await row900.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#turn-turn-900").evaluate((node) => node.open), true);
  const tail = page.getByRole("button", { name: /^Turn 1000, .*Running, Running$/ });
  assert.equal(await tail.count(), 1, "running turn shows a label only");

  // Only turn 1 (deep link) and turn 900 reach the per-turn trace endpoints.
  await page.waitForTimeout(1500);
  const traced = requests.filter((url) => /\/assistant\/traces\/turn-\d+\//.test(url));
  const touched = new Set(traced.map((url) => url.match(/\/traces\/(turn-\d+)\//)[1]));
  assert.deepEqual([...touched].sort(), ["turn-1", "turn-900"], `unexpected per-turn requests: ${[...touched]}`);

  // Idle window with a running turn: the page polls the conversation every 2 s, and the identical
  // answer must not render the overview again.
  assert.ok(await page.evaluate(() => window.__commits) > 0, "the commit counter sees real renders");
  const pollsBefore = polls;
  const idleStart = await metrics();
  const idle = await page.evaluate(() => new Promise((resolve) => {
    const list = document.querySelector(".cw-trace-overview-list");
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
    const longBefore = window.__longTasks; const commitsBefore = window.__commits;
    const frames = []; let last = performance.now(); let alive = true;
    const tick = (now) => { frames.push(now - last); last = now; if (alive) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => { alive = false; observer.disconnect();
      resolve({ mutations, commits: window.__commits - commitsBefore, longTasks: window.__longTasks - longBefore, worstFrameMs: Math.round(Math.max(...frames)) }); }, 6000);
  }));
  const pollsDuring = polls - pollsBefore;
  assert.equal(idle.mutations, 0, `overview list mutated while idle: ${idle.mutations}`);
  assert.equal(idle.commits, 0, `React committed ${idle.commits} renders while idle`);
  assert.ok(pollsDuring >= 1, "the running conversation keeps polling");
  const after = await metrics();
  const mb = (value) => value === undefined ? "n/a" : (value / 1048576).toFixed(1);
  console.log("1000 turn measurements (chromium headless, dev server, fixture API):");
  console.table([{
    "overview rows": MANY, "goto to all rows (ms)": renderMs, "DOMContentLoaded (ms)": Math.round(timing),
    "DOM nodes": dom, "turn 900 click to focus (ms)": focusMs,
    "heap after load (MB)": mb(before?.JSHeapUsedSize), "heap before idle (MB)": mb(idleStart?.JSHeapUsedSize), "heap after 6 s idle (MB)": mb(after?.JSHeapUsedSize),
    "layout count in idle": idleStart && after ? `${idleStart.LayoutCount} -> ${after.LayoutCount}` : "n/a",
    "style recalcs in idle": idleStart && after ? `${idleStart.RecalcStyleCount} -> ${after.RecalcStyleCount}` : "n/a",
    "idle list mutations (6 s)": idle.mutations, "idle React commits (6 s)": idle.commits, "idle polls (6 s)": pollsDuring,
    "idle long tasks": idle.longTasks, "long tasks total": await page.evaluate(() => window.__longTasks),
    "worst idle frame (ms)": idle.worstFrameMs,
  }]);
  console.log(`per-turn trace requests: ${[...touched].sort().join(", ")} (${traced.length} requests)`);
  await page.close();
}
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const words = copy[locale];
    const open = async (turns, { turn: target = "turn-1", viewport = { width: 1440, height: 900 }, requests = [], ready = true } = {}) => {
      const page = await browser.newPage({ locale, viewport });
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => assert.fail(error.message));
      page.on("request", (request) => requests.push(request.url()));
      await page.addInitScript((current) => {
        localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
        localStorage.setItem("opendirector.locale.v1", current);
      }, locale);
      await page.route(/\/assistant\/conversations\/[^/]+\/trace$/, (route) =>
        route.fulfill({ json: { conversationId: conversation, turns } }));
      await page.goto(`${base}/?${new URLSearchParams({
        traceProject: project, conversation, turn: target, runtime: "codex" })}`);
      if (ready) await page.getByRole("region", { name: words.title, exact: true }).waitFor();
      return page;
    };
    const rowFor = (page, number) => page.getByRole("button", { name: new RegExp(`^${locale === "en-US" ? "Turn" : "第"} ${number}[ ,，]`) });
    const state = (page, id) => page.locator(`#turn-${id}`).evaluate((node) => node.open);
    // Where the summary sits relative to the sticky bars, and whether it holds keyboard focus.
    const placement = (page, id) => page.evaluate((turnId) => {
      const summary = document.querySelector(`#turn-${turnId} > summary`);
      const rect = summary.getBoundingClientRect();
      const bars = [".cw-trace-header", ".cw-trace-turnnav"].map((s) => document.querySelector(s).getBoundingClientRect().bottom);
      return { top: rect.top, bottom: rect.bottom, covered: Math.max(...bars), height: innerHeight, focused: document.activeElement === summary };
    }, id);
    const assertRevealed = async (page, id, focused = true) => {
      await page.waitForFunction((turnId) => document.activeElement === document.querySelector(`#turn-${turnId} > summary`) || null,
        id, { timeout: focused ? 5000 : 100 }).catch((error) => { if (focused) throw error; });
      const at = await placement(page, id);
      assert.equal(at.focused, focused, `${id} focus: ${JSON.stringify(at)}`);
      assert.ok(at.top >= at.covered - 1 && at.bottom <= at.height + 1, `${id} is visible below the sticky bars: ${JSON.stringify(at)}`);
    };

    // Mixed states.
    const page = await open(mixed());
    const overview = page.getByRole("region", { name: words.title, exact: true });
    const rows = overview.getByRole("button");
    assert.equal(await rows.count(), 8);
    const widths = await overview.locator(".cw-trace-overview-track > span").evaluateAll((bars) =>
      bars.map((bar) => bar.getBoundingClientRect().width / bar.parentElement.getBoundingClientRect().width));
    assert.ok(Math.abs(widths[1] - 1) < 0.01, "longest turn fills the track");
    assert.ok(Math.abs(widths[0] - 0.25) < 0.01 && Math.abs(widths[2] - 0.5) < 0.01 && Math.abs(widths[3] - 0.125) < 0.01, JSON.stringify(widths));
    assert.ok(widths[6] > 0 && widths[6] < 0.05, "0 ms keeps a visible minimum bar");
    // Open-ended bars (unknown, legacy, running) are hatched, never sized by a duration.
    for (const index of [4, 5, 7])
      assert.equal(await rows.nth(index).locator(".cw-trace-overview-bar").evaluate((bar) => bar.classList.contains("is-open-ended")), true);
    assert.equal(await rows.nth(1).getAttribute("aria-label"), words.row(2, "OpenCode", words.done, "8.0 s"));
    assert.equal(await rows.nth(2).getAttribute("aria-label"), words.row(3, "Claude Code", words.stopped, "4.0 s"));
    assert.equal(await rows.nth(3).getAttribute("aria-label"), words.row(4, "DeepSeek Harness", words.interrupted, "1.0 s"));
    assert.equal(await rows.nth(4).getAttribute("aria-label"), words.row(5, "Codex", words.interrupted, words.unavailable));
    assert.equal(await rows.nth(5).getAttribute("aria-label"), words.row(6, "Codex", words.done, words.unavailable));
    assert.equal(await rows.nth(6).getAttribute("aria-label"), words.row(7, "Codex", words.done, "0 ms"));
    // A running turn shows a label only, never a time computed from the browser clock.
    assert.equal(await rows.nth(7).locator(".cw-trace-overview-value").innerText(), words.running);
    assert.equal(await rows.nth(7).getAttribute("aria-label"), words.row(8, "Codex", words.running, words.running));
    assert.doesNotMatch(await rows.nth(7).locator(".cw-trace-overview-value").innerText(), /\d/);
    // The running turn does not rescale the others.
    assert.ok(Math.abs((await overview.locator(".cw-trace-overview-track > span").evaluateAll((bars) =>
      bars[1].getBoundingClientRect().width / bars[1].parentElement.getBoundingClientRect().width)) - 1) < 0.01);
    if (shots) await page.screenshot({ path: `${shots}/overview-desktop-${locale}.png` });

    // Deep link: opens and positions its turn below the bars without taking focus on load.
    assert.equal(await state(page, "turn-1"), true, "deep link opens its turn");
    await assertRevealed(page, "turn-1", false);
    // The rows expose aria-controls but no aria-expanded.
    for (let index = 0; index < 8; index += 1) {
      assert.equal(await rows.nth(index).getAttribute("aria-expanded"), null);
      assert.equal(await rows.nth(index).getAttribute("aria-controls"), `turn-turn-${index + 1}`);
    }
    // Mouse: the click opens the turn, moves focus to its summary, and the others stay closed.
    await rows.nth(2).click();
    assert.equal(await state(page, "turn-3"), true);
    assert.equal(await state(page, "turn-2"), false);
    await assertRevealed(page, "turn-3");
    // A repeated click keeps it open (no toggle), re-focuses it, and scrolls back to it.
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
    await rows.nth(2).click();
    assert.equal(await state(page, "turn-3"), true);
    await assertRevealed(page, "turn-3");
    // Keyboard: Enter and Space open the turn and move focus to its summary.
    await rows.nth(1).focus();
    await page.keyboard.press("Enter");
    assert.equal(await state(page, "turn-2"), true);
    await assertRevealed(page, "turn-2");
    await page.evaluate(() => window.scrollTo(0, 0));
    await rows.nth(3).focus();
    await page.keyboard.press("Space");
    assert.equal(await state(page, "turn-4"), true);
    await assertRevealed(page, "turn-4");
    // Enter again on the same row stays open and re-focuses.
    await page.evaluate(() => window.scrollTo(0, 0));
    await rows.nth(3).focus();
    await page.keyboard.press("Enter");
    assert.equal(await state(page, "turn-4"), true);
    await assertRevealed(page, "turn-4");
    // The summary is still a native control: Enter toggles its own turn closed without moving focus away.
    await page.keyboard.press("Enter");
    assert.equal(await state(page, "turn-4"), false);
    // Turn navigation keeps its behaviour: it opens and scrolls, and does not take focus.
    const nav = page.getByRole("navigation", { name: words.turns, exact: true });
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
    await nav.getByRole("button", { name: "6", exact: true }).click();
    assert.equal(await state(page, "turn-6"), true);
    await assertRevealed(page, "turn-6", false);
    assert.equal(await nav.getByRole("button", { name: "6", exact: true }).evaluate((node) => node === document.activeElement), true);
    // Tab moves focus from one row to the next.
    await page.evaluate(() => window.scrollTo(0, 0));
    await rows.nth(0).focus();
    await page.keyboard.press("Tab");
    assert.equal(await rows.nth(1).evaluate((node) => node === document.activeElement), true);
    await page.close();

    // Long conversation: lazy loading, exact targeting, and a scrollable list instead of a tall page.
    const requests = [];
    const long = await open(longConversation(), { requests });
    const longRows = long.getByRole("region", { name: words.title, exact: true }).getByRole("button");
    assert.equal(await longRows.count(), LONG);
    const box = await long.locator(".cw-trace-overview-list").evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
    assert.ok(box.client < box.scroll && box.client <= 400, JSON.stringify(box));
    assert.ok(!requests.some((url) => url.includes("/traces/turn-60")), "Overview must not load unopened turns");
    assert.ok(!requests.some((url) => /\/traces\/turn-(?!1\/|1$)/.test(url)), "Only the linked turn is loaded");
    await rowFor(long, 60).scrollIntoViewIfNeeded();
    await rowFor(long, 60).click();
    assert.equal(await state(long, "turn-60"), true);
    await assertRevealed(long, "turn-60");
    const deadline = Date.now() + 15000;
    while (!requests.some((url) => url.includes("/traces/turn-60/")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const loaded = new Set(requests.map((url) => url.match(/\/traces\/(turn-\d+)/)?.[1]).filter(Boolean));
    assert.deepEqual([...loaded].sort(), ["turn-1", "turn-60"]);
    assert.equal(await long.locator(".cw-trace-turn[open]").count(), 2);
    await long.close();

    // Old data: no timing fields at all. No bar is invented and the old controls still work.
    const legacy = await open([turn(1, { durationMs: undefined, startedAt: undefined, finishedAt: undefined }),
      turn(2, { durationMs: undefined, startedAt: undefined, finishedAt: undefined })]);
    const legacyValues = await legacy.locator(".cw-trace-overview-value").allTextContents();
    assert.deepEqual(legacyValues, [words.unavailable, words.unavailable]);
    assert.equal(await legacy.locator(".cw-trace-overview-bar:not(.is-open-ended)").count(), 0);
    await legacy.getByRole("navigation", { name: words.turns, exact: true }).getByRole("button", { name: "2", exact: true }).click();
    assert.equal(await state(legacy, "turn-2"), true);
    await legacy.close();

    // A running-only conversation, and a conversation with no turns.
    const running = await open([turn(1, { status: "streaming", durationMs: null, finishedAt: null })]);
    assert.equal(await running.locator(".cw-trace-overview-bar.is-open-ended").count(), 1);
    await running.close();
    // No turns: the empty state is shown and there is no overview. A failed load would show neither
    // and time out here, so it cannot pass as an empty conversation.
    const none = await open([], { turn: "", ready: false });
    await none.getByRole("status").filter({ hasText: words.empty }).waitFor();
    assert.equal(await none.getByRole("region", { name: words.title, exact: true }).count(), 0);
    assert.equal(await none.locator(".cw-trace-overview").count(), 0);
    await none.close();

    // Layout at five widths: no overflow or overlap, two rows up to 900 px and one row above it.
    for (const width of WIDTHS) {
      const view = await open(mixed(), { viewport: { width, height: width <= 640 ? 740 : 900 } });
      const result = await view.evaluate(() => {
        const rect = (node) => node.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".cw-trace-overview-row")];
        let overlaps = 0; let overflowing = 0; let twoRows = 0; let oneRow = 0;
        const tracks = [];
        for (const row of rows) {
          if (row.scrollWidth > row.clientWidth + 1) overflowing += 1;
          const cells = [".cw-trace-overview-name", ".cw-trace-overview-runtime", ".cw-trace-badge", ".cw-trace-overview-value"]
            .map((selector) => rect(row.querySelector(selector)));
          for (let i = 0; i < cells.length; i += 1) for (let j = i + 1; j < cells.length; j += 1)
            if (cells[i].left < cells[j].right - 0.5 && cells[j].left < cells[i].right - 0.5
              && cells[i].top < cells[j].bottom - 0.5 && cells[j].top < cells[i].bottom - 0.5) overlaps += 1;
          const track = rect(row.querySelector(".cw-trace-overview-track"));
          const rowRect = rect(row);
          tracks.push(Math.round(track.width));
          const below = track.top >= Math.max(...cells.map((cell) => cell.bottom)) - 0.5;
          if (below && track.width >= rowRect.width - 20) twoRows += 1;
          if (!below && cells.every((cell) => cell.top < track.bottom && cell.bottom > track.top)) oneRow += 1;
        }
        const list = document.querySelector(".cw-trace-overview-list");
        return {
          docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
          overlaps, overflowing, twoRows, oneRow, rows: rows.length, track: Math.min(...tracks),
          listOverflow: list.scrollWidth - list.clientWidth,
        };
      });
      assert.ok(result.docScroll <= result.docClient, `${locale} ${width}: document overflows ${JSON.stringify(result)}`);
      assert.equal(result.overflowing, 0, `${locale} ${width}: ${JSON.stringify(result)}`);
      assert.equal(result.overlaps, 0, `${locale} ${width}: ${JSON.stringify(result)}`);
      assert.equal(result.listOverflow, 0, `${locale} ${width}: ${JSON.stringify(result)}`);
      if (width <= 900) assert.equal(result.twoRows, result.rows, `${locale} ${width}: track is not a full-width second row ${JSON.stringify(result)}`);
      else assert.equal(result.oneRow, result.rows, `${locale} ${width}: expected a single row ${JSON.stringify(result)}`);
      stats.push({ locale, width, layout: width <= 900 ? "2 rows" : "1 row", minTrackPx: result.track,
        docOverflowPx: result.docScroll - result.docClient, rowOverflow: result.overflowing, overlaps: result.overlaps });
      if (shots && [360, 768, 1440].includes(width)) {
        await view.evaluate(() => window.scrollTo(0, 0));
        await view.waitForTimeout(300);
        await view.screenshot({ path: `${shots}/overview-${width === 1440 ? "desktop" : width === 360 ? "narrow" : "768"}-${locale}.png` });
      }
      await view.close();
    }
  }
  console.table(stats);

  // 1,000 turns, one running: render, interaction, lazy loading and idle cost. Numbers are printed.
  await measureMany();
  console.log("trace timing overview browser check passed");
} finally {
  await browser.close();
}
