/**
 * The desktop sidebar keeps the legacy icon + text stop row.
 *
 * Reloading the Codex model catalog is an occasional recovery action, so it stays
 * available on the mobile action surface and Models page without taking a permanent
 * row in the desktop footer.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
// Comments describe the controls by name; matching prose is not evidence about code.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

test("the sidebar foot keeps only the aligned stop row", () => {
  const foot = src.slice(src.indexOf('className="sidebar-foot"'), src.indexOf("<SidebarGithubRow"));
  expect(foot).toContain('className="theme-toggle stop-toggle"');
  expect(foot).toContain("handleStop");
  expect(foot).toContain("IconPower");
  expect(foot).toContain('<span className="mode">');
  expect(foot).not.toContain("handleCodexRestart");
  expect(foot).not.toContain("IconRefresh");
  expect(foot).not.toContain("sidebar-action-row");
});

test("the mobile top bar carries the same pair", () => {
  // A capability that exists only on desktop is a capability the user cannot find
  // on the surface where the picker is most often noticed as stale.
  const bar = src.slice(src.indexOf('className="mobile-topbar-actions"'), src.indexOf("</div>", src.indexOf('className="mobile-topbar-actions"')));
  expect(bar).toContain("handleStop");
  expect(bar).toContain("handleCodexRestart");
});

test("both controls are disabled while their own action is pending", () => {
  expect(src).toContain("disabled={stopping}");
  expect(src).toContain("disabled={codexRestarting}");
});

test("every action orb carries an accessible name", () => {
  // Icon-only buttons have no text content, so aria-label is the only name.
  // Splitting on the tag start is more robust than matching to a closing angle
  // bracket: arrow functions inside JSX attributes contain ">" themselves.
  const chunks = src.split("<button").slice(1);
  const orbs = chunks.filter(chunk => chunk.slice(0, 400).includes("sidebar-orb"));
  // App owns the two mobile lifecycle orbs; desktop lifecycle actions carry text.
  expect(orbs.length).toBe(2);
  for (const orb of orbs) expect(orb.slice(0, 400)).toContain("aria-label");
});

test("the restart action comes from the shared hook, not an inline duplicate", () => {
  // The models page reuses the same controller; a second inline implementation
  // would drift on the four-branch message mapping. The hook now also takes an
  // options object, so match the call rather than one exact argument list.
  expect(src).toContain("useCodexRestart(API_BASE");
  expect(src).not.toContain("requestCodexRestart(");
});

test("the desktop stop row inherits the same icon width and gap as Theme", () => {
  const rule = css.slice(css.indexOf(".theme-toggle {"), css.indexOf(".theme-toggle:hover"));
  expect(rule).toContain("gap: 9px");
  expect(rule).toContain("padding: 8px 10px");
  expect(css).not.toContain(".sidebar-action-row");
});

test("mobile orbs keep a 44px touch target", () => {
  const block = css.slice(css.indexOf(".mobile-topbar-actions"));
  expect(block).toContain("44px");
});


/**
 * Outcome-message and consent assertions. Kept here rather than in a second file so
 * one suite owns the sidebar restart surface.
 */
const hook = await Bun.file(new URL("../src/use-codex-restart.ts", import.meta.url)).text();
const { en } = await import("../src/i18n/en");

test("the restart action is confirm-gated before any request leaves", () => {
  // This can interrupt an in-flight Codex turn. The startup path deliberately
  // refuses to assume that consent; a click is where it is actually given.
  const confirmAt = hook.indexOf("dash.codexRestartConfirm");
  const requestAt = hook.indexOf("requestCodexRestart(");
  expect(confirmAt).toBeGreaterThan(-1);
  expect(requestAt).toBeGreaterThan(confirmAt);
});

test("each response code maps to its own message", () => {
  for (const key of [
    "dash.codexRestartDone",
    "dash.codexRestartNothing",
    "dash.codexRestartUnknown",
    "dash.codexRestartPartial",
  ]) {
    expect(hook).toContain(key);
  }
});

test("the hook reports the code, so a caller can refresh on the nothing_running race", () => {
  // A boolean "stopped" would leave a staleness banner up after nothing_running,
  // which is a SUCCESSFUL outcome.
  expect(hook).toContain("CodexRestartCode | null");
});

test("every restart string exists in the English source with its slots intact", () => {
  for (const key of [
    "dash.actions",
    "dash.codexRestart",
    "dash.codexRestarting",
    "dash.codexRestartConfirm",
    "dash.codexRestartDone",
    "dash.codexRestartNothing",
    "dash.codexRestartUnknown",
    "dash.codexRestartPartial",
    "dash.codexRestartFailed",
    "dash.codexRestartUnreachable",
    "dash.codexRestartMalformed",
  ]) {
    expect(en[key as keyof typeof en]).toBeTruthy();
  }
  expect(en["dash.codexRestartDone"]).toContain("{count}");
  expect(en["dash.codexRestartPartial"]).toContain("{count}");
  expect(en["dash.codexRestartFailed"]).toContain("{status}");
});
