import { add, compare, gt } from "../core/amounts.js";
import type { AssetInfo } from "../core/assets.js";
import type { Allowance } from "../core/types.js";
import type { ChainReader } from "./chain.js";

/**
 * A chain in memory: accounts, balances, Safes and the Allowance
 * Module's rules. It exists so that the Lock level can be built and
 * tested before a real Safe does, and it is a model, not the contracts:
 * what it shows is the behaviour the module documents (an allowance per
 * delegate and token, spent amounts, a reset period), nothing about the
 * deployed bytecode.
 */
export interface SimulatedAccount {
  kind: "eoa" | "safe" | "contract";
  /** By asset symbol, in the asset's units. */
  balances?: Record<string, string>;
  owners?: string[];
  threshold?: number;
  allowanceModule?: boolean;
  /** delegate -> symbol -> allowance. */
  allowances?: Record<string, Record<string, Allowance & { spent?: string; lastResetMinute?: number }>>;
}

export interface SimulatedState {
  /** CAIP-2. Defaults to a local chain id that can never be mistaken for a real one. */
  chain?: string;
  accounts: Record<string, SimulatedAccount>;
}

export class AllowanceExceeded extends Error {
  constructor(readonly asset: string, readonly requested: string, readonly remaining: string) {
    super(`the Allowance Module rejects ${requested} ${asset}: ${remaining} ${asset} left in this period`);
    this.name = "AllowanceExceeded";
  }
}

const sub = (a: string, b: string): string => {
  const scale = 10n ** 18n;
  const units = (s: string) => {
    const [w, f = ""] = s.split(".");
    return BigInt(w) * scale + BigInt(f.padEnd(18, "0").slice(0, 18));
  };
  const d = units(a) - units(b);
  const whole = d / scale;
  const frac = (d % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

export class SimulatedChain implements ChainReader {
  readonly chain: string;
  private readonly accounts = new Map<string, SimulatedAccount>();

  constructor(state: SimulatedState) {
    this.chain = state.chain ?? "eip155:31337";
    for (const [address, account] of Object.entries(state.accounts)) this.accounts.set(address.toLowerCase(), structuredClone(account));
  }

  private at(address: string): SimulatedAccount | undefined {
    return this.accounts.get(address.toLowerCase());
  }

  async kind(address: string) {
    return this.at(address)?.kind ?? "eoa";
  }

  async safe(address: string) {
    const a = this.at(address);
    if (a?.kind !== "safe") throw new Error(`${address} is not a Safe`);
    return { owners: a.owners ?? [], threshold: a.threshold ?? 1, allowanceModuleEnabled: a.allowanceModule === true };
  }

  private entry(safe: string, delegate: string, symbol: string) {
    const all = this.at(safe)?.allowances ?? {};
    const key = Object.keys(all).find((d) => d.toLowerCase() === delegate.toLowerCase());
    return key ? all[key][symbol] : undefined;
  }

  async allowance(safe: string, delegate: string, asset: AssetInfo): Promise<Allowance> {
    const e = this.entry(safe, delegate, asset.symbol);
    return { amount: e?.amount ?? "0", resetMinutes: e?.resetMinutes ?? 0 };
  }

  async balance(address: string, asset: AssetInfo) {
    return this.at(address)?.balances?.[asset.symbol] ?? "0";
  }

  /**
   * What the module's `executeAllowanceTransfer` does: moves funds out of
   * the Safe on the delegate's word alone, up to what is left of its
   * allowance in the current period, and refuses anything above it.
   */
  executeAllowanceTransfer(input: { safe: string; delegate: string; symbol: string; to: string; amount: string; now: Date }): void {
    const safe = this.at(input.safe);
    if (safe?.kind !== "safe" || !safe.allowanceModule) throw new Error("the Allowance Module is not enabled on this Safe");
    const e = this.entry(input.safe, input.delegate, input.symbol);
    if (!e) throw new AllowanceExceeded(input.symbol, input.amount, "0");
    const minute = Math.floor(input.now.getTime() / 60_000);
    if (e.resetMinutes > 0 && minute - (e.lastResetMinute ?? 0) >= e.resetMinutes) {
      e.spent = "0";
      // The module keeps periods aligned to the first one rather than to each spend.
      e.lastResetMinute = e.lastResetMinute === undefined ? minute : minute - ((minute - e.lastResetMinute) % e.resetMinutes);
    }
    const spent = add(e.spent ?? "0", input.amount);
    if (gt(spent, e.amount)) throw new AllowanceExceeded(input.symbol, input.amount, sub(e.amount, e.spent ?? "0"));
    const balance = safe.balances?.[input.symbol] ?? "0";
    if (compare(balance, input.amount) === -1) throw new Error(`the Safe holds ${balance} ${input.symbol}`);
    e.spent = spent;
    safe.balances = { ...safe.balances, [input.symbol]: sub(balance, input.amount) };
    const to = this.at(input.to) ?? { kind: "eoa" as const };
    to.balances = { ...to.balances, [input.symbol]: add(to.balances?.[input.symbol] ?? "0", input.amount) };
    this.accounts.set(input.to.toLowerCase(), to);
  }
}
