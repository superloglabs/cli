import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type StoredAuth = {
  token: string;
  ingestKey: string;
  projectId: string;
  gatewayUrl: string;
  user: string;
  org: string;
};

const DIR = path.join(os.homedir(), ".config", "superlog");
const FILE = path.join(DIR, "auth.json");

export function loadAuth(): StoredAuth | null {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (
      !parsed.token ||
      !parsed.ingestKey ||
      !parsed.projectId ||
      !parsed.gatewayUrl ||
      !parsed.user ||
      !parsed.org
    )
      return null;
    return parsed as StoredAuth;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
}
