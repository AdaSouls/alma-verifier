import { fromBaseUnits } from "./amounts.js";

/**
 * Limits are written per asset symbol ("USDC"); chains and receipts name
 * an asset by its address (CAIP-19) and count in base units. This table
 * is the bridge. An asset that isn't in it is never guessed: checks that
 * need it say so.
 */
export interface AssetInfo {
  symbol: string;
  /** CAIP-2. */
  chain: string;
  /** CAIP-19. */
  id: string;
  decimals: number;
}

const usdc = (chain: string, address: string): AssetInfo => ({ symbol: "USDC", chain, id: `${chain}/erc20:${address}`, decimals: 6 });

/** Circle's USDC on the chains ALMA tooling is used on. Extend it with your own tokens through the `assets` option. */
export const KNOWN_ASSETS: AssetInfo[] = [
  usdc("eip155:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  usdc("eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  usdc("eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  usdc("eip155:11155111", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
];

export const findAsset = (assets: AssetInfo[], chain: string, symbol: string) => assets.find((a) => a.chain === chain && a.symbol === symbol.toUpperCase());
export const assetById = (assets: AssetInfo[], id: string) => assets.find((a) => a.id.toLowerCase() === id.toLowerCase());
/** The token's contract address, for an ERC-20. */
export const erc20Address = (asset: AssetInfo) => /\/erc20:(0x[0-9a-fA-F]{40})$/.exec(asset.id)?.[1];
export const displayAmount = (asset: AssetInfo, baseUnits: string) => fromBaseUnits(BigInt(baseUnits), asset.decimals);

/** Whether a chain is a mainnet or a testnet, for the chains whose kind is known. A receipt never guesses "mainnet". */
export const CHAIN_ENVS: Record<string, "mainnet" | "testnet" | "mock"> = { "eip155:1": "mainnet", "eip155:8453": "mainnet", "eip155:10": "mainnet", "eip155:42161": "mainnet", "eip155:84532": "testnet", "eip155:11155111": "testnet", "eip155:31337": "mock" };
