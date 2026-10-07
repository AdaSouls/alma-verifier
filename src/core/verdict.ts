import type { CheckResult, Facts, Ring, Verdict } from "./types.js";

/**
 * The verdict is computed from the checks and the facts, by this code
 * and nothing else. It is the highest ring actually in place:
 *
 * - UNCONNECTED: no identity, or nothing delegated.
 * - CHAIN-ENFORCED: the agent's signer is a delegate of a Safe whose
 *   Allowance Module caps it at or below the declared limits, it can't
 *   reach the Safe on its own, and no funds sit where it can move them
 *   freely.
 * - CUSTODY-ENFORCED: the agent holds no signer; a custody service signs
 *   after checking policy.
 * - ADVISORY: everything else. In particular whenever something couldn't
 *   be determined: "unknown" never raises a verdict.
 */
export function verdictOf(checks: CheckResult[], facts: Facts): Verdict {
  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  if (status("IDN-01") !== "pass" || status("AUT-01") !== "pass") return "UNCONNECTED";

  const clean = (id: string) => status(id) === "pass" || status(id) === "na";
  if (status("CUS-03") === "pass" && clean("CUS-02") && clean("CUS-04") && status("CUS-05") === "pass") return "CHAIN-ENFORCED";

  const c = facts.custody;
  if (c && c.agentSigner === undefined && c.signedBy === "custody" && status("CUS-05") !== "fail") return "CUSTODY-ENFORCED";
  return "ADVISORY";
}

/** The three rings between the agent and the funds, and the state of each for this agent. */
export function ringsOf(checks: CheckResult[], facts: Facts, verdict: Verdict): Ring[] {
  const status = (id: string) => checks.find((c) => c.id === id)?.status;
  const c = facts.custody;
  const custody: Ring["state"] = !c ? "unknown" : c.agentSigner === undefined && c.signedBy === "custody" ? "in place" : "missing";
  const chain: Ring["state"] = !c ? "unknown" : verdict === "CHAIN-ENFORCED" ? "in place" : status("CUS-04") === "fail" || (c.safe?.allowanceModuleEnabled && status("CUS-03") === "fail") ? "misconfigured" : "missing";
  return [
    // Whether the agent's code calls a guard can't be seen from outside: declared limits are the most that can be said.
    { ring: 1, name: "Guard inside the agent process", stops: "mistakes and prompt-injected tool calls", state: verdict === "UNCONNECTED" ? "missing" : "unknown" },
    { ring: 2, name: "Custody: limits checked before anything is signed", stops: "a modified agent or a stolen agent key", state: custody },
    { ring: 3, name: "Chain: Safe + Allowance Module", stops: "even a compromised custody service", state: chain },
  ];
}
