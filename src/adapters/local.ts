import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSigner, almaIdentitySchema, createIssuerKeyset, delegationSchema, type AlmaIdentity, type Delegation } from "@adasouls/alma-core";
import { parseManifestYaml, type AgentManifest, type ManifestSelfPolicyRules } from "@adasouls/alma-manifest";
import type { Facts, HistoryFacts } from "../core/types.js";

/**
 * Reads a project the ALMA CLI connected: `alma.yaml` next to the code
 * and the `.alma/` folder (identity, delegations, the project's own
 * signed receipts and log). Everything stays on this machine.
 *
 * A file that is there but unreadable is an error, not a missing fact:
 * a verification must not quietly skip what it couldn't parse.
 */
export const storeDir = (cwd: string) => join(cwd, ".alma");
export const localIssuer = (almaId: string) => `self:${almaId}`;

function json(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

export function readIdentity(cwd: string): AlmaIdentity | undefined {
  const raw = json(join(storeDir(cwd), "identity.json"));
  if (raw === undefined) return undefined;
  const parsed = almaIdentitySchema.safeParse(raw);
  if (!parsed.success) throw new Error(".alma/identity.json is not an ALMA identity");
  return parsed.data;
}

export function readDelegations(cwd: string): Delegation[] {
  const raw = json(join(storeDir(cwd), "delegations.json"));
  if (raw === undefined) return [];
  const parsed = delegationSchema.array().safeParse(raw);
  if (!parsed.success) throw new Error(".alma/delegations.json is not a list of ALMA delegations");
  return parsed.data;
}

export function readManifest(cwd: string): AgentManifest | undefined {
  const path = join(cwd, "alma.yaml");
  return existsSync(path) ? parseManifestYaml(readFileSync(path, "utf-8")) : undefined;
}

/** An organization's rules, as a file with the same `authority` keys as alma.yaml (or a whole manifest). */
export function readRulesFile(path: string): ManifestSelfPolicyRules {
  const text = readFileSync(path, "utf-8");
  if (/^kind:\s*Agent/m.test(text)) return parseManifestYaml(text).authority ?? {};
  return parseManifestYaml(`kind: Agent\nversion: alma/v1\nmetadata:\n  name: rules\nidentity:\n  type: agent\ncapabilities: [pay]\nauthority:\n${text.replace(/^/gm, "  ")}`).authority ?? {};
}

export async function loadSigner(cwd: string): Promise<LocalSigner | undefined> {
  const path = join(storeDir(cwd), "issuer.key");
  return existsSync(path) ? LocalSigner.fromPkcs8(new Uint8Array(readFileSync(path))) : undefined;
}

export interface LocalReceipt {
  id: string;
  statement: unknown;
  mint: unknown;
  selfAttested: true;
}

export function readReceipts(cwd: string): LocalReceipt[] {
  const path = join(storeDir(cwd), "receipts.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as LocalReceipt;
      } catch {
        throw new Error(`.alma/receipts.jsonl line ${i + 1} is not valid JSON`);
      }
    });
}

export interface LocalLog {
  log: string;
  size: number;
  frontier: string[];
  leaves: string[];
}
export const readLog = (cwd: string) => json(join(storeDir(cwd), "log.json")) as LocalLog | undefined;

async function readHistory(cwd: string, identity: AlmaIdentity): Promise<HistoryFacts | undefined> {
  const signer = await loadSigner(cwd);
  const receipts = readReceipts(cwd);
  const log = readLog(cwd);
  if (!signer) {
    // Receipts with no key to check them against can't be called verified; no receipts and no key is just "no history".
    return receipts.length === 0 && !log ? { receipts: [], keyset: new Map() } : { receipts, keyset: new Map(), log };
  }
  const keyset = await createIssuerKeyset([{ iss: localIssuer(identity.id), publicKey: Buffer.from(signer.publicKey).toString("base64url") }]);
  return { receipts, keyset, log };
}

/** The facts a project's own files give. Custody is not among them: where the funds are is read from the chain. */
export async function readProject(cwd: string, now = new Date()): Promise<Pick<Facts, "identity" | "delegations" | "manifest" | "history" | "now">> {
  const identity = readIdentity(cwd);
  return { identity, delegations: readDelegations(cwd), manifest: readManifest(cwd), history: identity ? await readHistory(cwd, identity) : undefined, now };
}
