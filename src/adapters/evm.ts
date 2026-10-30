import { createPublicClient, getAddress, http, keccak256, parseAbi, type Hex, type PublicClient } from "viem";
import { fromBaseUnits } from "../core/amounts.js";
import { erc20Address } from "../core/assets.js";
import type { ChainReader } from "./chain.js";

/**
 * Reads custody from an EVM chain over JSON-RPC: only `eth_call`,
 * `eth_getCode`, `eth_getStorageAt` and `eth_chainId`, nothing that
 * needs a key.
 *
 * A wallet counts as a Safe only when its code is a known SafeProxy and
 * the master copy it delegates to is a known Safe singleton (v1.3.0,
 * v1.4.1, v1.5.0, from safe-global/safe-deployments). Anything else that
 * answers `getOwners` and `getThreshold` could answer them with anything,
 * so it is just a contract. The Allowance Module given must be one of
 * its published deployments, for the same reason.
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
const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
]);
const ALLOWANCE_ABI = parseAbi(["function getTokens(address safe, address delegate) view returns (address[])", "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])"]);
const ERC20_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/** keccak256 of the runtime code of SafeProxy v1.3.0, v1.4.1 and v1.5.0, as their factories deploy it. */
export const SAFE_PROXY_CODE_HASHES = [
  "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
  "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  "0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f",
];
/** Safe and SafeL2 singletons (canonical and eip155 deployments), v1.3.0, v1.4.1 and v1.5.0. */
export const SAFE_SINGLETONS = [
  "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
  "0x3E5c63644E683549055b9Be8653de26E0B4CD36E",
  "0x69f4D1788e39c87893C980c06EdF4b7f686e2938",
  "0xfb1bffC9d739B8D520DaF37dF666da4C687191EA",
  "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
  "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
].map((a) => a.toLowerCase());
/** The Allowance Module's published deployments (safe-global/safe-modules-deployments, v0.1.0 and v0.1.1). */
export const ALLOWANCE_MODULES = ["0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134", "0x1Fb403834C911eB98d56E74F5182b0d64C3b3b4D", "0xAA46724893dedD72658219405185Fb0Fc91e091C"].map((a) => a.toLowerCase());

const SENTINEL = "0x0000000000000000000000000000000000000001";
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";
const slotAddress = (word: Hex | undefined) => (word ? getAddress(`0x${word.slice(-40)}`) : undefined);
const isZero = (a: string | undefined) => !a || /^0x0{40}$/i.test(a);

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

  const module = async (): Promise<`0x${string}`> => {
    if (!options.allowanceModule) throw new Error("the Allowance Module's address on this chain wasn't given (--allowance-module), so the Safe's limits can't be read");
    const address = getAddress(options.allowanceModule);
    if (!ALLOWANCE_MODULES.includes(address.toLowerCase())) throw new Error(`${address} is not a published Allowance Module deployment`);
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`there is no Allowance Module at ${address} on ${chain}`);
    return address;
  };

  return {
    chain,
    async kind(address) {
      const a = getAddress(address);
      const code = await client.getCode({ address: a });
      // An EIP-7702 delegation leaves the account's key in charge: whoever holds it signs as before.
      if (!code || code === "0x" || code.toLowerCase().startsWith("0xef0100")) return "eoa";
      if (!SAFE_PROXY_CODE_HASHES.includes(keccak256(code))) return "contract";
      const singleton = slotAddress(await client.getStorageAt({ address: a, slot: "0x0" }));
      return singleton && SAFE_SINGLETONS.includes(singleton.toLowerCase()) ? "safe" : "contract";
    },
    async safe(address) {
      const a = getAddress(address);
      const allowanceModule = await module();
      const [owners, threshold, guard, moduleGuard] = await Promise.all([
        client.readContract({ address: a, abi: SAFE_ABI, functionName: "getOwners" }),
        client.readContract({ address: a, abi: SAFE_ABI, functionName: "getThreshold" }),
        client.getStorageAt({ address: a, slot: GUARD_SLOT }),
        client.getStorageAt({ address: a, slot: MODULE_GUARD_SLOT }),
      ]);
      // Every enabled module, page by page: any of them can move funds without an allowance.
      const modules: string[] = [];
      let start: `0x${string}` = SENTINEL;
      for (let page = 0; ; page++) {
        if (page === 20) throw new Error(`${a} has more modules than this reader lists`);
        const [array, next] = await client.readContract({ address: a, abi: SAFE_ABI, functionName: "getModulesPaginated", args: [start, 50n] });
        modules.push(...array);
        if (isZero(next) || next.toLowerCase() === SENTINEL) break;
        start = next;
      }
      const guards = [slotAddress(guard), slotAddress(moduleGuard)].filter((g): g is `0x${string}` => !isZero(g));
      return {
        owners: [...owners],
        threshold: Number(threshold),
        allowanceModuleEnabled: modules.some((m) => m.toLowerCase() === allowanceModule.toLowerCase()),
        otherModules: modules.filter((m) => m.toLowerCase() !== allowanceModule.toLowerCase()),
        ...(guards.length ? { guard: guards.join(", ") } : {}),
      };
    },
    async allowances(safe, delegate) {
      const address = await module();
      const tokens = await client.readContract({ address, abi: ALLOWANCE_ABI, functionName: "getTokens", args: [getAddress(safe), getAddress(delegate)] });
      return Promise.all(
        tokens.map(async (token) => {
          // [amount, spent, resetTimeMin, lastResetMin, nonce]
          const [amount, , resetTimeMin] = await client.readContract({ address, abi: ALLOWANCE_ABI, functionName: "getTokenAllowance", args: [getAddress(safe), getAddress(delegate), token] });
          return { token, baseUnits: amount, resetMinutes: Number(resetTimeMin) };
        })
      );
    },
    async balance(address, asset) {
      const token = erc20Address(asset);
      if (!token) throw new Error(`${asset.symbol} on ${asset.chain} is not an ERC-20 this reader can query`);
      const units = await client.readContract({ address: getAddress(token), abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(address)] });
      return fromBaseUnits(units, asset.decimals);
    },
    async verifyMessage(address, message, signature) {
      if (!/^0x[0-9a-fA-F]*$/.test(signature)) return false;
      // viem checks a key by recovery and a contract by ERC-1271 `isValidSignature`, on this chain.
      return client.verifyMessage({ address: getAddress(address), message, signature: signature as Hex }).catch(() => false);
    },
  };
}
