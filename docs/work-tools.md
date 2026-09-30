# Work tools over MCP: Atlassian, Linear, Notion and the rest

Skills → **MCP servers & presets** → **Work tools** connects Bom to the hosted
MCP servers that company tools publish. Most of them sign in with OAuth, so
there's no token to create or paste: you choose **Add Server → Add & sign in**,
approve Bom on the service's own page in the tab that opens, and the server's
tools are ready when you come back. Bom can only do what your account can.

| Preset | Service | How it connects |
| --- | --- | --- |
| `atlassian` | Jira, Confluence and Compass on Atlassian Cloud (Atlassian's Rovo MCP server) | Sign in |
| `jira_confluence` | Jira and Confluence, Cloud or Server / Data Center (the open-source `mcp-atlassian`, run with `uvx`) | API token or personal access token |
| `linear` | Linear | Sign in, or a Linear API key |
| `notion` | Notion | Sign in |
| `sentry` | Sentry | Sign in |
| `stripe` | Stripe | Sign in, or a restricted key |
| `supabase`, `vercel` | Supabase, Vercel (under Code & docs) | Sign in |
| `hosted_oauth` | Any hosted MCP server that signs in with OAuth, including your company's own | Sign in |
| `github` | GitHub (under Code & docs) | Personal access token |
| `remote_bridge` | Servers that refuse `hosted_oauth` (through `mcp-remote`) | Sign-in on the machine running Bom |

An organization admin may need to allow a new app before its members can sign
in. For Atlassian, that means allowing the Rovo MCP server.

## How signing in works

Bom follows the MCP authorization spec, so it needs no client id configured in
advance:

1. The server answers an unsigned request with `401` and a `WWW-Authenticate`
   header. That header names its protected-resource metadata, which names its
   authorization server, which publishes its endpoints.
2. Bom registers itself there as a public client (dynamic client registration),
   with this server's `/mcp/oauth/callback` as its redirect.
3. Your browser signs in with PKCE. The MCP server is named as the `resource`,
   so the token is issued for that server only.
4. The token goes on every request as a bearer header. When it expires, Bom
   refreshes it on its own. If the server refuses the refresh, the row shows
   **Sign in** again. A tool call that fails with `401` mid-conversation is
   refreshed and retried once before the model is told to ask you to sign in.

Tokens stay on the server, in the `mcp_auth` table next to the other MCP
secrets, and survive restarts. The API never returns them. **Sign out** forgets
the tokens and disconnects, but keeps the server configured, so signing in again
is one click.

A key or token you enter yourself, such as a Linear API key or a GitHub PAT, is
used instead of a signed-in token.

## What the callback needs

The service sends your browser back to Bom at the address that browser used to
reach it, plus `/mcp/oauth/callback`. Most services accept plain `http` only
for `localhost` and `127.0.0.1`. From another device on the network, serve Bom
over `https` (for example through a reverse proxy) or sign in from the machine
running it.

Over HTTP, all under `/api` with the bearer token:

| Method | Path | |
| --- | --- | --- |
| POST | `/mcp/servers/{id}/signin` | `{"callback_base": "<origin>"}` → `{state, url}` |
| GET | `/mcp/signin/{state}` | `pending`, `connected` or `failed`, with the server's status |
| DELETE | `/mcp/servers/{id}/signin` | sign out |

`GET /mcp/servers` reports `auth: {signed_in, required, can_sign_in}` for each
server.
