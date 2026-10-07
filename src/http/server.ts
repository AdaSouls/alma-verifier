import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { InputError, NotConfigured, NotFound, UpstreamError, type CheckInput, type Verifier, type VerifyInput } from "../service.js";

/**
 * The verifier over HTTP, and the MCP tools over streamable HTTP at
 * /mcp.
 *
 *   POST /v1/verify        { almaId | projectDir, walletAddress?, chain?, agentSigner?, custodySigns? }
 *   POST /v1/check         { almaId | projectDir, amount, asset, to, capability?, chain?, counterparty? }
 *   POST /v1/explain       { reportId | report, question? }
 *   GET  /v1/reports/:id
 *   GET  /.well-known/alma-verifier-keys
 *
 * It speaks plain HTTP: put it behind TLS before exposing it. A caller's
 * key for the ALMA provider travels in `X-AdaSouls-Key` and is used for
 * that request only; it is never stored or logged.
 */
export interface HttpOptions {
  /** When set, every request must carry `Authorization: Bearer <token>`. Set it on anything reachable by others: explanations cost money. */
  token?: string;
  /**
   * The `Host` values this server answers to. A server meant for this
   * machine only must refuse other names, or a web page could reach it
   * by pointing its own domain at 127.0.0.1.
   */
  allowedHosts?: string[];
}

const MAX_BODY = 256 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "the request is too large");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new HttpError(400, "the body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const str = (body: Record<string, unknown>, key: string, max = 1024): string | undefined => {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new HttpError(400, `${key} must be a string`);
  return v;
};
const required = (body: Record<string, unknown>, key: string): string => {
  const v = str(body, key);
  if (v === undefined) throw new HttpError(400, `${key} is required`);
  return v;
};
const bool = (body: Record<string, unknown>, key: string): boolean | undefined => {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new HttpError(400, `${key} must be true or false`);
  return v;
};

function verifyInput(b: Record<string, unknown>): VerifyInput {
  return { almaId: str(b, "almaId", 200), projectDir: str(b, "projectDir"), walletAddress: str(b, "walletAddress", 64), chain: str(b, "chain", 64), agentSigner: str(b, "agentSigner", 64), custodySigns: bool(b, "custodySigns") };
}

function checkInput(b: Record<string, unknown>): CheckInput {
  return { almaId: str(b, "almaId", 200), projectDir: str(b, "projectDir"), capability: str(b, "capability", 64), amount: required(b, "amount"), asset: required(b, "asset"), to: required(b, "to"), chain: str(b, "chain", 64), counterparty: str(b, "counterparty", 200) };
}

export function createHttpServer(verifier: Verifier, options: HttpOptions = {}): Server {
  const expected = options.token ? digest(options.token) : undefined;
  const hosts = options.allowedHosts?.map((h) => h.toLowerCase());

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (hosts && !hosts.includes((req.headers.host ?? "").toLowerCase())) throw new HttpError(403, "this server doesn't answer to that host name");
    const url = new URL(req.url ?? "/", "http://verifier");
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/.well-known/alma-verifier-keys") {
      // Published for convenience. A reader who needs to trust a report should get this key some other way than from the server that signed it.
      const issuer = verifier.issuer;
      return send(res, 200, issuer ? { iss: issuer.iss, keys: [{ kid: issuer.kid, alg: "Ed25519", publicKey: issuer.publicKey }] } : { keys: [] });
    }

    if (expected) {
      const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!given || !timingSafeEqual(digest(given), expected)) throw new HttpError(401, "unauthorized");
    }
    const header = req.headers["x-adasouls-key"];
    const apiKey = typeof header === "string" && header.trim() !== "" ? header.trim() : undefined;

    if (path === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      // Stateless: a server and a transport per request, so one caller's key is never another's.
      const server = createMcpServer(verifier, apiKey);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readJson(req));
      return;
    }

    const report = /^\/v1\/reports\/([^/]+)$/.exec(path);
    if (req.method === "GET" && report) return send(res, 200, verifier.report(report[1]));

    if (req.method === "POST" && path === "/v1/verify") return send(res, 200, await verifier.verify(verifyInput(await readJson(req)), apiKey));
    if (req.method === "POST" && path === "/v1/check") return send(res, 200, await verifier.check(checkInput(await readJson(req)), apiKey));
    if (req.method === "POST" && path === "/v1/explain") {
      const body = await readJson(req);
      return send(res, 200, await verifier.explain({ reportId: str(body, "reportId", 64), report: body.report, question: str(body, "question", 2000) }));
    }
    throw new HttpError(404, "not found");
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof InputError) return send(res, 400, { error: err.message });
      if (err instanceof NotFound) return send(res, 404, { error: err.message });
      if (err instanceof NotConfigured) return send(res, 501, { error: err.message });
      if (err instanceof UpstreamError) return send(res, 502, { error: err.message });
      console.error("[alma-verifier]", err);
      send(res, 500, { error: "the verifier failed unexpectedly" });
    });
  });
}
