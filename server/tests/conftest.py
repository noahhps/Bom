"""Shared test fixtures for the server."""

from __future__ import annotations

import os
import pytest

# Ensure every test process sees the same bearer token so the fixture and the
# live ``app`` (created at import time) agree on what is valid.  This avoids a
# silent mismatch when ``load_settings()`` reads a persisted token from disk.
os.environ["AUTH_TOKEN"] = "test-token"

# Never the real remote-access link: an app started by a test must not find
# this machine's relay.json and dial out to the relay with it.
import tempfile  # noqa: E402

os.environ["BOM_RELAY_PATH"] = os.path.join(tempfile.mkdtemp(prefix="bom-relay-"), "relay.json")
for _name in ("BOM_RELAY_URL", "BOM_RELAY_KEY", "BOM_RELAY_WEB_URL", "BOM_REMOTE"):
    os.environ.pop(_name, None)


@pytest.fixture()
def auth_header():
    return {"Authorization": "Bearer test-token"}
