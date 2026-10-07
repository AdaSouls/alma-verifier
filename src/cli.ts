#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { createIssuerKeyset } from "@adasouls/alma-core";
import { readCustody, type ChainReader } from "./adapters/chain.js";
import { evmReader } from "./adapters/evm.js";
import { loadSigner, localIssuer, readProject, readRulesFile, storeDir } from "./adapters/local.js";
import { SimulatedChain } from "./adapters/simulated.js";
import { KNOWN_ASSETS, type AssetInfo } from "./core/assets.js";
import { declaredRules } from "./core/checks.js";
import { signReport, verify, verifySignedReport, type SignedReport } from "./core/report.js";
import { VERDICTS, type CheckResult, type Facts, type Report, type Verdict } from "./core/types.js";
import { check } from "./guard/index.js";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow] = [paint(1), paint(2), paint(31), paint(32), paint(33)];
const MARK: Record<CheckResult["status"], string> = { pass: green("✓"), fail: red("✗"), na: dim("–"), unknown: yellow("?") };
const GROUPS: [string, string][] = [["IDN", "Identity"], ["AUT", "Authority"], ["POL", "Policy"], ["CUS", "Custody"], ["HIS", "History"]];

export function render(report: Report): string {
  const lines: string[] = [];
  const colour = report.verdict === "CHAIN-ENFORCED" || report.verdict === "CUSTODY-ENFORCED" ? green : report.verdict === "ADVISORY" ? yellow : red;
  lines.push("", `${bold("Verdict")}  ${colour(bold(report.verdict))}`, `         ${report.meaning}`, `${bold("Agent")}    ${report.subject ?? "none"}`);
  if (report.scope.wallet) lines.push(`${bold("Wallet")}   ${report.scope.wallet} on ${report.scope.chain}`);
  lines.push("", bold("What stands between this agent and the funds"));
  for (const ring of report.rings) lines.push(`  Ring ${ring.ring}  ${ring.name}: ${ring.state === "in place" ? green(ring.state) : ring.state === "unknown" ? yellow("can't be seen from here") : red(ring.state)}  ${dim(`(stops ${ring.stops})`)}`);
  for (const [prefix, name] of GROUPS) {
    lines.push("", bold(name));
    for (const c of report.checks.filter((c) => c.id.startsWith(prefix))) {
      lines.push(`  ${MARK[c.status]} ${c.id}  ${c.title}${c.status === "fail" ? dim(`  [${c.severity}]`) : ""}`, `           ${dim(c.detail)}`);
      if (c.fix) lines.push(`           → ${c.fix}`);
    }
  }
  const count = (s: CheckResult["status"]) => report.checks.filter((c) => c.status === s).length;
  lines.push("", `${count("pass")} passed, ${count("fail")} failed, ${count("unknown")} couldn't be checked, ${count("na")} don't apply.`);
  if (count("unknown")) lines.push(dim("A check that couldn't be run never counts in the agent's favour."));
  lines.push("");
  return lines.join("\n");
}

interface DoctorOptions {
  cwd: string;
  wallet?: string;
  signer?: string;
  custodySigns?: boolean;
  rpc?: string;
  allowanceModule?: string;
  simulate?: string;
  orgRules?: string;
  assets?: string;
  json?: boolean;
  sign?: boolean;
  out?: string;
  require?: string;
}

async function doctor(o: DoctorOptions): Promise<void> {
  const cwd = resolve(o.cwd);
  const assets: AssetInfo[] = [...(o.assets ? (JSON.parse(readFileSync(o.assets, "utf-8")) as AssetInfo[]) : []), ...KNOWN_ASSETS];
  const sources = ["project files (alma.yaml, .alma/)"];
  const facts: Facts = { ...(await readProject(cwd)), assets };
  if (o.orgRules) {
    facts.orgRules = readRulesFile(o.orgRules);
    sources.push("organization rules file");
  }

  if (o.wallet) {
    try {
      let reader: ChainReader;
      if (o.simulate) {
        reader = new SimulatedChain(JSON.parse(readFileSync(o.simulate, "utf-8")));
        sources.push("simulated chain (a file, not a network)");
      } else if (o.rpc) {
        reader = await evmReader({ rpcUrl: o.rpc, allowanceModule: o.allowanceModule });
        sources.push(`chain ${reader.chain} over JSON-RPC`);
      } else throw new Error("no chain to read it from was given (--rpc, or --simulate for a simulated one)");
      const rules = declaredRules(facts);
      const symbols = [...new Set([...(rules.allowedAssets ?? []), ...Object.keys(rules.maxTransaction ?? {}), ...Object.keys(rules.dailySpend ?? {})])];
      facts.custody = await readCustody(reader, { wallet: o.wallet, agentSigner: o.signer, signedBy: o.custodySigns ? "custody" : undefined, symbols, assets });
    } catch (err) {
      facts.custodyUnreadable = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    }
  }

  const report = await verify(facts, sources, Boolean(o.simulate && o.wallet));
  let output: Report | SignedReport = report;
  if (o.sign) {
    const signer = await loadSigner(cwd);
    if (!signer || !report.subject) throw new Error("--sign needs this project's key (.alma/issuer.key) and identity: run `alma connect` first");
    output = await signReport(report, signer, localIssuer(report.subject));
    writeFileSync(o.out ?? join(storeDir(cwd), "verification.json"), JSON.stringify(output, null, 2) + "\n", "utf-8");
  } else if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2) + "\n", "utf-8");

  if (o.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(render(report));
    if (o.sign) console.log(dim(`Signed with this project's own key and saved to ${o.out ?? ".alma/verification.json"}. It says what this machine found; it is not AdaSouls' word.\n`));
    if (report.scope.simulated) console.log(yellow("Custody was read from a simulated chain. This verdict says nothing about real funds.\n"));
  }
  if (o.require) {
    if (!(VERDICTS as readonly string[]).includes(o.require)) throw new Error(`--require: one of ${VERDICTS.join(", ")}`);
    if (VERDICTS.indexOf(report.verdict) < VERDICTS.indexOf(o.require as Verdict)) process.exitCode = 2;
  }
}

const program = new Command();
program.name("alma-verifier").description("Will this agent obey its soul? Checks an agent's ALMA identity, authority, limits and custody, and says what actually enforces them.");

program
  .command("doctor")
  .description("Verify the agent in this project. Runs on this machine; nothing is uploaded.")
  .option("--cwd <dir>", "the project's folder", ".")
  .option("--wallet <address>", "the address the agent's funds are at")
  .option("--signer <address>", "an address whose key the agent's runtime holds")
  .option("--custody-signs", "a custody service signs for the agent, which holds no key")
  .option("--rpc <url>", "a JSON-RPC endpoint of the wallet's chain (read-only calls)")
  .option("--allowance-module <address>", "the Safe Allowance Module's address on that chain")
  .option("--simulate <file>", "read custody from a simulated chain described in a JSON file")
  .option("--org-rules <file>", "the organization's rules, to check the agent doesn't loosen them")
  .option("--assets <file>", "extra tokens: a JSON list of { symbol, chain, id, decimals }")
  .option("--json", "print the report as JSON")
  .option("--sign", "sign the report with this project's key and save it")
  .option("--out <file>", "where to write the report")
  .option("--require <verdict>", "exit with status 2 unless the verdict is at least this one (for CI)")
  .action(doctor);

program
  .command("check")
  .description("Would this payment be let through by the declared limits? Sends nothing.")
  .requiredOption("--to <address>", "who receives it")
  .requiredOption("--asset <symbol>", "e.g. USDC")
  .requiredOption("--amount <amount>", "e.g. 25")
  .requiredOption("--chain <caip2>", "e.g. eip155:84532")
  .option("--counterparty <id>", "the payee's ALMA id")
  .option("--cwd <dir>", "the project's folder", ".")
  .option("--json", "print the decision as JSON")
  .action((o: { to: string; asset: string; amount: string; chain: string; counterparty?: string; cwd: string; json?: boolean }) => {
    const decision = check({ to: o.to, asset: o.asset, amount: o.amount, chain: o.chain, counterparty: o.counterparty }, { cwd: resolve(o.cwd) });
    if (o.json) console.log(JSON.stringify(decision, null, 2));
    else if (decision.decision === "allow") console.log(`${green("allow")}  within the declared limits`);
    else if (decision.decision === "needs_approval") console.log(`${yellow("needs approval")}  a person must approve it first`);
    else console.log(`${red("deny")}  ${decision.reasons.join("; ")}`);
    if (decision.decision === "deny") process.exitCode = 1;
  });

program
  .command("verify-report <file>")
  .description("Check a signed report: that it is the one that was signed, by the key you expect.")
  .requiredOption("--issuer <name>", "who signed it, e.g. self:alma:main:agent:shopper")
  .requiredOption("--key <base64url>", "that signer's Ed25519 public key, obtained from them and not from the report")
  .action(async (file: string, o: { issuer: string; key: string }) => {
    const result = await verifySignedReport(JSON.parse(readFileSync(file, "utf-8")) as SignedReport, await createIssuerKeyset([{ iss: o.issuer, publicKey: o.key }]));
    if (result.ok) console.log(`${green("✓")} Signed by ${o.issuer}: ${result.report.verdict} for ${result.report.subject ?? "no agent"}, generated ${result.report.generatedAt}${result.report.scope.simulated ? yellow("\n  Custody was read from a simulated chain: this says nothing about real funds.") : ""}`);
    else {
      console.log(`${red("✗")} ${result.reason}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`${red("✗")} ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
