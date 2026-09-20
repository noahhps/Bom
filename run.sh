#!/usr/bin/env bash
#
# Bring the whole thing up with one command.
#
# There are three moving parts -- Ollama, the Python server, and the built
# client -- and only one of them tells you clearly when it is missing. This
# checks all three, installs what is absent, and starts what is left.
#
#   ./run.sh              build the client, then serve everything on :8080
#   ./run.sh --dev        also run Vite on :5173 with hot reload
#   ./run.sh --no-build   skip the client build (use the existing dist/)
#   ./run.sh --port 8090  serve somewhere else
#   ./run.sh --model X    override OLLAMA_MODEL for this run
#
set -euo pipefail
cd "$(dirname "$0")"

MODE=serve
SKIP_BUILD=0
PORT="${BIND_PORT:-8080}"
MODEL="${OLLAMA_MODEL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dev)      MODE=dev ;;
    --no-build) SKIP_BUILD=1 ;;
    --port)     PORT="${2:?--port needs a number}"; shift ;;
    --model)    MODEL="${2:?--model needs a name}"; shift ;;
    -h|--help)  sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown option $1 (try --help)" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m !! \033[0m%s\n' "$1" >&2; }

# --- python ------------------------------------------------------------------
# The server needs 3.11+ (pyproject.toml). Exits non-zero for anything older.
new_enough() { "$1" -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; }

# Windows venvs put the interpreter in Scripts/, POSIX ones in bin/.
venv_python() {
  if   [ -x .venv/Scripts/python.exe ]; then echo .venv/Scripts/python.exe
  elif [ -x .venv/bin/python ];        then echo .venv/bin/python
  fi
}

PY=$(venv_python)
# A venv built from a too-old interpreter never recovers on its own: every run
# would reuse it and fail the same pip install. Rebuild it instead.
if [ -n "$PY" ] && ! new_enough "$PY"; then
  warn ".venv is $("$PY" -V 2>&1) -- the server needs 3.11+, recreating it"
  rm -rf .venv
  PY=
fi

if [ -z "$PY" ]; then
  say "creating .venv"
  # macOS's /usr/bin/python3 is 3.9 and usually sits ahead of Homebrew on PATH,
  # so plain python3 is the last resort, not the first choice.
  PYTHON_CMD=
  for candidate in python3.14 python3.13 python3.12 python3.11 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && new_enough "$candidate"; then
      PYTHON_CMD="$candidate"; break
    fi
  done
  if [ -z "$PYTHON_CMD" ]; then
    warn "no Python 3.11+ found -- install one (e.g. brew install python) and rerun"
    exit 1
  fi
  "$PYTHON_CMD" -m venv .venv
  PY=$(venv_python)
fi

# Cheapest honest check that the server's dependencies are actually installed.
# Kept to what pyproject.toml actually declares: naming a package that is no
# longer a dependency makes this fail forever and reinstall on every single run.
if ! "$PY" -c "import fastapi, uvicorn, httpx, pydantic" >/dev/null 2>&1; then
  say "installing server dependencies"
  "$PY" -m pip install --quiet --upgrade pip
  "$PY" -m pip install --quiet -e ./server
fi

# --- client ------------------------------------------------------------------
if [ ! -d client/node_modules ]; then
  say "installing client dependencies"
  (cd client && npm install --silent)
fi

if [ "$SKIP_BUILD" -eq 0 ] && [ "$MODE" = serve ]; then
  say "building the client"
  (cd client && npm run build --silent >/dev/null)
elif [ "$MODE" = serve ] && [ ! -f client/dist/index.html ]; then
  warn "no client/dist -- serving the API only. Drop --no-build to build it."
fi

# --- ollama ------------------------------------------------------------------
# Not started here: it is a system service with its own lifecycle, and guessing
# at that is how you end up with two of them. Only reported.
if OLLAMA_VERSION=$(curl -s -m 2 http://127.0.0.1:11434/api/version 2>/dev/null); then
  say "ollama up ${OLLAMA_VERSION}"
  # sed, not grep -P: Git Bash ships a grep without PCRE, and the lookbehind
  # version fails silently -- reporting the wrong model rather than none.
  DEFAULT_MODEL=$(sed -n 's/.*OLLAMA_MODEL", "\([^"]*\)".*/\1/p' server/app/config.py 2>/dev/null || true)
  WANT="${MODEL:-${DEFAULT_MODEL:-gemma4}}"
  if ! curl -s -m 3 http://127.0.0.1:11434/api/tags | grep -q "\"${WANT%%:*}"; then
    warn "model '${WANT}' is not pulled -- ollama pull ${WANT}"
  fi
else
  # Only a warning, and deliberately: a cloud backend answers without it now,
  # so an OpenRouter-only setup is a working setup rather than a broken one.
  warn "ollama is not answering on :11434 -- start it, or answers come from the cloud backend if one is connected"
fi

# --- port --------------------------------------------------------------------
# This one bites often enough to be worth naming: a server left running from a
# previous session holds the port and the new one dies with a bare errno.
if "$PY" - "$PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
then :; else
  warn "port ${PORT} is already in use -- something is still running there"
  exit 1
fi

# --- run ---------------------------------------------------------------------
export BIND_PORT="$PORT"
[ -n "$MODEL" ] && export OLLAMA_MODEL="$MODEL"

# Stopping this cleanly is harder than it looks on Windows: `npm run dev` puts
# node two levels down, so the PID bash knows about is a shell that has already
# exited by the time you kill it, leaving the server orphaned on its port. The
# ports are the reliable handle -- and they are safe to reclaim, because the
# check above proved nothing else was on them when we started.
release_port() {
  command -v powershell >/dev/null 2>&1 || return 0
  powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -EA SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -EA SilentlyContinue }" >/dev/null 2>&1 || true
}

CHILDREN=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${CHILDREN[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  release_port "$PORT"
  [ "$MODE" = dev ] && release_port 5173
  return 0
}
trap cleanup EXIT INT TERM

if [ "$MODE" = dev ]; then
  say "starting Vite on :5173 (proxying /api to :${PORT})"
  (cd client && API_ORIGIN="http://127.0.0.1:${PORT}" npm run dev) &
  CHILDREN+=("$!")
fi

say "starting the server on :${PORT}"
"$PY" -m app
