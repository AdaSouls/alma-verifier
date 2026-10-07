import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSigner, createDelegation, createIdentity, type AlmaIdentity, type Delegation } from "@adasouls/alma-core";
import { buildManifest, stringifyManifest, type AgentManifest, type ManifestSelfPolicyRules } from "@adasouls/alma-manifest";
import type { CustodyFacts, Facts } from "../src/core/types.js";

export const NOW = new Date("2026-10-07T12:00:00Z");
export const ORG = "alma:main:org:acme";
export const WALLET = "0x1111111111111111111111111111111111111111";
export const SIGNER = "0x2222222222222222222222222222222222222222";
export const OWNER_A = "0x3333333333333333333333333333333333333333";
export const OWNER_B = "0x4444444444444444444444444444444444444444";
export const PAYEE = "0x5555555555555555555555555555555555555555";

export const LIMITS: ManifestSelfPolicyRules = { maxTransaction: { USDC: "100" }, dailySpend: { USDC: "500" }, humanApprovalThreshold: { USDC: "50" }, allowedAssets: ["USDC"] };

export function agent(overrides: Partial<{ name: string; wallet: string; principal: string | undefined }> = {}): AlmaIdentity {
  return createIdentity({ subjectType: "agent", displayName: overrides.name ?? "Shopper", localId: "shopper", principal: "principal" in overrides ? overrides.principal : ORG, controllers: [{ type: "wallet", value: overrides.wallet ?? WALLET }] });
}

export function delegation(identity: AlmaIdentity, rules: ManifestSelfPolicyRules = LIMITS, expiresAt: string | null = "2027-01-01T00:00:00.000Z"): Delegation {
  return createDelegation({ issuer: identity.principal ?? ORG, subject: identity.id, scope: { capabilities: ["pay"], constraints: rules }, expiresAt: expiresAt ?? undefined });
}

export function manifest(rules: ManifestSelfPolicyRules = LIMITS, name = "Shopper", counterparty = true): AgentManifest {
  return buildManifest({ name, capabilities: ["pay"], selfPolicy: rules as never, ...(counterparty ? { counterpartyPolicy: { allowlist: ["alma:main:agent:supplier"] } } : {}) });
}

/** A fully connected agent, with no custody facts yet. */
export function connected(overrides: Partial<Facts> = {}): Facts {
  const identity = agent();
  return { identity, delegations: [delegation(identity)], manifest: manifest(), now: NOW, ...overrides };
}

export const eoa = (): CustodyFacts => ({ chain: "eip155:31337", wallet: WALLET, walletKind: "eoa", agentSigner: WALLET, otherFunds: [] });
export const safe = (over: Partial<NonNullable<CustodyFacts["safe"]>> = {}, more: Partial<CustodyFacts> = {}): CustodyFacts => ({
  chain: "eip155:31337",
  wallet: WALLET,
  walletKind: "safe",
  agentSigner: SIGNER,
  otherFunds: [],
  safe: { owners: [OWNER_A, OWNER_B], threshold: 2, allowanceModuleEnabled: true, allowances: { USDC: { amount: "500", resetMinutes: 1440 } }, ...over },
  ...more,
});

/** A project on disk, in the files the ALMA CLI writes. */
export async function project(options: { rules?: ManifestSelfPolicyRules; counterparty?: boolean; name?: string } = {}): Promise<{ cwd: string; identity: AlmaIdentity; signer: LocalSigner }> {
  const cwd = mkdtempSync(join(tmpdir(), "alma-verifier-"));
  const identity = agent({ name: options.name });
  const signer = await LocalSigner.generate();
  mkdirSync(join(cwd, ".alma"));
  writeFileSync(join(cwd, ".alma", "identity.json"), JSON.stringify(identity));
  writeFileSync(join(cwd, ".alma", "delegations.json"), JSON.stringify([delegation(identity, options.rules ?? LIMITS)]));
  writeFileSync(join(cwd, ".alma", "issuer.key"), await signer.exportPkcs8(), { mode: 0o600 });
  writeFileSync(join(cwd, "alma.yaml"), stringifyManifest(manifest(options.rules ?? LIMITS, options.name, options.counterparty ?? false)));
  return { cwd, identity, signer };
}
