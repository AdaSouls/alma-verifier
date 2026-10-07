#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { AdaSouls } from "@adasouls/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { LocalSigner, createIssuerKeyset } from "@adasouls/alma-core";
import { readCustody, type ChainReader } from "./adapters/chain.js";
import { evmReader } from "./adapters/evm.js";
import { loadSigner, localIssuer, readIdentity, readManifest, readProject, readRulesFile, storeDir } from "./adapters/local.js";
import { SimulatedChain, type SimulatedState } from "./adapters/simulated.js";
import { KNOWN_ASSETS, type AssetInfo } from "./core/assets.js";
import { declaredRules } from "./core/checks.js";
import { signReport, verify, verifySignedReport, type SignedReport } from "./core/report.js";
import { VERDICTS, type CheckResult, type Facts, type Report, type Verdict } from "./core/types.js";
import { DEFAULT_MODEL, explain, plainReport, type Explanation } from "./explainer/index.js";
import { check } from "./guard/index.js";
import { createHttpServer } from "./http/server.js";
import { createMcpServer } from "./mcp/server.js";
import { Verifier, type VerifierOptions } from "./service.js";

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
  if (report.verdict === "ADVISORY" && report.rings.some((r) => r.ring > 1 && r.state === "in place")) {
    lines.push("", yellow("  This wallet is protected, but it isn't shown to be this agent's (IDN-03), so the verdict stays ADVISORY."));
  }
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

// ---------- The verifier as a service: MCP and HTTP ----------

interface ServiceFlags {
  projectRoot?: string;
  rpc: string[];
  allowanceModule: string[];
  simulate?: string;
  assets?: string;
  model?: string;
  explainer?: boolean;
}

const collect = (value: string, previous: string[]) => [...previous, value];

/** "eip155:84532=https://…" pairs. The chain id has a colon in it, so the split is on the first "=". */
function pairs(values: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    if (at < 1 || at === value.length - 1) throw new Error(`${flag}: write it as <chain>=<value>, e.g. eip155:84532=…`);
    out[value.slice(0, at)] = value.slice(at + 1);
  }
  return out;
}

/** `ownKey`: use this process's ADASOULS_API_KEY for callers who send none. Right for one person's local MCP server, never for a server others can call. */
function serviceOptions(o: ServiceFlags, ownKey: boolean): VerifierOptions {
  const rpc = pairs(o.rpc, "--rpc");
  const modules = pairs(o.allowanceModule, "--allowance-module");
  for (const chain of Object.keys(modules)) if (!rpc[chain]) throw new Error(`--allowance-module names ${chain}, and no --rpc was given for it`);
  const baseUrl = process.env.ADASOULS_API_URL || undefined;
  // A model is used only when asked for, or when its credentials are plainly there.
  const withModel = o.explainer ?? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return {
    chains: Object.fromEntries(Object.entries(rpc).map(([chain, rpcUrl]) => [chain, { rpcUrl, allowanceModule: modules[chain] }])),
    simulated: o.simulate ? (JSON.parse(readFileSync(o.simulate, "utf-8")) as SimulatedState) : undefined,
    projectRoot: o.projectRoot ? resolve(o.projectRoot) : undefined,
    agent: (almaId, apiKey) => new AdaSouls({ apiKey, baseUrl }).agent(almaId),
    apiKey: ownKey ? process.env.ADASOULS_API_KEY || undefined : undefined,
    assets: o.assets ? (JSON.parse(readFileSync(o.assets, "utf-8")) as AssetInfo[]) : undefined,
    explainer: withModel ? { client: new Anthropic({ timeout: 120_000, maxRetries: 1 }), model: o.model ?? process.env.ALMA_VERIFIER_MODEL ?? DEFAULT_MODEL } : undefined,
  };
}

/** The verifier's own signing key: read from the file, or made there the first time. */
async function verifierKey(path: string): Promise<LocalSigner> {
  if (existsSync(path)) return LocalSigner.fromPkcs8(new Uint8Array(readFileSync(path)));
  const signer = await LocalSigner.generate();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, await signer.exportPkcs8(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return signer;
}

const service = (command: Command) =>
  command
    .option("--rpc <chain=url>", "where to read a chain from, e.g. eip155:84532=https://sepolia.base.org (repeatable)", collect, [])
    .option("--allowance-module <chain=address>", "the Safe Allowance Module's address on a chain (repeatable)", collect, [])
    .option("--simulate <file>", "also read custody from a simulated chain described in a JSON file")
    .option("--assets <file>", "extra tokens: a JSON list of { symbol, chain, id, decimals }")
    .option("--explainer", "explain reports with a Claude model (on by default when ANTHROPIC_API_KEY is set)")
    .option("--model <id>", `the Claude model that explains (default ${DEFAULT_MODEL}, or ALMA_VERIFIER_MODEL)`);

service(
  program
    .command("mcp")
    .description("Run as an MCP server over stdio, for an AI client on this machine. Tools: alma_verify_agent, alma_check_intent, alma_explain.")
    .option("--project-root <dir>", "the folder local projects may be read from", ".")
).action(async (o: ServiceFlags) => {
  // stdout belongs to the MCP transport: nothing else is written to it.
  await createMcpServer(new Verifier(serviceOptions(o, true))).connect(new StdioServerTransport());
});

service(
  program
    .command("serve")
    .description("Run as an HTTP server: POST /v1/verify, /v1/check, /v1/explain, GET /v1/reports/:id, and the MCP tools at /mcp.")
    .option("--port <port>", "the port to listen on", "8787")
    .option("--host <address>", "the address to listen on", "127.0.0.1")
    .option("--project-root <dir>", "let callers verify local projects under this folder (off by default)")
    .option("--key <file>", "this verifier's signing key; made on first run", join(homedir(), ".alma-verifier", "issuer.key"))
    .option("--issuer <name>", "the name this verifier signs reports as")
    .option("--token <token>", "require `Authorization: Bearer <token>`. Prefer ALMA_VERIFIER_TOKEN: a flag shows in the process list")
    .option("--allowed-host <host>", "a Host header to answer to (repeatable); defaults to this machine's names when listening on it", collect, [])
    .option("--reports-dir <dir>", "keep reports on disk as well")
).action(async (o: ServiceFlags & { port: string; host: string; key: string; issuer?: string; token?: string; allowedHost: string[]; reportsDir?: string }) => {
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port: a number between 1 and 65535");
  const local = ["127.0.0.1", "localhost", "::1"].includes(o.host);
  const token = o.token ?? (process.env.ALMA_VERIFIER_TOKEN || undefined);
  if (!local && !token) throw new Error(`listening on ${o.host} lets others reach this server: set --token (or ALMA_VERIFIER_TOKEN) first`);
  const signer = await verifierKey(resolve(o.key));
  const issuer = o.issuer ?? `verifier:${o.host}:${port}`;
  const verifier = new Verifier({ ...serviceOptions(o, false), signer, issuer, reportsDir: o.reportsDir ? resolve(o.reportsDir) : undefined });
  const allowedHosts = o.allowedHost.length ? o.allowedHost : local ? [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`] : undefined;
  createHttpServer(verifier, { token, allowedHosts }).listen(port, o.host, () => {
    console.error(`alma-verifier listening on http://${o.host}:${port}`);
    console.error(`  signs reports as ${issuer}, key ${signer.kid}`);
    console.error(`  public key ${Buffer.from(signer.publicKey).toString("base64url")}`);
    if (!token) console.error(yellow("  no token set: anyone who can reach this address can use it"));
  });
});

// ---------- Forge: this project's verifier, driven from a browser ----------

const DEFAULT_FORGE_URL = "https://forge.adasouls.io";

/** Hands a link to the system's browser. Best effort: the link is printed too. */
function openInBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser to hand it to: the printed link is enough.
  }
}

/** The first port from `from` on that nothing on this machine is listening on. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 50; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createTcpServer();
      probe.once("error", () => done(false));
      // No address: every interface, so a server bound to all of them counts as taken too.
      probe.listen(port, () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port between ${from} and ${from + 49}: pass one with --port`);
}

interface ForgeFlags {
  cwd: string;
  wallet?: string;
  signer?: string;
  custodySigns?: boolean;
  rpc?: string;
  allowanceModule?: string;
  simulate?: string;
  assets?: string;
  explainer?: boolean;
  model?: string;
  port?: string;
  forgeUrl: string;
  open: boolean;
}

program
  .command("forge")
  .description("Verify the agent in this project and open the result in ALMA Forge. The checks run here; the page in your browser talks to this machine only.")
  .option("--cwd <dir>", "the project's folder", ".")
  .option("--wallet <address>", "the address the agent's funds are at")
  .option("--signer <address>", "an address whose key the agent's runtime holds")
  .option("--custody-signs", "a custody service signs for the agent, which holds no key")
  .option("--rpc <url>", "a JSON-RPC endpoint of the wallet's chain (read-only calls)")
  .option("--allowance-module <address>", "the Safe Allowance Module's address on that chain")
  .option("--simulate <file>", "read custody from a simulated chain described in a JSON file")
  .option("--assets <file>", "extra tokens: a JSON list of { symbol, chain, id, decimals }")
  .option("--explainer", "explain reports with a Claude model (on by default when ANTHROPIC_API_KEY is set)")
  .option("--model <id>", `the Claude model that explains (default ${DEFAULT_MODEL}, or ALMA_VERIFIER_MODEL)`)
  .option("--port <port>", "the local port Forge talks to (default: the first free one from 8790)")
  .option("--forge-url <url>", "where Forge is served (or ALMA_FORGE_URL)", process.env.ALMA_FORGE_URL || DEFAULT_FORGE_URL)
  .option("--no-open", "print the link instead of opening the browser")
  .action(async (o: ForgeFlags) => {
    const cwd = resolve(o.cwd);
    if (o.port !== undefined && !(Number.isInteger(Number(o.port)) && Number(o.port) >= 1 && Number(o.port) <= 65535)) throw new Error("--port: a number between 1 and 65535");
    const forge = new URL(o.forgeUrl);
    // Said out loud: this origin is the one page that will be allowed to use the server below.
    if (forge.origin !== new URL(DEFAULT_FORGE_URL).origin) console.error(yellow(`! Forge is taken to be at ${forge.origin}, not ${DEFAULT_FORGE_URL} (--forge-url or ALMA_FORGE_URL). That page will be able to use this verifier.`));
    if (forge.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(forge.hostname)) throw new Error("--forge-url: an https address (or one on this machine)");

    // The chain is whichever one the endpoint answers for: read from it, never typed in.
    let chain: string | undefined;
    const chains: NonNullable<VerifierOptions["chains"]> = {};
    const simulated = o.simulate ? (JSON.parse(readFileSync(o.simulate, "utf-8")) as SimulatedState) : undefined;
    if (simulated) chain = new SimulatedChain(simulated).chain;
    else if (o.rpc) {
      chain = (await evmReader({ rpcUrl: o.rpc, allowanceModule: o.allowanceModule })).chain;
      chains[chain] = { rpcUrl: o.rpc, allowanceModule: o.allowanceModule };
    }
    if (o.wallet && !chain) throw new Error("--wallet needs a chain to read it from: --rpc, or --simulate for a simulated one");

    const identity = readIdentity(cwd);
    const signer = identity ? await loadSigner(cwd) : undefined;
    const withModel = o.explainer ?? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    const verifier = new Verifier({
      chains,
      simulated,
      projectRoot: cwd,
      // Signed with the project's own key, as `doctor --sign` does: it says what this machine found.
      ...(identity && signer ? { signer, issuer: localIssuer(identity.id) } : {}),
      assets: o.assets ? (JSON.parse(readFileSync(o.assets, "utf-8")) as AssetInfo[]) : undefined,
      explainer: withModel ? { client: new Anthropic({ timeout: 120_000, maxRetries: 1 }), model: o.model ?? process.env.ALMA_VERIFIER_MODEL ?? DEFAULT_MODEL } : undefined,
    });

    const target = { projectDir: ".", ...(o.wallet ? { walletAddress: o.wallet, chain } : {}), ...(o.signer ? { agentSigner: o.signer } : {}), ...(o.custodySigns ? { custodySigns: true } : {}) };
    /** What Forge shows next to the report. Read again on each request, so an edited alma.yaml shows after the next run. */
    const project = () => {
      const manifest = readManifest(cwd);
      return {
        folder: basename(cwd),
        agent: readIdentity(cwd)?.id ?? null,
        target,
        /** The chain payments are tried on, when one is known. */
        chain: chain ?? null,
        declared: manifest ? { capabilities: manifest.capabilities ?? [], authority: manifest.authority ?? {}, counterpartyPolicy: manifest.counterpartyPolicy ?? null } : null,
        signer: verifier.issuer ?? null,
        explainer: withModel,
      };
    };

    const first = await verifier.verify(target);
    console.log(render(first.report));
    const port = o.port !== undefined ? Number(o.port) : await freePort(8790);

    // One token per run, known to this process and to the page it opens. Nothing else can use the server.
    const token = randomBytes(24).toString("base64url");
    // The link doesn't carry the token: a link handed to a browser shows in this machine's process list.
    // It carries a code the page trades for the token, once. A code somebody else used first leaves
    // the page unable to connect, which is noticed.
    const code = randomBytes(24).toString("base64url");
    const sha = (s: string) => createHash("sha256").update(s).digest();
    let codeLeft = true;
    const codeUntil = Date.now() + 10 * 60_000;
    const exchange = (given: string) => {
      if (!codeLeft || Date.now() > codeUntil || !timingSafeEqual(sha(given), sha(code))) return undefined;
      codeLeft = false;
      return token;
    };
    const server = createHttpServer(verifier, { token, allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [forge.origin], project, exchange });
    server.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`${red("✗")} ${err.code === "EADDRINUSE" ? `port ${port} is in use: pass another with --port` : err.message}`);
      process.exit(1);
    });
    server.listen(port, "127.0.0.1", () => {
      // After the "#": a browser keeps that part to itself, so neither the token nor the report reaches Forge's server.
      const at = `${forge.origin}${forge.pathname.replace(/\/$/, "")}/#`;
      const connection = { local: `http://127.0.0.1:${port}`, code };
      const short = at + new URLSearchParams(connection).toString();
      // The browser's link also carries this first report, so the page shows it even where a browser won't let a page call this machine.
      const link = at + new URLSearchParams({ ...connection, r: gzipSync(JSON.stringify({ stored: first, project: project() })).toString("base64url") }).toString();
      console.log(`${bold("Open in ALMA Forge")}  ${short}`);
      console.log(dim(`\n  Forge runs in your browser and talks to this machine at 127.0.0.1:${port}. Your files and keys stay here.`));
      console.log(dim("  The link works once, within ten minutes: don't share it. Keep this running to verify again or try"));
      console.log(dim("  payments from the page. Ctrl+C to stop.\n"));
      if (o.open) openInBrowser(link);
    });
  });

/**
 * Text a model wrote, made safe to print next to the verifier's own
 * lines: no control characters (so it can't clear the screen or recolour
 * anything) and every line behind a bar, so none of it can pass for a
 * line the verifier printed.
 */
const fromModel = (s: string, indent = "  ") => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim().split("\n").map((line) => `${indent}${dim("│")} ${line}`).join("\n");

function renderExplanation(e: Explanation): string {
  const lines = ["", `${bold("Verdict")}  ${bold(e.verdict)}  ${dim("(computed by the checks, not by the model)")}`, `         ${e.meaning}`];
  for (const notice of e.notices) lines.push("", yellow(`! ${notice}`));
  lines.push("", bold("Explanation"), fromModel(e.explanation));
  if (e.fixes.length) {
    lines.push("", bold("Fix in this order"));
    e.fixes.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.check}  ${f.title}${dim(`  [${f.severity}]`)}`, `     → ${f.fix}`);
      if (f.why) lines.push(fromModel(f.why, "     "));
    });
  }
  if (e.concerns.length) lines.push("", bold("Also worth a look, according to the model"), ...e.concerns.map((c) => fromModel(c)));
  if (e.draftAlmaYaml) lines.push("", bold("A corrected alma.yaml to review (nothing was changed)"), fromModel(e.draftAlmaYaml));
  if (e.draftRejected) lines.push("", dim(e.draftRejected));
  lines.push("", dim(`Lines behind a bar were written by ${e.model.replace(/[^\w.:-]/g, "")}. The verdict, the findings and each fix are the verifier's.`), "");
  return lines.join("\n");
}

program
  .command("explain [file]")
  .description("Explain a report in plain language, with the fixes in order. Uses a Claude model (ANTHROPIC_API_KEY); the verdict is never the model's.")
  .option("--cwd <dir>", "the project's folder", ".")
  .option("--question <text>", "what you want to know")
  .option("--model <id>", `the Claude model to use (default ${DEFAULT_MODEL}, or ALMA_VERIFIER_MODEL)`)
  .option("--json", "print the explanation as JSON")
  .action(async (file: string | undefined, o: { cwd: string; question?: string; model?: string; json?: boolean }) => {
    const cwd = resolve(o.cwd);
    const path = file ?? join(storeDir(cwd), "verification.json");
    if (!existsSync(path)) throw new Error(`${path} not found: run \`alma-verifier doctor --out <file>\` (or --sign) first`);
    const read = JSON.parse(readFileSync(path, "utf-8")) as Report | SignedReport;
    const report = plainReport("report" in read ? read.report : read);
    if (!report) throw new Error(`${path} is not a verification report`);
    // The project's limits are sent along only when the report is about this project's agent.
    const manifest = report.subject && readIdentity(cwd)?.id === report.subject ? readManifest(cwd) : undefined;
    const explanation = await explain(new Anthropic(), { report, manifest, question: o.question }, o.model ?? process.env.ALMA_VERIFIER_MODEL ?? DEFAULT_MODEL);
    console.log(o.json ? JSON.stringify(explanation, null, 2) : renderExplanation(explanation));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`${red("✗")} ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
