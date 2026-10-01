#!/usr/bin/env bash
#
# Set up Bom's relay in your own Supabase project, in one go.
#
#   ./relay/setup.sh <project-ref> <web-app-url>
#
#   <project-ref>   the id in your project's URL:
#                   https://supabase.com/dashboard/project/<project-ref>
#   <web-app-url>   where the web app is hosted, e.g. https://my-bom.vercel.app
#                   (sign-in links go back there; leave it out if you only use
#                   the desktop app, and run this again once you have one)
#
# Asks once for a Supabase access token (from
# https://supabase.com/dashboard/account/tokens) unless SUPABASE_ACCESS_TOKEN
# is set. Creates the tables and access rules, deploys the pairing function,
# sets up sign-in (where links go, a code in every email), turns Realtime to
# private channels only, and prints the two values Bom needs.
#
# Safe to run again: every step replaces what the last run made.
#
# Optional: BOM_ALLOWED_EMAILS=you@example.com   only these accounts may link devices
#
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m !! \033[0m%s\n' "$1" >&2; }

REF="${1:-}"
WEB="${2:-}"
if [ -z "$REF" ]; then
  sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
# The whole dashboard URL pasted instead of the id: take the id out of it.
case "$REF" in
  *supabase.com/dashboard/project/*) REF="${REF##*/project/}"; REF="${REF%%/*}" ;;
  https://*.supabase.co*) REF="${REF#https://}"; REF="${REF%%.supabase.co*}" ;;
esac

command -v python3 >/dev/null 2>&1 || { warn "needs python3"; exit 1; }

# One token for everything: the CLI reads it from the environment (so no
# browser sign-in), and configure.py uses it for the settings the CLI cannot
# change. Read without echoing; never written anywhere.
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "A Supabase access token is needed once. Create one at:"
  echo "  https://supabase.com/dashboard/account/tokens"
  printf "Paste it here (hidden): "
  read -rs SUPABASE_ACCESS_TOKEN
  echo
  [ -n "$SUPABASE_ACCESS_TOKEN" ] || { warn "no token -- nothing done"; exit 1; }
fi
export SUPABASE_ACCESS_TOKEN

if [ -z "$WEB" ]; then
  warn "no web app address given -- sign-in links won't work until you run this again with one"
fi

# The CLI through npx when it isn't installed: nothing to set up first.
if command -v supabase >/dev/null 2>&1; then
  SB=(supabase)
else
  command -v npx >/dev/null 2>&1 || { warn "needs Node (for npx) or the Supabase CLI"; exit 1; }
  SB=(npx --yes supabase@latest)
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

python3 configure.py "$REF" "$WEB"
