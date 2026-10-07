import { createPublicClient, formatUnits, getAddress, http, parseAbi, type PublicClient } from "viem";
import { erc20Address, type AssetInfo } from "../core/assets.js";
import type { Allowance } from "../core/types.js";
import type { ChainReader } from "./chain.js";

/**
 * Reads custody from an EVM chain over JSON-RPC: only `eth_call`,
 * `eth_getCode` and `eth_chainId`, nothing that needs a key.
 *
 * Run against Base Sepolia on 2026-10-07, reads only: a real Safe
 * (detected as one, its owners, threshold and module state read), an
 * ERC-20 balance, and the Allowance Module v0.1.1 at
 * 0xAA46724893dedD72658219405185Fb0Fc91e091C answering
 * `getTokenAllowance`. NOT YET RUN against a Safe that has the module
 * enabled with an allowance set, so a CHAIN-ENFORCED verdict has only
 * been produced from the simulated chain: treat one from a real chain
 * as unconfirmed until that has been exercised.
 */
const SAFE_ABI = parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function isModuleEnabled(address module) view returns (bool)"]);
const ALLOWANCE_ABI = parseAbi(["function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])"]);
const ERC20_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export interface EvmReaderOptions {
  rpcUrl: string;
  /**
   * The Allowance Module's address on this chain. It differs between
   * chains and module versions, so it is never assumed: without it, a
   * Safe can't be checked and custody is reported as unknown.
   */
  allowanceModule?: string;
}

export async function evmReader(options: EvmReaderOptions): Promise<ChainReader> {
  const client: PublicClient = createPublicClient({ transport: http(options.rpcUrl) });
  const chain = `eip155:${await client.getChainId()}`;

  const isSafe = async (address: `0x${string}`) => {
    try {
      const [owners, threshold] = await Promise.all([client.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }), client.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" })]);
      return owners.length > 0 && threshold > 0n;
    } catch {
      return false;
    }
  };
  const token = (asset: AssetInfo) => {
    const address = erc20Address(asset);
    if (!address) throw new Error(`${asset.symbol} on ${asset.chain} is not an ERC-20 this reader can query`);
    return getAddress(address);
  };

  return {
    chain,
    async kind(address) {
      const a = getAddress(address);
      const code = await client.getCode({ address: a });
      // An account whose code is an EIP-7702 delegation behaves as a contract: it is not a plain key.
      if (!code || code === "0x") return "eoa";
      return (await isSafe(a)) ? "safe" : "contract";
    },
    async safe(address) {
      const a = getAddress(address);
      if (!options.allowanceModule) throw new Error("the Allowance Module's address on this chain wasn't given (--allowance-module), so the Safe's limits can't be read");
      const [owners, threshold, enabled] = await Promise.all([
        client.readContract({ address: a, abi: SAFE_ABI, functionName: "getOwners" }),
        client.readContract({ address: a, abi: SAFE_ABI, functionName: "getThreshold" }),
        client.readContract({ address: a, abi: SAFE_ABI, functionName: "isModuleEnabled", args: [getAddress(options.allowanceModule)] }),
      ]);
      return { owners: [...owners], threshold: Number(threshold), allowanceModuleEnabled: enabled };
    },
    async allowance(safe, delegate, asset): Promise<Allowance> {
      if (!options.allowanceModule) throw new Error("the Allowance Module's address wasn't given");
      // [amount, spent, resetTimeMin, lastResetMin, nonce]
      const [amount, , resetTimeMin] = await client.readContract({ address: getAddress(options.allowanceModule), abi: ALLOWANCE_ABI, functionName: "getTokenAllowance", args: [getAddress(safe), getAddress(delegate), token(asset)] });
      return { amount: formatUnits(amount, asset.decimals), resetMinutes: Number(resetTimeMin) };
    },
    async balance(address, asset) {
      return formatUnits(await client.readContract({ address: token(asset), abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(address)] }), asset.decimals);
    },
  };
}
