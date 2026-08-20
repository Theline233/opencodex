import { expect, test } from "bun:test";
import { installVitePreloadRecovery } from "../src/preload-recovery";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("a stale dynamic import reloads once and prevents the rejected module error", () => {
  const target = new EventTarget();
  const storage = new MemoryStorage();
  let reloads = 0;
  const uninstall = installVitePreloadRecovery({
    target,
    storage,
    buildKey: "entry-old.js",
    reload: () => { reloads += 1; },
  });

  const first = new Event("vite:preloadError", { cancelable: true });
  target.dispatchEvent(first);
  expect(first.defaultPrevented).toBe(true);
  expect(reloads).toBe(1);

  const duplicate = new Event("vite:preloadError", { cancelable: true });
  target.dispatchEvent(duplicate);
  expect(duplicate.defaultPrevented).toBe(true);
  expect(reloads).toBe(1);

  uninstall();
  target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
  expect(reloads).toBe(1);
});

test("a new entry build may recover once and removes stale build guards", () => {
  const target = new EventTarget();
  const storage = new MemoryStorage();
  storage.setItem("ocx-preload-reload:entry-old.js", "1");
  let reloads = 0;

  installVitePreloadRecovery({
    target,
    storage,
    buildKey: "entry-new.js",
    reload: () => { reloads += 1; },
  });
  target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

  expect(reloads).toBe(1);
  expect(storage.getItem("ocx-preload-reload:entry-old.js")).toBeNull();
  expect(storage.getItem("ocx-preload-reload:entry-new.js")).toBe("1");
});

test("the GUI entry installs recovery before rendering routes", async () => {
  const main = await Bun.file(new URL("../src/main.tsx", import.meta.url)).text();
  expect(main).toContain("installVitePreloadRecovery");
  expect(main.indexOf("installVitePreloadRecovery")).toBeLessThan(main.indexOf("ReactDOM.createRoot"));
});

