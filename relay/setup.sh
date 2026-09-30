#!/usr/bin/env bash
#
# Set up Bom's relay in your own Supabase project, in one go.
#
#   ./relay/setup.sh <project-ref>
#
# <project-ref> is the id in your project's URL:
#   https://supabase.com/dashboard/project/<project-ref>
#
# Creates the tables and access rules, deploys the pairing function, turns
# Realtime to private-channels-only, and prints the two values Bom needs.
# Safe to run again: every step replaces what the last run made.
#
# Optional environment:
#   BOM_ALLOWED_EMAILS=you@example.com   only these accounts may link devices
#   SUPABASE_ACCESS_TOKEN=...            skip the interactive `supabase login`
#
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m !! \033[0m%s\n' "$1" >&2; }

REF="${1:-}"
if [ -z "$REF" ]; then
  sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# The CLI through npx when it isn't installed: nothing to set up first.
if command -v supabase >/dev/null 2>&1; then
  SB=(supabase)
else
  command -v npx >/dev/null 2>&1 || { warn "needs Node (for npx) or the Supabase CLI"; exit 1; }
  SB=(npx --yes supabase@latest)
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  say "signing in to Supabase (a browser opens once)"
  "${SB[@]}" login
fi

say "linking project $REF"
"${SB[@]}" link --project-ref "$REF"

say "creating tables and access rules"
"${SB[@]}" db push --include-all

if [ -n "${BOM_ALLOWED_EMAILS:-}" ]; then
  say "only $BOM_ALLOWED_EMAILS may link devices"
  "${SB[@]}" secrets set --project-ref "$REF" "BOM_ALLOWED_EMAILS=$BOM_ALLOWED_EMAILS"
fi

say "deploying the pairing function"
"${SB[@]}" functions deploy bom-pair --project-ref "$REF" --no-verify-jwt

# Private channels only: a public channel skips the access rules entirely, so
# with this on, the only way onto a host's channel is through them.
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  say "turning off public Realtime channels"
  if ! curl -fsS -X PATCH "https://api.supabase.com/v1/projects/$REF/config/realtime" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"private_only": true}' >/dev/null; then
    warn "couldn't change it from here -- do it by hand (below)"
  fi
fi

KEYS=$("${SB[@]}" projects api-keys --project-ref "$REF" -o json 2>/dev/null || true)
KEY=$(printf '%s' "$KEYS" | python3 -c '
import json, sys
try:
    keys = json.load(sys.stdin)
except Exception:
    sys.exit(0)
# The publishable key if the project has one, else the legacy anon key. Both
# are safe to ship in a web page: the access rules are what protect the data.
for want in ("publishable", "anon"):
    for k in keys:
        if want in (k.get("name", ""), k.get("type", "")):
            print(k.get("api_key", "")); sys.exit(0)
' || true)

# Worked out before the summary, not inside it: macOS's bash 3.2 misreads
# quotes inside ${VAR:-...} in a here-document and aborts the whole block.
if [ -n "$KEY" ]; then
  KEY_LINE="BOM_RELAY_KEY=$KEY"
else
  KEY_LINE="BOM_RELAY_KEY=  (copy the anon or publishable key from Project Settings > API Keys)"
fi
URL="https://$REF.supabase.co"
DASHBOARD="https://supabase.com/dashboard/project/$REF"

cat <<DONE

  Relay ready.

    BOM_RELAY_URL=$URL
    $KEY_LINE

  Three things to check once in the dashboard ($DASHBOARD):
    * Realtime > Settings: "Allow public access" is OFF.
    * Authentication > Emails > Magic Link: add {{ .Token }} to the template, so the
      email carries a 6-digit code as well as a link (the desktop app needs the code).
    * Authentication > URL Configuration: add your web app address (e.g. the Vercel URL).
  For a personal relay, turn off "Allow new users to sign up" once you have signed in once.

  Next: put the two values in the Vercel environment (as VITE_BOM_RELAY_URL / VITE_BOM_RELAY_KEY)
  and on the host (./run.sh --remote, or Settings > Remote access). See docs/remote.md.

DONE
