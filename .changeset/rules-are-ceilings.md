---
"@adasouls/alma-verifier": patch
---

An agent read from an ALMA provider now gets the limits the provider really applies: the tightest of what is set for every agent of its organization (or person) and its own rules, as `@adasouls/policy-engine` 0.2 evaluates them. Before, the agent's own rule was taken to replace the wider one, so a looser agent rule showed as the limit in force and failed POL-05; it is now simply not in force. Moves to `@adasouls/policy-engine` ^0.2.0.
