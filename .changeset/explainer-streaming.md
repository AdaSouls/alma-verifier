---
"@adasouls/alma-verifier": patch
---

The explainer asks Claude for its answer as a stream and waits up to five minutes for it. Before, the request was cut off at two minutes and retried, so a slow answer took close to three. It also asks at a medium effort level and for a shorter developer paragraph: an explanation now takes about half a minute instead of about fifty seconds, with the plain-language answers as detailed as before. New exports `streamed()` and `EXPLAINER_TIMEOUT_MS`. Moves to `@adasouls/alma-core` ^0.8.0.
