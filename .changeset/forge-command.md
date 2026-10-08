---
"@adasouls/alma-verifier": minor
---

New command `forge`: verifies the agent in the project and opens the result in ALMA Forge, a web page that talks to a server the command starts on `127.0.0.1` for that project only. The HTTP server gains `allowedOrigins` (the web origins whose pages may call it from a browser; with it set, a request naming any other origin is refused before anything runs) and `project` (what `GET /v1/project` answers when the server was started for one project). Without those options the server behaves as before, except that a request carrying an `Origin` header is now refused, since no page was ever meant to call it.

`forge --agent <almaId>` verifies an agent kept by an ALMA provider instead of the one in the folder, read with the agent's own key (`ADASOULS_API_KEY`); a payment tried from the page then gets the provider's own answer. The link the command opens carries a one-time code the page trades for the run's token (`POST /v1/session`, the `exchange` option), never the token itself.
