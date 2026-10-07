---
"@adasouls/alma-verifier": minor
---

MCP (`alma-verifier mcp`, stdio) and HTTP (`alma-verifier serve`, with the MCP tools at `/mcp`) interfaces: `alma_verify_agent`, `alma_check_intent`, `alma_explain`, and `POST /v1/verify`, `/v1/check`, `/v1/explain`, `GET /v1/reports/:id`. The server signs its reports with its own key. `alma-verifier explain` and `explain()`: a Claude model puts a report in plain language and orders the fixes; the verdict, the findings and each fix stay the report's. `readAgent()` reads an agent from an ALMA provider through the AdaSouls SDK.
