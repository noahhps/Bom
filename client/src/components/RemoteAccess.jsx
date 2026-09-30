/* Remote access: this machine as a host, reachable from anywhere.
 *
 * The switch and everything behind it can only be changed from this machine:
 * the server refuses it from anywhere else, and this screen says so rather
 * than showing controls that would be refused. See server/app/remote/. */
import { useCallback, useEffect, useId, useState } from "react";

import { useDialog } from "./Dialog";

const STATE_LABEL = {
  off: "Off",
  pairing: "Waiting to be linked",
  connecting: "Connecting…",
  online: "Online",
  error: "Not working",
};

export function RemoteAccess({ api }) {
  const { confirm } = useDialog();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.remoteStatus());
    } catch (exc) {
      setError(exc.message || String(exc));
    }
  }, [api]);

  // Faster while something is about to change on its own -- a code being
  // typed in somewhere else, a connection coming up.
  const settling = status?.state === "pairing" || status?.state === "connecting";
  useEffect(() => {
    load();
    const timer = setInterval(load, settling ? 2000 : 10000);
    return () => clearInterval(timer);
  }, [load, settling]);

  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      setStatus(await work());
    } catch (exc) {
      setError(exc.message || String(exc));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return error ? <p className="gate-error">{error}</p> : <p className="remote-quiet">Loading…</p>;
  }

  if (!status.can_manage) {
    return (
      <div className="settings-rows">
        <div className="settings-row">
          <div>
            <b>{status.via_relay ? "You're connected through the relay" : "Change this at the host"}</b>
            <p>
              Remote access can only be turned on, off or unlinked at the machine Bom runs on —
              so no one, including you from somewhere else, can switch hosting on for a machine
              that isn't in front of them.
            </p>
          </div>
          <span className="mi" data-strong="">
            {STATE_LABEL[status.state] || status.state}
          </span>
        </div>
      </div>
    );
  }

  const on = Boolean(status.enabled);
  const showConfig = editing || !status.configured;

  return (
    <>
      {showConfig ? (
        <RelayConfig
          status={status}
          busy={busy}
          onSave={(config) =>
            act(async () => {
              const next = await api.setRemoteConfig(config);
              setEditing(false);
              return next;
            })
          }
          onCancel={status.configured ? () => setEditing(false) : null}
        />
      ) : null}

      <div className="settings-rows">
        <div className="settings-row">
          <div>
            <b>Allow remote access</b>
            <p>
              Lets you use this machine's models, conversations and files from the web app or the
              desktop app anywhere, signed in to your relay account. Nothing listens on a port:
              this machine connects out to your relay and serves only your account.
            </p>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={on}
            aria-pressed={on}
            aria-label="Allow remote access"
            disabled={busy || !status.configured}
            onClick={() => act(on ? api.disableRemote : api.enableRemote)}
          >
            <i />
          </button>
        </div>

        <div className="settings-row">
          <div>
            <b>Status</b>
            <p>
              {status.linked
                ? `Linked to ${status.linked.owner_email || "your account"} as “${status.linked.name}”.`
                : status.pairing
                  ? "Enter the code below in the web app to link this machine to your account."
                  : "Not linked to an account yet. Turning remote access on shows a code to link it."}
              {status.error ? (
                <>
                  <br />
                  <span className="remote-warn">{status.error}</span>
                </>
              ) : null}
            </p>
          </div>
          <span className="remote-state" data-state={status.state}>
            <i className="remote-dot" aria-hidden="true" />
            {STATE_LABEL[status.state] || status.state}
          </span>
        </div>

        {status.linked ? (
          <div className="settings-row">
            <div>
              <b>Unlink this device</b>
              <p>
                Removes it from your account and deletes its sign-in on the relay. Your
                conversations stay here. To use it remotely again, link it again.
              </p>
            </div>
            <button
              type="button"
              className="btn"
              data-danger=""
              disabled={busy}
              onClick={async () => {
                const yes = await confirm(
                  "It will no longer be reachable through the relay until you link it again.",
                  { title: "Unlink this device?", confirmLabel: "Unlink", destructive: true },
                );
                if (yes) act(api.unlinkRemote);
              }}
            >
              Unlink
            </button>
          </div>
        ) : null}

        {!showConfig ? (
          <div className="settings-row">
            <div>
              <b>Relay</b>
              <p>
                {status.config.url}
                {status.config.web_url ? ` · web app at ${status.config.web_url}` : ""}
              </p>
            </div>
            <button type="button" className="btn" onClick={() => setEditing(true)} disabled={busy}>
              Change
            </button>
          </div>
        ) : null}
      </div>

      {status.pairing ? <Pairing pairing={status.pairing} /> : null}

      {error ? (
        <p className="gate-error" role="alert">
          {error}
        </p>
      ) : null}

      <h3 className="settings-sub">Who can use it</h3>
      <ul className="remote-layers">
        <li>
          <b>Only switched on here.</b> This machine never hosts until someone at it turns this on.
          Requests from anywhere else can't turn it on, off or re-link it.
        </li>
        <li>
          <b>Linked by you.</b> Linking needs the one-time code shown on this screen, typed in by
          someone signed in to your relay account. The code works once, for ten minutes.
        </li>
        <li>
          <b>Served to you alone.</b> Every request carries your account's session, and this
          machine checks with the relay's sign-in service that it's yours before answering. The
          relay's access rules also keep everyone else off this machine's channel.
        </li>
      </ul>
    </>
  );
}

function RelayConfig({ status, busy, onSave, onCancel }) {
  const env = status.config.from_env;
  const [url, setUrl] = useState(status.config.url || "");
  const [key, setKey] = useState(status.config.key || "");
  const [web, setWeb] = useState(status.config.web_url || "");
  const ids = { url: useId(), key: useId(), web: useId() };

  return (
    <form
      className="sur remote-config"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ url, key, web_url: web });
      }}
    >
      <p className="remote-quiet">
        Your relay is a Supabase project of your own; <code>relay/setup.sh</code> creates it and
        prints these. See docs/remote.md.
      </p>
      <div className="gate-field">
        <label htmlFor={ids.url}>Relay address</label>
        <input
          id={ids.url}
          className="gate-input"
          placeholder="https://your-project.supabase.co"
          value={url}
          disabled={env.url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="gate-field">
        <label htmlFor={ids.key}>Relay key</label>
        <input
          id={ids.key}
          className="gate-input"
          placeholder="anon or publishable key"
          value={key}
          disabled={env.key}
          onChange={(event) => setKey(event.target.value)}
        />
      </div>
      <div className="gate-field">
        <label htmlFor={ids.web}>Web app address (optional)</label>
        <input
          id={ids.web}
          className="gate-input"
          placeholder="https://your-bom.vercel.app"
          value={web}
          disabled={env.web_url}
          onChange={(event) => setWeb(event.target.value)}
        />
      </div>
      <div className="remote-confirm-actions">
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="btn" disabled={busy || !url.trim() || !key.trim()}>
          Save relay
        </button>
      </div>
    </form>
  );
}

function Pairing({ pairing }) {
  const [copied, setCopied] = useState(false);
  const minutes = Math.max(0, Math.round((new Date(pairing.expires_at).getTime() - Date.now()) / 60000));
  return (
    <div className="sur remote-pairing" role="status" aria-live="polite">
      <p>
        {pairing.link_url ? (
          <>
            On your phone or any browser, open{" "}
            <a href={pairing.link_url} target="_blank" rel="noreferrer">
              {pairing.link_url.replace(/^https?:\/\//, "").replace(/\/?\?.*$/, "")}
            </a>
            , sign in, and enter:
          </>
        ) : (
          <>In the Bom web app, sign in, choose Link a device, and enter:</>
        )}
      </p>
      <div className="remote-pairing-code">{pairing.user_code}</div>
      <p className="remote-quiet">
        Works once{minutes ? `, for about ${minutes} more minute${minutes === 1 ? "" : "s"}` : ""}.
        This screen updates by itself when it's done.
        {pairing.link_url ? (
          <>
            {" "}
            <button
              type="button"
              className="remote-link"
              onClick={() => {
                navigator.clipboard?.writeText(pairing.link_url).then(() => setCopied(true));
              }}
            >
              {copied ? "Link copied" : "Copy the link"}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}
