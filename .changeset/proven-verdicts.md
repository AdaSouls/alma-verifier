---
"@adasouls/alma-verifier": minor
---

A verdict now only claims what was proven.

- IDN-03 needs the wallet's own signature (a controller proof, checked on its chain with ecrecover or ERC-1271), not only the wallet's name in `.alma/identity.json`. Without one it reports "controller not proven" and the verdict stays ADVISORY. New `alma-verifier controller-proof` prints the message and saves the signature.
- The EVM reader counts a wallet as a Safe only when it is a known SafeProxy delegating to a known Safe singleton, accepts only published Allowance Module deployments, lists every enabled module and the guard (any other module, or a guard, rules out CHAIN-ENFORCED), and reads every allowance the agent's signer has, native token included. An EIP-7702-delegated account reads as a plain key. `ChainReader` changes: `allowances()` and `verifyMessage()` replace `allowance()`.
- `--custody-signs` is the caller's word: the verdict stays at what is proven, and the report shows `claimed: CUSTODY-ENFORCED`. CUSTODY-ENFORCED needs `custodyVerified`.
- The guard resolves who is paid from `to` (`.alma/counterparties.json`, or the `counterparties` option) and refuses a `counterparty` id that doesn't match the address. The provider is no longer sent the caller's counterparty id.
- POL-01 fails without `allowedAssets`; POL-02 fails when any allowed asset has no approval threshold below its limit.
