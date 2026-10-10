import { almaIdentitySchema, delegationSchema } from "@adasouls/alma-core";
import { buildManifest, type AgentManifest, type ManifestCounterpartyPolicyRules, type ManifestSelfPolicyRules } from "@adasouls/alma-manifest";
import { compare, isAmount } from "../core/amounts.js";
import type { Facts } from "../core/types.js";

/**
 * Reads an agent from an ALMA provider (adasouls-api) instead of from a
 * project's files. It takes the two reads the AdaSouls SDK's agent handle
 * already has (`adasouls.agent(id)` fits), so this package asks the API
 * nothing the SDK doesn't.
 *
 * What it can't give: which wallets are bound to the identity (the API
 * doesn't return controllers, so IDN-03 is "unknown") and the agent's
 * receipts (the history checks don't run). Custody is read from the
 * chain, as for a local project.
 */
export interface AgentSource {
  identity(): Promise<{ id: string; subjectType: string; displayName: string; status: string; principal?: string | null; createdAt: string }>;
  authority(): Promise<{ activeDelegations: unknown[]; policySummary: { kind: string; scope: Record<string, unknown>; rules: Record<string, unknown> }[] }>;
}

const AMOUNT_KEYS = ["maxTransaction", "dailySpend", "humanApprovalThreshold"] as const;
const LIST_KEYS = ["allowedAssets", "allowedProtocols", "allowedContracts", "allowedActions"] as const;

/**
 * Several rule sets at the same level, as one: the lowest of each
 * amount, the intersection of each list. Never looser than any of them.
 */
export function tightest(sets: ManifestSelfPolicyRules[]): ManifestSelfPolicyRules {
  const out: ManifestSelfPolicyRules = {};
  for (const rules of sets) {
    for (const key of AMOUNT_KEYS) {
      for (const [asset, amount] of Object.entries(rules[key] ?? {})) {
        const current = out[key]?.[asset];
        // An amount that can't be read is kept, whichever set it came from: the checks then report it, where dropping it would hide it behind a readable one.
        const keep = current === undefined ? amount : !isAmount(current) ? current : !isAmount(amount) ? amount : compare(amount, current) === -1 ? amount : current;
        out[key] = { ...out[key], [asset]: keep };
      }
    }
    for (const key of LIST_KEYS) {
      const list = rules[key];
      if (list) out[key] = out[key] ? out[key]!.filter((v) => list.includes(v)) : [...list];
    }
    if (rules.timeRestrictions && !out.timeRestrictions) out.timeRestrictions = rules.timeRestrictions;
  }
  return out;
}

export type ApiFacts = Pick<Facts, "identity" | "controllersUnknown" | "delegations" | "manifest" | "orgRules" | "now">;

export async function readAgent(agent: AgentSource, now = new Date()): Promise<ApiFacts> {
  const [rawIdentity, authority] = await Promise.all([agent.identity(), agent.authority()]);

  const identity = almaIdentitySchema.safeParse({ ...rawIdentity, principal: rawIdentity.principal ?? undefined, controllers: [] });
  if (!identity.success) throw new Error("the provider's answer is not an ALMA identity");
  const delegations = delegationSchema.array().safeParse(authority.activeDelegations);
  if (!delegations.success) throw new Error("the provider's answer is not a list of ALMA delegations");

  const self = authority.policySummary.filter((p) => p.kind === "self");
  const own = self.filter((p) => typeof p.scope.agentId === "string").map((p) => p.rules as ManifestSelfPolicyRules);
  const org = self.filter((p) => typeof p.scope.agentId !== "string").map((p) => p.rules as ManifestSelfPolicyRules);
  const orgRules = org.length ? tightest(org) : undefined;
  // What the provider's engine applies (policy-engine 0.2): the tightest rule wins whatever level it was set at,
  // so what is set for every agent is a ceiling the agent's own rules can only lower.
  const effective: ManifestSelfPolicyRules = tightest([...org, ...own]);
  const counterparty = authority.policySummary.find((p) => p.kind === "counterparty")?.rules as ManifestCounterpartyPolicyRules | undefined;

  const capabilities = [...new Set(delegations.data.flatMap((d) => d.scope.capabilities))];
  let manifest: AgentManifest | undefined;
  if (capabilities.length) {
    const input = { capabilities, selfPolicy: Object.keys(effective).length ? effective : undefined, counterpartyPolicy: counterparty && Object.keys(counterparty).length ? counterparty : undefined };
    try {
      manifest = buildManifest({ name: identity.data.displayName, ...input });
    } catch {
      // A display name a manifest can't carry says nothing about the limits.
      manifest = buildManifest({ name: "agent", ...input });
    }
  }
  return { identity: identity.data, controllersUnknown: true, delegations: delegations.data, manifest, orgRules, now };
}
