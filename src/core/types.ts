import type { AlmaIdentity, Delegation, IssuerKeyset } from "@adasouls/alma-core";
import type { AssetInfo } from "./assets.js";
import type { AgentManifest, ManifestSelfPolicyRules } from "@adasouls/alma-manifest";

/**
 * What enforces an agent's limits, from weakest to strongest. An agent's
 * verdict is the highest level actually in place: a soul can only
 * enforce rules where the agent's keys live.
 */
export const VERDICTS = ["UNCONNECTED", "ADVISORY", "CUSTODY-ENFORCED", "CHAIN-ENFORCED"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_MEANING: Record<Verdict, string> = {
  UNCONNECTED: "No identity, or no active delegation: nothing has been granted to this agent.",
  ADVISORY: "Limits are configuration the agent's own code may or may not consult.",
  "CUSTODY-ENFORCED": "Limits are checked before signing by a service the agent can't change; that service could still bypass them.",
  "CHAIN-ENFORCED": "The chain rejects any spend over the limits, even if the agent and the custody service are compromised.",
};

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/**
 * pass / fail: the check ran and this is its answer.
 * na: it doesn't apply to this agent (e.g. Safe checks for a plain key).
 * unknown: it couldn't be run (the chain couldn't be read, no wallet was given). Never counted as a pass.
 */
export type CheckStatus = "pass" | "fail" | "na" | "unknown";

export interface CheckResult {
  id: string;
  title: string;
  severity: Severity;
  status: CheckStatus;
  /** What was found, in a sentence. Built from facts, never from text the agent controls being interpreted. */
  detail: string;
  /** For a failed check: what to change. Fixed text per check, the same for everyone. */
  fix?: string;
}

/** One asset's allowance for the agent's signer in a Safe's Allowance Module. Amounts are decimal strings in the asset's units. */
export interface Allowance {
  amount: string;
  /** Minutes after which the allowance resets; 0 means it never does (a one-time allowance). */
  resetMinutes: number;
}

/** Where the agent's funds are and who can move them: read from the chain, or from the custody service. */
export interface CustodyFacts {
  /** CAIP-2, e.g. "eip155:84532". */
  chain: string;
  /** The address the agent's funds are at. */
  wallet: string;
  /** "eoa": a plain key. "safe": a Safe. "contract": some other contract. */
  walletKind: "eoa" | "safe" | "contract";
  /**
   * An address whose private key the agent's runtime holds. Undefined:
   * it holds none, and something else signs (see `signedBy`).
   */
  agentSigner?: string;
  /** Who signs the agent's payments when it holds no key: the custody service checks policy before signing. */
  signedBy?: "custody";
  safe?: {
    owners: string[];
    threshold: number;
    allowanceModuleEnabled: boolean;
    /** The agent signer's allowances, by asset symbol. */
    allowances: Record<string, Allowance>;
  };
  /** Funds at other addresses the agent can sign for (its own key, other controllers), by asset symbol. */
  otherFunds: { address: string; asset: string; amount: string }[];
}

export interface HistoryFacts {
  /** Receipts as stored: `{ id, statement, mint, payment?, delivery? }`. */
  receipts: { id: string; statement: unknown; mint: unknown; payment?: unknown; delivery?: unknown }[];
  /** The keys those receipts must be signed with. */
  keyset: IssuerKeyset;
  /** The log they are in, when there is one: leaf hashes in order, and its stored right edge. */
  log?: { size: number; frontier: string[]; leaves: string[] };
  /** The last root that was anchored somewhere else, when known: the log must still extend it. */
  anchored?: { treeSize: number; rootHash: string };
}

/**
 * Everything a verification is computed from. Adapters gather it (a
 * project's `.alma/`, the AdaSouls API, the chain); the checks only read
 * it. Anything an adapter couldn't obtain is left undefined, and the
 * checks that needed it report "unknown".
 */
export interface Facts {
  identity?: AlmaIdentity;
  /** True when the source of the identity doesn't say which wallets are bound to it: IDN-03 is then "unknown", never a pass. */
  controllersUnknown?: boolean;
  delegations: Delegation[];
  /** The agent's declared limits (alma.yaml). */
  manifest?: AgentManifest;
  /** The organization's own rules, when known: the ceiling an agent's rules may only tighten. */
  orgRules?: ManifestSelfPolicyRules;
  custody?: CustodyFacts;
  /** Why custody couldn't be read, when it was asked for and failed. */
  custodyUnreadable?: string;
  history?: HistoryFacts;
  /** The assets amounts can be read in. Defaults to the built-in table. */
  assets?: AssetInfo[];
  now: Date;
}

export interface Ring {
  /** 1: a guard in the agent's process. 2: the custody service. 3: the chain. */
  ring: 1 | 2 | 3;
  name: string;
  stops: string;
  /** "in place": this ring enforces the limits now. "missing": it isn't set up. "misconfigured": set up, but not at the declared limits. "unknown": couldn't be determined. */
  state: "in place" | "missing" | "misconfigured" | "unknown";
}

export const REPORT_VERSION = "alma-verification/1";

export interface Report {
  v: typeof REPORT_VERSION;
  /** The agent's ALMA id, or null when the project has no identity. */
  subject: string | null;
  generatedAt: string;
  verdict: Verdict;
  meaning: string;
  rings: Ring[];
  checks: CheckResult[];
  /** What the verification looked at, so a reader knows its reach. */
  scope: {
    wallet: string | null;
    chain: string | null;
    sources: string[];
    /** True when custody was read from a simulated chain: the verdict then says nothing about real funds. */
    simulated: boolean;
  };
}
