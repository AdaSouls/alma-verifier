import type { CheckResult, Facts, Ring, Verdict } from "./types.js";

/**
 * What protects the wallet that was looked at, whoever it belongs to:
 * - chain: the agent's signer is a delegate of a Safe whose Allowance
 *   Module caps it at or below the declared limits, it can't reach the
 *   Safe on its own, and no funds sit where it can move them freely.
 * - custody: the agent holds no signer; a custody service signs after
 *   checking policy.
 */
function enforcement(checks: CheckResult[], facts: Facts): { chain: boolean; custody: boolean } {
  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  const clean = (id: string) => status(id) === "pass" || status(id) === "na";
  const c = facts.custody;
  return {
    chain: status("CUS-03") === "pass" && clean("CUS-02") && clean("CUS-04") && status("CUS-05") === "pass",
    custody: Boolean(c && c.agentSigner === undefined && c.signedBy === "custody" && status("CUS-05") !== "fail"),
  };
}

/**
 * The verdict is computed from the checks and the facts, by this code
 * and nothing else. It is the highest ring actually in place FOR THIS
 * AGENT:
 *
 * - UNCONNECTED: no identity, or nothing delegated.
 * - CHAIN-ENFORCED / CUSTODY-ENFORCED: the wallet is protected that way
 *   (see `enforcement`) AND it is a bound controller of the agent's
 *   identity (IDN-03 passes). A well-protected wallet says nothing about
 *   an agent it doesn't belong to: without that tie, anyone could point
 *   at somebody else's Safe and be called chain-enforced.
 * - ADVISORY: everything else. In particular whenever something couldn't
 *   be determined: "unknown" never raises a verdict, and that includes
 *   not knowing whether the wallet is the agent's.
 */
export function verdictOf(checks: CheckResult[], facts: Facts): Verdict {
  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  if (status("IDN-01") !== "pass" || status("AUT-01") !== "pass") return "UNCONNECTED";
  if (status("IDN-03") !== "pass") return "ADVISORY";
  const enforced = enforcement(checks, facts);
  return enforced.chain ? "CHAIN-ENFORCED" : enforced.custody ? "CUSTODY-ENFORCED" : "ADVISORY";
}

/** The three rings between the agent and the funds, and the state of each for the wallet that was looked at. */
export function ringsOf(checks: CheckResult[], facts: Facts, verdict: Verdict): Ring[] {
  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  const c = facts.custody;
  const enforced = enforcement(checks, facts);
  const custody: Ring["state"] = !c ? "unknown" : enforced.custody ? "in place" : "missing";
  const chain: Ring["state"] = !c ? "unknown" : enforced.chain ? "in place" : status("CUS-04") === "fail" || (c.safe?.allowanceModuleEnabled && status("CUS-03") === "fail") ? "misconfigured" : "missing";
  return [
    // Whether the agent's code calls a guard can't be seen from outside: declared limits are the most that can be said.
    { ring: 1, name: "Guard inside the agent process", stops: "mistakes and prompt-injected tool calls", state: verdict === "UNCONNECTED" ? "missing" : "unknown" },
    { ring: 2, name: "Custody: limits checked before anything is signed", stops: "a modified agent or a stolen agent key", state: custody },
    { ring: 3, name: "Chain: Safe + Allowance Module", stops: "even a compromised custody service", state: chain },
  ];
}
