import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { canonicalJsonValue, type IssuerSigner } from "@adasouls/alma-core";
import type { AgentManifest } from "@adasouls/alma-manifest";
import { readAgent, type AgentSource } from "./adapters/api.js";
import { readCustody, type ChainReader } from "./adapters/chain.js";
import { evmReader } from "./adapters/evm.js";
import { readProject } from "./adapters/local.js";
import { SimulatedChain, type SimulatedState } from "./adapters/simulated.js";
import { KNOWN_ASSETS, type AssetInfo } from "./core/assets.js";
import { declaredRules } from "./core/checks.js";
import { signReport, verify, type SignedReport } from "./core/report.js";
import type { Facts, Report } from "./core/types.js";
import { ExplainerUnavailable, explain, plainReport, type ExplainerClient, type Explanation } from "./explainer/index.js";
import { check } from "./guard/index.js";

/**
 * The three things the verifier does for a caller, behind both
 * transports (MCP and HTTPS): verify an agent, check one payment against
 * its limits, explain a report.
 *
 * What a caller can and can't choose, since a caller may be anyone:
 * - which agent, wallet and chain to look at;
 * - never where the chain is read from (the RPC endpoints are this
 *   process's configuration, so a request can't make it fetch a URL);
 * - never a folder outside the one this process was told it may read;
 * - never whose credentials reach the ALMA provider: a caller's own key
 *   is used for the caller's own request.
 */
export class InputError extends Error {}
export class NotConfigured extends Error {}
export class NotFound extends Error {}
export class UpstreamError extends Error {}

/** An agent at an ALMA provider: what the AdaSouls SDK's `adasouls.agent(id)` returns. */
export interface AgentHandle extends AgentSource {
  checkPolicy(input: { capability: string; amount?: string; asset?: string; to?: string; counterparty?: { id: string } }): Promise<{ allowed: boolean; reasons: string[]; approvalsRequired: string[] }>;
}

export interface VerifierOptions {
  /** Where each chain is read from, by CAIP-2 id. */
  chains?: Record<string, { rpcUrl: string; allowanceModule?: string }>;
  /** A simulated chain to read custody from. Reports that use it are marked simulated. */
  simulated?: SimulatedState;
  /** The folder local projects may be read from. Unset: no local projects. */
  projectRoot?: string;
  /** How to reach an agent at the ALMA provider with a given key. Unset: agents can't be looked up by id. */
  agent?: (almaId: string, apiKey: string) => AgentHandle;
  /** The key used when a caller sends none (a local, single-user server). */
  apiKey?: string;
  /** Signs the reports this verifier produces. Unset: they are returned unsigned. */
  signer?: IssuerSigner & { publicKey: Uint8Array };
  issuer?: string;
  explainer?: { client: ExplainerClient; model?: string };
  assets?: AssetInfo[];
  /** Keep reports on disk as well, one file each. */
  reportsDir?: string;
  now?: () => Date;
}

export interface VerifyInput {
  almaId?: string;
  projectDir?: string;
  walletAddress?: string;
  /** CAIP-2. */
  chain?: string;
  /** An address whose key the agent's runtime holds. */
  agentSigner?: string;
  /** A custody service signs for the agent, which holds no key. */
  custodySigns?: boolean;
}

export interface CheckInput {
  almaId?: string;
  projectDir?: string;
  capability?: string;
  amount: string;
  asset: string;
  to: string;
  chain?: string;
  counterparty?: string;
}

export interface CheckOutcome {
  outcome: "pass" | "fail" | "requires_approval";
  reasons: string[];
  approvals: string[];
  /** Whose answer this is. Both run the same policy engine; only the provider knows what was spent through it today. */
  decidedBy: "the limits in this project, evaluated here" | "the ALMA provider";
}

export interface StoredReport {
  id: string;
  report: Report;
  envelope?: SignedReport["envelope"];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAIN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const REPORT_ID = /^[a-f0-9]{64}$/;
const MAX_KEPT = 500;

const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const NO_PROJECT = "no such project folder among the ones this verifier may read";
/** The files a project is read from. Each must really be inside it: a link that leads elsewhere is refused, not followed. */
const PROJECT_FILES = ["alma.yaml", ".alma", ".alma/identity.json", ".alma/delegations.json", ".alma/receipts.jsonl", ".alma/log.json", ".alma/issuer.key"];

export class Verifier {
  private readonly kept = new Map<string, StoredReport & { manifest?: AgentManifest }>();
  private readonly readers = new Map<string, Promise<ChainReader>>();

  constructor(private readonly options: VerifierOptions = {}) {}

  get issuer(): { iss: string; kid: string; publicKey: string } | undefined {
    const { signer, issuer } = this.options;
    return signer && issuer ? { iss: issuer, kid: signer.kid, publicKey: Buffer.from(signer.publicKey).toString("base64url") } : undefined;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private assets(): AssetInfo[] {
    return [...(this.options.assets ?? []), ...KNOWN_ASSETS];
  }

  private project(dir: string): string {
    if (!this.options.projectRoot) throw new NotConfigured("this verifier doesn't read local projects; give it an agent's ALMA id");
    let root: string;
    try {
      root = realpathSync(this.options.projectRoot);
    } catch {
      throw new NotConfigured("this verifier's project folder is not available");
    }
    // The path as written is checked before the disk is touched, and one answer covers "outside" and "not there": a caller learns nothing about what else exists on this machine.
    const target = resolve(root, dir);
    if (!inside(root, target) || !existsSync(target)) throw new InputError(NO_PROJECT);
    const real = realpathSync(target);
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new InputError(NO_PROJECT);
    for (const file of PROJECT_FILES) {
      const path = join(real, file);
      if (existsSync(path) && !inside(real, realpathSync(path))) throw new InputError("the project has files that lead outside it; they are not read");
    }
    return real;
  }

  private agent(almaId: string, apiKey: string | undefined): AgentHandle {
    if (!this.options.agent) throw new NotConfigured("this verifier isn't connected to an ALMA provider; give it a project folder");
    const key = apiKey ?? this.options.apiKey;
    if (!key) throw new InputError("an API key for the ALMA provider is needed to look an agent up by id");
    return this.options.agent(almaId, key);
  }

  private target(input: { almaId?: string; projectDir?: string }): { almaId: string } | { projectDir: string } {
    if (input.almaId && input.projectDir) throw new InputError("give an ALMA id or a project folder, not both");
    if (input.almaId) return { almaId: input.almaId };
    if (input.projectDir) return { projectDir: input.projectDir };
    throw new InputError("give an agent's ALMA id or a project folder");
  }

  private reader(chain: string): Promise<ChainReader> | undefined {
    if (this.options.simulated) {
      const simulated = new SimulatedChain(this.options.simulated);
      if (simulated.chain === chain) return Promise.resolve(simulated);
    }
    const configured = this.options.chains?.[chain];
    if (!configured) return undefined;
    let reader = this.readers.get(chain);
    if (!reader) {
      reader = evmReader(configured).then((r) => {
        if (r.chain !== chain) throw new Error(`the endpoint configured for ${chain} answers for ${r.chain}`);
        return r;
      });
      this.readers.set(chain, reader);
      // A failed connection isn't remembered: the next request tries again.
      reader.catch(() => this.readers.delete(chain));
    }
    return reader;
  }

  private isSimulated(chain: string | undefined): boolean {
    return Boolean(chain && this.options.simulated && new SimulatedChain(this.options.simulated).chain === chain);
  }

  async verify(input: VerifyInput, apiKey?: string): Promise<StoredReport> {
    const target = this.target(input);
    for (const [name, value] of [["walletAddress", input.walletAddress], ["agentSigner", input.agentSigner]] as const) {
      if (value !== undefined && !ADDRESS.test(value)) throw new InputError(`${name} is not an address`);
    }
    if (input.chain !== undefined && !CHAIN.test(input.chain)) throw new InputError("chain is not a CAIP-2 id (e.g. eip155:84532)");
    if (input.walletAddress && !input.chain) throw new InputError("say which chain the wallet is on");

    const sources: string[] = [];
    let facts: Facts;
    if ("projectDir" in target) {
      let project: Awaited<ReturnType<typeof readProject>>;
      try {
        project = await readProject(this.project(target.projectDir), this.now());
      } catch (err) {
        if (err instanceof InputError || err instanceof NotConfigured) throw err;
        // Not the error's own text: it names paths on this machine, and a parser's can quote what it read.
        throw new InputError("the project's files (alma.yaml, .alma/) couldn't be read as an ALMA project; run `alma-verifier doctor` in it for the detail");
      }
      facts = { ...project, assets: this.assets() };
      sources.push("project files (alma.yaml, .alma/)");
    } else {
      try {
        facts = { ...(await readAgent(this.agent(target.almaId, apiKey), this.now())), assets: this.assets() };
      } catch (err) {
        if (err instanceof InputError || err instanceof NotConfigured) throw err;
        throw new UpstreamError(`the ALMA provider didn't give this agent: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
      }
      sources.push("the ALMA provider (identity, delegations, policies)");
    }

    if (input.walletAddress && input.chain) {
      const reader = this.reader(input.chain);
      if (!reader) facts.custodyUnreadable = `this verifier has no way to read ${input.chain}`;
      else {
        try {
          const rules = declaredRules(facts);
          const symbols = [...new Set([...(rules.allowedAssets ?? []), ...Object.keys(rules.maxTransaction ?? {}), ...Object.keys(rules.dailySpend ?? {})])];
          facts.custody = await readCustody(await reader, { wallet: input.walletAddress, agentSigner: input.agentSigner, signedBy: input.custodySigns ? "custody" : undefined, symbols, assets: this.assets() });
          sources.push(this.isSimulated(input.chain) ? "simulated chain (not a network)" : `chain ${input.chain} over JSON-RPC`);
          // Who holds the key can't be read from a chain. It is the caller's statement, and the report says so.
          if (input.custodySigns) sources.push("stated by the caller, not checked: a custody service signs for the agent");
          if (input.agentSigner) sources.push(`stated by the caller, not checked: the agent's runtime holds the key of ${input.agentSigner}`);
        } catch {
          // Not the error's own text: it can carry the endpoint's URL, and that may hold a key.
          facts.custodyUnreadable = `${input.chain} couldn't be read`;
        }
      }
    }

    const report = await verify(facts, sources, Boolean(facts.custody) && this.isSimulated(input.chain));
    return this.keep(report, facts.manifest);
  }

  private async keep(report: Report, manifest?: AgentManifest): Promise<StoredReport> {
    const id = createHash("sha256").update(canonicalJsonValue(report)).digest("hex");
    const { signer, issuer } = this.options;
    const stored: StoredReport = { id, report, ...(signer && issuer ? { envelope: (await signReport(report, signer, issuer)).envelope } : {}) };
    this.kept.set(id, { ...stored, manifest });
    if (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value as string);
    if (this.options.reportsDir) {
      mkdirSync(this.options.reportsDir, { recursive: true });
      writeFileSync(join(this.options.reportsDir, `${id}.json`), JSON.stringify(stored, null, 2) + "\n", "utf-8");
    }
    return stored;
  }

  private find(id: string): (StoredReport & { manifest?: AgentManifest }) | undefined {
    if (!REPORT_ID.test(id)) return undefined;
    const kept = this.kept.get(id);
    if (kept || !this.options.reportsDir) return kept;
    const path = join(this.options.reportsDir, `${id}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as StoredReport) : undefined;
  }

  /** A report this verifier produced, by its id. */
  report(id: string): StoredReport {
    const found = this.find(id);
    if (!found) throw new NotFound("no report with that id");
    return { id: found.id, report: found.report, ...(found.envelope ? { envelope: found.envelope } : {}) };
  }

  async check(input: CheckInput, apiKey?: string): Promise<CheckOutcome> {
    const target = this.target(input);
    if ("projectDir" in target) {
      if (!input.chain || !CHAIN.test(input.chain)) throw new InputError("say which chain the payment is on, as a CAIP-2 id (e.g. eip155:84532)");
      const cwd = this.project(target.projectDir);
      let decision: ReturnType<typeof check>;
      try {
        decision = check({ to: input.to, asset: input.asset, amount: input.amount, chain: input.chain, counterparty: input.counterparty, capability: input.capability }, { cwd, assets: this.options.assets, now: this.options.now });
      } catch {
        throw new InputError("the project's files (alma.yaml, .alma/) couldn't be read as an ALMA project; run `alma-verifier doctor` in it for the detail");
      }
      const decidedBy = "the limits in this project, evaluated here" as const;
      if (decision.decision === "allow") return { outcome: "pass", reasons: [], approvals: [], decidedBy };
      if (decision.decision === "needs_approval") return { outcome: "requires_approval", reasons: [], approvals: decision.approvals, decidedBy };
      return { outcome: "fail", reasons: decision.reasons, approvals: [], decidedBy };
    }
    let evaluation: Awaited<ReturnType<AgentHandle["checkPolicy"]>>;
    try {
      evaluation = await this.agent(target.almaId, apiKey).checkPolicy({ capability: input.capability ?? "pay", amount: input.amount, asset: input.asset, to: input.to, ...(input.counterparty ? { counterparty: { id: input.counterparty } } : {}) });
    } catch (err) {
      if (err instanceof InputError || err instanceof NotConfigured) throw err;
      throw new UpstreamError(`the ALMA provider didn't answer: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
    const decidedBy = "the ALMA provider" as const;
    if (evaluation.allowed) return { outcome: "pass", reasons: [], approvals: [], decidedBy };
    if (evaluation.approvalsRequired.length) return { outcome: "requires_approval", reasons: evaluation.reasons, approvals: evaluation.approvalsRequired, decidedBy };
    return { outcome: "fail", reasons: evaluation.reasons, approvals: [], decidedBy };
  }

  async explain(input: { reportId?: string; report?: unknown; question?: string }): Promise<Explanation & { reportFrom: "this verifier" | "the caller, not checked" }> {
    if (!this.options.explainer) throw new NotConfigured("this verifier has no model to explain with; the report is complete without one");
    let report: Report;
    let manifest: AgentManifest | undefined;
    let reportFrom: "this verifier" | "the caller, not checked";
    if (input.reportId) {
      const found = this.find(input.reportId);
      if (!found) throw new NotFound("no report with that id");
      ({ report, manifest } = found);
      reportFrom = "this verifier";
    } else if (plainReport(input.report)) {
      // Rebuilt from a report's own fields: whatever else the caller sent doesn't reach the model.
      report = plainReport(input.report)!;
      reportFrom = "the caller, not checked";
    } else throw new InputError("give a report id, or a report");
    try {
      return { ...(await explain(this.options.explainer.client, { report, manifest, question: input.question }, this.options.explainer.model)), reportFrom };
    } catch (err) {
      if (err instanceof ExplainerUnavailable) throw new UpstreamError(err.message);
      if (err instanceof Anthropic.AuthenticationError) throw new UpstreamError("No explanation: the model's credentials were refused. The report itself is unaffected.");
      if (err instanceof Anthropic.RateLimitError) throw new UpstreamError("No explanation: the model is rate limited right now. The report itself is unaffected.");
      if (err instanceof Anthropic.APIError) throw new UpstreamError(`No explanation: the model's API failed${err.status ? ` (${err.status})` : ""}. The report itself is unaffected.`);
      throw err;
    }
  }
}
