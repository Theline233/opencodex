import { describe, expect, test } from "bun:test";
import {
  NativeMainDeviceLoginController,
  parseCodexDeviceLoginOutput,
} from "../src/codex/native-main-device-login";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";

function outputStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function deferredExit() {
  let resolve!: (code: number) => void;
  return { promise: new Promise<number>(done => { resolve = done; }), resolve };
}

describe("native main device login", () => {
  test("parses ANSI-colored official Codex device login output", () => {
    const parsed = parseCodexDeviceLoginOutput(
      "Open \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m then enter \u001b[94mABCD-EFGHJ\u001b[0m",
    );
    expect(parsed).toEqual({
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHJ",
    });
  });

  test("same-identity device login refreshes the active main profile", async () => {
    const exit = deferredExit();
    let refreshed = 0;
    let cancelled = 0;
    const manager = {
      list: async () => ({ profiles: [{ id: "active", label: "main", identityHint: "hint", state: "active" }], activeProfileId: "active", effectiveCodexHome: "/codex" }),
      register: async () => { throw new Error("register should not run"); },
      prepareStage: async () => ({ stageId: "stage", writerToken: "writer", stagingCodexHome: "/stage", effectiveCodexHome: "/codex", leaseExpiresAt: Date.now() + 60_000, heartbeatIntervalMs: 60_000 }),
      heartbeatStage: async () => ({ ok: true as const, leaseExpiresAt: Date.now() + 60_000 }),
      refreshActiveFromStage: async () => { refreshed += 1; return { refreshed: true, effectiveCodexHome: "/codex" }; },
      finishStage: async () => { throw new Error("finish should not run"); },
      cancelStage: async () => { cancelled += 1; return { removed: true, plaintextMayRemain: false }; },
    } as unknown as NativeProfileManager;
    const controller = new NativeMainDeviceLoginController({
      managerFactory: () => manager,
      randomId: () => "flow",
      resolveRuntime: () => ({ runtime: { command: "codex", version: "0.146.0", source: "configured" }, failures: [] }),
      spawn: command => {
        expect(command.slice(-2)).toEqual(["login", "--device-auth"]);
        return {
          stdout: outputStream("Open https://auth.openai.com/codex/device and enter ABCD-EFGHJ"),
          stderr: null,
          exited: exit.promise,
          kill: () => {},
        };
      },
    });

    const started = await controller.start();
    expect(started).toMatchObject({ flowId: "flow", status: "waiting", userCode: "ABCD-EFGHJ" });
    exit.resolve(0);
    for (let attempt = 0; attempt < 100 && controller.status("flow").status !== "done"; attempt += 1) await Bun.sleep(1);
    expect(controller.status("flow").status).toBe("done");
    expect(controller.status("flow").userCode).toBeUndefined();
    expect(refreshed).toBe(1);
    expect(cancelled).toBe(0);
  });

  test("different-identity device login imports and switches the new profile", async () => {
    const exit = deferredExit();
    let switched = "";
    const manager = {
      list: async () => ({ profiles: [{ id: "active", label: "main", identityHint: "hint", state: "active" }], activeProfileId: "active", effectiveCodexHome: "/codex" }),
      prepareStage: async () => ({ stageId: "stage", writerToken: "writer", stagingCodexHome: "/stage", effectiveCodexHome: "/codex", leaseExpiresAt: Date.now() + 60_000, heartbeatIntervalMs: 60_000 }),
      heartbeatStage: async () => ({ ok: true as const, leaseExpiresAt: Date.now() + 60_000 }),
      refreshActiveFromStage: async () => ({ refreshed: false, effectiveCodexHome: "/codex" }),
      finishStage: async () => ({ effectiveCodexHome: "/codex", profile: { id: "new-profile", label: "web", identityHint: "new", state: "inactive" }, plaintextMayRemain: false as const }),
      cancelStage: async () => ({ removed: true, plaintextMayRemain: false }),
    } as unknown as NativeProfileManager;
    const controller = new NativeMainDeviceLoginController({
      managerFactory: () => manager,
      randomId: () => "flow-new",
      resolveRuntime: () => ({ runtime: { command: "codex", version: "0.146.0", source: "configured" }, failures: [] }),
      spawn: () => ({
        stdout: outputStream("https://auth.openai.com/codex/device ABCD-EFGHJ"),
        stderr: null,
        exited: exit.promise,
        kill: () => {},
      }),
      switchProfile: async (_manager, target) => { switched = target; return { ok: true }; },
    });

    await controller.start();
    exit.resolve(0);
    for (let attempt = 0; attempt < 100 && controller.status("flow-new").status !== "done"; attempt += 1) await Bun.sleep(1);
    expect(controller.status("flow-new").status).toBe("done");
    expect(switched).toBe("new-profile");
  });

  test("runtime discovery failure securely cancels the staged login", async () => {
    let cancelled = 0;
    const manager = {
      list: async () => ({ profiles: [{ id: "active", label: "main", identityHint: "hint", state: "active" }], activeProfileId: "active", effectiveCodexHome: "/codex" }),
      prepareStage: async () => ({ stageId: "stage", writerToken: "writer", stagingCodexHome: "/stage", effectiveCodexHome: "/codex", leaseExpiresAt: Date.now() + 60_000, heartbeatIntervalMs: 60_000 }),
      cancelStage: async () => { cancelled += 1; return { removed: true, plaintextMayRemain: false }; },
    } as unknown as NativeProfileManager;
    const controller = new NativeMainDeviceLoginController({
      managerFactory: () => manager,
      resolveRuntime: () => { throw new Error("runtime unavailable"); },
    });

    expect(controller.start()).rejects.toThrow("runtime unavailable");
    await Bun.sleep(0);
    expect(cancelled).toBe(1);
  });

  test("an expired device code terminates the child and cleans its stage", async () => {
    const exit = deferredExit();
    let killed = 0;
    let cancelled = 0;
    const manager = {
      list: async () => ({ profiles: [{ id: "active", label: "main", identityHint: "hint", state: "active" }], activeProfileId: "active", effectiveCodexHome: "/codex" }),
      prepareStage: async () => ({ stageId: "stage", writerToken: "writer", stagingCodexHome: "/stage", effectiveCodexHome: "/codex", leaseExpiresAt: Date.now() + 60_000, heartbeatIntervalMs: 60_000 }),
      heartbeatStage: async () => ({ ok: true as const, leaseExpiresAt: Date.now() + 60_000 }),
      cancelStage: async () => { cancelled += 1; return { removed: true, plaintextMayRemain: false }; },
    } as unknown as NativeProfileManager;
    const controller = new NativeMainDeviceLoginController({
      managerFactory: () => manager,
      randomId: () => "flow",
      deviceLoginTtlMs: 10,
      resolveRuntime: () => ({ runtime: { command: "codex", version: "0.146.0", source: "configured" }, failures: [] }),
      spawn: () => ({
        stdout: outputStream("https://auth.openai.com/codex/device ABCD-EFGHJ"),
        stderr: null,
        exited: exit.promise,
        kill: () => { killed += 1; exit.resolve(1); },
      }),
    });

    await controller.start();
    for (let attempt = 0; attempt < 100 && controller.status("flow").status !== "error"; attempt += 1) await Bun.sleep(1);
    expect(controller.status("flow")).toMatchObject({ status: "error", error: expect.stringContaining("expired") });
    expect(controller.status("flow").userCode).toBeUndefined();
    expect(killed).toBe(1);
    for (let attempt = 0; attempt < 100 && cancelled === 0; attempt += 1) await Bun.sleep(1);
    expect(cancelled).toBeGreaterThan(0);
  });
});
