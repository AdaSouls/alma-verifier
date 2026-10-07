---
"@adasouls/alma-verifier": minor
---

New command `forge`: verifies the agent in the project and opens the result in ALMA Forge, a web page that talks to a server the command starts on `127.0.0.1` for that project only. The HTTP server gains `allowedOrigins` (the web origins whose pages may call it from a browser; with it set, a request naming any other origin is refused before anything runs) and `project` (what `GET /v1/project` answers when the server was started for one project). Without those options the server behaves as before, except that a request carrying an `Origin` header is now refused, since no page was ever meant to call it.
