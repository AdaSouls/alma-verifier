import { findAsset, type AssetInfo } from "../core/assets.js";
import type { Allowance, CustodyFacts } from "../core/types.js";

/**
 * What the custody checks need to know about a chain. Two
 * implementations: `SimulatedChain` (in memory, for tests and for
 * trying things before a real Safe exists) and `evmReader` (JSON-RPC).
 */
export interface ChainReader {
  /** CAIP-2. */
  readonly chain: string;
  kind(address: string): Promise<"eoa" | "safe" | "contract">;
  safe(address: string): Promise<{ owners: string[]; threshold: number; allowanceModuleEnabled: boolean }>;
  /** The delegate's allowance for one asset in the Safe's Allowance Module, in the asset's units. */
  allowance(safe: string, delegate: string, asset: AssetInfo): Promise<Allowance>;
  /** In the asset's units. */
  balance(address: string, asset: AssetInfo): Promise<string>;
}

export interface CustodyQuestion {
  wallet: string;
  /** An address whose key the agent's runtime holds. Leave out when it holds none. */
  agentSigner?: string;
  /** Set when a custody service signs for the agent. */
  signedBy?: "custody";
  /** The asset symbols the agent's limits name. */
  symbols: string[];
  assets: AssetInfo[];
}

/** Reads where the funds are and who can move them. Throws when the chain can't be read: the caller records that as "unknown". */
export async function readCustody(reader: ChainReader, q: CustodyQuestion): Promise<CustodyFacts> {
  const walletKind = await reader.kind(q.wallet);
  const known = q.symbols.map((s) => findAsset(q.assets, reader.chain, s)).filter((a): a is AssetInfo => a !== undefined);
  const facts: CustodyFacts = { chain: reader.chain, wallet: q.wallet, walletKind, agentSigner: q.agentSigner, signedBy: q.signedBy, otherFunds: [] };

  if (walletKind === "safe") {
    const safe = await reader.safe(q.wallet);
    const allowances: Record<string, Allowance> = {};
    if (safe.allowanceModuleEnabled && q.agentSigner) {
      for (const asset of known) allowances[asset.symbol] = await reader.allowance(q.wallet, q.agentSigner, asset);
    }
    facts.safe = { ...safe, allowances };
  }
  if (q.agentSigner && q.agentSigner.toLowerCase() !== q.wallet.toLowerCase()) {
    for (const asset of known) {
      const amount = await reader.balance(q.agentSigner, asset);
      if (/[1-9]/.test(amount)) facts.otherFunds.push({ address: q.agentSigner, asset: asset.symbol, amount });
    }
  }
  return facts;
}
