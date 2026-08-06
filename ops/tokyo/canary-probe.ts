import { readFileSync } from "node:fs";

type ProbeConfig = {
  apiKeys?: Array<{ key?: unknown }>;
};

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

const baseUrl = argument("--url", "http://127.0.0.1:10101").replace(/\/$/, "");
const configPath = argument("--config", `${process.env.HOME}/.opencodex/config.json`);
const model = argument("--model", "deepseek/deepseek-v4-flash");
const timeoutMs = Number.parseInt(argument("--timeout-ms", "45000"), 10);

const config = JSON.parse(readFileSync(configPath, "utf8")) as ProbeConfig;
const apiKey = config.apiKeys?.find(entry => typeof entry?.key === "string")?.key;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("probe timed out")), timeoutMs);
const startedAt = Date.now();

try {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(typeof apiKey === "string" ? { "x-opencodex-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      model,
      input: "Reply with exactly OK.",
      stream: true,
      store: false,
    }),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunks = 0;
  let completed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    buffer = (buffer + decoder.decode(value, { stream: true })).slice(-64_000);
    if (/"type"\s*:\s*"(?:response\.failed|error)"/.test(buffer)) {
      throw new Error("upstream returned a failed response event");
    }
    if (/"type"\s*:\s*"response\.completed"/.test(buffer)) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error("stream ended without response.completed");
  console.log(`DEEPSEEK_PROBE_OK elapsed_ms=${Date.now() - startedAt} chunks=${chunks}`);
} finally {
  clearTimeout(timeout);
}
