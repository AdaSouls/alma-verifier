import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InputError, NotConfigured, NotFound, UpstreamError, type Verifier } from "../service.js";

export const SERVER_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

const target = {
  almaId: z.string().min(1).max(200).optional().describe("The agent's ALMA id, e.g. alma:main:agent:shopper. Give this or projectDir."),
  projectDir: z.string().min(1).max(1024).optional().describe("A project folder connected with `alma connect`. Give this or almaId."),
};

function failure(err: unknown): CallToolResult {
  const known = err instanceof InputError || err instanceof NotConfigured || err instanceof NotFound || err instanceof UpstreamError;
  // An unexpected error's text stays in this process's log, not in a model's context.
  if (!known) console.error("[alma-verifier]", err);
  return { isError: true, content: [{ type: "text", text: known ? (err as Error).message : "The verifier failed unexpectedly." }] };
}

const ok = (value: object): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

/**
 * The verifier as MCP tools. `apiKey` is the calling client's own key
 * for the ALMA provider, when the transport carried one.
 *
 * None of these tools moves money or changes anything: they read, and
 * they answer. `alma_check_intent` in particular approves nothing. It
 * says what the limits would say, and the payment still has to go
 * through whatever enforces them.
 */
export function createMcpServer(verifier: Verifier, apiKey?: string): McpServer {
  const server = new McpServer({ name: "alma-verifier", version: SERVER_VERSION });

  server.registerTool(
    "alma_verify_agent",
    {
      title: "Verify an agent",
      description:
        "Will this agent obey its soul? Runs the deterministic checks of an agent's ALMA identity, authority, limits and custody, and returns a report with a verdict: UNCONNECTED, ADVISORY, CUSTODY-ENFORCED or CHAIN-ENFORCED. Without a wallet address the custody checks can't run and the verdict can be ADVISORY at most. Read-only.",
      inputSchema: {
        ...target,
        walletAddress: z.string().optional().describe("The address the agent's funds are at."),
        chain: z.string().optional().describe("The wallet's chain as a CAIP-2 id, e.g. eip155:84532."),
        agentSigner: z.string().optional().describe("An address whose private key the agent's runtime holds, if any."),
        custodySigns: z.boolean().optional().describe("True when a custody service signs for the agent and the agent holds no key."),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return ok(await verifier.verify(input, apiKey));
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "alma_check_intent",
    {
      title: "Check a payment against the agent's limits",
      description:
        "Would this payment be let through by the agent's limits? Returns pass, fail or requires_approval, with reasons. It sends nothing and authorizes nothing: a pass is not a permission, and the payment must still go through whatever enforces the limits.",
      inputSchema: {
        ...target,
        capability: z.string().optional().describe('Defaults to "pay".'),
        amount: z.string().describe('A decimal amount in the asset\'s units, e.g. "12.50".'),
        asset: z.string().describe('The asset\'s symbol, e.g. "USDC".'),
        to: z.string().describe("The address that would receive the funds."),
        chain: z.string().optional().describe("CAIP-2 id of the payment's chain. Required with projectDir."),
        counterparty: z.string().optional().describe("The payee's ALMA id, when it has one."),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return ok(await verifier.check(input, apiKey));
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "alma_explain",
    {
      title: "Explain a verification report",
      description:
        "A plain-language explanation of a report from alma_verify_agent, with the fixes in order. The explanation is written by a language model; the verdict and the findings it carries are the report's own and the model can't change them.",
      inputSchema: {
        reportId: z.string().optional().describe("The id of a report this verifier produced. Give this or report."),
        report: z.record(z.string(), z.unknown()).optional().describe("A report, when it isn't one this verifier kept."),
        question: z.string().max(2000).optional().describe("What you want to know about it."),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return ok(await verifier.explain(input));
      } catch (err) {
        return failure(err);
      }
    }
  );

  return server;
}
