/** Trace Timing Overview (#468 Slice B): per-turn duration bars on the Conversation Trace page.
 * The conversation trace response is answered by page.route so long, legacy, running and ended turns
 * can be shown; everything else reaches the real fixture API and Vite page.
 * Start creation_server.py with --assistant-fixture before running this check.
 * Set TRACE_OVERVIEW_SCREENSHOTS=<dir> to save desktop and narrow screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const shots = process.env.TRACE_OVERVIEW_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const project = crypto.randomUUID();
const conversation = "conversation-overview";

const copy = {
  "en-US": {
    title: "Turn durations", unavailable: "Unavailable", running: "Running", turns: "Turns",
    row: (n, runtime, status, duration) => `Turn ${n}, ${runtime}, ${status}, ${duration}`,
    done: "Completed", stopped: "Stopped", interrupted: "Interrupted", progress: /^about .+ so far$/,
  },
  "zh-CN": {
    title: "各轮耗时", unavailable: "不可用", running: "运行中", turns: "轮次",
    row: (n, runtime, status, duration) => `第 ${n} 轮，${runtime}，${status}，${duration}`,
    done: "已完成", stopped: "已停止", interrupted: "已中断", progress: /^已运行约 .+$/,
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
  turn(8, { status: "streaming", durationMs: null, finishedAt: null, startedAt: new Date(Date.now() - 5000).toISOString() }),
];

const browser = await launchBrowser();
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const words = copy[locale];
    const open = async (turns, { turn: target = "turn-1", viewport = { width: 1440, height: 900 }, requests = [] } = {}) => {
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
      await page.getByRole("region", { name: words.title, exact: true }).waitFor();
      return page;
    };
    const rowFor = (page, number) => page.getByRole("button", { name: new RegExp(`^${locale === "en-US" ? "Turn" : "第"} ${number}[ ,，]`) });
    const state = (page, id) => page.locator(`#turn-${id}`).evaluate((node) => node.open);

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
    assert.match(await rows.nth(7).locator(".cw-trace-overview-value").innerText(), words.progress);
    assert.match(await rows.nth(7).getAttribute("aria-label"), new RegExp(words.running));
    // Elapsed time of the running turn is display only and does not rescale the others.
    assert.ok(Math.abs((await overview.locator(".cw-trace-overview-track > span").evaluateAll((bars) =>
      bars[1].getBoundingClientRect().width / bars[1].parentElement.getBoundingClientRect().width)) - 1) < 0.01);
    if (shots) await page.screenshot({ path: `${shots}/overview-desktop-${locale}.png` });

    // Mouse: bar opens and scrolls to its turn, and the others stay closed.
    assert.equal(await state(page, "turn-1"), true, "deep link opens its turn");
    await rows.nth(2).click();
    assert.equal(await state(page, "turn-3"), true);
    assert.equal(await state(page, "turn-2"), false);
    assert.equal(await rows.nth(2).getAttribute("aria-expanded"), "true");
    assert.equal(await rows.nth(2).getAttribute("aria-controls"), "turn-turn-3");
    await page.locator("#turn-turn-3 > summary").waitFor();
    const top = await page.locator("#turn-turn-3").evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 900, `turn 3 is in view, got ${top}`); // a short page cannot scroll it to the top
    // Keyboard: focus a row and press Enter / Space.
    await rows.nth(1).focus();
    await page.keyboard.press("Enter");
    assert.equal(await state(page, "turn-2"), true);
    await rows.nth(3).focus();
    await page.keyboard.press("Space");
    assert.equal(await state(page, "turn-4"), true);
    // Tab moves focus from one row to the next.
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
    await long.waitForFunction(() => {
      const top = document.getElementById("turn-turn-60")?.getBoundingClientRect().top;
      return top !== undefined && top >= 0 && top < 120;
    }, null, { timeout: 5000 });
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
    const none = await open([]).catch(() => null);
    if (none) {
      assert.equal(await none.getByRole("region", { name: words.title, exact: true }).count(), 0);
      await none.close();
    }

    // Narrow screen: no horizontal scrolling, every control reachable.
    const narrow = await open(mixed(), { viewport: { width: 360, height: 740 } });
    const fit = await narrow.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(fit.scroll <= fit.client, JSON.stringify(fit));
    const overflow = await narrow.locator(".cw-trace-overview-row").evaluateAll((items) =>
      items.filter((item) => item.scrollWidth > item.clientWidth + 1).length);
    assert.equal(overflow, 0);
    const trackWidths = await narrow.locator(".cw-trace-overview-track").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().width)));
    assert.equal(new Set(trackWidths).size, 1, `tracks share one width: ${trackWidths}`);
    await narrow.waitForTimeout(500);
    await narrow.evaluate(() => window.scrollTo(0, 0));
    if (shots) await narrow.screenshot({ path: `${shots}/overview-narrow-${locale}.png` });
    await narrow.locator(".cw-trace-overview-row").nth(2).click();
    assert.equal(await state(narrow, "turn-3"), true);
    await narrow.close();
  }
  console.log("trace timing overview browser check passed");
} finally {
  await browser.close();
}
