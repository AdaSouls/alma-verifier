import { evaluatePolicy, type CounterpartyContext, type CounterpartyPolicyRules, type Policy, type SelfPolicyRules } from "@adasouls/policy-engine";

/** A payment an agent is about to make, in the terms its limits are written in. */
export interface PaymentIntent {
  /** The address that receives the funds. */
  to: string;
  /** The asset's symbol, e.g. "USDC". */
  asset: string;
  /** A decimal amount in the asset's units, e.g. "12.50". Never a float. */
  amount: string;
  /** CAIP-2, e.g. "eip155:84532". */
  chain: string;
  /**
   * Who the caller says is being paid: an ALMA id. A claim, never used as
   * the counterparty: who is paid is resolved from `to`, and a claim that
   * doesn't match that is refused.
   */
  counterparty?: string;
  /** Defaults to "pay". */
  capability?: string;
}

export interface IntentInput {
  agentId: string;
  /** The capabilities delegated to the agent. */
  capabilities: string[];
  /**
   * Every set of limits that applies: the agent's own, its delegation's
   * constraints, its organization's rules. The most restrictive wins for
   * each limit, so none of them can loosen another.
   */
  rules: SelfPolicyRules[];
  counterpartyPolicy?: CounterpartyPolicyRules;
  /** The counterparty `to` resolves to, from a source the agent's caller doesn't control. Left out, rules that need it deny. */
  counterparty?: CounterpartyContext;
  /** Spent so far today, per asset symbol. */
  spentToday: Record<string, string>;
  now: Date;
}

export type IntentDecision =
  | { decision: "allow" }
  | { decision: "needs_approval"; approvals: string[] }
  | { decision: "deny"; reasons: string[] };

/** Would this payment be allowed? The policy engine's answer, with nothing added. */
export function checkIntent(input: IntentInput, intent: PaymentIntent): IntentDecision {
  const capability = intent.capability ?? "pay";
  if (!input.capabilities.includes(capability)) return { decision: "deny", reasons: [`"${capability}" has not been delegated to this agent`] };
  if (!/^\d+(\.\d+)?$/.test(intent.amount)) return { decision: "deny", reasons: [`amount "${intent.amount}" is not a decimal amount`] };
  // The id and the address can both come from a prompt-injected tool call: the address is what gets paid, so the id must match it.
  if (intent.counterparty !== undefined && intent.counterparty !== input.counterparty?.id) {
    return { decision: "deny", reasons: [input.counterparty ? `${intent.to} belongs to ${input.counterparty.id}, not ${intent.counterparty}` : `${intent.to} isn't known to belong to ${intent.counterparty}`] };
  }

  const scope = { agentId: input.agentId };
  const policies: Policy[] = input.rules.map((rules, i) => ({ id: `self-${i}`, kind: "self", version: 1, scope, rules }));
  if (input.counterpartyPolicy && Object.keys(input.counterpartyPolicy).length) policies.push({ id: "counterparty", kind: "counterparty", version: 1, scope, rules: input.counterpartyPolicy });

  const evaluation = evaluatePolicy(policies, {
    agentId: input.agentId,
    intent: { capability, asset: intent.asset.toUpperCase(), amount: intent.amount, chain: intent.chain },
    counterparty: input.counterparty,
    dailySpendSoFar: input.spentToday,
    now: input.now,
  });
  if (evaluation.allowed) return { decision: "allow" };
  if (evaluation.approvalsRequired.length) return { decision: "needs_approval", approvals: evaluation.approvalsRequired };
  return { decision: "deny", reasons: evaluation.reasons };
}
