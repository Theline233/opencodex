import { randomUUID } from "node:crypto";
import type { OcxConfig } from "../types";
import { jsonResponse } from "../server/auth-cors";
import {
  managementBodyTooLargeResponse,
  readManagementJsonBody,
  rethrowManagementBodyTooLarge,
} from "../server/management/body";
import { codexExecInvocation } from "./exec-invocation";
import { NativeProfileManager } from "./native-profile-manager";
import { switchNativeMainProfileWithDrain } from "./native-profile-api";
import { NativeProfileError } from "./native-profile-types";
import { resolveAndPersistCodexRuntime } from "./runtime";

const DEVICE_LOGIN_TTL_MS = 15 * 60_000;
const TERMINAL_FLOW_TTL_MS = 5 * 60_000;
const START_OUTPUT_TIMEOUT_MS = 20_000;
const MAX_DEVICE_LOGIN_OUTPUT_CHARS = 32 * 1024;
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const DEVICE_URL_RE = /https?:\/\/[^\s]+/i;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;

export type NativeMainDeviceLoginStatus = "waiting" | "activating" | "done" | "error" | "cancelled";

export interface NativeMainDeviceLoginPublicState {
  flowId: string;
  status: NativeMainDeviceLoginStatus;
  verificationUri?: string;
  userCode?: string;
  expiresAt: number;
  error?: string;
}

interface DeviceLoginChild {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

interface DeviceLoginStage {
  stageId: string;
  writerToken: string;
  stagingCodexHome: string;
  heartbeatIntervalMs: number;
}

interface DeviceLoginFlow {
  id: string;
  status: NativeMainDeviceLoginStatus;
  manager: NativeProfileManager;
  stage: DeviceLoginStage;
  child: DeviceLoginChild;
  output: string;
  verificationUri?: string;
  userCode?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
  doneAt?: number;
  heartbeat?: ReturnType<typeof setInterval>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  heartbeatBusy: boolean;
  cancelRequested: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
}

export interface NativeMainDeviceLoginDeps {
  managerFactory?: () => NativeProfileManager;
  now?: () => number;
  randomId?: () => string;
  resolveRuntime?: typeof resolveAndPersistCodexRuntime;
  spawn?: (command: string[], options: {
    env: NodeJS.ProcessEnv;
    stdin: "ignore";
    stdout: "pipe";
    stderr: "pipe";
    windowsVerbatimArguments?: boolean;
  }) => DeviceLoginChild;
  switchProfile?: typeof switchNativeMainProfileWithDrain;
  deviceLoginTtlMs?: number;
}

export function parseCodexDeviceLoginOutput(raw: string): { verificationUri?: string; userCode?: string } {
  const plain = raw.replace(ANSI_ESCAPE_RE, "");
  const verificationUri = plain.match(DEVICE_URL_RE)?.[0]?.replace(/[),.;]+$/, "");
  const userCode = plain.match(DEVICE_CODE_RE)?.[0];
  return {
    ...(verificationUri ? { verificationUri } : {}),
    ...(userCode ? { userCode } : {}),
  };
}

function publicState(flow: DeviceLoginFlow): NativeMainDeviceLoginPublicState {
  const waiting = flow.status === "waiting";
  return {
    flowId: flow.id,
    status: flow.status,
    ...(waiting && flow.verificationUri ? { verificationUri: flow.verificationUri } : {}),
    ...(waiting && flow.userCode ? { userCode: flow.userCode } : {}),
    expiresAt: flow.expiresAt,
    ...(flow.error ? { error: flow.error } : {}),
  };
}

function safeLoginError(error: unknown): string {
  if (error instanceof NativeProfileError) return error.message;
  return "Main account login failed. Retry the device login.";
}

function profileLabel(prefix: string, now: number): string {
  return `${prefix} ${new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

export class NativeMainDeviceLoginController {
  private readonly flows = new Map<string, DeviceLoginFlow>();
  private readonly deps: NativeMainDeviceLoginDeps;

  constructor(deps: NativeMainDeviceLoginDeps = {}) {
    this.deps = deps;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private prune(): void {
    const now = this.now();
    for (const [id, flow] of this.flows) {
      if (flow.doneAt !== undefined && now - flow.doneAt >= TERMINAL_FLOW_TTL_MS) this.flows.delete(id);
    }
  }

  private appendOutput(flow: DeviceLoginFlow, chunk: string): void {
    flow.output = `${flow.output}${chunk}`.slice(-MAX_DEVICE_LOGIN_OUTPUT_CHARS);
    const parsed = parseCodexDeviceLoginOutput(flow.output);
    if (parsed.verificationUri) flow.verificationUri = parsed.verificationUri;
    if (parsed.userCode) flow.userCode = parsed.userCode;
    if (flow.verificationUri && flow.userCode) flow.resolveReady();
  }

  private async consume(stream: ReadableStream<Uint8Array> | null, flow: DeviceLoginFlow): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        this.appendOutput(flow, decoder.decode(result.value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) this.appendOutput(flow, tail);
    } catch {
      // Child exit and the public flow status are authoritative.
    } finally {
      reader.releaseLock();
    }
  }

  private stopHeartbeat(flow: DeviceLoginFlow): void {
    if (flow.heartbeat) clearInterval(flow.heartbeat);
    flow.heartbeat = undefined;
  }

  private stopExpiryTimer(flow: DeviceLoginFlow): void {
    if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
    flow.expiryTimer = undefined;
  }

  private expire(flow: DeviceLoginFlow): void {
    if (flow.status !== "waiting") return;
    flow.status = "error";
    flow.error = "The Codex device login code expired. Start a new login.";
    flow.doneAt = this.now();
    this.stopHeartbeat(flow);
    this.stopExpiryTimer(flow);
    try { flow.child.kill(); } catch { /* settle() still performs stage cleanup */ }
    void this.cancelStage(flow);
    flow.resolveReady();
  }

  private startHeartbeat(flow: DeviceLoginFlow): void {
    const interval = Math.max(5_000, Math.min(flow.stage.heartbeatIntervalMs, 60_000));
    flow.heartbeat = setInterval(() => {
      if (flow.heartbeatBusy || flow.status !== "waiting") return;
      flow.heartbeatBusy = true;
      void flow.manager.heartbeatStage(flow.stage.stageId, flow.stage.writerToken)
        .catch(async error => {
          if (flow.status !== "waiting") return;
          flow.error = safeLoginError(error);
          flow.status = "error";
          flow.doneAt = this.now();
          flow.resolveReady();
          try { flow.child.kill(); } catch { /* child exit settles below */ }
        })
        .finally(() => { flow.heartbeatBusy = false; });
    }, interval);
  }

  private async cancelStage(flow: DeviceLoginFlow): Promise<void> {
    try {
      await flow.manager.cancelStage(flow.stage.stageId, flow.stage.writerToken);
    } catch {
      // A successful refresh/import already removed the stage; terminal cleanup is idempotent here.
    }
  }

  private async settle(flow: DeviceLoginFlow): Promise<void> {
    const exitCode = await flow.child.exited.catch(() => -1);
    this.stopHeartbeat(flow);
    this.stopExpiryTimer(flow);
    if (flow.cancelRequested || flow.status === "cancelled") {
      await this.cancelStage(flow);
      flow.resolveReady();
      return;
    }
    if (exitCode !== 0) {
      await this.cancelStage(flow);
      if (flow.status !== "error") {
        flow.status = "error";
        flow.error = "Codex device login did not complete.";
        flow.doneAt = this.now();
      }
      flow.resolveReady();
      return;
    }

    flow.status = "activating";
    flow.resolveReady();
    try {
      const refreshed = await flow.manager.refreshActiveFromStage(flow.stage.stageId, flow.stage.writerToken);
      if (!refreshed.refreshed) {
        const imported = await flow.manager.finishStage(
          flow.stage.stageId,
          flow.stage.writerToken,
          profileLabel("Web login", flow.createdAt),
        );
        await (this.deps.switchProfile ?? switchNativeMainProfileWithDrain)(flow.manager, imported.profile.id);
      }
      flow.status = "done";
      flow.doneAt = this.now();
    } catch (error) {
      await this.cancelStage(flow);
      flow.status = "error";
      flow.error = safeLoginError(error);
      flow.doneAt = this.now();
    }
  }

  async start(): Promise<NativeMainDeviceLoginPublicState> {
    this.prune();
    const active = [...this.flows.values()].find(flow => flow.doneAt === undefined);
    if (active) throw new NativeProfileError("NATIVE_PROFILE_BUSY", "A main account login is already in progress.", 409, true);

    const manager = (this.deps.managerFactory ?? (() => new NativeProfileManager()))();
    const now = this.now();
    const ttlMs = this.deps.deviceLoginTtlMs ?? DEVICE_LOGIN_TTL_MS;
    const listed = await manager.list();
    if (listed.profiles.length === 0) await manager.register(profileLabel("Pre-login backup", now));
    const stage = await manager.prepareStage();
    let child: DeviceLoginChild;
    try {
      const runtime = (this.deps.resolveRuntime ?? resolveAndPersistCodexRuntime)({ discoverAlternatives: false }).runtime;
      const invocation = codexExecInvocation(runtime.command || "codex", ["login", "--device-auth"]);
      const spawn = this.deps.spawn ?? ((command, options) => Bun.spawn(command, options) as unknown as DeviceLoginChild);
      child = spawn([invocation.file, ...invocation.args], {
        env: { ...process.env, CODEX_HOME: stage.stagingCodexHome },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      await manager.cancelStage(stage.stageId, stage.writerToken).catch(() => {});
      throw error;
    }

    let resolveReady = () => {};
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const flow: DeviceLoginFlow = {
      id: (this.deps.randomId ?? randomUUID)(),
      status: "waiting",
      manager,
      stage,
      child,
      output: "",
      createdAt: now,
      expiresAt: now + ttlMs,
      heartbeatBusy: false,
      cancelRequested: false,
      ready,
      resolveReady,
    };
    this.flows.set(flow.id, flow);
    this.startHeartbeat(flow);
    flow.expiryTimer = setTimeout(() => this.expire(flow), ttlMs);
    void this.consume(child.stdout, flow);
    void this.consume(child.stderr, flow);
    void this.settle(flow);

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      flow.ready,
      new Promise<void>(resolve => { startTimer = setTimeout(resolve, START_OUTPUT_TIMEOUT_MS); }),
    ]);
    if (startTimer) clearTimeout(startTimer);
    if (!flow.verificationUri || !flow.userCode) {
      await this.cancel(flow.id);
      throw new NativeProfileError("INTERNAL_ERROR", flow.error ?? "Codex did not provide a device login code.", 502, true);
    }
    return publicState(flow);
  }

  status(flowId: string): NativeMainDeviceLoginPublicState {
    this.prune();
    const flow = this.flows.get(flowId);
    if (!flow) throw new NativeProfileError("PROFILE_NOT_FOUND", "Main account login flow not found.", 404);
    return publicState(flow);
  }

  async cancel(flowId: string): Promise<{ ok: true }> {
    this.prune();
    const flow = this.flows.get(flowId);
    if (!flow) return { ok: true };
    if (flow.status === "done" || flow.status === "error" || flow.status === "cancelled") return { ok: true };
    flow.cancelRequested = true;
    flow.status = "cancelled";
    flow.doneAt = this.now();
    this.stopHeartbeat(flow);
    this.stopExpiryTimer(flow);
    try { flow.child.kill(); } catch { /* cleanup below remains authoritative */ }
    await this.cancelStage(flow);
    flow.resolveReady();
    return { ok: true };
  }
}

const defaultController = new NativeMainDeviceLoginController();

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await readManagementJsonBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
    return parsed as Record<string, unknown>;
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    throw new NativeProfileError("INVALID_REQUEST", "A JSON object body is required.", 400);
  }
}

export async function handleNativeMainDeviceLoginAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
  controller: NativeMainDeviceLoginController = defaultController,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/native-main-login")) return null;
  try {
    if (url.pathname === "/api/native-main-login/start" && req.method === "POST") {
      return jsonResponse(await controller.start(), 200, req, config);
    }
    if (url.pathname === "/api/native-main-login/status" && req.method === "GET") {
      const flowId = url.searchParams.get("flowId")?.trim();
      if (!flowId) throw new NativeProfileError("INVALID_REQUEST", "A login flow id is required.", 400);
      return jsonResponse(controller.status(flowId), 200, req, config);
    }
    if (url.pathname === "/api/native-main-login/cancel" && req.method === "POST") {
      const input = await requestBody(req);
      if (typeof input.flowId !== "string") throw new NativeProfileError("INVALID_REQUEST", "A login flow id is required.", 400);
      return jsonResponse(await controller.cancel(input.flowId), 200, req, config);
    }
    return jsonResponse({ error: "Unknown main account login operation", code: "INVALID_REQUEST" }, 404, req, config);
  } catch (error) {
    const tooLarge = managementBodyTooLargeResponse(error, req, config);
    if (tooLarge) return tooLarge;
    if (error instanceof NativeProfileError) {
      return jsonResponse({ error: error.message, code: error.code, retryable: error.retryable }, error.status, req, config);
    }
    return jsonResponse({ error: safeLoginError(error), code: "INTERNAL_ERROR" }, 500, req, config);
  }
}
