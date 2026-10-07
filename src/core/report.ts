import { canonicalJsonValue, jsonDigest, type IssuerKeyset, type IssuerSigner } from "@adasouls/alma-core";
import { runChecks } from "./checks.js";
import { REPORT_VERSION, VERDICTS, VERDICT_MEANING, type Facts, type Report, type Verdict } from "./types.js";
import { ringsOf, verdictOf } from "./verdict.js";

/** Runs every check and assembles the report. Deterministic: the same facts give the same report, apart from its time. */
export async function verify(facts: Facts, sources: string[] = [], simulated = false): Promise<Report> {
  const checks = await runChecks(facts);
  const verdict = verdictOf(checks, facts);
  return {
    v: REPORT_VERSION,
    subject: facts.identity?.id ?? null,
    generatedAt: facts.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    verdict,
    meaning: VERDICT_MEANING[verdict],
    rings: ringsOf(checks, facts, verdict),
    checks,
    scope: { wallet: facts.custody?.wallet ?? null, chain: facts.custody?.chain ?? null, sources, simulated },
  };
}

export const REPORT_ENVELOPE_TYPE = "alma-verification-report/1";

/**
 * A report, signed by whoever ran the verifier: the same envelope style
 * as ALMA receipts (a flat payload, canonical JSON, Ed25519), so a report
 * someone forwards can be checked. The payload carries the report's
 * digest, its subject and its verdict; the report travels next to it.
 */
export interface SignedReport {
  report: Report;
  envelope: {
    payload: { t: typeof REPORT_ENVELOPE_TYPE; iss: string; kid: string; subject: string; verdict: Verdict; digest: string; generatedAt: string };
    alg: "Ed25519";
    sig: string;
  };
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export async function signReport(report: Report, signer: IssuerSigner, iss: string): Promise<SignedReport> {
  const payload = { t: REPORT_ENVELOPE_TYPE, iss, kid: signer.kid, subject: report.subject ?? "none", verdict: report.verdict, digest: await jsonDigest(report), generatedAt: report.generatedAt } as const;
  const sig = await signer.sign(new TextEncoder().encode(canonicalJsonValue(payload)));
  return { report, envelope: { payload, alg: "Ed25519", sig: b64url(sig) } };
}

export type ReportCheck = { ok: true; report: Report } | { ok: false; reason: string };

/** That this report is the one that was signed, by a key the reader trusts for that verifier. */
export async function verifySignedReport(signed: SignedReport, keyset: IssuerKeyset): Promise<ReportCheck> {
  const p = signed?.envelope?.payload;
  if (!p || signed.envelope.alg !== "Ed25519" || p.t !== REPORT_ENVELOPE_TYPE || !(VERDICTS as readonly string[]).includes(p.verdict)) return { ok: false, reason: "malformed envelope" };
  const key = keyset.get(p.kid);
  if (!key) return { ok: false, reason: `untrusted key ${p.kid}` };
  if (key.iss !== p.iss) return { ok: false, reason: `key ${p.kid} does not sign for ${p.iss}` };
  const valid = await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key.cryptoKey, Buffer.from(signed.envelope.sig, "base64url"), new TextEncoder().encode(canonicalJsonValue(p)));
  if (!valid) return { ok: false, reason: "bad signature" };
  if ((await jsonDigest(signed.report)) !== p.digest) return { ok: false, reason: "the report isn't the one that was signed" };
  if (signed.report.verdict !== p.verdict || (signed.report.subject ?? "none") !== p.subject) return { ok: false, reason: "the report disagrees with what was signed" };
  return { ok: true, report: signed.report };
}
