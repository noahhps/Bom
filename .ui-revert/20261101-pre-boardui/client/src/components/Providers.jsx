import { useEffect, useState } from "react";

/* Where the backends are managed: what each is pointed at, and how to connect
 * the one that needs connecting.
 *
 * The rail's menu is the fast path -- open it, pick a model, close it. This is
 * the slow one, and it is where the things that cannot be a menu item live: a
 * key to paste, a sign-in to start, an account to look at, a connection to
 * take back. Both change the same server state, so a model picked here shows
 * in the menu and the other way round.
 */

const LABELS = {
  local: { name: "Local", blurb: "Ollama, on this machine" },
  network: { name: "Network", blurb: "Ollama, on another machine on your network" },
  cloud: { name: "Cloud", blurb: "Anthropic" },
  openrouter: { name: "OpenRouter", blurb: "One key, several hundred models" },
};

/** What a backend is called: the four built in by name, a connection by its own. */
export function providerLabel(entry) {
  return LABELS[entry?.id]?.name || entry?.label || entry?.name || entry?.id || "";
}

export function Providers({ models, provider, onProvider, serving }) {
  return (
    <>
      <div className="lane">
        <span className="mi" data-strong>
          Connection
        </span>
        <i />
        <span className="mi">
          {serving === "none" ? "nothing reachable" : `serving ${serving || "…"}`}
        </span>
      </div>

      {models.error ? (
        <div className="callout" data-tint="ochre">
          <p>
            {models.error.answered
              ? models.error.message
              : "Couldn't reach the server to list the models."}
          </p>
        </div>
      ) : null}

      {/* `loading` starts true so the page says "checking" rather than
          flashing an empty column and then contradicting it. */}
      {models.loading && models.providers.length === 0 ? (
        <p className="caveat" style={{ margin: 0 }}>
          Checking what is reachable…
        </p>
      ) : null}

      {models.providers.map((entry) => (
        <div key={entry.id} className="sur corpus provider-card">
          <div className="corpus-top">
            <i
              style={{
                background: entry.healthy ? "var(--green)" : "rgba(var(--ink-rgb), 0.18)",
              }}
            />
            <span>{providerLabel(entry)}</span>
            <span className="mi">
              {/* Three states, not two: a backend with no key at all is not
                  the same as one whose key stopped working, and the label is
                  short because it is set in the small caps of a card head. */}
              {entry.healthy
                ? "reachable"
                : entry.configured
                  ? "unreachable"
                  : entry.id === "network"
                    ? "not connected"
                    : "no key"}
            </span>
          </div>

          <ModelRow entry={entry} onChoose={models.choose} />

          {entry.id === "openrouter" ? (
            <OpenRouterConnection models={models} entry={entry} />
          ) : entry.id === "network" ? (
            <NetworkConnection models={models} entry={entry} />
          ) : entry.id === "cloud" ? (
            <AnthropicConnection models={models} entry={entry} />
          ) : entry.connection ? (
            <ConnectionDetails models={models} entry={entry} />
          ) : (
            <p>{entry.error || LABELS[entry.id]?.blurb}</p>
          )}
        </div>
      ))}

      {models.connections.filter((c) => !c.enabled).map((connection) => (
        <SwitchedOff key={connection.id} models={models} connection={connection} />
      ))}

      <AddConnection models={models} />

      <FallbackOrder models={models} />

      <div className="lane" style={{ marginTop: "6px" }}>
        <span className="mi" data-strong>
          Answer with
        </span>
        <i />
      </div>
      <div className="filters">
        {[{ id: null, label: "Auto" }, ...models.providers.map((p) => ({
          id: p.id,
          label: providerLabel(p),
        }))].map((choice) => (
          <button
            key={choice.id || "auto"}
            type="button"
            className="chip"
            data-on={provider === choice.id ? "" : undefined}
            onClick={() => onProvider(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <p className="caveat" style={{ margin: 0 }}>
        Auto uses the local model and, when it cannot be reached, falls back in
        the order above. Whichever one answers, it answers with the model
        chosen for it — and that choice is kept on the server, so it is the
        same on every device.
      </p>
    </>
  );
}

/**
 * The model in use, and everything else this backend has.
 *
 * A native select rather than the rail's filtered list: this page has room,
 * the lists are short enough to scroll on every backend but OpenRouter, and a
 * select is the one control a phone already knows how to make usable.
 */
function ModelRow({ entry, onChoose }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const models = entry.models || [];

  // A model set from the environment, or picked before it was retired, can be
  // one the catalogue no longer lists. It is still what this backend will use,
  // so it is added to the options rather than silently replaced by the first
  // one in the list -- which is what a select with no matching value does.
  const options = models.some((m) => m.id === entry.model)
    ? models
    : [{ id: entry.model, name: entry.model }, ...models];

  const change = async (model) => {
    if (!model || model === entry.model) return;
    setBusy(true);
    setProblem("");
    try {
      await onChoose(entry.id, model);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  // A connection whose service lists nothing usable -- Azure, where the
  // model is a deployment's name -- takes a typed one instead.
  if (entry.connection && models.length === 0) {
    return <TypedModel entry={entry} onChoose={onChoose} />;
  }

  return (
    <div className="provider-model">
      <label className="mi" htmlFor={`model-${entry.id}`}>
        Model
      </label>
      {models.length === 0 && !entry.model ? (
        <span className="mi">—</span>
      ) : (
        <select
          id={`model-${entry.id}`}
          value={entry.model || ""}
          disabled={busy || models.length === 0}
          onChange={(event) => change(event.target.value)}
        >
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name || model.id}
            </option>
          ))}
        </select>
      )}
      {problem ? <span className="mi provider-problem">{problem}</span> : null}
    </div>
  );
}

/**
 * Connecting an Ollama on another machine: type its address, or find it.
 *
 * The server does the checking -- that the address is on this network and
 * that Ollama answers there -- so this only has to say what it was told.
 * "Find" scans the server's own subnet, which is the network that matters:
 * the server is what will be talking to it, not this browser.
 */
function NetworkConnection({ models, entry }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [found, setFound] = useState(null);

  const connect = async (address) => {
    setBusy("connect");
    setProblem("");
    try {
      await models.setNetworkUrl(address.trim());
      setUrl("");
      setFound(null);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy("");
    }
  };

  const find = async () => {
    setBusy("find");
    setProblem("");
    try {
      const result = await models.discoverNetwork();
      setFound(result);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy("");
    }
  };

  if (entry.configured) {
    return (
      <>
        <p>
          Answering from <code>{entry.url}</code>. Models are the ones pulled on that
          machine; conversations go to it over your network and nowhere else.
        </p>
        <div className="skill-needs">
          <span className="mi">{entry.healthy ? "Connected" : "Saved, but not answering"}</span>
          <button type="button" className="mi" disabled={Boolean(busy)} onClick={() => connect("")}>
            disconnect
          </button>
        </div>
        {problem ? <p className="provider-problem">{problem}</p> : null}
      </>
    );
  }

  return (
    <>
      <p>
        Use Ollama running on another computer on your network — a desktop with a
        bigger GPU, a home server. On that machine, set{" "}
        <code>OLLAMA_HOST=0.0.0.0</code> and restart Ollama so it listens on the
        network.
      </p>
      <form
        className="skill-key"
        onSubmit={(event) => {
          event.preventDefault();
          connect(url);
        }}
      >
        <input
          value={url}
          autoComplete="off"
          spellCheck="false"
          placeholder="192.168.1.20 or gpu-box:11434"
          aria-label="Network Ollama address"
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" className="btnp" disabled={!url.trim() || Boolean(busy)}>
          {busy === "connect" ? "Checking…" : "Connect"}
        </button>
      </form>
      <div className="side-actions" style={{ marginTop: "10px" }}>
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={find}>
          {busy === "find" ? "Looking…" : "Find on my network"}
        </button>
      </div>
      {found ? (
        found.servers.length ? (
          <ul className="network-found">
            {found.servers.map((server) => (
              <li key={server.url}>
                <span>
                  <code>{server.url}</code>
                  <span className="mi">
                    {server.self ? "this machine · " : ""}
                    {server.models.length} model{server.models.length === 1 ? "" : "s"}
                    {server.version ? ` · Ollama ${server.version}` : ""}
                  </span>
                </span>
                <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => connect(server.url)}>
                  Use
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="caveat">
            No Ollama answered on {found.scanned?.length ? found.scanned.map((ip) => ip.replace(/\.\d+$/, ".x")).join(", ") : "this network"}.
            Check that it listens on the network, or type its address.
          </p>
        )
      ) : null}
      {problem ? <p className="provider-problem">{problem}</p> : null}
    </>
  );
}

/**
 * Connecting OpenRouter: sign in, or paste a key.
 *
 * Both end at the same place -- a key held on the server, in `data/` -- so
 * this offers whichever one the reader would rather do rather than picking for
 * them. The sign-in is first because it is one tap and the other is four steps
 * in a web console.
 */
function OpenRouterConnection({ models, entry }) {
  const [pasting, setPasting] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const signIn = models.signIn;

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      await models.setKey(key.trim());
      setKey("");
      setPasting(false);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setProblem("");
    try {
      await models.setKey("");
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (entry.configured) {
    return (
      <>
        <p>
          {entry.account?.label ? `Connected as ${entry.account.label}. ` : "Connected. "}
          {typeof entry.account?.usage === "number"
            ? `$${entry.account.usage.toFixed(2)} spent on this key` +
              (entry.account.limit ? ` of $${Number(entry.account.limit).toFixed(2)}.` : ".")
            : "Usage and limits live on openrouter.ai."}
        </p>
        <div className="skill-needs">
          <span className="mi">
            {entry.healthy ? "Key accepted" : "Key stored, but not accepted"}
          </span>
          <button type="button" className="mi" disabled={busy} onClick={disconnect}>
            disconnect
          </button>
        </div>
        {problem ? <p className="provider-problem">{problem}</p> : null}
      </>
    );
  }

  return (
    <>
      <p>
        Sign in and OpenRouter mints a key for this app. Nothing else is stored:
        the key lands in <code>data/openrouter_key</code> on the server, and
        disconnecting deletes it.
      </p>

      {signIn?.status === "pending" ? (
        <p>
          Waiting for the sign-in to finish in the other tab…{" "}
          {/* The link matters more than it looks: a browser that blocked the
              popup leaves this as the only way through the flow. */}
          {signIn.url ? (
            <a href={signIn.url} target="_blank" rel="noreferrer">
              open it again
            </a>
          ) : null}
          {" · "}
          <button type="button" className="mi" onClick={models.dismissSignIn}>
            stop waiting
          </button>
        </p>
      ) : null}
      {signIn?.status === "failed" ? (
        <p className="provider-problem">{signIn.error || "The sign-in didn't finish."}</p>
      ) : null}

      <div className="side-actions" style={{ marginTop: "10px" }}>
        <button
          type="button"
          className="btn"
          disabled={signIn?.status === "pending" || signIn?.status === "starting"}
          onClick={models.startSignIn}
        >
          {signIn?.status === "pending" ? "Waiting…" : "Sign in with OpenRouter"}
        </button>
        <button type="button" className="btn" onClick={() => setPasting((was) => !was)}>
          {pasting ? "Cancel" : "Paste a key"}
        </button>
      </div>

      {pasting ? (
        <form className="skill-key" onSubmit={save}>
          <input
            type="password"
            value={key}
            autoFocus
            autoComplete="off"
            spellCheck="false"
            placeholder="sk-or-v1-…"
            aria-label="OpenRouter API key"
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="btnp" disabled={!key.trim() || busy}>
            {busy ? "Checking…" : "Save"}
          </button>
        </form>
      ) : null}

      {problem ? <p className="provider-problem">{problem}</p> : null}
    </>
  );
}


/** A model named by hand, for a connection whose service does not list one. */
function TypedModel({ entry, onChoose }) {
  const [value, setValue] = useState(entry.model || "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      await onChoose(entry.id, value.trim());
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="provider-model" onSubmit={save}>
      <label className="mi" htmlFor={`model-${entry.id}`}>
        Model
      </label>
      <input
        id={`model-${entry.id}`}
        value={value}
        placeholder="model or deployment name"
        spellCheck="false"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="btn" disabled={busy || !value.trim() || value.trim() === entry.model}>
        Save
      </button>
      {problem ? <span className="mi provider-problem">{problem}</span> : null}
    </form>
  );
}

/** A key pasted for Anthropic, or the server's own environment. */
function AnthropicConnection({ models, entry }) {
  const [pasting, setPasting] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const run = async (next) => {
    setBusy(true);
    setProblem("");
    try {
      await models.setAnthropicKey(next);
      setKey("");
      setPasting(false);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        {entry.key_source === "settings"
          ? "Connected with the key pasted here."
          : entry.key_source === "environment"
            ? "Connected with the key in the server's environment."
            : "Paste an Anthropic API key (console.anthropic.com > API keys), or set ANTHROPIC_API_KEY on the server."}
      </p>
      <div className="side-actions" style={{ marginTop: "10px" }}>
        <button type="button" className="btn" onClick={() => setPasting((was) => !was)}>
          {pasting ? "Cancel" : entry.key_source ? "Replace key" : "Paste a key"}
        </button>
        {entry.key_source === "settings" ? (
          <button type="button" className="btn" disabled={busy} onClick={() => run("")}>
            Forget key
          </button>
        ) : null}
      </div>
      {pasting ? (
        <form
          className="skill-key"
          onSubmit={(event) => {
            event.preventDefault();
            run(key.trim());
          }}
        >
          <input
            type="password"
            value={key}
            autoFocus
            autoComplete="off"
            spellCheck="false"
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="btnp" disabled={!key.trim() || busy}>
            {busy ? "Checking…" : "Save"}
          </button>
        </form>
      ) : null}
      {problem ? <p className="provider-problem">{problem}</p> : null}
    </>
  );
}

/** One connection: where it points, its key, and taking it back. */
function ConnectionDetails({ models, entry }) {
  const connection = entry.connection;
  const [editing, setEditing] = useState(null); // "key" | "name" | null
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [removing, setRemoving] = useState(false);

  const run = async (action) => {
    setBusy(true);
    setProblem("");
    try {
      await action();
      setEditing(null);
      setValue("");
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        {connection.base_url}
        {" · "}
        {connection.has_key ? "key saved" : connection.key_required ? "no key" : "no key needed"}
        {entry.error ? ` · ${entry.error}` : ""}
      </p>
      <div className="side-actions" style={{ marginTop: "10px" }}>
        <button type="button" className="btn" onClick={() => {
          setEditing(editing === "key" ? null : "key");
          setValue("");
        }}>
          {editing === "key" ? "Cancel" : connection.has_key ? "Replace key" : "Add key"}
        </button>
        <button type="button" className="btn" onClick={() => {
          setEditing(editing === "name" ? null : "name");
          setValue(connection.name);
        }}>
          {editing === "name" ? "Cancel" : "Rename"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run(() => models.editConnection(connection.id, { enabled: false }))}
        >
          Switch off
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onBlur={() => setRemoving(false)}
          onClick={() =>
            removing ? run(() => models.removeConnection(connection.id)) : setRemoving(true)
          }
        >
          {removing ? "Really remove?" : "Remove"}
        </button>
      </div>
      {editing ? (
        <form
          className="skill-key"
          onSubmit={(event) => {
            event.preventDefault();
            const patch = editing === "key" ? { api_key: value.trim() } : { name: value.trim() };
            run(() => models.editConnection(connection.id, patch));
          }}
        >
          <input
            type={editing === "key" ? "password" : "text"}
            value={value}
            autoFocus
            autoComplete="off"
            spellCheck="false"
            aria-label={editing === "key" ? `${providerLabel(entry)} API key` : "Name"}
            placeholder={editing === "key" ? "API key" : "Name"}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" className="btnp" disabled={busy || (editing === "name" && !value.trim())}>
            Save
          </button>
        </form>
      ) : null}
      {problem ? <p className="provider-problem">{problem}</p> : null}
    </>
  );
}

/** A connection that is switched off: listed, not offered. */
function SwitchedOff({ models, connection }) {
  const [busy, setBusy] = useState(false);
  const run = async (action) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sur corpus provider-card" data-off>
      <div className="corpus-top">
        <i style={{ background: "rgba(var(--ink-rgb), 0.18)" }} />
        <span>{connection.name}</span>
        <span className="mi">switched off</span>
      </div>
      <p>{connection.base_url}</p>
      <div className="side-actions" style={{ marginTop: "10px" }}>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run(() => models.editConnection(connection.id, { enabled: true }))}
        >
          Switch on
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => run(() => models.removeConnection(connection.id))}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * Adding a connection: pick the service, give it a key (or an address, for a
 * server of your own), check it, pick a model, add it.
 *
 * Checked before it is saved, so a wrong key or a server that is not running
 * is found here rather than on the first message.
 */
function AddConnection({ models }) {
  const [presets, setPresets] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [form, setForm] = useState({ name: "", base_url: "", api_key: "", model: "" });
  const [check, setCheck] = useState(null); // {ok, models, error}
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let live = true;
    models
      .presets()
      .then((data) => live && setPresets(data.presets || []))
      .catch(() => {});
    return () => {
      live = false;
    };
    // `models.presets` is a fresh function each render; fetching once is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (preset) => {
    setChosen(preset);
    setForm({ name: "", base_url: preset.base_url || "", api_key: "", model: "" });
    setCheck(null);
    setProblem("");
  };

  const body = () => ({
    preset: chosen.id,
    name: form.name.trim(),
    base_url: chosen.url_editable ? form.base_url.trim() : "",
    api_key: form.api_key.trim(),
  });

  const runCheck = async () => {
    setBusy(true);
    setProblem("");
    try {
      const found = await models.checkConnection(body());
      setCheck(found);
      if (found.ok && found.models.length && !form.model) {
        setForm((was) => ({ ...was, model: found.models[0].id }));
      }
    } catch (failure) {
      setCheck(null);
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  const add = async (event) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      await models.addConnection({ ...body(), model: form.model.trim() });
      setChosen(null);
      setCheck(null);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    } finally {
      setBusy(false);
    }
  };

  const field = (name) => (event) => {
    setForm((was) => ({ ...was, [name]: event.target.value }));
    if (name !== "model" && name !== "name") setCheck(null);
  };

  const groups = [
    { kind: "cloud", label: "Cloud services" },
    { kind: "local", label: "On this machine or your network" },
  ];
  const needsKey = chosen?.key_required && !form.api_key.trim();

  return (
    <div className="provider-add">
      <div className="lane" style={{ marginTop: "6px" }}>
        <span className="mi" data-strong>
          Add a provider
        </span>
        <i />
      </div>
      <p className="caveat" style={{ margin: 0 }}>
        Anything that speaks OpenAI's chat API: the services below, a model
        server of your own, or your company's gateway.
      </p>
      {groups.map((group) => (
        <div key={group.kind} className="provider-presets">
          <span className="mi">{group.label}</span>
          <div className="filters">
            {presets
              .filter((preset) => preset.kind === group.kind)
              .map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="chip"
                  data-on={chosen?.id === preset.id ? "" : undefined}
                  title={preset.blurb}
                  onClick={() => (chosen?.id === preset.id ? setChosen(null) : pick(preset))}
                >
                  {preset.label}
                </button>
              ))}
          </div>
        </div>
      ))}

      {chosen ? (
        <form className="sur provider-form" onSubmit={add}>
          <p>{chosen.blurb}</p>
          <label>
            <span className="mi">Name</span>
            <input value={form.name} placeholder={chosen.label} onChange={field("name")} />
          </label>
          {chosen.url_editable ? (
            <label>
              <span className="mi">Address</span>
              <input
                value={form.base_url}
                placeholder="https://…/v1"
                spellCheck="false"
                onChange={field("base_url")}
              />
            </label>
          ) : null}
          {chosen.key_required || chosen.key_help ? (
            <label>
              <span className="mi">API key{chosen.key_required ? "" : " (optional)"}</span>
              <input
                type="password"
                value={form.api_key}
                autoComplete="off"
                spellCheck="false"
                placeholder={chosen.key_help || "API key"}
                onChange={field("api_key")}
              />
            </label>
          ) : null}
          <div className="side-actions">
            <button type="button" className="btn" disabled={busy || needsKey} onClick={runCheck}>
              {busy && !check ? "Checking…" : "Check"}
            </button>
          </div>
          {check && !check.ok ? <p className="provider-problem">{check.error}</p> : null}
          {check ? (
            <label>
              <span className="mi">Model</span>
              {check.models.length ? (
                <select value={form.model} onChange={field("model")}>
                  {check.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={form.model}
                  placeholder="model or deployment name"
                  spellCheck="false"
                  onChange={field("model")}
                />
              )}
            </label>
          ) : null}
          {problem ? <p className="provider-problem">{problem}</p> : null}
          <div className="side-actions">
            <button
              type="submit"
              className="btnp"
              disabled={busy || needsKey || !check || !form.model.trim()}
            >
              Add {form.name.trim() || chosen.label}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** The order Auto falls back in, after the local model. */
function FallbackOrder({ models }) {
  const [problem, setProblem] = useState("");
  const byId = Object.fromEntries(models.providers.map((p) => [p.id, p]));
  const order = models.order.filter((id) => byId[id]);
  if (order.length < 2) return null;

  const move = async (index, step) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + step, 0, item);
    setProblem("");
    try {
      await models.setFallbackOrder(next);
    } catch (failure) {
      setProblem(failure.message || String(failure));
    }
  };

  return (
    <div className="provider-order">
      <div className="lane" style={{ marginTop: "6px" }}>
        <span className="mi" data-strong>
          Fallback order
        </span>
        <i />
      </div>
      <p className="caveat" style={{ margin: 0 }}>
        When the local model is not answering, Auto tries these in turn and uses
        the first that is reachable.
      </p>
      <ol>
        {order.map((id, index) => (
          <li key={id}>
            <span className="mi">{index + 1}</span>
            <span className="provider-order-name">{providerLabel(byId[id])}</span>
            <span className="mi">{byId[id].healthy ? "reachable" : "unreachable"}</span>
            <button
              type="button"
              className="btn"
              aria-label={`Move ${providerLabel(byId[id])} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn"
              aria-label={`Move ${providerLabel(byId[id])} down`}
              disabled={index === order.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      {problem ? <p className="provider-problem">{problem}</p> : null}
    </div>
  );
}
