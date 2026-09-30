/* Enterprise mode: one switch that sizes Bom's limits for company work.
 *
 * The server holds the switch and both sets of limits (GET /enterprise), so
 * this screen draws what it is told rather than keeping its own copy of the
 * numbers: an operator who raised a limit in the environment sees their
 * value here, not a default written into the client. */
import { useCallback, useEffect, useState } from "react";

function format(value, unit) {
  if (value === null || value === undefined) return "—";
  if (unit === "of the window") return `${Math.round(Number(value) * 100)}%`;
  if (typeof value === "string") {
    const match = /^(\d+)([mh])$/.exec(value);
    if (match) {
      const n = Number(match[1]);
      const word = match[2] === "h" ? "hour" : "minute";
      return `${n} ${word}${n === 1 ? "" : "s"}`;
    }
    return value;
  }
  const number = Number(value).toLocaleString();
  return unit ? `${number} ${unit}` : number;
}

export function Enterprise({ api }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getEnterprise()
      .then((data) => live && setState(data))
      .catch((problem) => live && setError(problem.message || String(problem)));
    return () => {
      live = false;
    };
  }, [api]);

  const toggle = useCallback(async () => {
    if (!state || saving) return;
    const before = state;
    setSaving(true);
    setState({ ...state, enabled: !state.enabled });
    try {
      setState(await api.setEnterprise(!before.enabled));
      setError(null);
    } catch (problem) {
      setState(before);
      setError(problem.message || String(problem));
    } finally {
      setSaving(false);
    }
  }, [api, state, saving]);

  const on = Boolean(state?.enabled);

  return (
    <>
      <div className="settings-rows">
        <div className="settings-row">
          <div>
            <b>Enterprise mode</b>
            <p>
              For company work: very long conversations, large codebases and
              cloud models with big context windows. Raises the context window,
              lets tools return much more and run for longer, compacts the
              conversation later while keeping more of it word for word, and
              keeps the prompt cached for an hour. Takes effect on the next
              message.
            </p>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={on}
            aria-pressed={on}
            aria-label="Enterprise mode"
            disabled={!state || saving}
            onClick={toggle}
          >
            <i />
          </button>
        </div>
      </div>

      {error ? (
        <p className="settings-note" role="alert">
          {error}
        </p>
      ) : null}

      <h3 className="settings-sub">
        Limits
        <span className="mi">{on ? "enterprise in use" : "standard in use"}</span>
      </h3>
      {state ? (
        <div className="limits-table" role="table" aria-label="Limits in standard and enterprise mode">
          <div className="limits-row limits-head" role="row">
            <span role="columnheader">Limit</span>
            <span role="columnheader" data-active={!on || undefined}>
              Standard
            </span>
            <span role="columnheader" data-active={on || undefined}>
              Enterprise
            </span>
          </div>
          {state.limits.map((row) => (
            <div key={row.name} className="limits-row" role="row">
              <span role="rowheader">{row.label}</span>
              <span role="cell" data-active={!on || undefined}>
                {format(row.standard, row.unit)}
              </span>
              <span role="cell" data-active={on || undefined}>
                {format(row.enterprise, row.unit)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-note">Loading…</p>
      )}

      <h3 className="settings-sub">Compaction</h3>
      <p className="settings-note">
        When a conversation's history fills the share of the window above, its
        older messages are summarized into one note that the model reads in
        their place, and the recent ones are still sent word for word. The
        thread here keeps every message; only the model's copy is compacted.
        Within one long turn, results of earlier tool calls are cleared once
        the window runs short.
      </p>

      <h3 className="settings-sub">What stays the same</h3>
      <p className="settings-note">
        Everything that keeps this machine safe: the sandbox switch, asking
        before a skill runs, the folders a project may be opened from, and the
        secrets kept out of every shell. Windows are still capped at what the
        model itself can hold. Each limit can be tuned on the server with an{" "}
        <b>ENTERPRISE_</b>-prefixed environment variable, such as{" "}
        <b>ENTERPRISE_CONTEXT_TOKENS</b>.
      </p>
    </>
  );
}
