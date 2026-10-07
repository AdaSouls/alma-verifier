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

> Status: first release, not yet published to npm. The EVM reader has not
> been run against a deployed Safe yet; everything else here is covered
> by the test suite.

## Verify an agent

In a project connected with the ALMA CLI (`alma connect`):

```
npx @adasouls/alma-verifier doctor
```

With nothing else, the best it can say is `ADVISORY`: it has seen the
limits, not where the money is. Tell it:

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

## As a library

```ts
import { verify, checkIntent } from "@adasouls/alma-verifier";
import { readProject, readCustody, SimulatedChain } from "@adasouls/alma-verifier/adapters";

const report = await verify({ ...(await readProject(process.cwd())), custody });
```

`verify(facts)` is a pure function: adapters gather facts, checks only
read them.

## Not here yet

- MCP and HTTPS interfaces, and plain-language explanations of a report.
- Reading identity, delegations and custody from a hosted ALMA provider.
- A run against a deployed Safe.

## Development

```
npm install
npm test
npm run lint
npm run build
```

MIT.
