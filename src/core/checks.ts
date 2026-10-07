import { envelopeLeafHash, frontierRoot, hashToHex, hexToHash, isNarrowerScope, merkleRoot, verifyReceipt, type Delegation } from "@adasouls/alma-core";
import type { ManifestSelfPolicyRules } from "@adasouls/alma-manifest";
import { compare, gt, isAmount, times } from "./amounts.js";
import { KNOWN_ASSETS, assetById, displayAmount } from "./assets.js";
import { FIXES } from "./remediation.js";
import type { CheckResult, CheckStatus, Facts, Severity } from "./types.js";

/**
 * The checks. Each one is a small function of the facts: it reads
 * nothing itself and decides nothing by judgement. Same facts, same
 * results, whoever runs it.
 *
 * No text an agent controls (a display name, a memo) is ever treated as
 * an instruction here, because nothing here follows instructions.
 */

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const result = (id: string, title: string, severity: Severity, status: CheckStatus, detail: string): CheckResult => ({ id, title, severity, status, detail, ...(status === "fail" && FIXES[id] ? { fix: FIXES[id] } : {}) });

/** The agent's delegations that are in force now. */
export function activeDelegations(f: Facts): Delegation[] {
  if (!f.identity) return [];
  return f.delegations.filter((d) => d.subject === f.identity!.id && d.status === "active" && (!d.expiresAt || new Date(d.expiresAt) > f.now));
}

const AMOUNT_KEYS = ["maxTransaction", "dailySpend", "humanApprovalThreshold"] as const;

function rawRules(f: Facts): ManifestSelfPolicyRules {
  if (f.manifest?.authority) return f.manifest.authority;
  return (activeDelegations(f)[0]?.scope.constraints ?? {}) as ManifestSelfPolicyRules;
}

/** Limits written as something that isn't a decimal amount ("100 dollars", "1e3"). */
export function unreadableLimits(f: Facts): string[] {
  const raw = rawRules(f);
  return AMOUNT_KEYS.flatMap((key) => Object.entries(raw[key] ?? {}).filter(([, v]) => !isAmount(v)).map(([asset]) => `${key}.${asset}`));
}

/**
 * The limits the agent runs under: its manifest's, or failing that its
 * delegation's constraints. A limit that can't be read as an amount is
 * left out, which every check treats as "no limit set": it never helps.
 */
export function declaredRules(f: Facts): ManifestSelfPolicyRules {
  const raw = rawRules(f);
  const out: ManifestSelfPolicyRules = { ...raw };
  for (const key of AMOUNT_KEYS) {
    if (raw[key] && typeof raw[key] === "object") out[key] = Object.fromEntries(Object.entries(raw[key]!).filter(([, v]) => isAmount(v)));
  }
  return out;
}

// ---------- Identity ----------

function identity(f: Facts): CheckResult[] {
  const id = f.identity;
  const idn01 = result("IDN-01", "Identity exists and is active", "critical", id?.status === "active" ? "pass" : "fail", !id ? "No ALMA identity was found." : id.status === "active" ? `Identity ${id.id} is active.` : `Identity ${id.id} is ${id.status}.`);
  const idn02 = result("IDN-02", "A principal is linked", "high", !id ? "na" : id.principal ? "pass" : "fail", !id ? "No identity to check." : id.principal ? `It represents ${id.principal}.` : "No principal: nobody is accountable for this agent, and nobody can delegate to it.");

  let idn03: CheckResult;
  const wallet = f.custody?.wallet;
  if (!id) idn03 = result("IDN-03", "The wallet address is a bound controller of this soul", "high", "na", "No identity to check.");
  else if (!wallet) idn03 = result("IDN-03", "The wallet address is a bound controller of this soul", "high", "unknown", "No wallet address was given to verify.");
  else {
    const bound = id.controllers.some((c) => c.type === "wallet" && same(c.value, wallet));
    idn03 = result("IDN-03", "The wallet address is a bound controller of this soul", "high", bound ? "pass" : "fail", bound ? `${wallet} is bound to the identity.` : `${wallet} is not among the identity's wallet controllers: nothing ties these funds to this soul.`);
  }
  return [idn01, idn02, idn03];
}

// ---------- Authority ----------

function authority(f: Facts): CheckResult[] {
  if (!f.identity) return [
    result("AUT-01", "An active, unexpired delegation covers every capability the agent uses", "critical", "fail", "No identity, so no delegation."),
    result("AUT-02", "The delegation has an expiry", "medium", "na", "No delegation to check."),
    result("AUT-03", "Chained delegations are narrower than their issuer's", "critical", "na", "No delegation to check."),
  ];
  const active = activeDelegations(f);
  const granted = new Set(active.flatMap((d) => d.scope.capabilities));
  const used = f.manifest?.capabilities ?? [...granted];
  const uncovered = used.filter((c) => !granted.has(c));
  const aut01 =
    active.length === 0
      ? result("AUT-01", "An active, unexpired delegation covers every capability the agent uses", "critical", "fail", "No active, unexpired delegation: this agent has been granted nothing.")
      : result("AUT-01", "An active, unexpired delegation covers every capability the agent uses", "critical", uncovered.length ? "fail" : "pass", uncovered.length ? `Declared but not delegated: ${uncovered.join(", ")}.` : `Delegated: ${[...granted].join(", ")}.`);

  const open = active.filter((d) => !d.expiresAt);
  const aut02 = result("AUT-02", "The delegation has an expiry", "medium", active.length === 0 ? "na" : open.length ? "fail" : "pass", active.length === 0 ? "No delegation to check." : open.length ? `${open.length} active delegation(s) never expire: authority stays until someone remembers to revoke it.` : "Every active delegation expires.");

  // A delegation whose issuer was itself delegated to must not grant more than it received.
  const chained = active
    .map((d) => ({ d, parents: f.delegations.filter((p) => p.subject === d.issuer && p.status === "active" && (!p.expiresAt || new Date(p.expiresAt) > f.now)) }))
    .filter((c) => c.parents.length > 0);
  const wider = chained.filter((c) => !c.parents.some((p) => isNarrowerScope(c.d.scope, p.scope)));
  const aut03 = result("AUT-03", "Chained delegations are narrower than their issuer's", "critical", chained.length === 0 ? "na" : wider.length ? "fail" : "pass", chained.length === 0 ? "No chained delegations." : wider.length ? `${wider.length} delegation(s) grant more than their issuer was granted.` : "Every chained delegation stays within what its issuer was granted.");
  return [aut01, aut02, aut03];
}

// ---------- Policy ----------

const LIMIT_KEYS = ["maxTransaction", "dailySpend", "humanApprovalThreshold"] as const;

/** Where `rules` allow more than `ceiling` does. A missing limit under a ceiling that has one is looser too. */
export function loosening(rules: ManifestSelfPolicyRules, ceiling: ManifestSelfPolicyRules): string[] {
  const out: string[] = [];
  for (const key of LIMIT_KEYS) {
    for (const [asset, cap] of Object.entries(ceiling[key] ?? {})) {
      const own = rules[key]?.[asset];
      if (own === undefined) out.push(`${key}.${asset} is ${cap} above, and not set here`);
      else if (isAmount(own) && isAmount(cap) && gt(own, cap)) out.push(`${key}.${asset} is ${own}, above ${cap}`);
    }
  }
  if (ceiling.allowedAssets) {
    const extra = rules.allowedAssets ? rules.allowedAssets.filter((a) => !ceiling.allowedAssets!.includes(a)) : ["any asset"];
    if (extra.length) out.push(`allows ${extra.join(", ")} beyond ${ceiling.allowedAssets.join(", ")}`);
  }
  return out;
}

function policy(f: Facts): CheckResult[] {
  const rules = declaredRules(f);
  const none = Object.keys(rules).length === 0;
  const assets = rules.allowedAssets ?? [...new Set(LIMIT_KEYS.flatMap((k) => Object.keys(rules[k] ?? {})))];
  const pays = (f.manifest?.capabilities ?? activeDelegations(f).flatMap((d) => d.scope.capabilities)).some((c) => c === "pay" || c === "hire" || c === "swap");

  const unlimited = assets.filter((a) => !rules.maxTransaction?.[a]);
  const unreadable = unreadableLimits(f);
  const pol01 = unreadable.length
    ? result("POL-01", "Every allowed asset has a per-transaction limit", "high", "fail", `Not a decimal amount, so not a limit: ${unreadable.join(", ")}.`)
    : none
      ? result("POL-01", "Every allowed asset has a per-transaction limit", "high", "fail", "No limits are declared at all.")
      : result("POL-01", "Every allowed asset has a per-transaction limit", "high", assets.length === 0 || unlimited.length ? "fail" : "pass", assets.length === 0 ? "No asset has a limit." : unlimited.length ? `No per-transaction limit for: ${unlimited.join(", ")}.` : `Limited: ${assets.map((a) => `${rules.maxTransaction![a]} ${a}`).join(", ")}.`);

  const dead = Object.entries(rules.humanApprovalThreshold ?? {}).filter(([a, t]) => rules.maxTransaction?.[a] && compare(t, rules.maxTransaction[a]) !== -1);
  const pol02 = result("POL-02", "The human-approval threshold is below the per-transaction limit", "medium", !rules.humanApprovalThreshold ? "na" : dead.length ? "fail" : "pass", !rules.humanApprovalThreshold ? "No approval threshold is declared." : dead.length ? `Approval can never trigger for ${dead.map(([a]) => a).join(", ")}: the threshold is not below the limit.` : "A person is asked before the largest allowed payments.");

  const small = Object.entries(rules.dailySpend ?? {}).filter(([a, d]) => rules.maxTransaction?.[a] && compare(d, rules.maxTransaction[a]) === -1);
  const pol03 = result("POL-03", "The daily limit is at least the per-transaction limit", "low", !rules.dailySpend ? "na" : small.length ? "fail" : "pass", !rules.dailySpend ? "No daily limit is declared." : small.length ? `For ${small.map(([a]) => a).join(", ")} the daily limit is below the per-transaction limit, so it silently replaces it.` : "Daily limits are at or above the per-transaction limits.");

  const cp = f.manifest?.counterpartyPolicy;
  const hasCp = cp !== undefined && Object.keys(cp).length > 0;
  const pol04 = result("POL-04", "Payments have a counterparty policy", "medium", !pays ? "na" : hasCp ? "pass" : "fail", !pays ? "The agent doesn't pay." : hasCp ? "Counterparties are restricted." : "No counterparty rule: within its limits, the agent can pay anyone.");

  // An agent's rules may only tighten what was set above it: its organization's rules, and what its delegation allows.
  const ceilings: [string, ManifestSelfPolicyRules][] = [];
  if (f.orgRules) ceilings.push(["the organization's rules", f.orgRules]);
  const constraints = activeDelegations(f)[0]?.scope.constraints as ManifestSelfPolicyRules | undefined;
  if (constraints && f.manifest?.authority) ceilings.push(["its delegation", constraints]);
  const looser = ceilings.flatMap(([name, c]) => loosening(rules, c).map((l) => `${l} (${name})`));
  const pol05 = result("POL-05", "The agent's policy never loosens what was set above it", "high", ceilings.length === 0 ? "unknown" : looser.length ? "fail" : "pass", ceilings.length === 0 ? "Neither the organization's rules nor a delegation's constraints were available to compare with." : looser.length ? `Looser than what was set above it: ${looser.join("; ")}.` : "Its limits are within what was set above it.");
  return [pol01, pol02, pol03, pol04, pol05];
}

// ---------- Custody ----------

/** What an allowance lets through in a day: its amount, as many times as it resets in one. A one-time allowance never resets. */
export const perDay = (a: { amount: string; resetMinutes: number }): string => (a.resetMinutes === 0 || a.resetMinutes >= 1440 ? a.amount : times(a.amount, Math.ceil(1440 / a.resetMinutes)));

function custody(f: Facts): CheckResult[] {
  const titles: Record<string, [string, Severity]> = {
    "CUS-01": ["The wallet is not a plain key the agent holds", "critical"],
    "CUS-02": ["The agent's signer can't reach the Safe threshold alone", "critical"],
    "CUS-03": ["The Allowance Module caps the agent's signer at or below the declared limits", "info"],
    "CUS-04": ["No on-chain allowance is above the declared limit", "high"],
    "CUS-05": ["No funds sit at another address the agent can sign for", "high"],
  };
  const all = (status: CheckStatus, detail: string) => Object.entries(titles).map(([id, [title, severity]]) => result(id, title, severity, status, detail));
  const c = f.custody;
  if (!c) return all("unknown", f.custodyUnreadable ? `Custody couldn't be read: ${f.custodyUnreadable}` : "No wallet address was given, so custody wasn't checked.");
  const r = (id: string, status: CheckStatus, detail: string) => result(id, titles[id][0], titles[id][1], status, detail);
  const rules = declaredRules(f);
  const signer = c.agentSigner;

  const holdsWallet = c.walletKind === "eoa" && signer !== undefined && same(signer, c.wallet);
  const cus01 =
    c.walletKind !== "eoa"
      ? r("CUS-01", "pass", `The wallet is a ${c.walletKind === "safe" ? "Safe" : "contract"}, not a plain key.`)
      : holdsWallet
        ? r("CUS-01", "fail", "The wallet is a plain key and the agent holds it: whatever limits are declared, the agent's own code can ignore them.")
        : r("CUS-01", c.signedBy === "custody" ? "pass" : "unknown", c.signedBy === "custody" ? "The wallet is a plain key held by the custody service; the agent holds no signer." : "The wallet is a plain key, and who holds it wasn't stated.");

  if (c.walletKind !== "safe" || !c.safe) {
    const na = "The wallet is not a Safe.";
    const stray = c.otherFunds.filter((o) => !same(o.address, c.wallet));
    return [cus01, r("CUS-02", "na", na), r("CUS-03", "na", na), r("CUS-04", "na", na), r("CUS-05", c.walletKind === "eoa" ? "na" : stray.length ? "fail" : "pass", c.walletKind === "eoa" ? "The wallet is the agent's own key." : stray.length ? `Funds the agent can move directly: ${stray.map((o) => `${o.amount} ${o.asset} at ${o.address}`).join(", ")}.` : "No funds at other addresses the agent can sign for.")];
  }

  const s = c.safe;
  const isOwner = signer !== undefined && s.owners.some((o) => same(o, signer));
  const cus02 = !signer
    ? r("CUS-02", "pass", "The agent holds no signer.")
    : r("CUS-02", isOwner && s.threshold <= 1 ? "fail" : "pass", isOwner && s.threshold <= 1 ? "The agent's signer is an owner of a Safe that needs only one signature: it can move everything, and change the limits." : isOwner ? `The agent's signer is one of ${s.owners.length} owners and ${s.threshold} signatures are needed: it can't act alone, but an owner is more than a delegate should be.` : "The agent's signer is not an owner of the Safe.");

  const allowances = Object.entries(s.allowances).filter(([, a]) => gt(a.amount, "0"));
  const over = allowances.filter(([asset, a]) => !rules.dailySpend?.[asset] || gt(perDay(a), rules.dailySpend[asset]));
  const uncapped = Object.keys(rules.dailySpend ?? {}).filter((asset) => !s.allowances[asset] || !gt(s.allowances[asset].amount, "0"));
  let cus03: CheckResult;
  if (!signer) cus03 = r("CUS-03", "na", "The agent holds no signer to be a delegate.");
  else if (!s.allowanceModuleEnabled) cus03 = r("CUS-03", "fail", "The Allowance Module is not enabled on this Safe: nothing on-chain caps the agent.");
  else if (isOwner) cus03 = r("CUS-03", "fail", "The agent's signer is an owner, so an allowance doesn't confine it.");
  else if (allowances.length === 0) cus03 = r("CUS-03", "fail", "The Allowance Module is enabled but the agent's signer has no allowance.");
  else if (over.length) cus03 = r("CUS-03", "fail", "An allowance is above the declared limit (see CUS-04).");
  else cus03 = r("CUS-03", "pass", `The chain caps the agent's signer: ${allowances.map(([asset, a]) => `${perDay(a)} ${asset} per day`).join(", ")}, within the declared daily limits.${uncapped.length ? ` No allowance for ${uncapped.join(", ")}: the agent can't spend those at all.` : ""} Per-transaction limits and approval thresholds are not enforced by the module.`);

  const cus04 = !s.allowanceModuleEnabled || allowances.length === 0
    ? r("CUS-04", "na", "There are no on-chain allowances.")
    : r("CUS-04", over.length ? "fail" : "pass", over.length ? `On-chain allowance above what is declared: ${over.map(([asset, a]) => `${perDay(a)} ${asset} per day on-chain, ${rules.dailySpend?.[asset] ? `${rules.dailySpend[asset]} declared` : "no daily limit declared"}`).join("; ")}.` : "Every on-chain allowance is at or below its declared daily limit.");

  const stray = c.otherFunds.filter((o) => !same(o.address, c.wallet));
  const cus05 = r("CUS-05", stray.length ? "fail" : "pass", stray.length ? `Funds the agent can move without the Safe: ${stray.map((o) => `${o.amount} ${o.asset} at ${o.address}`).join(", ")}.` : "No funds at other addresses the agent can sign for.");
  return [cus01, cus02, cus03, cus04, cus05];
}

// ---------- History ----------

async function history(f: Facts): Promise<CheckResult[]> {
  const titles: Record<string, [string, Severity]> = {
    "HIS-01": ["Every receipt's signature verifies against the issuer keyset", "high"],
    "HIS-02": ["The log is consistent with its last anchored root", "high"],
    "HIS-03": ["No past action would be denied by today's policy", "info"],
  };
  const r = (id: string, status: CheckStatus, detail: string) => result(id, titles[id][0], titles[id][1], status, detail);
  const h = f.history;
  if (!h) return Object.keys(titles).map((id) => r(id, "unknown", "No history was available to check."));
  if (h.receipts.length === 0 && (!h.log || h.log.size === 0)) return Object.keys(titles).map((id) => r(id, "na", "There is no history yet."));

  const bad: string[] = [];
  const statements = [];
  for (const receipt of h.receipts) {
    const v = await verifyReceipt(receipt, h.keyset);
    if (!v.ok) bad.push(receipt.id);
    else statements.push(v.payload.statement);
  }
  const his01 = r("HIS-01", bad.length ? "fail" : "pass", bad.length ? `${bad.length} of ${h.receipts.length} receipt(s) don't verify: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}.` : `All ${h.receipts.length} receipt(s) verify.`);

  let his02: CheckResult;
  if (!h.log) his02 = r("HIS-02", "unknown", "No log was available to check.");
  else {
    const problems: string[] = [];
    const leaves = h.log.leaves.map(hexToHash);
    if (leaves.length !== h.log.size) problems.push(`the log says ${h.log.size} entries and holds ${leaves.length}`);
    const root = hashToHex(await merkleRoot(leaves));
    const edge = hashToHex(await frontierRoot({ size: h.log.size, nodes: h.log.frontier.map(hexToHash) }));
    if (root !== edge) problems.push("its stored edge doesn't produce the root of its entries");
    const logged = new Set(h.log.leaves);
    let missing = 0;
    for (const receipt of h.receipts) {
      try {
        if (!logged.has(hashToHex(await envelopeLeafHash(receipt.mint)))) missing++;
      } catch {
        missing++;
      }
    }
    if (missing) problems.push(`${missing} receipt(s) are not in the log`);
    if (h.anchored) {
      if (h.anchored.treeSize > leaves.length) problems.push(`it has ${leaves.length} entries, fewer than the ${h.anchored.treeSize} that were anchored`);
      else if (hashToHex(await merkleRoot(leaves.slice(0, h.anchored.treeSize))) !== h.anchored.rootHash) problems.push("its first entries no longer produce the anchored root: history was rewritten");
    }
    his02 = r("HIS-02", problems.length ? "fail" : "pass", problems.length ? `The log doesn't hold up: ${problems.join("; ")}.` : h.anchored ? `The log extends the root anchored at ${h.anchored.treeSize} entries.` : "The log is internally consistent. No anchored root was given to compare it with.");
  }

  // Receipts name an asset by its address and count in base units; only assets in the table can be judged.
  const rules = declaredRules(f);
  const assets = f.assets ?? KNOWN_ASSETS;
  let judged = 0;
  const denied: string[] = [];
  for (const s of statements) {
    if (s.payer !== f.identity?.id) continue;
    const asset = assetById(assets, s.asset);
    if (!asset) continue;
    judged++;
    const amount = displayAmount(asset, s.amount);
    const max = rules.maxTransaction?.[asset.symbol];
    if (rules.allowedAssets && !rules.allowedAssets.includes(asset.symbol)) denied.push(`${amount} ${asset.symbol} (asset not allowed)`);
    else if (max && gt(amount, max)) denied.push(`${amount} ${asset.symbol} (limit ${max})`);
  }
  const skipped = statements.length - judged;
  const his03 = r("HIS-03", denied.length ? "fail" : judged ? "pass" : "na", denied.length ? `${denied.length} past payment(s) would be denied today: ${denied.slice(0, 5).join(", ")}${denied.length > 5 ? "…" : ""}.` : judged ? `None of ${judged} past payment(s) would be denied by today's limits.${skipped ? ` ${skipped} in assets this verifier doesn't know were not judged.` : ""}` : "No past payment is in an asset this verifier knows.");
  return [his01, his02, his03];
}

/** Every check, in a fixed order. */
export async function runChecks(f: Facts): Promise<CheckResult[]> {
  return [...identity(f), ...authority(f), ...policy(f), ...custody(f), ...(await history(f))];
}
