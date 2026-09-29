import { useEffect, useId, useRef, useState } from "react";

import { AgentFlower } from "./AgentFlower";
import {
  DEFAULT_ORIGIN,
  needsExplicitOrigin,
  serverOrigin,
  setServerOrigin,
} from "../lib/serverOrigin";

/* The sign-in screen. Nothing else renders until the bearer token is accepted.
 *
 * The logo is the first thing here and the largest: the agent's flower, open,
 * blooming while the pointer is over it -- the same flower that heads the rail
 * and blooms beside a live answer, so the first screen already speaks the
 * app's language. It also blooms while connecting, which is the one wait on
 * this screen and the one thing worth showing is alive.
 *
 * Under it, one field and one button. Only the bundled desktop app asks where
 * the server is -- see needsExplicitOrigin. Under `tauri dev` the Vite proxy
 * answers that, so the gate stays the one-field form it is in a browser. */
export function TokenGate({ error, connecting, onSubmit }) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const desktop = needsExplicitOrigin();
  const [origin, setOrigin] = useState(() => serverOrigin() || DEFAULT_ORIGIN);
  const tokenId = useId();
  const originId = useId();
  const errorId = useId();
  const token = useRef(null);

  // Straight into the field: this screen has one job.
  useEffect(() => {
    token.current?.focus();
  }, []);

  // A rejected token is selected, so the next paste replaces it.
  useEffect(() => {
    if (error) token.current?.select();
  }, [error]);

  const ready = value.trim().length > 0;

  return (
    <main className="gate">
      <div className="gate-backdrop" aria-hidden="true" />

      <div className="gate-panel">
        <header className="gate-brand">
          <AgentFlower open mark size={96} blooming={connecting} className="gate-mark" />
          <h1 className="gate-title">
            Bom <span lang="ko">봄</span>
          </h1>
          <p className="gate-tagline">Your assistant, on your own hardware.</p>
        </header>

        <form
          className="gate-card"
          aria-busy={connecting || undefined}
          data-error={error ? "" : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || connecting) return;
            // Saved before the token is handed up, because the caller's very
            // next act is a request that has to go to the right host.
            if (desktop) setServerOrigin(origin);
            onSubmit(value.trim());
          }}
        >
          {desktop ? (
            <div className="gate-field">
              <label htmlFor={originId}>Server</label>
              <input
                id={originId}
                className="gate-input"
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                placeholder={DEFAULT_ORIGIN}
                spellCheck="false"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
              />
            </div>
          ) : null}

          <div className="gate-field">
            <label htmlFor={tokenId}>Access token</label>
            <div className="gate-secret">
              <input
                id={tokenId}
                ref={token}
                className="gate-input"
                type={shown ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="off"
                placeholder="Paste your token"
                spellCheck="false"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <button
                type="button"
                className="gate-reveal"
                aria-pressed={shown}
                aria-label={shown ? "Hide token" : "Show token"}
                onClick={() => setShown((was) => !was)}
              >
                {shown ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {error ? (
            <p className="gate-error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="gate-submit" disabled={!ready || connecting}>
            {connecting ? "Connecting…" : "Connect"}
          </button>

          <details className="gate-help">
            <summary>Where do I find the token?</summary>
            <p>
              The server prints it when it starts, on the line beginning{" "}
              <code>token:</code>, and keeps it in <code>data/token</code> beside
              the database. It stays the same across restarts.
            </p>
          </details>
        </form>

        <p className="gate-foot">Runs on this machine. Nothing leaves it unless you send it.</p>
      </div>
    </main>
  );
}
