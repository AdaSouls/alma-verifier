# @adasouls/alma-verifier

## 0.2.0

### Minor Changes

- [#2](https://github.com/AdaSouls/alma-verifier/pull/2) [`b5fa60c`](https://github.com/AdaSouls/alma-verifier/commit/b5fa60c957717cb20e3cacf219844ed97c086a72) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - A verdict above `ADVISORY` now requires the wallet to be a bound controller of the agent's identity (IDN-03 passes). Before, an agent verified against somebody else's well-configured Safe read `CHAIN-ENFORCED`. The rings in a report still describe the wallet that was looked at, so a report can show ring 3 in place and say `ADVISORY`. Not knowing whose wallet it is counts the same as knowing it isn't the agent's, so an agent read from an ALMA provider, which doesn't publish bound wallets yet, reads `ADVISORY` at most.

- [#2](https://github.com/AdaSouls/alma-verifier/pull/2) [`47d2bde`](https://github.com/AdaSouls/alma-verifier/commit/47d2bde26b208c1fb020bcfdb97bddd7dab2c7af) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - MCP (`alma-verifier mcp`, stdio) and HTTP (`alma-verifier serve`, with the MCP tools at `/mcp`) interfaces: `alma_verify_agent`, `alma_check_intent`, `alma_explain`, and `POST /v1/verify`, `/v1/check`, `/v1/explain`, `GET /v1/reports/:id`. The server signs its reports with its own key. `alma-verifier explain` and `explain()`: a Claude model puts a report in plain language and orders the fixes; the verdict, the findings and each fix stay the report's. `readAgent()` reads an agent from an ALMA provider through the AdaSouls SDK.

## 0.1.0

### Minor Changes

- [`abc57f9`](https://github.com/AdaSouls/alma-verifier/commit/abc57f9459656a59f3f7934aafea7f4c9be2558a) Thanks [@MatiFalcone](https://github.com/MatiFalcone)! - First release: the deterministic checks (identity, authority, policy, custody, history), the four verdicts, signed reports, the local guard, a simulated chain, and the `doctor`, `check` and `verify-report` commands.
