#!/usr/bin/env bash
# Regenerates code.js from code.template.js, inlining the rail's brush-stroke
# mark. Figma plugins cannot read from disk, so the image travels as base64.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 - "$here" <<'PY'
import base64, pathlib, sys
here = pathlib.Path(sys.argv[1])
mark = here.parents[1] / "client" / "public" / "courier-mark.png"
b64 = base64.b64encode(mark.read_bytes()).decode()
src = (here / "code.template.js").read_text()
(here / "code.js").write_text(src.replace("__MARK_B64__", b64))
PY
echo "wrote $here/code.js"
