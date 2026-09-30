"""Pre-configured MCP server presets, plus the placeholder substitution they need.

Presets describe *how* to reach a server, not the secrets required to do so.
Anything the reader has to supply is written as a ``${NAME}`` placeholder inside
``args``/``env``/``headers`` and declared in ``inputs``, so the UI knows which
fields to prompt for and :func:`resolve_preset` knows what to fill in. Nothing
here is a shell, so ``${NAME}`` is expanded by this module -- previously these
were shell-style ``${NAME:-}`` strings that no shell ever saw, and the literal
text ``${FIGMA_ACCESS_TOKEN:-}`` was being sent as the bearer token.
"""

from __future__ import annotations

import os
import re
from typing import Any

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


PRESETS: dict[str, dict[str, Any]] = {
    # -- Work tools ------------------------------------------------------------
    #
    # The hosted servers a company's tools publish. Each signs in with OAuth
    # (`"auth": "oauth"`): Bom discovers the server's authorization server,
    # registers itself, and sends the reader to the service's own consent page
    # (see oauth.py) -- no token to create or paste, and access is exactly what
    # the reader's account allows. Where a service also takes an API key, it
    # is an optional input; filled in, it is used instead of signing in.
    "atlassian": {
        "name": "atlassian",
        "category": "work",
        "auth": "oauth",
        "description": (
            "Jira, Confluence and Compass on Atlassian Cloud, through Atlassian's "
            "own Rovo MCP server: search and read issues and pages, create and "
            "update them. Signs in with your Atlassian account."
        ),
        "transport": "http",
        "url": "https://mcp.atlassian.com/v1/mcp",
        "homepage": "atlassian.com",
        "inputs": [],
        "auto_approve": [
            "getAccessibleAtlassianResources",
            "searchJiraIssuesUsingJql",
            "getJiraIssue",
            "searchConfluenceUsingCql",
            "getConfluencePage",
        ],
        "notes": (
            "Sign in with the Atlassian account whose sites you want to reach. "
            "An organization admin may need to allow the Rovo MCP server first. "
            "For Jira or Confluence Server / Data Center, or to use API tokens, "
            "use the jira_confluence preset instead."
        ),
    },
    # The community server, for what the hosted one does not cover: Server and
    # Data Center installs, and organizations that hand out API tokens rather
    # than allowing a new OAuth app.
    "jira_confluence": {
        "name": "jira_confluence",
        "category": "work",
        "description": (
            "Jira and Confluence with API tokens -- Atlassian Cloud, Server or Data "
            "Center. Fill in the product you use; leave the other blank."
        ),
        "transport": "stdio",
        "command": "uvx",
        "args": ["mcp-atlassian"],
        "env": {
            "JIRA_URL": "${JIRA_URL}",
            "JIRA_USERNAME": "${JIRA_USERNAME}",
            "JIRA_API_TOKEN": "${JIRA_API_TOKEN}",
            "JIRA_PERSONAL_TOKEN": "${JIRA_PERSONAL_TOKEN}",
            "CONFLUENCE_URL": "${CONFLUENCE_URL}",
            "CONFLUENCE_USERNAME": "${CONFLUENCE_USERNAME}",
            "CONFLUENCE_API_TOKEN": "${CONFLUENCE_API_TOKEN}",
            "CONFLUENCE_PERSONAL_TOKEN": "${CONFLUENCE_PERSONAL_TOKEN}",
        },
        "homepage": "atlassian.com",
        "inputs": [
            {"key": "JIRA_URL", "label": "Jira address", "required": False, "secret": False,
             "help": "https://your-company.atlassian.net or your Jira server's address."},
            {"key": "JIRA_USERNAME", "label": "Jira email (Cloud)", "required": False, "secret": False,
             "help": "The email you sign in with. Cloud only."},
            {"key": "JIRA_API_TOKEN", "label": "Jira API token (Cloud)", "required": False, "secret": True,
             "help": "id.atlassian.com > Security > API tokens."},
            {"key": "JIRA_PERSONAL_TOKEN", "label": "Jira personal access token (Server/DC)",
             "required": False, "secret": True, "help": "Profile > Personal access tokens."},
            {"key": "CONFLUENCE_URL", "label": "Confluence address", "required": False, "secret": False,
             "help": "https://your-company.atlassian.net/wiki or your Confluence server's address."},
            {"key": "CONFLUENCE_USERNAME", "label": "Confluence email (Cloud)", "required": False,
             "secret": False, "help": "Usually the same as Jira's."},
            {"key": "CONFLUENCE_API_TOKEN", "label": "Confluence API token (Cloud)", "required": False,
             "secret": True, "help": "The same Atlassian API token works for both."},
            {"key": "CONFLUENCE_PERSONAL_TOKEN", "label": "Confluence personal access token (Server/DC)",
             "required": False, "secret": True, "help": "Profile > Personal access tokens."},
        ],
        "auto_approve": ["jira_search", "jira_get_issue", "confluence_search", "confluence_get_page"],
        "notes": (
            "Runs the open-source mcp-atlassian server on the machine running Bom, "
            "with uv (docs.astral.sh/uv) -- install it first. Set READ_ONLY_MODE=true "
            "in the server's environment to keep it from changing anything."
        ),
    },
    "linear": {
        "name": "linear",
        "category": "work",
        "auth": "oauth",
        "description": (
            "Linear's own server: find, create and update issues, projects, cycles "
            "and comments. Signs in with your Linear account."
        ),
        "transport": "http",
        "url": "https://mcp.linear.app/mcp",
        "headers": {"Authorization": "Bearer ${LINEAR_API_KEY}"},
        "homepage": "linear.app",
        "inputs": [
            {
                "key": "LINEAR_API_KEY",
                "label": "Linear API key",
                "required": False,
                "secret": True,
                "help": "Optional. Leave blank to sign in instead; or Settings > Security & access > API keys.",
            }
        ],
        "auto_approve": ["list_issues", "get_issue", "list_projects", "list_teams"],
    },
    "notion": {
        "name": "notion",
        "category": "work",
        "auth": "oauth",
        "description": (
            "Notion's hosted server: search the workspace, read and write pages and "
            "databases. Signs in with your Notion account."
        ),
        "transport": "http",
        "url": "https://mcp.notion.com/mcp",
        "homepage": "notion.so",
        "inputs": [],
        "auto_approve": ["notion-search", "notion-fetch"],
    },
    "sentry": {
        "name": "sentry",
        "category": "work",
        "auth": "oauth",
        "description": (
            "Sentry's server: issues, errors, traces and releases, with Seer's "
            "analysis of a failure. Signs in with your Sentry account."
        ),
        "transport": "http",
        "url": "https://mcp.sentry.dev/mcp",
        "homepage": "sentry.io",
        "inputs": [],
        "auto_approve": ["find_organizations", "search_issues", "get_issue_details"],
    },
    "stripe": {
        "name": "stripe",
        "category": "work",
        "auth": "oauth",
        "description": (
            "Stripe's server: customers, payments, subscriptions and invoices, and "
            "search over Stripe's documentation. Signs in with your Stripe account."
        ),
        "transport": "http",
        "url": "https://mcp.stripe.com",
        "headers": {"Authorization": "Bearer ${STRIPE_SECRET_KEY}"},
        "homepage": "stripe.com",
        "inputs": [
            {
                "key": "STRIPE_SECRET_KEY",
                "label": "Stripe restricted key",
                "required": False,
                "secret": True,
                "help": "Optional. Leave blank to sign in; a restricted key limits what it can touch.",
            }
        ],
        "auto_approve": ["search_stripe_documentation", "list_customers"],
    },
    # Any hosted server that follows the MCP authorization spec -- including a
    # company's own internal ones -- without waiting for a preset of its own.
    "hosted_oauth": {
        "name": "hosted_oauth",
        "category": "work",
        "auth": "oauth",
        "description": (
            "Any hosted MCP server that signs in with OAuth, including your "
            "company's own: give its address, then sign in."
        ),
        "transport": "http",
        "url": "${REMOTE_URL}",
        "homepage": "modelcontextprotocol.io",
        "inputs": [
            {
                "key": "REMOTE_URL",
                "label": "Server address",
                "required": True,
                "secret": False,
                "help": "e.g. https://mcp.example.com/mcp",
            }
        ],
        "notes": "Rename the server after adding it, so several can sit side by side.",
    },
    # -- Figma ---------------------------------------------------------------
    #
    # Figma ships its own MCP server inside the desktop app: Figma menu ->
    # Preferences -> "Enable local MCP server". It listens on 127.0.0.1:3845 and
    # speaks Streamable HTTP at /mcp -- not SSE on :3000, which is what this
    # preset used to point at, and which nothing has ever served.
    #
    # It reads whatever is selected in the running Figma app, so it needs no
    # token at all: the desktop app is already signed in.
    "figma": {
        "name": "figma",
        "category": "design",
        "description": (
            "Figma Dev Mode MCP server built into the Figma desktop app. Reads the "
            "current selection: code, screenshots, variables, Code Connect mappings. "
            "Requires Figma desktop running with Preferences > Enable local MCP server."
        ),
        "transport": "http",
        "url": "http://127.0.0.1:3845/mcp",
        "homepage": "figma.com",
        "inputs": [],
        "auto_approve": [
            "get_code",
            "get_screenshot",
            "get_metadata",
            "get_variable_defs",
            "get_code_connect_map",
        ],
    },
    # The REST-API route, for when Figma desktop is not running (headless boxes,
    # a server that is not the reader's laptop) or when the file is addressed by
    # URL rather than by selection. `--stdio` is not optional: without it the
    # package starts its own HTTP server and never speaks a word on stdin, which
    # is exactly the 15s initialize timeout this preset used to produce.
    "figma_api": {
        "name": "figma_api",
        "category": "design",
        "description": (
            "Figma via the REST API using a personal access token. Works without the "
            "desktop app; addresses files by URL or key. Needs a token with "
            "file_content:read scope from Figma > Settings > Security."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "figma-developer-mcp", "--stdio"],
        "env": {"FIGMA_API_KEY": "${FIGMA_API_KEY}"},
        "homepage": "figma.com",
        "inputs": [
            {
                "key": "FIGMA_API_KEY",
                "label": "Figma personal access token",
                "required": True,
                "secret": True,
                "help": "Figma > Settings > Security > Personal access tokens.",
            }
        ],
        "auto_approve": ["get_figma_data", "download_figma_images"],
    },
    # -- Google Workspace ----------------------------------------------------
    #
    # All three of these are browser-OAuth servers: they open a consent page on
    # first run and cache the grant under ~/.config/google-workspace-mcp. There
    # is no token to paste, which is why `inputs` is empty -- the previous
    # GOOGLE_APPLICATION_CREDENTIALS / GMAIL_TOKEN fields were prompting for
    # values the packages never read.
    # There is no separate "gmail" preset. There was, and it ran the same
    # package as this one against the same OAuth grant -- installing both
    # registered every tool twice and gave the model two names for one thing.
    "google_workspace": {
        "name": "google_workspace",
        "category": "google",
        "description": (
            "Gmail, Calendar, Drive, Docs and Sheets in one server. Opens a Google "
            "consent page in a browser the first time it runs, then caches the grant."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@presto-ai/google-workspace-mcp"],
        "env": {},
        "inputs": [],
        "auto_approve": ["list_events", "search_emails", "get_file"],
        "homepage": "workspace.google.com",
        "notes": (
            "First run needs an interactive browser. Run "
            "`npx -y @presto-ai/google-workspace-mcp` once in a terminal to complete "
            "the OAuth grant before enabling it here."
        ),
    },
    "google_calendar": {
        "name": "google_calendar",
        "category": "google",
        "description": "List, create, update and search Google Calendar events.",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@iflow-mcp/mcp-google-workspace"],
        "env": {},
        "homepage": "calendar.google.com",
        "inputs": [],
        "auto_approve": ["list_events", "get_event"],
        "notes": "First run needs an interactive browser to complete the OAuth grant.",
    },
    # -- Code and docs -------------------------------------------------------
    "github": {
        "name": "github",
        "category": "code",
        "description": (
            "GitHub's own hosted server: repositories, issues, pull requests, code "
            "search and Actions. Authenticates with a personal access token."
        ),
        "transport": "http",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"},
        "homepage": "github.com",
        "inputs": [
            {
                "key": "GITHUB_TOKEN",
                "label": "GitHub personal access token",
                "required": True,
                "secret": True,
                "help": "github.com > Settings > Developer settings > Personal access tokens.",
            }
        ],
        "auto_approve": ["search_repositories", "get_file_contents", "list_issues"],
    },
    "deepwiki": {
        "name": "deepwiki",
        "category": "code",
        "description": (
            "Ask questions about any public GitHub repository and get answers from "
            "generated documentation. No account and no token."
        ),
        "transport": "http",
        "url": "https://mcp.deepwiki.com/mcp",
        "homepage": "deepwiki.com",
        "inputs": [],
        "auto_approve": ["read_wiki_structure", "read_wiki_contents", "ask_question"],
    },
    "context7": {
        "name": "context7",
        "category": "code",
        "description": (
            "Up-to-date documentation and code examples for libraries and frameworks, "
            "fetched per version. Works without a key; one raises the rate limit."
        ),
        "transport": "http",
        "url": "https://mcp.context7.com/mcp",
        "headers": {"Authorization": "Bearer ${CONTEXT7_API_KEY}"},
        "homepage": "context7.com",
        "inputs": [
            {
                "key": "CONTEXT7_API_KEY",
                "label": "Context7 API key",
                "required": False,
                "secret": True,
                "help": "Optional. Leave blank to use the anonymous rate limit.",
            }
        ],
        "auto_approve": ["resolve-library-id", "get-library-docs"],
    },
    # -- Research and the web ------------------------------------------------
    "exa": {
        "name": "exa",
        "category": "research",
        "description": (
            "Neural web search built for models rather than for people, with the page "
            "contents returned alongside the results."
        ),
        "transport": "http",
        "url": "https://mcp.exa.ai/mcp",
        "homepage": "exa.ai",
        "inputs": [],
        "auto_approve": ["web_search_exa", "get_code_context_exa"],
    },
    "huggingface": {
        "name": "huggingface",
        "category": "research",
        "description": (
            "Search models, datasets, Spaces and papers on the Hugging Face Hub. "
            "Works anonymously; a token widens what is visible."
        ),
        "transport": "http",
        "url": "https://huggingface.co/mcp",
        "headers": {"Authorization": "Bearer ${HF_TOKEN}"},
        "homepage": "huggingface.co",
        "inputs": [
            {
                "key": "HF_TOKEN",
                "label": "Hugging Face access token",
                "required": False,
                "secret": True,
                "help": "Optional. Needed only for private repositories.",
            }
        ],
        "auto_approve": ["model_search", "dataset_search", "paper_search"],
    },
    "firecrawl": {
        "name": "firecrawl",
        "category": "research",
        "description": (
            "Turn any web page or whole site into clean markdown -- scraping, "
            "crawling and structured extraction."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "firecrawl-mcp"],
        "env": {"FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"},
        "homepage": "firecrawl.dev",
        "inputs": [
            {
                "key": "FIRECRAWL_API_KEY",
                "label": "Firecrawl API key",
                "required": True,
                "secret": True,
                "help": "firecrawl.dev > Dashboard > API Keys.",
            }
        ],
        "auto_approve": ["firecrawl_scrape", "firecrawl_search"],
    },
    "playwright": {
        "name": "playwright",
        "category": "research",
        "description": (
            "Drive a real browser: open pages, click, fill forms and read what is on "
            "screen. Works from the accessibility tree rather than screenshots."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest"],
        "homepage": "playwright.dev",
        "inputs": [],
        "auto_approve": ["browser_snapshot", "browser_navigate"],
        "notes": (
            "Runs on the server, not on your phone -- it drives a browser on the "
            "machine Bom is installed on. First run downloads a browser engine."
        ),
    },
    "supabase": {
        "name": "supabase",
        "category": "code",
        "auth": "oauth",
        "description": (
            "Supabase's hosted server: projects, tables, SQL, migrations, edge "
            "functions and logs. Signs in with your Supabase account."
        ),
        "transport": "http",
        "url": "https://mcp.supabase.com/mcp",
        "homepage": "supabase.com",
        "inputs": [],
        "auto_approve": ["list_projects", "list_tables", "search_docs"],
        "notes": "Add ?read_only=true to the server's address to keep it from writing.",
    },
    "vercel": {
        "name": "vercel",
        "category": "code",
        "auth": "oauth",
        "description": (
            "Vercel's server: projects, deployments and their logs, and search over "
            "Vercel's documentation. Signs in with your Vercel account."
        ),
        "transport": "http",
        "url": "https://mcp.vercel.com",
        "homepage": "vercel.com",
        "inputs": [],
        "auto_approve": ["search_vercel_documentation", "list_projects", "list_deployments"],
    },
    # -- Local to the server -------------------------------------------------
    "filesystem": {
        "name": "filesystem",
        "category": "local",
        "description": (
            "Read, write and search files in one directory on the machine running "
            "Bom. Nothing outside the directory you name is reachable."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${ROOT_DIR}"],
        "homepage": "modelcontextprotocol.io",
        "inputs": [
            {
                "key": "ROOT_DIR",
                "label": "Directory to expose",
                "required": True,
                "secret": False,
                "help": "An absolute path on the server, e.g. /Users/you/Documents.",
            }
        ],
        "auto_approve": ["read_file", "list_directory", "search_files"],
        "notes": (
            "The directory is the whole boundary: everything under it is readable "
            "and writable by the model, and nothing above it is reachable."
        ),
    },
    "sequential_thinking": {
        "name": "sequential_thinking",
        "category": "local",
        "description": (
            "A scratchpad for working a hard problem through in steps, with the "
            "ability to revise earlier steps. Local, no network, no key."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "homepage": "modelcontextprotocol.io",
        "inputs": [],
        "auto_approve": ["sequentialthinking"],
    },
    # -- The escape hatch ----------------------------------------------------
    #
    # Bom signs in to hosted servers itself now (see oauth.py and the work
    # presets above). This stays for the ones that will not let an app
    # register itself: mcp-remote runs the browser half of the dance on the
    # machine running Bom and presents the result as an ordinary stdio server.
    "remote_bridge": {
        "name": "remote_bridge",
        "category": "local",
        "description": (
            "Reach a hosted MCP server through the mcp-remote bridge, which signs in "
            "on the machine running Bom. For servers that refuse hosted_oauth."
        ),
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "mcp-remote", "${REMOTE_URL}"],
        "homepage": "modelcontextprotocol.io",
        "inputs": [
            {
                "key": "REMOTE_URL",
                "label": "Remote MCP endpoint",
                "required": True,
                "secret": False,
                "help": "e.g. https://mcp.notion.com/mcp or https://mcp.linear.app/sse",
            }
        ],
        "notes": (
            "First run opens a browser on the machine running Bom to complete "
            "the OAuth grant, then caches it under ~/.mcp-auth. Rename the server "
            "afterwards so several bridges can coexist."
        ),
    },
}


def list_presets() -> list[dict[str, Any]]:
    """Return every preset, each tagged with the id it is instantiated by."""
    return [{"id": preset_id, **preset_data} for preset_id, preset_data in PRESETS.items()]


def get_preset(name: str) -> dict[str, Any] | None:
    """Get a preset definition by id."""
    return PRESETS.get(name.strip().lower())


def substitute(value: Any, values: dict[str, str]) -> Any:
    """Replace every ``${NAME}`` in a string, list or dict with a supplied value.

    Falls back to the process environment, then to the empty string. Walks
    containers so a placeholder is as usable in ``args`` as in ``env``.
    """
    if isinstance(value, str):
        return _PLACEHOLDER.sub(
            lambda m: values.get(m.group(1)) or os.environ.get(m.group(1), ""), value
        )
    if isinstance(value, list):
        return [substitute(v, values) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, values) for k, v in value.items()}
    return value


def missing_inputs(preset: dict[str, Any], values: dict[str, str]) -> list[str]:
    """Which required inputs the reader has not supplied and the environment lacks."""
    missing: list[str] = []
    for spec in preset.get("inputs", []) or []:
        if not isinstance(spec, dict) or not spec.get("required"):
            continue
        key = str(spec.get("key", ""))
        if key and not (values.get(key) or os.environ.get(key)):
            missing.append(key)
    return missing


def _unfilled(template: Any, values: dict[str, str]) -> bool:
    """Whether a template's only content was a placeholder nobody filled in."""
    if not isinstance(template, str):
        return False
    names = _PLACEHOLDER.findall(template)
    if not names:
        return False
    return all(not (values.get(n) or os.environ.get(n)) for n in names)


def resolve_preset(preset: dict[str, Any], values: dict[str, str]) -> dict[str, Any]:
    """A copy of the preset with every placeholder in args/env/headers filled in.

    An *optional* input nobody filled in takes its whole entry with it. A
    preset like context7 writes ``Authorization: Bearer ${CONTEXT7_API_KEY}``,
    and substituting an empty key would send the literal header ``Bearer ``,
    which reads to a server as a malformed credential rather than as no
    credential -- answered with a 401 that looks like a wrong key.
    """
    resolved = dict(preset)
    for field in ("args", "url", "command", "cwd"):
        if preset.get(field) is not None:
            resolved[field] = substitute(preset[field], values)

    for field in ("env", "headers"):
        template = preset.get(field)
        if not isinstance(template, dict):
            continue
        resolved[field] = {
            key: substitute(value, values)
            for key, value in template.items()
            if not _unfilled(value, values)
        }
    return resolved
