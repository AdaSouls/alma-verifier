# @adasouls/alma-verifier

## 0.4.0

### Minor Changes

- [#11](https://github.com/AdaSouls/alma-verifier/pull/11) [`ec2e0e0`](https://github.com/AdaSouls/alma-verifier/commit/ec2e0e0d81f59a5aa43a925a9658117ce1fab5ea) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - A verdict now only claims what was proven.

  - IDN-03 needs the wallet's own signature (a controller proof, checked on its chain with ecrecover or ERC-1271), not only the wallet's name in `.alma/identity.json`. Without one it reports "controller not proven" and the verdict stays ADVISORY. New `alma-verifier controller-proof` prints the message and saves the signature.
  - The EVM reader counts a wallet as a Safe only when it is a known SafeProxy delegating to a known Safe singleton, accepts only published Allowance Module deployments, lists every enabled module and the guard (any other module, or a guard, rules out CHAIN-ENFORCED), and reads every allowance the agent's signer has, native token included. An EIP-7702-delegated account reads as a plain key. `ChainReader` changes: `allowances()` and `verifyMessage()` replace `allowance()`.
  - `--custody-signs` is the caller's word: the verdict stays at what is proven, and the report shows `claimed: CUSTODY-ENFORCED`. CUSTODY-ENFORCED needs `custodyVerified`.
  - The guard resolves who is paid from `to` (`.alma/counterparties.json`, or the `counterparties` option) and refuses a `counterparty` id that doesn't match the address. The provider is no longer sent the caller's counterparty id.
  - POL-01 fails without `allowedAssets`; POL-02 fails when any allowed asset has no approval threshold below its limit.

## 0.3.2

### Patch Changes

- [#9](https://github.com/AdaSouls/alma-verifier/pull/9) [`851d49a`](https://github.com/AdaSouls/alma-verifier/commit/851d49a9c206ad4914d349b65a9225af97a7fda4) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - The explainer asks Claude for its answer as a stream and waits up to five minutes for it. Before, the request was cut off at two minutes and retried, so a slow answer took close to three. It also asks at a medium effort level and for a shorter developer paragraph: an explanation now takes about half a minute instead of about fifty seconds, with the plain-language answers as detailed as before. New exports `streamed()` and `EXPLAINER_TIMEOUT_MS`. Moves to `@adasouls/alma-core` ^0.8.0.

## 0.3.1

### Patch Changes

- [#7](https://github.com/AdaSouls/alma-verifier/pull/7) [`74946f3`](https://github.com/AdaSouls/alma-verifier/commit/74946f3f4b57bb0ec7e983c836ccecff1f8e027b) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - An agent read from an ALMA provider now gets the limits the provider really applies: the tightest of what is set for every agent of its organization (or person) and its own rules, as `@adasouls/policy-engine` 0.2 evaluates them. Before, the agent's own rule was taken to replace the wider one, so a looser agent rule showed as the limit in force and failed POL-05; it is now simply not in force. Moves to `@adasouls/policy-engine` ^0.2.0.

## 0.3.0

### Minor Changes

- [#5](https://github.com/AdaSouls/alma-verifier/pull/5) [`8a947c1`](https://github.com/AdaSouls/alma-verifier/commit/8a947c12d2786f95c11259ebc9af32cd210119b6) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - New command `forge`: verifies the agent in the project and opens the result in ALMA Forge, a web page that talks to a server the command starts on `127.0.0.1` for that project only. The HTTP server gains `allowedOrigins` (the web origins whose pages may call it from a browser; with it set, a request naming any other origin is refused before anything runs) and `project` (what `GET /v1/project` answers when the server was started for one project). Without those options the server behaves as before, except that a request carrying an `Origin` header is now refused, since no page was ever meant to call it.

  `forge --agent <almaId>` verifies an agent kept by an ALMA provider instead of the one in the folder, read with the agent's own key (`ADASOULS_API_KEY`); a payment tried from the page then gets the provider's own answer. The link the command opens carries a one-time code the page trades for the run's token (`POST /v1/session`, the `exchange` option), never the token itself.

- [#5](https://github.com/AdaSouls/alma-verifier/pull/5) [`975008a`](https://github.com/AdaSouls/alma-verifier/commit/975008a76fdb86f2fc13ef2bb479dbe28dde4e82) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - The explainer also answers for an owner who is not a developer: `Explanation.plain` holds the bottom line and four answers in plain words (can the agent overspend, what actually stops it, what could still go wrong, what to do next), all five or none. An explanation can be asked for in English, Spanish or Portuguese (`language` on `explain()`, `POST /v1/explain`, the `alma_explain` tool, and `explain --language`); check ids, verdict names and code stay as they are. As before, the verdict, the findings and each fix are the checks', and wording that reassures beyond the verdict is flagged.

## 0.2.0

### Minor Changes

- [#2](https://github.com/AdaSouls/alma-verifier/pull/2) [`b5fa60c`](https://github.com/AdaSouls/alma-verifier/commit/b5fa60c957717cb20e3cacf219844ed97c086a72) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - A verdict above `ADVISORY` now requires the wallet to be a bound controller of the agent's identity (IDN-03 passes). Before, an agent verified against somebody else's well-configured Safe read `CHAIN-ENFORCED`. The rings in a report still describe the wallet that was looked at, so a report can show ring 3 in place and say `ADVISORY`. Not knowing whose wallet it is counts the same as knowing it isn't the agent's, so an agent read from an ALMA provider, which doesn't publish bound wallets yet, reads `ADVISORY` at most.

- [#2](https://github.com/AdaSouls/alma-verifier/pull/2) [`47d2bde`](https://github.com/AdaSouls/alma-verifier/commit/47d2bde26b208c1fb020bcfdb97bddd7dab2c7af) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - MCP (`alma-verifier mcp`, stdio) and HTTP (`alma-verifier serve`, with the MCP tools at `/mcp`) interfaces: `alma_verify_agent`, `alma_check_intent`, `alma_explain`, and `POST /v1/verify`, `/v1/check`, `/v1/explain`, `GET /v1/reports/:id`. The server signs its reports with its own key. `alma-verifier explain` and `explain()`: a Claude model puts a report in plain language and orders the fixes; the verdict, the findings and each fix stay the report's. `readAgent()` reads an agent from an ALMA provider through the AdaSouls SDK.

## 0.1.0

### Minor Changes

- [`abc57f9`](https://github.com/AdaSouls/alma-verifier/commit/abc57f9459656a59f3f7934aafea7f4c9be2558a) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - First release: the deterministic checks (identity, authority, policy, custody, history), the four verdicts, signed reports, the local guard, a simulated chain, and the `doctor`, `check` and `verify-report` commands.
