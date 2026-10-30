import { fromBaseUnits } from "../core/amounts.js";
import { NATIVE_TOKEN, erc20Address, findAsset, nativeAsset, type AssetInfo } from "../core/assets.js";
import type { Allowance, ControllerProof, CustodyFacts } from "../core/types.js";

/**
 * What the custody checks need to know about a chain. Two
 * implementations: `SimulatedChain` (in memory, for tests and for
 * trying things before a real Safe exists) and `evmReader` (JSON-RPC).
 */
export interface ChainReader {
  /** CAIP-2. */
  readonly chain: string;
  /** "safe" only for a known Safe deployment: something that merely answers like one is a "contract". */
  kind(address: string): Promise<"eoa" | "safe" | "contract">;
  safe(address: string): Promise<{ owners: string[]; threshold: number; allowanceModuleEnabled: boolean; otherModules: string[]; guard?: string }>;
  /**
   * Every allowance the delegate has in the Safe's Allowance Module, not
   * only the ones asked about: by token address, the native token as
   * `NATIVE_TOKEN`, amounts in base units.
   */
  allowances(safe: string, delegate: string): Promise<{ token: string; baseUnits: bigint; resetMinutes: number }[]>;
  /** In the asset's units. */
  balance(address: string, asset: AssetInfo): Promise<string>;
  /** Whether `signature` is `address`'s over `message` (EIP-191): ecrecover for a key, ERC-1271 for a contract. False when it can't be shown. */
  verifyMessage(address: string, message: string, signature: string): Promise<boolean>;
}

/** The text a wallet signs to accept being bound to an identity, on one chain. Fixed, so anyone can rebuild and check it. */
export function controllerProofMessage(almaId: string, wallet: string, chain: string): string {
  return `ALMA controller proof\n\nI control ${wallet.toLowerCase()} on ${chain} and bind it to ${almaId}.`;
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
  /** The agent's identity and the proofs it has, to check that the wallet accepted being bound to it. */
  almaId?: string;
  controllerProofs?: ControllerProof[];
}

/** Reads where the funds are and who can move them. Throws when the chain can't be read: the caller records that as "unknown". */
export async function readCustody(reader: ChainReader, q: CustodyQuestion): Promise<CustodyFacts> {
  const walletKind = await reader.kind(q.wallet);
  const known = q.symbols.map((s) => findAsset(q.assets, reader.chain, s)).filter((a): a is AssetInfo => a !== undefined);
  const facts: CustodyFacts = { chain: reader.chain, wallet: q.wallet, walletKind, agentSigner: q.agentSigner, signedBy: q.signedBy, otherFunds: [] };

  // Only a proof for this identity, this wallet and this chain counts; the chain says whether the signature is the wallet's.
  const proof = q.almaId ? q.controllerProofs?.find((p) => p.almaId === q.almaId && p.chain === reader.chain && p.wallet.toLowerCase() === q.wallet.toLowerCase()) : undefined;
  if (proof) facts.controllerProof = (await reader.verifyMessage(q.wallet, controllerProofMessage(proof.almaId, q.wallet, reader.chain), proof.signature).catch(() => false)) ? "valid" : "invalid";

  if (walletKind === "safe") {
    const safe = await reader.safe(q.wallet);
    const allowances: Record<string, Allowance> = {};
    const unlistedAllowances: NonNullable<CustodyFacts["safe"]>["unlistedAllowances"] = [];
    if (safe.allowanceModuleEnabled && q.agentSigner) {
      for (const asset of known) allowances[asset.symbol] = { amount: "0", resetMinutes: 0 };
      // Every token the module holds an allowance for, so one the limits don't name can't hide.
      for (const a of await reader.allowances(q.wallet, q.agentSigner)) {
        if (a.baseUnits === 0n) continue;
        const asset = a.token.toLowerCase() === NATIVE_TOKEN ? nativeAsset(reader.chain) : q.assets.find((x) => x.chain === reader.chain && erc20Address(x)?.toLowerCase() === a.token.toLowerCase());
        if (asset) allowances[asset.symbol] = { amount: fromBaseUnits(a.baseUnits, asset.decimals), resetMinutes: a.resetMinutes };
        else unlistedAllowances.push({ token: a.token, baseUnits: a.baseUnits.toString(), resetMinutes: a.resetMinutes });
      }
    }
    facts.safe = { ...safe, allowances, unlistedAllowances };
  }
  if (q.agentSigner && q.agentSigner.toLowerCase() !== q.wallet.toLowerCase()) {
    for (const asset of known) {
      const amount = await reader.balance(q.agentSigner, asset);
      if (/[1-9]/.test(amount)) facts.otherFunds.push({ address: q.agentSigner, asset: asset.symbol, amount });
    }
  }
  return facts;
}
