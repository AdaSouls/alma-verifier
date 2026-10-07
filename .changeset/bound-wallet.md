---
"@adasouls/alma-verifier": minor
---

A verdict above `ADVISORY` now requires the wallet to be a bound controller of the agent's identity (IDN-03 passes). Before, an agent verified against somebody else's well-configured Safe read `CHAIN-ENFORCED`. The rings in a report still describe the wallet that was looked at, so a report can show ring 3 in place and say `ADVISORY`. Not knowing whose wallet it is counts the same as knowing it isn't the agent's, so an agent read from an ALMA provider, which doesn't publish bound wallets yet, reads `ADVISORY` at most.
