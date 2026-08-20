import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainPreviousGuiAssets } from "../ops/tokyo/retain-previous-gui-assets";

const roots: string[] = [];
const manifestName = ".opencodex-gui-native-assets.json";

function release(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `ocx-assets-${name}-`));
  roots.push(root);
  mkdirSync(join(root, "gui", "dist", "assets"), { recursive: true });
  return root;
}

function asset(root: string, name: string, content = name): void {
  writeFileSync(join(root, "gui", "dist", "assets", name), content);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("retains the two prior native generations without inheriting their older baggage", () => {
  const next = release("next");
  const current = release("current");
  const previous = release("previous");

  asset(next, "next.js");
  asset(current, "current.js");
  asset(current, "older-retained.js");
  writeFileSync(join(current, manifestName), JSON.stringify(["current.js"]));
  // Legacy releases have no manifest; every direct asset is treated as native.
  asset(previous, "previous.js");

  const result = retainPreviousGuiAssets(next, [current, previous]);

  expect(result.native).toEqual(["next.js"]);
  expect(result.retained.sort()).toEqual(["current.js", "previous.js"]);
  expect(Bun.file(join(next, "gui", "dist", "assets", "next.js")).size).toBeGreaterThan(0);
  expect(Bun.file(join(next, "gui", "dist", "assets", "current.js")).size).toBeGreaterThan(0);
  expect(Bun.file(join(next, "gui", "dist", "assets", "previous.js")).size).toBeGreaterThan(0);
  expect(Bun.file(join(next, "gui", "dist", "assets", "older-retained.js")).size).toBe(0);
  expect(JSON.parse(readFileSync(join(next, manifestName), "utf8"))).toEqual(["next.js"]);
});

test("a retained name never overwrites the new build's own hashed asset", () => {
  const next = release("collision-next");
  const current = release("collision-current");
  asset(next, "shared.js", "new");
  asset(current, "shared.js", "old");
  writeFileSync(join(current, manifestName), JSON.stringify(["shared.js"]));

  retainPreviousGuiAssets(next, [current]);

  expect(readFileSync(join(next, "gui", "dist", "assets", "shared.js"), "utf8")).toBe("new");
});

test("the Tokyo prepare step retains both current and previous production assets", async () => {
  const deploy = await Bun.file(new URL("../ops/tokyo/server-deploy.sh", import.meta.url)).text();
  const prepare = deploy.slice(deploy.indexOf("prepare_release()"), deploy.indexOf("validate_canary()"));
  expect(prepare).toContain('prior_target=$(readlink -f -- "$current_link")');
  expect(prepare).toContain('prior_target=$(readlink -f -- "$previous_link")');
  expect(prepare).toContain('retain-previous-gui-assets.ts');
  expect(prepare.indexOf("retain-previous-gui-assets.ts")).toBeLessThan(prepare.lastIndexOf('assert_release_complete "$staging"'));
});
