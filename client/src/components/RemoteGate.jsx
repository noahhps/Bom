import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AgentFlower } from "./AgentFlower";
import { useDialog } from "./Dialog";
import {
  REMOTE_ONLY,
  currentAccount,
  formatCode,
  linkDevice,
  listHosts,
  lookupDevice,
  onAccountChange,
  relayConfig,
  relayFromBuild,
  removeHost,
  saveRelayConfig,
  sendSignInCode,
  signOutAccount,
  arrivalError,
  takeLinkCode,
  verifySignInCode,
} from "../lib/remote";

/* The way in when the server is somewhere else: sign in to your relay account,
 * then pick one of the machines linked to it.
 *
 * Three steps, each only when it is needed. The relay's address, if this build
 * did not come with one (the desktop app, a local build). The account, by a
 * code emailed to you -- no password to keep. Then the devices: the ones
 * already linked, and a field for the code a new one is showing on its screen.
 *
 * Linking is the verification. A device is only ever linked by someone who is
 * signed in here *and* can read the code on that device's screen -- the code
 * works once, for ten minutes -- and from then on only this account's session
 * is served by it. */
export function RemoteGate({ error, connectingTo, onConnect, onUseToken }) {
  const connecting = Boolean(connectingTo);
  const [config, setConfig] = useState(() => relayConfig());
  const [editing, setEditing] = useState(false);
  // undefined while asking, null when signed out.
  const [account, setAccount] = useState(undefined);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!config || editing) return undefined;
    let live = true;
    let off = null;
    setAccount(undefined);
    currentAccount()
      .then((user) => live && setAccount(user))
      .catch((exc) => {
        if (!live) return;
        setAccount(null);
        setProblem(exc.message || String(exc));
      });
    onAccountChange((user) => live && setAccount(user))
      .then((unsubscribe) => (live ? (off = unsubscribe) : unsubscribe()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, [config, editing]);

  let body;
  if (!config || editing) {
    body = (
      <RelaySetup
        initial={config}
        onSaved={(saved) => {
          setEditing(false);
          setConfig(saved);
        }}
        onCancel={config ? () => setEditing(false) : null}
      />
    );
  } else if (account === undefined) {
    body = (
      <div className="gate-card" aria-busy="true">
        <p className="remote-quiet">Checking your account…</p>
      </div>
    );
  } else if (!account) {
    body = <SignIn problem={problem} />;
  } else {
    body = (
      <Devices
        account={account}
        error={error}
        connectingTo={connectingTo}
        onConnect={onConnect}
        onChangeRelay={relayFromBuild() ? null : () => setEditing(true)}
      />
    );
  }

  return (
    <main className="gate">
      <div className="gate-backdrop" aria-hidden="true" />
      <div className="gate-panel">
        <header className="gate-brand">
          <AgentFlower open mark size={96} blooming={connecting} className="gate-mark" />
          <h1 className="gate-title">
            Bom <span lang="ko">봄</span>
          </h1>
          <p className="gate-tagline">Your assistant, on your own hardware — from anywhere.</p>
        </header>

        {body}

        <p className="gate-foot">
          {onUseToken && !REMOTE_ONLY ? (
            <>
              <button type="button" className="remote-link" onClick={onUseToken}>
                Connect with a token instead
              </button>
              {" · "}
            </>
          ) : null}
          Requests pass through your relay; conversations stay on your host.
        </p>
      </div>
    </main>
  );
}

function RelaySetup({ initial, onSaved, onCancel }) {
  const [url, setUrl] = useState(initial?.url || "");
  const [key, setKey] = useState(initial?.key || "");
  const [problem, setProblem] = useState("");
  const urlId = useId();
  const keyId = useId();

  return (
    <form
      className="gate-card"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onSaved(saveRelayConfig({ url, key }));
        } catch (exc) {
          setProblem(exc.message);
        }
      }}
    >
      <div className="gate-field">
        <label htmlFor={urlId}>Relay address</label>
        <input
          id={urlId}
          className="gate-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck="false"
          placeholder="https://your-project.supabase.co"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          autoFocus
        />
      </div>
      <div className="gate-field">
        <label htmlFor={keyId}>Relay key</label>
        <input
          id={keyId}
          className="gate-input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck="false"
          placeholder="The project's anon or publishable key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </div>
      {problem ? (
        <p className="gate-error" role="alert">
          {problem}
        </p>
      ) : null}
      <button type="submit" className="gate-submit" disabled={!url.trim() || !key.trim()}>
        Continue
      </button>
      {onCancel ? (
        <button type="button" className="remote-link" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      <details className="gate-help">
        <summary>Where do these come from?</summary>
        <p>
          Your relay is a Supabase project of your own. <code>relay/setup.sh</code> prints both
          values when it sets it up; they are also under Project Settings → API Keys. The key is
          meant to be public — what protects your host is your sign-in and the relay's access
          rules.
        </p>
      </details>
    </form>
  );
}

// The host's code: two groups of four letters and digits. Typed into the
// email-code field by mistake often enough to be worth recognising.
const DEVICE_CODE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

function SignIn({ problem }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  // A sign-in link that failed says why in the address it came back to.
  const [error, setError] = useState(() => arrivalError() || problem || "");
  const emailId = useId();
  const codeId = useId();
  const codeRef = useRef(null);

  useEffect(() => {
    if (sentTo) codeRef.current?.focus();
  }, [sentTo]);

  const run = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (exc) {
      setError(exc.message || String(exc));
    } finally {
      setBusy(false);
    }
  };

  if (!sentTo) {
    return (
      <form
        className="gate-card"
        aria-busy={busy || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (!email.trim() || busy) return;
          run(async () => {
            await sendSignInCode(email);
            setSentTo(email.trim());
          });
        }}
      >
        <div className="gate-field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            className="gate-input"
            type="email"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck="false"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus
          />
        </div>
        {error ? (
          <p className="gate-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="gate-submit" disabled={!email.trim() || busy}>
          {busy ? "Sending…" : "Email me a sign-in code"}
        </button>
        <p className="remote-quiet">
          Sign in to the account your devices are linked to. No password: each sign-in is a
          one-time code.
        </p>
      </form>
    );
  }

  return (
    <form
      className="gate-card"
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!code.trim() || busy) return;
        run(() => verifySignInCode(sentTo, code));
      }}
    >
      <p className="remote-quiet">
        We emailed <b>{sentTo}</b>. Type the code from that email here — or open its link on this
        device.
      </p>
      <div className="gate-field">
        <label htmlFor={codeId}>Code from the email</label>
        <input
          id={codeId}
          ref={codeRef}
          className="gate-input remote-code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          maxLength={12}
          aria-invalid={error ? true : undefined}
          value={code}
          onChange={(event) => {
            const typed = event.target.value.trim();
            if (DEVICE_CODE.test(typed) && /[A-Z]/i.test(typed)) {
              setCode("");
              setError(
                "That's your host's code. Sign in with the code from the email first — you'll enter the host's code on the next screen.",
              );
              return;
            }
            setCode(typed.replace(/\D/g, "").slice(0, 10));
          }}
        />
      </div>
      {error ? (
        <p className="gate-error" role="alert">
          {error}
        </p>
      ) : null}
      {resent ? (
        <p className="remote-quiet" role="status">
          Sent. Use the code from this newest email — the earlier one no longer works.
        </p>
      ) : null}
      <button type="submit" className="gate-submit" disabled={code.length < 6 || busy}>
        {busy ? "Checking…" : "Sign in"}
      </button>
      <div className="remote-row-links">
        <button
          type="button"
          className="remote-link"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setResent(false);
              await sendSignInCode(sentTo);
              setCode("");
              setResent(true);
            })
          }
        >
          Send a new code
        </button>
        <button
          type="button"
          className="remote-link"
          onClick={() => {
            setSentTo("");
            setCode("");
            setError("");
            setResent(false);
          }}
        >
          Use a different email
        </button>
      </div>
    </form>
  );
}

function seen(host) {
  if (host.online) return "online";
  if (!host.last_seen_at) return "never connected";
  const minutes = Math.round((Date.now() - new Date(host.last_seen_at).getTime()) / 60000);
  if (minutes < 60) return `seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `seen ${hours} h ago`;
  return `seen ${Math.round(hours / 24)} days ago`;
}

function Devices({ account, error, connectingTo, onConnect, onChangeRelay }) {
  const connecting = Boolean(connectingTo);
  const { confirm } = useDialog();
  const [hosts, setHosts] = useState(null);
  const [problem, setProblem] = useState("");
  const [code, setCode] = useState(() => formatCode(takeLinkCode()));
  const [found, setFound] = useState(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [linked, setLinked] = useState("");
  const codeId = useId();

  const refresh = useCallback(async () => {
    try {
      setHosts(await listHosts());
      setProblem("");
    } catch (exc) {
      setProblem(exc.message || String(exc));
      setHosts((was) => was || []);
    }
  }, []);

  // The list, and whether each one is up -- kept current while it is shown,
  // and more often just after a link, while the new device is coming online.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, linked ? 4000 : 15000);
    return () => clearInterval(timer);
  }, [refresh, linked]);

  // A code that arrived in the address (?link=) is looked up straight away.
  const lookedUp = useRef(false);
  useEffect(() => {
    if (lookedUp.current || code.replace("-", "").length !== 8) return;
    lookedUp.current = true;
    find(code);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function find(value) {
    setLinking(true);
    setLinkError("");
    setLinked("");
    try {
      setFound(await lookupDevice(value));
    } catch (exc) {
      setLinkError(exc.message || String(exc));
    } finally {
      setLinking(false);
    }
  }

  async function link() {
    setLinking(true);
    setLinkError("");
    try {
      const made = await linkDevice(code);
      setLinked(made.name || found?.device_name || "The device");
      setFound(null);
      setCode("");
      await refresh();
    } catch (exc) {
      setLinkError(exc.message || String(exc));
    } finally {
      setLinking(false);
    }
  }

  async function remove(host) {
    const yes = await confirm(
      `“${host.name}” will no longer be reachable from anywhere until it is linked again. Nothing on it is deleted.`,
      { title: "Remove this device?", confirmLabel: "Remove", destructive: true },
    );
    if (!yes) return;
    try {
      await removeHost(host.id);
      await refresh();
    } catch (exc) {
      setProblem(exc.message || String(exc));
    }
  }

  return (
    <div className="gate-card remote-devices">
      <div className="remote-account">
        <span>
          Signed in as <b>{account.email}</b>
        </span>
        <button type="button" className="remote-link" onClick={() => signOutAccount().catch(() => {})}>
          Sign out
        </button>
      </div>

      {error ? (
        <p className="gate-error" role="alert">
          {error}
        </p>
      ) : null}
      {problem ? (
        <p className="gate-error" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="gate-field">
        <label>Your devices</label>
        {hosts === null ? (
          <p className="remote-quiet">Loading…</p>
        ) : hosts.length === 0 ? (
          <p className="remote-quiet">No devices linked yet — link one below.</p>
        ) : (
          <ul className="remote-hosts">
            {hosts.map((host) => (
              <li key={host.id} className="remote-host" data-online={host.online || undefined}>
                <i className="remote-dot" aria-hidden="true" />
                <div className="remote-host-name">
                  <b>{host.name}</b>
                  <span>
                    {host.platform ? `${host.platform} · ` : ""}
                    {seen(host)}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn"
                  data-danger=""
                  aria-label={`Remove ${host.name}`}
                  title="Remove this device"
                  onClick={() => remove(host)}
                  disabled={Boolean(connecting)}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="gate-submit remote-connect"
                  disabled={Boolean(connecting)}
                  onClick={() => onConnect(host)}
                >
                  {connectingTo === host.id ? "Connecting…" : "Connect"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        className="gate-field remote-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.replace("-", "").length === 8 && !linking) find(code);
        }}
      >
        <label htmlFor={codeId}>Link a device</label>
        {found ? null : (
          <p className="remote-quiet">
            On the computer running Bom, open Settings → Remote access and turn it on. Enter the
            code it shows.
          </p>
        )}
        {found ? (
          <div className="remote-confirm" role="group" aria-label="Confirm linking">
            <p>
              Link <b>{found.device_name}</b>
              {found.platform ? ` (${found.platform})` : ""} to <b>{account.email}</b>? Anyone signed
              in to this account will be able to use it.
            </p>
            <div className="remote-confirm-actions">
              <button type="button" className="btn" onClick={() => setFound(null)} disabled={linking}>
                Cancel
              </button>
              <button type="button" className="gate-submit" onClick={link} disabled={linking}>
                {linking ? "Linking…" : "Link device"}
              </button>
            </div>
          </div>
        ) : (
          <div className="remote-code-row">
            <input
              id={codeId}
              className="gate-input remote-code-input"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck="false"
              placeholder="ABCD-EFGH"
              aria-invalid={linkError ? true : undefined}
              value={code}
              onChange={(event) => setCode(formatCode(event.target.value))}
            />
            <button
              type="submit"
              className="btn"
              disabled={code.replace("-", "").length !== 8 || linking}
            >
              {linking ? "Checking…" : "Continue"}
            </button>
          </div>
        )}
        {linkError ? (
          <p className="gate-error" role="alert">
            {linkError}
          </p>
        ) : null}
        {linked ? (
          <p className="remote-quiet" role="status">
            {linked} is linked. It appears as online once it connects — usually within a few
            seconds.
          </p>
        ) : null}
      </form>

      {onChangeRelay ? (
        <button type="button" className="remote-link" onClick={onChangeRelay}>
          Use a different relay
        </button>
      ) : null}
    </div>
  );
}
