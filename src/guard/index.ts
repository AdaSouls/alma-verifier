import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendToFrontier, buildReceiptStatement, envelopeLeafHash, hashToHex, hexToHash, receiptDigest, receiptStatementSchema, signReceiptMint, toBaseUnits } from "@adasouls/alma-core";
import type { ManifestSelfPolicyRules } from "@adasouls/alma-manifest";
import { loadSigner, localIssuer, readDelegations, readIdentity, readLog, readManifest, readReceipts, storeDir } from "../adapters/local.js";
import { add } from "../core/amounts.js";
import { CHAIN_ENVS, KNOWN_ASSETS, assetById, displayAmount, findAsset, type AssetInfo } from "../core/assets.js";
import { checkIntent, type IntentDecision, type PaymentIntent } from "../core/intent.js";

/**
 * Ring 1: a guard inside the agent's own process. It wraps the function
 * that sends a payment, so the limits in `alma.yaml` are checked before
 * anything is signed, and every payment that goes out leaves a signed
 * receipt in the project's log.
 *
 * It stops mistakes and prompt-injected tool calls. It does not stop the
 * agent's code from calling the wallet directly: whoever holds the key
 * can go around it. That is why an agent that only has this is ADVISORY.
 */
export type { PaymentIntent } from "../core/intent.js";

/** Your code that actually sends the payment. It returns the transaction's hash once it is sent. */
export type SendPayment = (payment: PaymentIntent) => Promise<{ txHash: string }>;

export interface GuardOptions {
  /** The project's folder (where alma.yaml and .alma/ are). Defaults to the current one. */
  cwd?: string;
  /** Extra limits that also apply, e.g. the organization's. They can only tighten. */
  rules?: ManifestSelfPolicyRules[];
  /** Tokens beyond the built-in table. */
  assets?: AssetInfo[];
  /**
   * Asked when a payment is above the approval threshold. Resolve true
   * only when a person said yes. Without it, such payments are refused.
   */
  approve?: (payment: PaymentIntent) => Promise<boolean>;
  /** "mainnet", "testnet" or "mock", for a chain this package doesn't know. */
  env?: "mainnet" | "testnet" | "mock";
  now?: () => Date;
}

export type DenialCode = "not_connected" | "denied" | "approval_required" | "approval_declined" | "unknown_asset";

/** The payment was not sent. `code` says why in a word, `reasons` in sentences. */
export class PaymentDenied extends Error {
  constructor(readonly code: DenialCode, readonly reasons: string[], readonly payment: PaymentIntent) {
    super(`Payment refused (${code}): ${reasons.join("; ")}`);
    this.name = "PaymentDenied";
  }
}

/** The payment WAS sent, and writing its receipt failed. Don't retry the payment: record `txHash` by hand. */
export class PaymentNotRecorded extends Error {
  constructor(readonly txHash: string, readonly payment: PaymentIntent, cause: unknown) {
    super(`Payment ${txHash} was sent but its receipt could not be written: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PaymentNotRecorded";
  }
}

export interface GuardedResult {
  txHash: string;
  /** The signed receipt's id. */
  receipt: string;
  /** Its position in the project's log. */
  position: number;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** What this project's own receipts say it has spent today (UTC), per asset symbol. */
export function spentToday(cwd: string, agentId: string, assets: AssetInfo[], now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const receipt of readReceipts(cwd)) {
    const s = receiptStatementSchema.safeParse(receipt.statement);
    if (!s.success || s.data.payer !== agentId || s.data.settledAt.slice(0, 10) !== utcDay(now)) continue;
    const asset = assetById(assets, s.data.asset);
    if (asset) out[asset.symbol] = add(out[asset.symbol] ?? "0", displayAmount(asset, s.data.amount));
  }
  return out;
}

/** Would this payment be let through right now? Sends nothing, writes nothing. */
export function check(payment: PaymentIntent, options: GuardOptions = {}): IntentDecision | { decision: "deny"; reasons: string[]; code: "not_connected" } {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now?.() ?? new Date();
  const identity = readIdentity(cwd);
  if (!identity || identity.status !== "active") return { decision: "deny", code: "not_connected", reasons: ["this project has no active ALMA identity (run `alma connect`)"] };
  const active = readDelegations(cwd).filter((d) => d.subject === identity.id && d.status === "active" && (!d.expiresAt || new Date(d.expiresAt) > now));
  if (active.length === 0) return { decision: "deny", code: "not_connected", reasons: ["no active, unexpired delegation: nothing has been granted to this agent"] };

  const manifest = readManifest(cwd);
  // The agent's own limits, what each delegation allows, and anything passed in: the tightest of all of them applies.
  const rules = [manifest?.authority, ...active.map((d) => d.scope.constraints as ManifestSelfPolicyRules | undefined), ...(options.rules ?? [])].filter((r): r is ManifestSelfPolicyRules => r !== undefined && Object.keys(r).length > 0);
  if (rules.length === 0) return { decision: "deny", reasons: ["no limits are declared: a guard with nothing to check refuses rather than wave everything through"] };

  return checkIntent(
    { agentId: identity.id, capabilities: active.flatMap((d) => d.scope.capabilities), rules, counterpartyPolicy: manifest?.counterpartyPolicy, spentToday: spentToday(cwd, identity.id, [...(options.assets ?? []), ...KNOWN_ASSETS], now), now },
    payment
  );
}

// One payment at a time per project folder: two that are checked together would both fit under a daily limit only one of them fits under.
const queues = new Map<string, Promise<unknown>>();

/**
 * Wraps the function that sends a payment.
 *
 *   const pay = guard(async (p) => ({ txHash: await wallet.sendUsdc(p.to, p.amount) }));
 *   await pay({ to: "0x…", asset: "USDC", amount: "25", chain: "eip155:84532" });
 *
 * Refused payments throw `PaymentDenied` and are never sent.
 */
export function guard(send: SendPayment, options: GuardOptions = {}): (payment: PaymentIntent) => Promise<GuardedResult> {
  const cwd = options.cwd ?? process.cwd();
  const run = async (payment: PaymentIntent): Promise<GuardedResult> => {
    const assets = [...(options.assets ?? []), ...KNOWN_ASSETS];
    // Before anything is sent: a payment that couldn't be written down afterwards is not let out.
    const asset = findAsset(assets, payment.chain, payment.asset);
    if (!asset) throw new PaymentDenied("unknown_asset", [`${payment.asset} on ${payment.chain} is not an asset this guard knows; pass it in the \`assets\` option`], payment);
    const env = options.env ?? CHAIN_ENVS[payment.chain];
    if (!env) throw new PaymentDenied("denied", [`say whether ${payment.chain} is mainnet, testnet or mock (the \`env\` option)`], payment);
    const signer = await loadSigner(cwd);
    const identity = readIdentity(cwd);
    if (!signer || !identity) throw new PaymentDenied("not_connected", ["this project has no ALMA identity or signing key (run `alma connect`)"], payment);
    let baseUnits: string;
    try {
      baseUnits = toBaseUnits(payment.amount, asset.decimals);
    } catch (err) {
      throw new PaymentDenied("denied", [err instanceof Error ? err.message : String(err)], payment);
    }

    const decision = check(payment, options);
    if (decision.decision === "deny") throw new PaymentDenied("code" in decision ? decision.code : "denied", decision.reasons, payment);
    if (decision.decision === "needs_approval") {
      if (!options.approve) throw new PaymentDenied("approval_required", ["a person must approve a payment this large, and no `approve` function was given"], payment);
      if ((await options.approve(payment)) !== true) throw new PaymentDenied("approval_declined", ["the person asked did not approve it"], payment);
    }

    const { txHash } = await send(payment);
    try {
      const action = `act_${randomUUID()}`;
      const statement = buildReceiptStatement({ issuer: localIssuer(identity.id), env, action, payer: identity.id, payee: payment.counterparty ?? payment.to, capability: payment.capability ?? "pay", chain: payment.chain, asset: asset.id, amount: baseUnits, to: payment.to, txHash, settledAt: options.now?.() });
      const id = `rcp_${action}`;
      // Not independent: the payer signs its own record. Nobody else vouched for it.
      const mint = await signReceiptMint(signer, { iss: localIssuer(identity.id), receipt: id, digest: await receiptDigest(statement), independent: false });
      mkdirSync(storeDir(cwd), { recursive: true });
      appendFileSync(join(storeDir(cwd), "receipts.jsonl"), JSON.stringify({ id, statement, mint, selfAttested: true }) + "\n", "utf-8");
      const log = readLog(cwd) ?? { log: `local-${identity.id.replace(/^alma:/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 64), size: 0, frontier: [], leaves: [] };
      const leaf = await envelopeLeafHash(mint);
      const next = await appendToFrontier({ size: log.size, nodes: log.frontier.map(hexToHash) }, leaf);
      writeFileSync(join(storeDir(cwd), "log.json"), JSON.stringify({ log: log.log, size: next.size, frontier: next.nodes.map(hashToHex), leaves: [...log.leaves, hashToHex(leaf)] }, null, 2) + "\n", "utf-8");
      return { txHash, receipt: id, position: log.size };
    } catch (err) {
      throw new PaymentNotRecorded(txHash, payment, err);
    }
  };
  return (payment) => {
    const next = (queues.get(cwd) ?? Promise.resolve()).then(() => run(payment), () => run(payment));
    queues.set(cwd, next.catch(() => undefined));
    return next;
  };
}
