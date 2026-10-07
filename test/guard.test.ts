import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProject } from "../src/adapters/local.js";
import { verify } from "../src/core/report.js";
import { PaymentDenied, PaymentNotRecorded, check, guard, type PaymentIntent } from "../src/guard/index.js";
import { LIMITS, PAYEE, project } from "./helpers.js";

const pay = (amount: string, more: Partial<PaymentIntent> = {}): PaymentIntent => ({ to: PAYEE, asset: "USDC", amount, chain: "eip155:84532", ...more });
const day = (iso: string) => () => new Date(iso);
const NOON = day("2026-10-07T12:00:00Z");

function sender() {
  const sent: PaymentIntent[] = [];
  return { sent, send: async (p: PaymentIntent) => (sent.push(p), { txHash: `0x${String(sent.length).padStart(64, "0")}` }) };
}
const denied = async (p: Promise<unknown>) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(PaymentDenied);
  return err as PaymentDenied;
};

describe("the local guard", () => {
  it("lets a payment within the limits through and leaves a signed receipt that verifies", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    const result = await guard(send, { cwd, now: NOON })(pay("25"));
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ position: 0 });

    const receipt = JSON.parse(readFileSync(join(cwd, ".alma", "receipts.jsonl"), "utf-8").trim());
    expect(receipt.statement).toMatchObject({ amount: "25000000", asset: "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e", env: "testnet", to: PAYEE });
    const report = await verify({ ...(await readProject(cwd, NOON())) });
    expect(Object.fromEntries(report.checks.filter((c) => c.id.startsWith("HIS")).map((c) => [c.id, c.status]))).toEqual({ "HIS-01": "pass", "HIS-02": "pass", "HIS-03": "pass" });
  });

  it("refuses a payment over the per-transaction limit without sending it", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    const err = await denied(guard(send, { cwd, now: NOON })(pay("100.01")));
    expect(err.code).toBe("denied");
    expect(err.reasons.join()).toContain("maxTransaction");
    expect(sent).toHaveLength(0);
  });

  it("refuses an asset that isn't allowed, and one it doesn't know", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    const dai = { symbol: "DAI", chain: "eip155:84532", id: "eip155:84532/erc20:0x00000000000000000000000000000000000000dd", decimals: 18 };
    expect((await denied(guard(send, { cwd, now: NOON, assets: [dai] })(pay("1", { asset: "DAI" })))).reasons.join()).toContain("allowedAssets");
    expect((await denied(guard(send, { cwd, now: NOON })(pay("1", { asset: "DAI" })))).code).toBe("unknown_asset");
    expect(sent).toHaveLength(0);
  });

  it("asks a person above the approval threshold, and refuses without an answer", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    expect((await denied(guard(send, { cwd, now: NOON })(pay("60")))).code).toBe("approval_required");
    expect((await denied(guard(send, { cwd, now: NOON, approve: async () => false })(pay("60")))).code).toBe("approval_declined");
    // Anything but a clear yes is a no.
    expect((await denied(guard(send, { cwd, now: NOON, approve: (async () => "yes") as never })(pay("60")))).code).toBe("approval_declined");
    expect(sent).toHaveLength(0);
    await guard(send, { cwd, now: NOON, approve: async () => true })(pay("60"));
    expect(sent).toHaveLength(1);
  });

  it("counts the day's receipts against the daily limit, and starts again the next day", async () => {
    const { cwd } = await project({ rules: { ...LIMITS, humanApprovalThreshold: undefined, dailySpend: { USDC: "150" } } });
    const { sent, send } = sender();
    const today = guard(send, { cwd, now: NOON });
    await today(pay("100"));
    await today(pay("50"));
    expect((await denied(today(pay("0.01")))).reasons.join()).toContain("dailySpend");
    expect(sent).toHaveLength(2);
    await guard(send, { cwd, now: day("2026-10-08T00:00:01Z") })(pay("100"));
    expect(sent).toHaveLength(3);
  });

  it("payments started together can't both fit under a limit only one fits under", async () => {
    const { cwd } = await project({ rules: { ...LIMITS, humanApprovalThreshold: undefined, dailySpend: { USDC: "150" } } });
    const { sent, send } = sender();
    const guarded = guard(send, { cwd, now: NOON });
    const results = await Promise.allSettled([guarded(pay("100")), guarded(pay("100")), guarded(pay("100"))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    expect(sent).toHaveLength(1);
  });

  it("extra rules can only tighten: the organization's ceiling wins over the agent's own limit", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    await denied(guard(send, { cwd, now: NOON, rules: [{ maxTransaction: { USDC: "10" } }] })(pay("25")));
    // A looser extra rule doesn't raise the agent's own limit.
    await denied(guard(send, { cwd, now: NOON, rules: [{ maxTransaction: { USDC: "100000" } }] })(pay("101")));
    expect(sent).toHaveLength(0);
  });

  it("refuses everything when the project isn't connected, or its delegation is gone", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    expect((await denied(guard(send, { cwd, now: day("2027-06-01T00:00:00Z") })(pay("1")))).code).toBe("not_connected");
    rmSync(join(cwd, ".alma"), { recursive: true });
    expect((await denied(guard(send, { cwd, now: NOON })(pay("1")))).code).toBe("not_connected");
    expect(sent).toHaveLength(0);
  });

  it("refuses a capability that wasn't delegated, and amounts that aren't amounts", async () => {
    const { cwd } = await project();
    const { sent, send } = sender();
    expect((await denied(guard(send, { cwd, now: NOON })(pay("1", { capability: "swap" })))).reasons.join()).toContain("not been delegated");
    for (const amount of ["-5", "1e2", "0.0000001", "", "NaN"]) await denied(guard(send, { cwd, now: NOON })(pay(amount)));
    expect(sent).toHaveLength(0);
  });

  it("a counterparty rule it can't evaluate denies rather than passes", async () => {
    const { cwd } = await project({ counterparty: true });
    const { sent, send } = sender();
    await denied(guard(send, { cwd, now: NOON })(pay("1", { counterparty: "alma:main:agent:stranger" })));
    await guard(send, { cwd, now: NOON })(pay("1", { counterparty: "alma:main:agent:supplier" }));
    expect(sent).toHaveLength(1);
  });

  it("says so, with the transaction, when a payment went out and couldn't be recorded", async () => {
    const { cwd } = await project();
    const err = await guard(async () => ({ txHash: "not ascii: ñ" }), { cwd, now: NOON })(pay("1")).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentNotRecorded);
    expect((err as PaymentNotRecorded).txHash).toBe("not ascii: ñ");
  });

  it("check() answers without sending or writing anything", async () => {
    const { cwd } = await project();
    expect(check(pay("25"), { cwd, now: NOON })).toEqual({ decision: "allow" });
    expect(check(pay("60"), { cwd, now: NOON }).decision).toBe("needs_approval");
    expect(check(pay("500"), { cwd, now: NOON }).decision).toBe("deny");
  });
});
