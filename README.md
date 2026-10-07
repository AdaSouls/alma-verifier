# ALMA Verifier

**Will this agent obey its soul?**

An AI agent with an [ALMA](https://github.com/AdaSouls/alma) identity
declares who it acts for and the limits it runs under. This tool checks
whether anything actually enforces those limits, and says so in one word:

| Verdict | Meaning |
|---|---|
| `UNCONNECTED` | No identity, or no active delegation. |
| `ADVISORY` | Limits are configuration the agent's own code may or may not consult. |
| `CUSTODY-ENFORCED` | Limits are checked before signing by a service the agent can't change. |
| `CHAIN-ENFORCED` | The chain rejects any spend over the limits. |

The rule behind them: **a soul can only enforce rules where the agent's
keys live.** [docs/ENFORCEMENT.md](docs/ENFORCEMENT.md) has every check
and how the verdict is computed.

It runs on your machine. Your code, keys and files are not uploaded
anywhere; reading a chain uses read-only RPC calls to an endpoint you
choose.

> Status: early releases, on npm as `@adasouls/alma-verifier`. One thing
> has not been run for real yet: the EVM reader against a Safe that has
> the Allowance Module enabled (it has read a real Safe without one on
> Base Sepolia). Everything else here is covered by the test suite, and
> the explainer has been run against the Claude API.

## Verify an agent

In a project connected with the ALMA CLI (`alma connect`):

```
npx @adasouls/alma-verifier doctor
```

With nothing else, the best it can say is `ADVISORY`: it has seen the
limits, not where the money is. Tell it, and make sure the wallet is
bound to the agent's identity (`alma connect --wallet 0xSafe…`): a
wallet that isn't the agent's can't raise its verdict, however well it
is protected.

```
npx @adasouls/alma-verifier doctor \
  --wallet 0xSafe… --signer 0xAgentKey… \
  --rpc https://sepolia.base.org --allowance-module 0xModule…
```

| Option | |
|---|---|
| `--wallet` | The address the agent's funds are at. |
| `--signer` | An address whose key the agent's runtime holds. |
| `--custody-signs` | A custody service signs for the agent, which holds no key. |
| `--rpc`, `--allowance-module` | Where to read the chain, and the Safe Allowance Module's address on it. |
| `--simulate <file>` | Read custody from a simulated chain instead (see below). |
| `--org-rules <file>` | The organization's rules, to check the agent doesn't loosen them. |
| `--sign` | Sign the report with the project's key and save it to `.alma/verification.json`. |
| `--json`, `--out <file>` | Machine-readable output. |
| `--require <verdict>` | Exit with status 2 unless the verdict is at least this one. For CI. |

Every failed check comes with what to change.

## Guard the wallet

Ring 1: wrap the function that sends a payment, so the limits in
`alma.yaml` are checked before anything is signed and every payment
leaves a signed receipt in the project's log.

```ts
import { guard, PaymentDenied } from "@adasouls/alma-verifier/guard";

const pay = guard(async (p) => ({ txHash: await wallet.sendToken(p.to, p.asset, p.amount) }), {
  approve: async (p) => askAPerson(`Pay ${p.amount} ${p.asset} to ${p.to}?`),
});

try {
  await pay({ to: "0x…", asset: "USDC", amount: "25", chain: "eip155:84532" });
} catch (err) {
  if (err instanceof PaymentDenied) console.log(err.code, err.reasons);
}
```

- Over a limit, an asset that isn't allowed, a capability that wasn't
  delegated, an expired delegation: `PaymentDenied`, and nothing is sent.
- Above the approval threshold it calls `approve`; without one, or
  without a clear yes, it refuses.
- The organization's rules can be passed as `rules`. They can only
  tighten.
- If a payment goes out and its receipt can't be written, it throws
  `PaymentNotRecorded` with the transaction hash. Don't retry the payment.

A guard stops mistakes and injected instructions. It does not stop code
that calls the wallet directly, which is why an agent with only a guard
is `ADVISORY`. To ask without sending anything:

```
npx @adasouls/alma-verifier check --to 0x… --asset USDC --amount 25 --chain eip155:84532
```

## Try the Lock level without a Safe

`--simulate` reads custody from a JSON file describing a chain:

```json
{
  "chain": "eip155:84532",
  "accounts": {
    "0xSafe…": {
      "kind": "safe",
      "owners": ["0xOwnerA…", "0xOwnerB…"],
      "threshold": 2,
      "allowanceModule": true,
      "allowances": { "0xAgentKey…": { "USDC": { "amount": "500", "resetMinutes": 1440 } } }
    }
  }
}
```

It shows what each verdict takes. A report produced this way is marked
`simulated` and says nothing about real funds. `SimulatedChain` (from
`@adasouls/alma-verifier/adapters`) also models the module's transfers,
for tests.

## Signed reports

```
npx @adasouls/alma-verifier doctor --sign
npx @adasouls/alma-verifier verify-report .alma/verification.json \
  --issuer self:alma:main:agent:shopper --key <the signer's public key>
```

A report signed with a project's own key says what that machine found.
Get the public key from the signer, not from the report.

## Explain a report

```
npx @adasouls/alma-verifier doctor --out report.json
npx @adasouls/alma-verifier explain report.json --question "What do I fix first?"
```

A Claude model puts the report in plain language and orders the fixes.
It needs `ANTHROPIC_API_KEY`; the model is `claude-opus-5` unless
`--model` or `ALMA_VERIFIER_MODEL` says otherwise. This is the only
part of the tool that sends anything anywhere: the report, and your
`alma.yaml` when the report is about this project.

**The model explains. It never decides.**

- The verdict, the failed checks and the fix for each one come from the
  report. The model's answer supplies the wording, the order, and any
  extra concern.
- It can add a concern. It cannot drop a finding: every failed check is
  in the result whether the model mentioned it or not.
- It has no tools.
- Names, memos and anything else an agent controls reach it as quoted
  data, with instructions not to follow them.
- A corrected `alma.yaml` it drafts is shown only if it parses and
  loosens nothing: no higher limit, no new asset or capability, no
  counterparty rule removed. It is shown as `alma.yaml` reads it, so a
  key the model made up isn't there, and a draft that then changes
  nothing isn't shown at all. Nothing is written to your files.

So a model that has been talked into something can produce a wrong
explanation, and nothing else. No explanation is needed to use a report.

## For AI clients: MCP

```json
{
  "mcpServers": {
    "alma-verifier": { "command": "npx", "args": ["-y", "@adasouls/alma-verifier", "mcp"] }
  }
}
```

| Tool | |
|---|---|
| `alma_verify_agent` | `almaId` or `projectDir`, plus `walletAddress`, `chain`, `agentSigner`, `custodySigns`. Returns the report. |
| `alma_check_intent` | `almaId` or `projectDir`, `amount`, `asset`, `to`, and optionally `capability`, `chain`, `counterparty`. Returns `pass`, `fail` or `requires_approval` with reasons. |
| `alma_explain` | `reportId` or `report`, and optionally `question`. |

All three only read. `alma_check_intent` approves nothing: it says what
the limits would say, and the payment still has to go through whatever
enforces them.

- `projectDir` is read under `--project-root` (the folder the server was
  started in, by default) and nowhere else.
- `almaId` asks an ALMA provider, with `ADASOULS_API_KEY` (and
  `ADASOULS_API_URL` for a self-hosted one). The provider doesn't say
  which wallets are bound to an identity, and its receipts aren't read
  yet, so `IDN-03` and the history checks report "unknown" this way,
  and since an unbound wallet can't raise a verdict, an agent looked up
  by id reads `ADVISORY` at most for now.
  For `alma_check_intent` the answer is the provider's own, since only
  it knows what the agent spent through it today.
- Chains are read from the endpoints given at start-up:
  `--rpc eip155:84532=https://sepolia.base.org --allowance-module eip155:84532=0xModule…`.
  A caller never supplies a URL.

## Over HTTP

```
npx @adasouls/alma-verifier serve --port 8787 \
  --rpc eip155:84532=https://sepolia.base.org --allowance-module eip155:84532=0xModule…
```

| | |
|---|---|
| `POST /v1/verify` | The same input as `alma_verify_agent`. Returns `{ id, report, envelope }`. |
| `POST /v1/check` | The same input as `alma_check_intent`. |
| `POST /v1/explain` | `{ reportId }` or `{ report }`, and optionally `question`. |
| `GET /v1/reports/:id` | A report this server produced. |
| `GET /.well-known/alma-verifier-keys` | The key it signs with. |
| `POST /mcp` | The MCP tools over streamable HTTP. |

Reports are signed with the server's own Ed25519 key (`--key`, made on
first run), in the same envelope as `doctor --sign`, so one that is
forwarded can be checked with `verify-report`. The key is published at
the well-known path for convenience; someone who needs to rely on a
report should get it from the operator some other way.

What to know before running it for others:

- It listens on `127.0.0.1` and answers only to this machine's host
  names. To listen elsewhere it requires `--token` (or
  `ALMA_VERIFIER_TOKEN`), sent as `Authorization: Bearer …`.
- It speaks plain HTTP. Put it behind TLS.
- Local projects are off unless `--project-root` is given.
- To verify by `almaId`, a caller sends their own provider key in
  `X-AdaSouls-Key`. It is used for that request and not kept.
- Who holds an agent's key (`agentSigner`, `custodySigns`) is the
  caller's statement, and the report's sources say so. A verdict
  obtained this way is only as good as that statement. Which wallet is
  the agent's is not the caller's to state: it has to be bound to the
  identity.
- There is no rate limiting, and explanations cost money: keep the
  token on.

## As a library

```ts
import { verify, checkIntent, Verifier } from "@adasouls/alma-verifier";
import { readProject, readAgent, readCustody, SimulatedChain } from "@adasouls/alma-verifier/adapters";

const report = await verify({ ...(await readProject(process.cwd())), custody });
```

`verify(facts)` is a pure function: adapters gather facts, checks only
read them. `readAgent(adasouls.agent(id))` gathers them from an ALMA
provider through the AdaSouls SDK. `Verifier` is what the MCP and HTTP
servers call.

## Not here yet

- A run against a Safe with the Allowance Module enabled.
- From an ALMA provider: an identity's bound wallets, and its receipts.
- Drafts of the Safe transactions that set allowances are not written
  by the model. `apply-limits` in adasouls-engine compiles `alma.yaml`
  into them, so that code writes what an owner signs.

## Development

```
npm install
npm test
npm run lint
npm run build
```

MIT.
