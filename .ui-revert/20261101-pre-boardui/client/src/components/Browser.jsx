/* Settings → Browser: the two browsers the model can work in.
 *
 * Bom's own browser needs an engine -- a Chromium on the machine, or the copy
 * of Chrome for Testing this screen can fetch -- and has one switch, whether
 * its window is shown. The user's own browser is a pick: which of the
 * browsers on this Mac the model may work in, with the two permissions macOS
 * and the browser will ask for the first time, spelt out here because the
 * dialogs that ask for them do not. */
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 1500;

function megabytes(n) {
  return `${(Number(n || 0) / 1048576).toFixed(0)} MB`;
}

export function Browser({ api }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getBrowser();
      setState(data);
      setError(null);
      return data;
    } catch (problem) {
      setError(problem.message || String(problem));
      return null;
    }
  }, [api]);

  useEffect(() => {
    let live = true;
    load().then(() => live || null);
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // While a fetch is in flight the numbers move; ask again until they stop.
  const installing = ["downloading", "unpacking"].includes(state?.own?.install?.state);
  useEffect(() => {
    if (!installing) return undefined;
    timer.current = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer.current);
  }, [installing, state, load]);

  const patch = useCallback(
    async (body) => {
      if (busy) return;
      setBusy(true);
      try {
        setState(await api.setBrowser(body));
        setError(null);
      } catch (problem) {
        setError(problem.message || String(problem));
      } finally {
        setBusy(false);
      }
    },
    [api, busy],
  );

  const install = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setState(await api.installBrowser());
      setError(null);
    } catch (problem) {
      setError(problem.message || String(problem));
    } finally {
      setBusy(false);
    }
  }, [api, busy]);

  const quit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setState(await api.closeBrowser());
    } catch (problem) {
      setError(problem.message || String(problem));
    } finally {
      setBusy(false);
    }
  }, [api, busy]);

  if (!state) {
    return error ? (
      <p className="settings-note" role="alert">{error}</p>
    ) : (
      <p className="settings-note">Loading…</p>
    );
  }

  const own = state.own || {};
  const mine = state.mine || {};
  const install_ = own.install || {};
  const selected = mine.selected || "";
  const choice = mine.choice;

  return (
    <>
      <h3 className="settings-sub">
        Bom's browser
        <span className="mi">{own.available ? (own.running ? "running" : "ready") : "no engine"}</span>
      </h3>
      <p className="settings-note">
        A private browser of Bom's own, with its own profile under <b>data/browser</b>: signed in to
        nothing, separate from yours. The model opens pages in it, reads them as text, and acts on
        them; you see a picture of the page after each step in the panel beside the conversation.
        {own.engine ? (
          <>
            {" "}Using <b>{own.engine.name}</b>
            {own.engine.source === "installed"
              ? ", found on this machine."
              : own.engine.source === "downloaded"
                ? ", fetched here."
                : ` (from ${own.engine.source}).`}
          </>
        ) : (
          " No Chromium-based browser was found on this machine: install Chrome, Chromium, Edge or Brave, point BROWSER_PATH at one, or fetch one below."
        )}
      </p>

      <div className="settings-rows">
        {!own.available || own.engine?.source === "downloaded" ? (
          <div className="settings-row">
            <div>
              <b>{own.engine?.source === "downloaded" ? "Fetch the current build again" : "Get a browser"}</b>
              <p>
                Downloads Google's plain “Chrome for Testing” build for this machine (about 150 MB,
                from Google's servers) into <b>data/browser/engine</b>. It never updates itself; fetch
                it again when you want a newer one.
                {install_.state === "downloading"
                  ? ` Downloading ${install_.version ? `version ${install_.version}` : ""}… ${megabytes(install_.received)}${install_.total ? ` of ${megabytes(install_.total)}` : ""}.`
                  : install_.state === "unpacking"
                    ? " Unpacking…"
                    : install_.state === "failed"
                      ? ` The last fetch failed: ${install_.error}`
                      : ""}
              </p>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || installing || !own.can_install}
              title={own.can_install ? undefined : "There is no Chrome for Testing build for this machine."}
              onClick={install}
            >
              {installing ? "Fetching…" : "Fetch"}
            </button>
          </div>
        ) : null}

        <div className="settings-row">
          <div>
            <b>Show its window</b>
            <p>
              Off, the browser runs headless and the panel's pictures are the only view of it. On,
              a browser window opens on this machine while the model works, which you can watch but
              should not touch. Takes effect the next time it starts.
            </p>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={Boolean(own.show_window)}
            aria-pressed={Boolean(own.show_window)}
            aria-label="Show Bom's browser window"
            disabled={busy}
            onClick={() => patch({ show_window: !own.show_window })}
          >
            <i />
          </button>
        </div>

        {own.running ? (
          <div className="settings-row">
            <div>
              <b>Quit Bom's browser</b>
              <p>
                {own.tabs === 1 ? "One conversation has a page open." : `${own.tabs} conversations have pages open.`}{" "}
                It quits on its own after a few minutes idle; this quits it now. Pages open again on
                the next step.
              </p>
            </div>
            <button type="button" className="btn" disabled={busy} onClick={quit}>
              Quit
            </button>
          </div>
        ) : null}
      </div>

      <h3 className="settings-sub">
        Your browser
        <span className="mi">{selected ? "on" : "off"}</span>
      </h3>
      <p className="settings-note">
        The browser you use yourself, with your accounts signed in. Off, the model never touches it.
        On, the model may open pages there and -- if the browser allows it -- read them and act on
        them, for the few things that need your signed-in account: your mail, a dashboard, an order.
        <b> Every step there is put to you first</b>, whatever the ask-first switch on the Skills page
        says, and the model is told never to type a password, a code or a card number: when a page
        wants one, it asks you to sign in yourself.
      </p>

      {mine.supported ? (
        <div className="settings-rows">
          <div className="settings-row">
            <div>
              <b>Which browser</b>
              <p>
                “Default” follows whatever macOS opens links with
                {mine.default ? ` (${mine.default.name} right now)` : ""}. A browser marked “open only”
                can be handed a page but not read.
              </p>
            </div>
            <select
              className="canvas-switch"
              aria-label="Which of your browsers the model may use"
              value={selected}
              disabled={busy}
              onChange={(event) => patch({ mine: event.target.value })}
            >
              <option value="">Off</option>
              <option value="default">Default{mine.default ? ` (${mine.default.name})` : ""}</option>
              {(mine.choices || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.scriptable ? "" : " (open only)"}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <p className="settings-note">
          Driving your browser works on a Mac, where every browser answers the system's Apple
          Events. Here, the model can still hand a page to your default browser for you to take
          over, once you turn this on by setting <b>browser.mine</b>; it cannot read what is there.
        </p>
      )}

      {selected && choice ? (
        <>
          <h3 className="settings-sub">Before {choice.name} answers</h3>
          <p className="settings-note">
            {choice.installed ? (
              <>
                Two permissions, each asked once, each yours to refuse:
                <br />
                <b>1. Automation.</b> The first time, macOS asks whether Bom may control {choice.name}.
                Change it later in System Settings → Privacy &amp; Security → Automation.
                <br />
                <b>2. JavaScript from Apple Events.</b> Reading a page runs a script in it, which
                browsers refuse until you allow it:{" "}
                {choice.name === "Safari"
                  ? "Safari → Settings → Advanced → Show features for web developers, then Develop → Allow JavaScript from Apple Events."
                  : `${choice.name} → View → Developer → Allow JavaScript from Apple Events.`}{" "}
                Until then Bom can open pages in {choice.name} but not read them.
                {!choice.scriptable ? ` ${choice.name} cannot run scripts from outside at all, so it is open-only.` : ""}
              </>
            ) : (
              <>{choice.name} does not seem to be installed; pick another, or Default.</>
            )}
          </p>
        </>
      ) : null}

      {error ? (
        <p className="settings-note" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
