#!/usr/bin/env python3
"""The parts of relay setup that live in Supabase's settings, not its database.

Called by setup.sh. These used to be "check these in the dashboard" -- and a
sign-in link that lands on Supabase's default `http://localhost:3000`, or an
email with a link but no code, is the whole sign-in broken. So they are set
here, through the Management API, with the same access token the CLI uses:

  * where sign-in links may send the browser (your web app)
  * a code in the sign-in emails, as well as the link -- both the first one
    (Confirm signup) and every later one (Magic Link)
  * Realtime accepts private channels only, so every join is checked against
    the access rules

Then it prints the two values Bom needs. Standard library only.

    SUPABASE_ACCESS_TOKEN=... python3 configure.py <project-ref> [web-app-url]
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.supabase.com/v1/projects"

SUBJECT = "Your Bom sign-in code"
# Both templates carry the code and the link. The code is what the desktop app
# needs (a link cannot open it), and what works when the email is read on a
# different device from the one signing in.
TEMPLATE = """<h2 style="font-family:system-ui,sans-serif;font-weight:600">Sign in to Bom</h2>
<p style="font-family:system-ui,sans-serif">Your code:</p>
<p style="font-family:ui-monospace,Menlo,monospace;font-size:30px;font-weight:600;letter-spacing:6px;margin:8px 0 16px">{{ .Token }}</p>
<p style="font-family:system-ui,sans-serif">Type it where Bom asked for it. Or, on the device you are signing in on,
<a href="{{ .ConfirmationURL }}">open this sign-in link</a>.</p>
<p style="font-family:system-ui,sans-serif;color:#888">It works once, and only the newest code counts.
If you didn't ask for it, you can ignore this email.</p>
"""


def call(method: str, path: str, token: str, body: dict | None = None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "bom-relay-setup",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise SystemExit(f"Supabase said no to {method} {path}: HTTP {exc.code} {detail}") from None
    except urllib.error.URLError as exc:
        raise SystemExit(f"Couldn't reach Supabase's API: {exc.reason}") from None


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    ref = sys.argv[1]
    web = (sys.argv[2] if len(sys.argv) > 2 else "").strip().rstrip("/")
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not token:
        raise SystemExit("SUPABASE_ACCESS_TOKEN is not set.")
    if web and not web.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise SystemExit(f"The web app address should start with https:// (got {web!r}).")

    # -- sign-in -------------------------------------------------------------
    current = call("GET", f"/{ref}/config/auth", token) or {}
    patch: dict = {}

    if web:
        patch["site_url"] = web
        # Added to, never replaced: the project may allow other addresses.
        allowed = [u.strip() for u in (current.get("uri_allow_list") or "").split(",") if u.strip()]
        for url in (web + "/**", "http://localhost:5173/**"):
            if url not in allowed:
                allowed.append(url)
        patch["uri_allow_list"] = ",".join(allowed)
    elif "localhost:3000" in (current.get("site_url") or ""):
        print(
            "  !! Sign-in links still go to Supabase's default, http://localhost:3000.\n"
            "     Run this again with your web app's address as the second argument.",
            file=sys.stderr,
        )

    # Templates someone already wrote with a code in are left alone.
    for kind in ("confirmation", "magic_link"):
        if "{{ .Token }}" not in (current.get(f"mailer_templates_{kind}_content") or ""):
            patch[f"mailer_templates_{kind}_content"] = TEMPLATE
            patch[f"mailer_subjects_{kind}"] = SUBJECT

    if patch:
        call("PATCH", f"/{ref}/config/auth", token, patch)
    print("==> sign-in: " + (f"links return to {web}; " if web else "") + "emails carry a code")

    # -- realtime ------------------------------------------------------------
    call("PATCH", f"/{ref}/config/realtime", token, {"private_only": True})
    print("==> realtime: private channels only")

    # -- the key Bom needs ---------------------------------------------------
    # The publishable key if the project has one, else the legacy anon key.
    # Never a secret or service-role key: this one ships inside the web app.
    keys = call("GET", f"/{ref}/api-keys", token) or []
    key = next((k.get("api_key") for k in keys if k.get("type") == "publishable" and k.get("api_key")), None)
    if not key:
        key = next((k.get("api_key") for k in keys if k.get("name") == "anon" and k.get("api_key")), None)

    url = f"https://{ref}.supabase.co"
    print(
        f"""
  Relay ready.

    BOM_RELAY_URL={url}
    BOM_RELAY_KEY={key or '(copy the publishable or anon key from Project Settings > API Keys)'}

  Next:
    * Vercel: set VITE_BOM_RELAY_URL and VITE_BOM_RELAY_KEY to these, and redeploy.
    * The host: Settings > Remote access (or ./run.sh --remote with BOM_RELAY_URL / BOM_RELAY_KEY).
  For a relay only you use: sign in once, then turn off "Allow new users to sign up"
  (Authentication > Sign In / Providers). See docs/remote.md.
"""
    )


if __name__ == "__main__":
    main()
