import { exec } from "node:child_process";

export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type DeviceTokenOk = {
  access_token: string;
  token_type: string;
  ingest_key: string;
  project_id: string;
  user: string;
  org: string;
  gateway_url: string;
};

export async function startDevice(gatewayUrl: string): Promise<DeviceStart> {
  const r = await fetch(`${gatewayUrl}/oauth/device`, { method: "POST" });
  if (!r.ok) throw new Error(`device start failed (${r.status})`);
  return (await r.json()) as DeviceStart;
}

export async function pollDeviceToken(
  gatewayUrl: string,
  deviceCode: string,
  opts: { intervalSec: number; timeoutMs: number; signal?: AbortSignal },
): Promise<DeviceTokenOk> {
  const deadline = Date.now() + opts.timeoutMs;
  const wait = Math.max(1, opts.intervalSec) * 1000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const r = await fetch(`${gatewayUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (r.status === 200) return (await r.json()) as DeviceTokenOk;
    if (r.status === 428) {
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `token poll failed (${r.status})`);
  }
  throw new Error("device code expired before approval");
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
