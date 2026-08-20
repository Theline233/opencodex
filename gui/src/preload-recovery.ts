const PRELOAD_GUARD_PREFIX = "ocx-preload-reload:";

type StorageLike = Pick<Storage, "length" | "getItem" | "key" | "removeItem" | "setItem">;
type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export function installVitePreloadRecovery(options: {
  buildKey: string;
  target?: EventTargetLike;
  storage?: StorageLike;
  reload?: () => void;
}): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const guardKey = PRELOAD_GUARD_PREFIX + options.buildKey;
  let reloadRequested = false;

  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(PRELOAD_GUARD_PREFIX) && key !== guardKey) storage.removeItem(key);
    }
    reloadRequested = storage.getItem(guardKey) === "1";
  } catch {
    // sessionStorage can be blocked. The in-memory flag still prevents two
    // reload calls from the same page lifetime.
  }

  const onPreloadError = (event: Event) => {
    // Vite otherwise rethrows the failed dynamic import after this event.
    event.preventDefault();
    if (reloadRequested) return;
    reloadRequested = true;
    try {
      storage.setItem(guardKey, "1");
    } catch {
      // Best effort. The module-level lifetime guard above still applies.
    }
    reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

