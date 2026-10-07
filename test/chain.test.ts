import { describe, expect, it } from "vitest";
import { readCustody } from "../src/adapters/chain.js";
import { AllowanceExceeded, SimulatedChain, type SimulatedState } from "../src/adapters/simulated.js";
import { KNOWN_ASSETS, type AssetInfo } from "../src/core/assets.js";
import { verify } from "../src/core/report.js";
import { OWNER_A, OWNER_B, PAYEE, SIGNER, WALLET, connected } from "./helpers.js";

const assets: AssetInfo[] = [{ symbol: "USDC", chain: "eip155:31337", id: "eip155:31337/erc20:0x00000000000000000000000000000000000000aa", decimals: 6 }, ...KNOWN_ASSETS];
const lock = (): SimulatedState => ({
  accounts: {
    [WALLET]: { kind: "safe", balances: { USDC: "10000" }, owners: [OWNER_A, OWNER_B], threshold: 2, allowanceModule: true, allowances: { [SIGNER]: { USDC: { amount: "500", resetMinutes: 1440 } } } },
  },
});
const ask = { wallet: WALLET, agentSigner: SIGNER, symbols: ["USDC"], assets };

describe("custody read from a chain", () => {
  it("a Safe with a matching allowance reads as CHAIN-ENFORCED", async () => {
    const custody = await readCustody(new SimulatedChain(lock()), ask);
    expect(custody.safe).toMatchObject({ threshold: 2, allowanceModuleEnabled: true, allowances: { USDC: { amount: "500", resetMinutes: 1440 } } });
    expect((await verify(connected({ custody, assets }))).verdict).toBe("CHAIN-ENFORCED");
  });

  it("the address case used doesn't matter", async () => {
    const custody = await readCustody(new SimulatedChain(lock()), { ...ask, wallet: WALLET.toUpperCase().replace("0X", "0x"), agentSigner: SIGNER.toUpperCase().replace("0X", "0x") });
    expect(custody.safe!.allowances.USDC.amount).toBe("500");
  });

  it("a plain key the agent holds reads as ADVISORY", async () => {
    const custody = await readCustody(new SimulatedChain({ accounts: { [WALLET]: { kind: "eoa", balances: { USDC: "900" } } } }), { ...ask, agentSigner: WALLET });
    expect(custody.walletKind).toBe("eoa");
    expect((await verify(connected({ custody, assets }))).verdict).toBe("ADVISORY");
  });

  it("finds funds left at the agent's own address", async () => {
    const state = lock();
    state.accounts[SIGNER] = { kind: "eoa", balances: { USDC: "75" } };
    const custody = await readCustody(new SimulatedChain(state), ask);
    expect(custody.otherFunds).toEqual([{ address: SIGNER, asset: "USDC", amount: "75" }]);
    expect((await verify(connected({ custody, assets }))).verdict).toBe("ADVISORY");
  });
});

describe("what CHAIN-ENFORCED means: the simulated Allowance Module", () => {
  const at = (iso: string) => new Date(iso);
  const transfer = (chain: SimulatedChain, amount: string, now: string, delegate = SIGNER) => chain.executeAllowanceTransfer({ safe: WALLET, delegate, symbol: "USDC", to: PAYEE, amount, now: at(now) });

  it("lets the delegate spend up to the allowance and refuses the rest, whatever the agent's code does", async () => {
    const chain = new SimulatedChain(lock());
    transfer(chain, "300", "2026-10-07T10:00:00Z");
    transfer(chain, "200", "2026-10-07T11:00:00Z");
    expect(() => transfer(chain, "0.000001", "2026-10-07T12:00:00Z")).toThrow(AllowanceExceeded);
    expect(await chain.balance(PAYEE, assets[0])).toBe("500");
    expect(await chain.balance(WALLET, assets[0])).toBe("9500");
  });

  it("the allowance comes back after its reset period, not before", () => {
    const chain = new SimulatedChain(lock());
    transfer(chain, "500", "2026-10-07T10:00:00Z");
    expect(() => transfer(chain, "1", "2026-10-08T09:59:00Z")).toThrow(AllowanceExceeded);
    transfer(chain, "500", "2026-10-08T10:00:00Z");
  });

  it("nobody but the delegate has an allowance", () => {
    expect(() => transfer(new SimulatedChain(lock()), "1", "2026-10-07T10:00:00Z", PAYEE)).toThrow(AllowanceExceeded);
  });
});
