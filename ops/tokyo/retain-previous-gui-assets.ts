import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const ASSET_DIR = join("gui", "dist", "assets");
export const GUI_NATIVE_ASSET_MANIFEST = ".opencodex-gui-native-assets.json";

function assetDirectory(releaseRoot: string): string {
  return join(releaseRoot, ASSET_DIR);
}

function safeAssetName(name: unknown): name is string {
  return typeof name === "string"
    && name.length > 0
    && name !== "."
    && name !== ".."
    && basename(name) === name
    && !name.includes("/")
    && !name.includes("\\");
}

function directAssets(releaseRoot: string): string[] {
  const directory = assetDirectory(releaseRoot);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && safeAssetName(entry.name))
    .map(entry => entry.name)
    .sort();
}

function nativeAssets(releaseRoot: string): string[] {
  const manifest = join(releaseRoot, GUI_NATIVE_ASSET_MANIFEST);
  if (!existsSync(manifest)) return directAssets(releaseRoot);
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(safeAssetName))].sort();
  } catch {
    return [];
  }
}

export function retainPreviousGuiAssets(
  nextRelease: string,
  priorReleases: string[],
): { native: string[]; retained: string[] } {
  const nextAssets = assetDirectory(nextRelease);
  if (!existsSync(nextAssets) || !statSync(nextAssets).isDirectory()) {
    throw new Error(`next GUI assets directory is missing: ${nextAssets}`);
  }

  // Snapshot the new build before copying anything. Future deployments use
  // this manifest so retained files never become "native" and accumulate.
  const native = directAssets(nextRelease);
  writeFileSync(
    join(nextRelease, GUI_NATIVE_ASSET_MANIFEST),
    JSON.stringify(native, null, 2) + "\n",
  );

  const retained: string[] = [];
  const seenPrior = new Set<string>();
  for (const priorRelease of priorReleases) {
    if (!priorRelease || priorRelease === nextRelease || seenPrior.has(priorRelease)) continue;
    seenPrior.add(priorRelease);
    const priorAssets = assetDirectory(priorRelease);
    if (!existsSync(priorAssets)) continue;
    for (const name of nativeAssets(priorRelease)) {
      const source = join(priorAssets, name);
      if (!existsSync(source) || !statSync(source).isFile()) continue;
      try {
        copyFileSync(source, join(nextAssets, name), constants.COPYFILE_EXCL);
        retained.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  return { native, retained: retained.sort() };
}

if (import.meta.main) {
  const [nextRelease, ...priorReleases] = process.argv.slice(2);
  if (!nextRelease) throw new Error("usage: retain-previous-gui-assets.ts NEXT_RELEASE [PRIOR_RELEASE...]");
  const result = retainPreviousGuiAssets(nextRelease, priorReleases);
  console.log(`GUI_ASSETS_RETAINED native=${result.native.length} previous=${result.retained.length}`);
}

