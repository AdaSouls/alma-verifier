import { describe, expect, it } from "vitest";
import { LocalSigner, buildReceiptStatement, createIssuerKeyset, envelopeLeafHash, hashToHex, appendToFrontier, emptyFrontier, merkleRoot, hexToHash, receiptDigest, signReceiptMint } from "@adasouls/alma-core";
import { signReport, verify, verifySignedReport } from "../src/core/report.js";
import type { HistoryFacts } from "../src/core/types.js";
import { connected, eoa, safe } from "./helpers.js";

const USDC = "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function history(amounts: string[], payer = "alma:main:agent:shopper"): Promise<{ facts: HistoryFacts; signer: LocalSigner }> {
  const signer = await LocalSigner.generate();
  const iss = `self:${payer}`;
  const receipts = [];
  let frontier = emptyFrontier();
  const leaves: string[] = [];
  for (const [i, amount] of amounts.entries()) {
    const statement = buildReceiptStatement({ issuer: iss, env: "testnet", action: `act_${i}`, payer, payee: "alma:main:agent:supplier", capability: "pay", chain: "eip155:84532", asset: USDC, amount, to: "0x5555555555555555555555555555555555555555", txHash: `0x${String(i).padStart(64, "0")}` });
    const mint = await signReceiptMint(signer, { iss, receipt: `rcp_${i}`, digest: await receiptDigest(statement), independent: false });
    receipts.push({ id: `rcp_${i}`, statement, mint });
    const leaf = await envelopeLeafHash(mint);
    frontier = await appendToFrontier(frontier, leaf);
    leaves.push(hashToHex(leaf));
  }
  const keyset = await createIssuerKeyset([{ iss, publicKey: Buffer.from(signer.publicKey).toString("base64url") }]);
  return { facts: { receipts, keyset, log: { size: frontier.size, frontier: frontier.nodes.map(hashToHex), leaves } }, signer };
}

const his = async (h: HistoryFacts) => Object.fromEntries((await verify(connected({ history: h }))).checks.filter((c) => c.id.startsWith("HIS")).map((c) => [c.id, c.status]));

describe("history", () => {
  it("a clean history passes", async () => {
    const { facts } = await history(["25000000", "40000000"]);
    expect(await his(facts)).toEqual({ "HIS-01": "pass", "HIS-02": "pass", "HIS-03": "pass" });
  });

  it("no history is not a failure, and unavailable history is unknown", async () => {
    expect(await his({ receipts: [], keyset: new Map() })).toEqual({ "HIS-01": "na", "HIS-02": "na", "HIS-03": "na" });
    expect((await verify(connected())).checks.filter((c) => c.id.startsWith("HIS")).every((c) => c.status === "unknown")).toBe(true);
  });

  it("HIS-01: an edited receipt, or one signed by another key", async () => {
    const { facts } = await history(["25000000"]);
    const edited = { ...facts, receipts: [{ ...facts.receipts[0], statement: { ...(facts.receipts[0].statement as object), amount: "1" } }] };
    expect((await his(edited))["HIS-01"]).toBe("fail");
    const other = await history(["25000000"]);
    expect((await his({ ...facts, keyset: other.facts.keyset }))["HIS-01"]).toBe("fail");
  });

  it("HIS-02: a receipt removed from the log, a log that lost entries, a rewritten log", async () => {
    const { facts } = await history(["25000000", "40000000", "10000000"]);
    const log = facts.log!;
    expect((await his({ ...facts, log: { ...log, leaves: log.leaves.slice(0, 2) } }))["HIS-02"]).toBe("fail");

    const anchored = { treeSize: 2, rootHash: hashToHex(await merkleRoot(log.leaves.slice(0, 2).map(hexToHash))) };
    expect((await his({ ...facts, anchored }))["HIS-02"]).toBe("pass");
    expect((await his({ ...facts, anchored: { treeSize: 5, rootHash: anchored.rootHash } }))["HIS-02"]).toBe("fail");

    // The same number of entries, in another order: internally consistent, but not what was anchored.
    const swapped = [log.leaves[1], log.leaves[0], log.leaves[2]];
    let frontier = emptyFrontier();
    for (const leaf of swapped) frontier = await appendToFrontier(frontier, hexToHash(leaf));
    const rewritten = { size: 3, frontier: frontier.nodes.map(hashToHex), leaves: swapped };
    expect((await his({ ...facts, log: rewritten }))["HIS-02"]).toBe("pass");
    expect((await his({ ...facts, log: rewritten, anchored }))["HIS-02"]).toBe("fail");
  });

  it("HIS-03: a past payment above today's limit is reported, and doesn't change the verdict", async () => {
    const { facts } = await history(["25000000", "250000000"]);
    const report = await verify(connected({ history: facts, custody: safe() }));
    const his03 = report.checks.find((c) => c.id === "HIS-03")!;
    expect(his03.status).toBe("fail");
    expect(his03.detail).toContain("250 USDC");
    expect(report.verdict).toBe("CHAIN-ENFORCED");
  });
});

describe("signed reports", () => {
  it("verifies, and only against the key the reader pinned", async () => {
    const signer = await LocalSigner.generate();
    const report = await verify(connected({ custody: safe() }));
    const signed = await signReport(report, signer, "self:alma:main:agent:shopper");
    const keyset = await createIssuerKeyset([{ iss: "self:alma:main:agent:shopper", publicKey: Buffer.from(signer.publicKey).toString("base64url") }]);
    expect(await verifySignedReport(signed, keyset)).toMatchObject({ ok: true });

    const stranger = await LocalSigner.generate();
    const wrong = await createIssuerKeyset([{ iss: "self:alma:main:agent:shopper", publicKey: Buffer.from(stranger.publicKey).toString("base64url") }]);
    expect(await verifySignedReport(signed, wrong)).toMatchObject({ ok: false });
    const otherName = await createIssuerKeyset([{ iss: "adasouls", publicKey: Buffer.from(signer.publicKey).toString("base64url") }]);
    expect(await verifySignedReport(signed, otherName)).toMatchObject({ ok: false });
  });

  it("a verdict upgraded after signing is caught, in the report or in the envelope", async () => {
    const signer = await LocalSigner.generate();
    const signed = await signReport(await verify(connected({ custody: eoa() })), signer, "self:x");
    const keyset = await createIssuerKeyset([{ iss: "self:x", publicKey: Buffer.from(signer.publicKey).toString("base64url") }]);
    expect(signed.report.verdict).toBe("ADVISORY");

    const upgradedReport = { ...signed, report: { ...signed.report, verdict: "CHAIN-ENFORCED" as const } };
    expect(await verifySignedReport(upgradedReport, keyset)).toMatchObject({ ok: false });
    const upgradedEnvelope = { ...signed, envelope: { ...signed.envelope, payload: { ...signed.envelope.payload, verdict: "CHAIN-ENFORCED" as const } } };
    expect(await verifySignedReport(upgradedEnvelope, keyset)).toMatchObject({ ok: false, reason: "bad signature" });
    const removedFinding = { ...signed, report: { ...signed.report, checks: signed.report.checks.filter((c) => c.status !== "fail") } };
    expect(await verifySignedReport(removedFinding, keyset)).toMatchObject({ ok: false });
    expect(await verifySignedReport({} as never, keyset)).toMatchObject({ ok: false });
  });
});
