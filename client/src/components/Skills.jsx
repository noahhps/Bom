import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useSkills } from "../hooks/useSkills";
import { serverOrigin } from "../lib/serverOrigin";
import { SHELVES, serviceName, shelfOf, skillTitle } from "../lib/skillShelf";
import { useDialog } from "./Dialog";
import { Icon } from "./Icon";
import { ServiceIcon } from "./ServiceIcon";
import { SeekField } from "./bencho/SeekField";
import { Switch } from "./bencho/Switch";
import { TiltCard } from "./bencho/TiltCard";

// Unavailable is blocked whether or not the server said why: it refuses to
// turn on a skill that is not available, so offering the switch would only
// produce an error.
const blockedSkill = (skill) => !skill.available;
const needOf = (skill) => skill.requires || "setting up on the server";

/* What a skill is waiting for, and -- where the thing it needs is a key --
 * the field to paste one into. One line per requirement, not per skill: four
 * page tools that all need a browser say so once. */
function SkillNeed({ skill, busy, onKey }) {
  const [key, setKey] = useState("");
  const [open, setOpen] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (await onKey(skill.name, key.trim())) {
      setKey("");
      setOpen(false);
    }
  };

  return (
    <div className="skill-need">
      <div className="skill-needs">
        <span className="mi">Needs {needOf(skill)}</span>
        {skill.configurable ? (
          <button type="button" className="mi" onClick={() => setOpen((was) => !was)}>
            {open ? "cancel" : "add key"}
          </button>
        ) : null}
      </div>
      {open ? (
        <form className="skill-key" onSubmit={save}>
          <input
            type="password"
            value={key}
            autoFocus
            autoComplete="off"
            spellCheck="false"
            placeholder="Paste the key"
            aria-label={`${needOf(skill)} for ${skill.name}`}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="btnp" disabled={!key.trim() || busy}>
            {busy ? "Checking…" : "Save"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/* One skill, opened up inside its card: the whole description, its saved
 * key, and -- while asking first is on -- whether it may skip the asking. */
function SkillDetail({ skill, busy, onKey, askFirst, onApproval }) {
  return (
    <div className="skill-detail" data-off={skill.enabled ? undefined : ""}>
      <div className="skill-item-name">
        <span className="h">{skillTitle(skill.name)}</span>
        <code className="skill-id">{skill.name}</code>
        <span className="spacer" />
        {/* Only while asking is on. Off, this control would claim to change
            something that has no effect, which is worse than not being there. */}
        {askFirst ? (
          <button
            type="button"
            className="skill-always"
            aria-pressed={skill.auto_approve}
            title={
              skill.auto_approve
                ? `Ask again before running ${skill.name}`
                : `Stop asking before running ${skill.name}`
            }
            onClick={() => onApproval({ auto_approve: { [skill.name]: !skill.auto_approve } })}
          >
            {skill.auto_approve ? "Always allowed" : "Ask first"}
          </button>
        ) : null}
      </div>
      <p className="skill-detail-body">{skill.description}</p>
      {skill.configurable && skill.available ? (
        <div className="skill-needs">
          <span className="mi">Key saved</span>
          <button type="button" className="mi" disabled={busy} onClick={() => onKey(skill.name, "")}>
            remove
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* A card per group of skills -- a shelf of built-ins, or everything one
 * connector brought -- with one toggle for the lot.
 *
 * The toggle reads "on" while anything in the group is on; flipping it turns
 * every usable skill in the group off, or on. Single skills are still one
 * press away: each is a chip that turns just itself on or off, so the card
 * can be coarse without the page losing any control it had. Details opens the
 * full descriptions and the per-skill approval policy. */
function SkillGroupCard({ mark, title, blurb, skills, needle, busyOf, onSetEnabled, onKey, askFirst, onApproval }) {
  const [open, setOpen] = useState(false);
  const usable = skills.filter((skill) => !blockedSkill(skill));
  const onCount = skills.filter((skill) => skill.enabled).length;
  const anyOn = usable.some((skill) => skill.enabled);
  const busy = skills.some((skill) => busyOf(skill.name));
  const needs = [...new Map(skills.filter(blockedSkill).map((skill) => [needOf(skill), skill])).values()];
  const matches = (skill) =>
    !needle ||
    skill.name.toLowerCase().includes(needle) ||
    (skill.description || "").toLowerCase().includes(needle);

  const state = !usable.length
    ? { label: "Needs setup", tone: "ochre" }
    : onCount === skills.length
      ? { label: "All on", tone: "green" }
      : onCount
        ? { label: `${onCount} of ${skills.length} on`, tone: "quiet" }
        : { label: "Off", tone: "quiet" };

  const flipAll = () => {
    const next = !anyOn;
    for (const skill of usable) if (Boolean(skill.enabled) !== next) onSetEnabled(skill.name, next);
  };

  return (
    <TiltCard className="preset-card skill-group" still={open} data-off={anyOn ? undefined : ""}>
      <div className="preset-top">
        {mark}
        <div className="preset-name">
          <span className="h">{title}</span>
          <span className="preset-setup" data-tone={state.tone}>
            {state.label}
          </span>
        </div>
      </div>
      {blurb ? <p className="preset-body skill-group-blurb">{blurb}</p> : null}

      <div className="skill-chips" role="group" aria-label={`${title} skills`}>
        {skills.map((skill) => (
          <button
            key={skill.name}
            type="button"
            className="skill-chip"
            aria-pressed={Boolean(skill.enabled)}
            data-dim={matches(skill) ? undefined : ""}
            disabled={blockedSkill(skill) || busyOf(skill.name)}
            title={
              blockedSkill(skill)
                ? `Needs ${needOf(skill)}`
                : `${skill.enabled ? "Turn off" : "Turn on"} ${skill.name}`
            }
            onClick={() => onSetEnabled(skill.name, !skill.enabled)}
          >
            <i aria-hidden="true" />
            {skillTitle(skill.name)}
          </button>
        ))}
      </div>

      {needs.length ? (
        <div className="skill-needs-list">
          {needs.map((skill) => (
            <SkillNeed key={needOf(skill)} skill={skill} busy={busyOf(skill.name)} onKey={onKey} />
          ))}
        </div>
      ) : null}

      <div className="preset-foot">
        <button type="button" className="skill-more" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? "Hide details" : "Details"}
          <Icon name="chevron" />
        </button>
        <span className="spacer" />
        <Switch
          on={anyOn}
          label={`${anyOn ? "Turn off" : "Turn on"} ${title}`}
          disabled={!usable.length || busy}
          onToggle={flipAll}
        />
      </div>

      {open ? (
        <div className="skill-details">
          {skills.map((skill) => (
            <SkillDetail
              key={skill.name}
              skill={skill}
              busy={busyOf(skill.name)}
              onKey={onKey}
              askFirst={askFirst}
              onApproval={onApproval}
            />
          ))}
        </div>
      ) : null}
    </TiltCard>
  );
}

/* How the preset gallery is sectioned, in this order. A preset with a category
 * not listed here lands in the last section rather than disappearing. */
const PRESET_SECTIONS = [
  { id: "work", label: "Work tools", icon: "enterprise", note: "Sign in with your company account — no token to create or paste." },
  { id: "code", label: "Code & docs", icon: "code" },
  { id: "google", label: "Google Workspace", icon: "mail" },
  { id: "design", label: "Design", icon: "design" },
  { id: "research", label: "Research & the web", icon: "globe" },
  { id: "local", label: "On this machine", icon: "terminal" },
];

// A sign-in is polled while the other tab is open: often enough to feel
// immediate when the reader comes back, for up to ten minutes.
const SIGNIN_POLL_MS = 2000;
const SIGNIN_POLL_LIMIT = 300;

function PresetCard({ api, preset, server, controls, onInstall, busy }) {
  const isInstalled = Boolean(server);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});

  // A preset declares what it needs in `inputs`; the older shape derived the
  // fields from `env`, which meant a preset whose secret belongs in a header
  // -- or in an argv flag -- had nowhere to put one.
  const inputs = preset.inputs || Object.keys(preset.env || {}).map((key) => ({ key }));
  const unfilled = inputs.filter((i) => i.required && !values[i.key]);
  // A preset that signs in does so unless the reader gave it a key instead.
  const signsIn =
    preset.auth === "oauth" && !inputs.some((i) => i.secret && (values[i.key] || "").trim());

  const handleInstall = async (e) => {
    e.preventDefault();
    if (unfilled.length) return;
    // Opened here, in the click, because a tab opened after an await has lost
    // the gesture that lets it open at all. It is pointed at the sign-in page
    // once the server has made one -- or closed, if none is needed.
    const tab = signsIn ? window.open("", "_blank") : null;
    await onInstall(preset.id, values, tab);
    setOpen(false);
  };

  // What adding it will ask of you, said on the card before you press.
  const needsKey = inputs.some((i) => i.secret && i.required);
  const setup =
    preset.auth === "oauth"
      ? { label: "Sign in", tone: "accent" }
      : needsKey
        ? { label: "API key", tone: "ochre" }
        : inputs.length
          ? { label: "A few settings", tone: "quiet" }
          : { label: "No setup", tone: "green" };

  return (
    /* Bencho's tilt card: it sinks under the pointer. Held still while its
       form is open, so it does not move under the hand that is typing. */
    <TiltCard
      className="preset-card"
      still={open}
      data-open={open ? "" : undefined}
      data-installed={isInstalled ? "" : undefined}
      data-off={isInstalled && !server.enabled ? "" : undefined}
    >
      <div className="preset-top">
        {isInstalled ? (
          <ServiceIcon
            api={api}
            name={server.name}
            serverId={server.id}
            hasIcon={server.has_icon}
            uploaded={server.icon_uploaded}
          />
        ) : (
          <ServiceIcon api={api} name={preset.name} presetId={preset.id} hasIcon={preset.has_icon} />
        )}
        <div className="preset-name">
          <span className="h">{serviceName(preset.name)}</span>
          {isInstalled ? (
            <ConnectorState server={server} />
          ) : (
            <span className="preset-setup" data-tone={setup.tone}>
              {setup.label}
            </span>
          )}
        </div>
      </div>
      <p className="preset-body" title={preset.description}>
        {preset.description}
      </p>
      {/* Added, the card is the connector: its toggle and its controls take
          the place of the Add button. */}
      {isInstalled ? (
        <ConnectorControls server={server} busy={busy} controls={controls} />
      ) : (
      <div className="preset-foot">
        <code className="skill-id">{preset.name}</code>
        <span className="spacer" />
        {(
          <button
            type="button"
            className="preset-add"
            data-open={open ? "" : undefined}
            disabled={busy}
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            <Icon name={open ? "close" : "plus"} />
            {open ? "Cancel" : "Add"}
          </button>
        )}
      </div>
      )}

      {open && !isInstalled ? (
        <form
          onSubmit={handleInstall}
          style={{
            marginTop: "8px",
            padding: "12px",
            background: "var(--rail)",
            borderRadius: "var(--r-surface)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          {preset.notes ? (
            <p
              style={{
                margin: 0,
                fontSize: "var(--t-xs)",
                color: "var(--text-dim)",
                lineHeight: 1.5,
              }}
            >
              {preset.notes}
            </p>
          ) : null}
          {inputs.length === 0 ? (
            <p style={{ margin: 0, fontSize: "var(--t-xs)", color: "var(--text-faint)" }}>
              {preset.auth === "oauth"
                ? "Nothing to configure — a sign-in page opens in a new tab."
                : "Nothing to configure — this server authenticates on its own."}
            </p>
          ) : null}
          {inputs.map((input) => (
            <div key={input.key}>
              <label
                style={{
                  display: "block",
                  fontSize: "var(--t-xs)",
                  color: "var(--text-faint)",
                  marginBottom: "4px",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {input.label || input.key}
                {input.required ? " *" : ""}
              </label>
              <input
                type={input.secret ? "password" : "text"}
                value={values[input.key] || ""}
                autoComplete="off"
                placeholder={input.help || input.key}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  fontSize: "var(--t-sm)",
                  borderRadius: "var(--r-surface)",
                  border: "1px solid var(--line)",
                  background: "var(--surface)",
                }}
                onChange={(e) => setValues({ ...values, [input.key]: e.target.value })}
              />
            </div>
          ))}
          <button
            type="submit"
            className="btnp"
            style={{ alignSelf: "flex-start" }}
            disabled={busy || unfilled.length > 0}
          >
            {busy ? "Connecting…" : signsIn ? "Add & sign in" : "Activate Preset"}
          </button>
        </form>
      ) : null}
    </TiltCard>
  );
}

/* Where an added connector stands, in the chip under its name. */
function ConnectorState({ server }) {
  const state = !server.enabled
    ? { label: "Off", tone: "quiet" }
    : server.auth?.required
      ? { label: "Sign in to finish", tone: "ochre" }
      : server.connected
        ? { label: "Connected", tone: "green" }
        : server.error
          ? { label: "Can't connect", tone: "ochre" }
          : { label: "Connecting…", tone: "quiet" };
  return (
    <span className="preset-setup" data-tone={state.tone}>
      {state.label}
    </span>
  );
}

/* The bottom of an added connector's card: what it registered, why it is not
 * connected if it is not, its few actions as glyphs, and the toggle. */
function ConnectorControls({ server, busy, controls }) {
  const fileInput = useRef(null);
  const tools = server.tools?.length || 0;

  const pickLogo = (event) => {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice still fires a change.
    event.target.value = "";
    if (file) controls.onLogo(server.id, file);
  };

  return (
    <>
      {server.error && server.enabled ? (
        <p className="conn-error" title={server.error}>
          {server.error}
        </p>
      ) : null}
      {server.auth?.required && server.auth?.can_sign_in ? (
        <button
          type="button"
          className="btnp conn-signin"
          disabled={busy}
          title={`Sign in to ${server.name} in a new tab`}
          onClick={() => controls.onSignIn(server)}
        >
          Sign in
        </button>
      ) : null}
      <div className="preset-foot">
        <span className="mi conn-tools">
          {tools} {tools === 1 ? "tool" : "tools"}
          {server.auth?.signed_in ? " · signed in" : ""}
          {server.icon_uploaded ? (
            <>
              {" · "}
              <button
                type="button"
                className="conn-link"
                disabled={busy}
                title="Drop your logo and go back to the service's own"
                onClick={() => controls.onResetLogo(server.id)}
              >
                reset logo
              </button>
            </>
          ) : null}
        </span>
        <span className="spacer" />
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.ico"
          hidden
          onChange={pickLogo}
        />
        <button
          type="button"
          className="conn-icon"
          disabled={busy}
          title="Look for its tools again"
          aria-label={`Sync ${server.name}`}
          onClick={() => controls.onSync(server.id)}
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          className="conn-icon"
          disabled={busy}
          title={server.icon_uploaded ? "Use another logo" : "Use your own logo"}
          aria-label={`Logo for ${server.name}`}
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="image" />
        </button>
        {server.auth?.signed_in ? (
          <button
            type="button"
            className="conn-icon"
            disabled={busy}
            title="Forget this sign-in and disconnect"
            aria-label={`Sign out of ${server.name}`}
            onClick={() => controls.onSignOut(server)}
          >
            <Icon name="external" />
          </button>
        ) : null}
        <button
          type="button"
          className="conn-icon"
          data-tone="danger"
          disabled={busy}
          title="Remove this connector"
          aria-label={`Remove ${server.name}`}
          onClick={() => controls.onDelete(server.id, server.name)}
        >
          <Icon name="trash" />
        </button>
        <Switch
          on={server.enabled}
          label={`${server.enabled ? "Turn off" : "Turn on"} ${server.name}`}
          disabled={busy}
          onToggle={() => controls.onToggle(server.id, !server.enabled)}
        />
      </div>
    </>
  );
}

/* A connector added by hand or imported, which has no preset card to live on. */
function CustomConnectorCard({ api, server, busy, controls }) {
  return (
    <TiltCard className="preset-card" data-installed="" data-off={server.enabled ? undefined : ""}>
      <div className="preset-top">
        <ServiceIcon
          api={api}
          name={server.name}
          serverId={server.id}
          hasIcon={server.has_icon}
          uploaded={server.icon_uploaded}
        />
        <div className="preset-name">
          <span className="h">{serviceName(server.name)}</span>
          <ConnectorState server={server} />
        </div>
      </div>
      <p className="preset-body" title={server.description || undefined}>
        {server.description || (server.transport === "stdio" ? server.command : server.url)}
      </p>
      <ConnectorControls server={server} busy={busy} controls={controls} />
    </TiltCard>
  );
}

export function Skills({ api }) {
  const { confirm, notify } = useDialog();
  const { skills, loading, error, refresh, setEnabled, setKey, pending, askFirst, setApproval } =
    useSkills(api);
  const [tab, setTab] = useState("skills"); // "skills" | "mcp"
  const [query, setQuery] = useState("");

  // The tabs' dark pill is one element that slides to whichever tab is on,
  // rather than each tab painting its own -- measured, because the labels
  // carry counts and so change width.
  const tabsRef = useRef(null);
  const [pill, setPill] = useState(null);

  // MCP State
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpPresets, setMcpPresets] = useState([]);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customServer, setCustomServer] = useState({
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    description: "",
    homepage: "",
  });

  // A sign-in in flight: which server, how it is going, and the page to open
  // by hand if the browser blocked the tab.
  const [signIn, setSignIn] = useState(null);
  const signInPoll = useRef(null);
  useEffect(() => () => clearInterval(signInPoll.current), []);

  const loadMcpData = useCallback(async () => {
    try {
      const [serversRes, presetsRes] = await Promise.all([
        api.listMcpServers(),
        api.listMcpPresets(),
      ]);
      setMcpServers(serversRes.servers || []);
      setMcpPresets(presetsRes.presets || []);
    } catch (err) {
      console.error("Failed loading MCP servers/presets", err);
    }
  }, [api]);

  useEffect(() => {
    loadMcpData();
  }, [loadMcpData]);

  /* A file, as the base64 the icon endpoint takes. readAsDataURL rather than
   * readAsArrayBuffer: the prefix is trivial to strip and the alternative is
   * hand-rolling base64 over a byte array. */
  const readAsBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("could not read that file"));
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.readAsDataURL(file);
    });

  const handleUploadLogo = async (serverId, file) => {
    setMcpBusy(true);
    try {
      await api.uploadMcpIcon(serverId, await readAsBase64(file), file.type || null);
      await loadMcpData();
    } catch (err) {
      await notify(`Could not use that image: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleResetLogo = async (serverId) => {
    setMcpBusy(true);
    try {
      // Clear any upload first, then go back to the service's own site. Both
      // are quiet about finding nothing -- plenty of sites offer no icon.
      await api.clearMcpIcon(serverId);
      await api.refreshMcpIcon(serverId).catch(() => {});
      await loadMcpData();
    } catch (err) {
      await notify(`Could not reset that logo: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleImportConfig = async (event) => {
    event.preventDefault();
    let parsed;
    try {
      parsed = JSON.parse(importText);
    } catch (err) {
      await notify(`That is not valid JSON: ${err.message}`);
      return;
    }
    setMcpBusy(true);
    try {
      const result = await api.importMcpServers(parsed, true);
      await loadMcpData();
      setImportText("");
      setImportOpen(false);
      const added = result.added.map((s) => s.name);
      const skipped = result.skipped.map((s) => `${s.name} (${s.reason})`);
      await notify(
        [
          added.length ? `Added: ${added.join(", ")}` : "Nothing added.",
          skipped.length ? `Skipped: ${skipped.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (err) {
      await notify(`Import failed: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  /* Sign in to a hosted server in `tab` (opened by the click that asked, so
   * the browser lets it open), then watch for the server to say how it went.
   * The sign-in page comes back to this server, which keeps the tokens and
   * connects; all the page here does is poll and redraw. */
  const runSignIn = async (server, tab) => {
    clearInterval(signInPoll.current);
    setSignIn({ serverId: server.id, name: server.name, status: "starting", error: "" });
    let started;
    try {
      started = await api.startMcpSignIn(server.id, serverOrigin() || window.location.origin);
    } catch (err) {
      tab?.close();
      setSignIn({ serverId: server.id, name: server.name, status: "failed", error: err.message || String(err) });
      return;
    }
    if (tab) tab.location = started.url;
    setSignIn({ serverId: server.id, name: server.name, status: "pending", error: "", url: started.url });

    let ticks = 0;
    signInPoll.current = setInterval(async () => {
      ticks += 1;
      if (ticks > SIGNIN_POLL_LIMIT) {
        clearInterval(signInPoll.current);
        setSignIn((was) =>
          was?.status === "pending" ? { ...was, status: "failed", error: "the sign-in timed out" } : was,
        );
        return;
      }
      let report;
      try {
        report = await api.mcpSignInStatus(started.state);
      } catch {
        return; // a blip in the poll is not a failed sign-in
      }
      if (report.status === "pending") return;
      clearInterval(signInPoll.current);
      // The list first, so the row and the banner change together.
      if (report.status === "connected") {
        await loadMcpData();
        await refresh();
      }
      setSignIn({ serverId: server.id, name: server.name, status: report.status, error: report.error || "" });
    }, SIGNIN_POLL_MS);
  };

  const handleSignIn = (server) => {
    const tab = window.open("", "_blank");
    runSignIn(server, tab);
  };

  const handleSignOut = async (server) => {
    setMcpBusy(true);
    try {
      await api.mcpSignOut(server.id);
      await loadMcpData();
      await refresh();
    } catch (err) {
      await notify(`Could not sign out: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleInstallPreset = async (presetId, values, tab = null) => {
    setMcpBusy(true);
    let added = null;
    try {
      added = await api.instantiateMcpPreset({ preset: presetId, values });
      await loadMcpData();
      await refresh();
    } catch (err) {
      tab?.close();
      await notify(`Could not add that connector: ${err.message || err}`);
      return;
    } finally {
      setMcpBusy(false);
    }
    // Added; now signed in, if it wants a person rather than a key.
    if (added?.auth?.required && added.auth.can_sign_in) runSignIn(added, tab);
    else tab?.close();
  };

  const handleToggleMcpServer = async (serverId, enabled) => {
    setMcpBusy(true);
    try {
      await api.updateMcpServer(serverId, { enabled });
      await loadMcpData();
      await refresh();
    } catch (err) {
      await notify(`Could not switch that connector: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleDeleteMcpServer = async (serverId, serverName) => {
    const yes = await confirm(`Remove the ${serviceName(serverName)} connector?`, {
      title: "Remove connector",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!yes) return;
    setMcpBusy(true);
    try {
      await api.deleteMcpServer(serverId);
      await loadMcpData();
      await refresh();
    } catch (err) {
      await notify(`Could not remove that connector: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleSyncMcpServer = async (serverId) => {
    setMcpBusy(true);
    try {
      await api.syncMcpServer(serverId);
      await loadMcpData();
      await refresh();
    } catch (err) {
      await notify(`Sync error: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleAddCustomServer = async (e) => {
    e.preventDefault();
    if (!customServer.name.trim()) return;
    setMcpBusy(true);
    try {
      const argsList = customServer.args
        .split(" ")
        .map((a) => a.trim())
        .filter(Boolean);
      await api.createMcpServer({
        name: customServer.name.trim(),
        transport: customServer.transport,
        command: customServer.command.trim() || undefined,
        args: argsList,
        url: customServer.url.trim() || undefined,
        description: customServer.description.trim() || undefined,
        // Only needed for stdio: an HTTP server's logo is looked up from its
        // own endpoint host, so leaving this blank still finds one.
        homepage: customServer.homepage.trim() || undefined,
        enabled: true,
      });
      setCustomOpen(false);
      setCustomServer({
        name: "",
        transport: "stdio",
        command: "",
        args: "",
        url: "",
        description: "",
        homepage: "",
      });
      await loadMcpData();
      await refresh();
    } catch (err) {
      await notify(`Could not add that connector: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const matchesSkill = (skill) =>
    skill.name.toLowerCase().includes(needle) ||
    (skill.description || "").toLowerCase().includes(needle);

  // One card per shelf of built-in skills (lib/skillShelf), then one per
  // connector for the tools it registered.
  const skillCards = useMemo(() => {
    const shelves = new Map(SHELVES.map((def) => [def.key, { ...def, skills: [] }]));
    const byServer = new Map();
    for (const skill of skills) {
      if (skill.server) {
        if (!byServer.has(skill.server)) byServer.set(skill.server, []);
        byServer.get(skill.server).push(skill);
      } else {
        shelves.get(shelfOf(skill.name)).skills.push(skill);
      }
    }
    return [
      ...[...shelves.values()]
        .filter((entry) => entry.skills.length)
        .map((entry) => ({
          key: entry.key,
          title: entry.label,
          blurb: entry.blurb,
          mark: (
            <span className="mcp-avatar card-glyph" aria-hidden="true">
              <Icon name={entry.icon} />
            </span>
          ),
          skills: entry.skills,
        })),
      ...[...byServer.entries()]
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([server, list]) => ({
          key: `server:${server}`,
          title: serviceName(server),
          blurb: `What the ${serviceName(server)} connector brought.`,
          mark: <ServiceIcon name={server} />,
          skills: list,
        })),
    ];
  }, [skills]);
  // A search keeps the cards with a match in them, and dims the rest of
  // each card's chips (SkillGroupCard).
  const shownCards = needle
    ? skillCards.filter((card) => card.title.toLowerCase().includes(needle) || card.skills.some(matchesSkill))
    : skillCards;

  // Added connectors live on their preset's card; anything added by hand or
  // imported gets a card of its own.
  const presetNames = new Set(mcpPresets.map((preset) => preset.name));
  const serverByName = new Map(mcpServers.map((server) => [server.name, server]));
  const customServers = mcpServers.filter((server) => !presetNames.has(server.name));
  const connectorControls = {
    onToggle: handleToggleMcpServer,
    onDelete: handleDeleteMcpServer,
    onSync: handleSyncMcpServer,
    onLogo: handleUploadLogo,
    onResetLogo: handleResetLogo,
    onSignIn: handleSignIn,
    onSignOut: handleSignOut,
  };

  useLayoutEffect(() => {
    const active = tabsRef.current?.querySelector("button[data-active]");
    if (active) setPill((was) => ({ x: active.offsetLeft, w: active.offsetWidth, ready: Boolean(was) }));
  }, [tab, skills.length, mcpServers.length]);

  const on = skills.filter((s) => s.enabled).length;

  return (
    <div className="page">
      <div className="page-head" data-tint="green">
        <div
          className="sw"
          style={{
            left: "-90px",
            top: "-110px",
            width: "280px",
            height: "280px",
            background: "#d5e8db",
          }}
        />
        <div
          className="sw"
          style={{
            left: "120px",
            top: "-70px",
            width: "130px",
            height: "130px",
            background: "#f6efd4",
          }}
        />
        <div className="inner">
          <div>
            <h1 className="h">Skills & Connectors</h1>
            <p>
              What I can do, and the services I can reach. Turn a card off and I
              stop being offered what is on it.
            </p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                refresh();
                loadMcpData();
              }}
              disabled={loading || mcpBusy}
            >
              {loading ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>
      </div>

      <div className="page-body" style={{ flexDirection: "column" }}>
        <div className="page-col" style={{ alignSelf: "stretch" }}>
          {/* The two halves of the page, as the app's segmented control --
              the same one the Projects page switches kinds with. */}
          <div ref={tabsRef} className="segmented skills-tabs" role="tablist" aria-label="Skills and connectors">
            {pill ? (
              <span
                className="skills-tabs-pill"
                aria-hidden="true"
                data-ready={pill.ready ? "" : undefined}
                style={{ width: pill.w, transform: `translateX(${pill.x}px)` }}
              />
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={tab === "skills"}
              data-active={tab === "skills" ? "" : undefined}
              onClick={() => setTab("skills")}
            >
              <Icon name="skills" />
              Skills
              <span className="count">{skills.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "mcp"}
              data-active={tab === "mcp" ? "" : undefined}
              onClick={() => setTab("mcp")}
            >
              <Icon name="apps" />
              Connectors
              <span className="count">{mcpServers.length}</span>
            </button>
          </div>

          {tab === "skills" ? (
            <>
              <div className="lane">
                <span className="mi" data-strong>
                  {loading ? "Checking" : `${on} on · ${skills.length} registered`}
                </span>
                <i />
                {/* The filter waits at the end of the lane as its own lens
                    and opens into the field when pressed -- Bencho's search.
                    A filter that is narrowing the list stays open. */}
                {skills.length > 3 ? (
                  <SeekField
                    value={query}
                    onChange={setQuery}
                    placeholder="Filter skills by name or keyword"
                    label="Filter skills"
                    width={300}
                  />
                ) : null}
              </div>

              {error ? (
                <div className="callout" data-tint="ochre">
                  <div style={{ flex: 1 }}>
                    <span className="h" style={{ fontSize: "var(--t-lg)" }}>
                      {error.answered ? "That did not work" : "Could not reach the server"}
                    </span>
                    <p style={{ margin: "7px 0 0", color: "var(--text-dim)", fontSize: "var(--t-sm)", lineHeight: 1.7 }}>
                      {error.message}
                    </p>
                  </div>
                  <button type="button" className="btn" onClick={refresh}>
                    Try again
                  </button>
                </div>
              ) : null}

              {/* The switch the whole feature hangs off. Above the list
                  rather than in Settings, because what it changes is how every
                  row below behaves. */}
              <div className="approval-setting">
                <div className="approval-setting-text">
                  <p className="approval-setting-title">Ask before running a skill</p>
                  <p className="approval-setting-note">
                    The answer stops and shows you which skill wants to run, and
                    with what, until you allow it. Off, an enabled skill runs
                    whenever the model asks for it.
                  </p>
                </div>
                <Switch
                  on={askFirst}
                  label={askFirst ? "Stop asking before skills run" : "Ask before skills run"}
                  onToggle={() => setApproval({ ask_first: !askFirst })}
                />
              </div>

              {skills.length === 0 && !loading ? (
                <p className="p" style={{ color: "var(--text-dim)" }}>
                  No skills registered. Go to the <strong>Connectors</strong> tab to connect GitHub,
                  Figma, Google Workspace, or a server of your own.
                </p>
              ) : (
                <>
                  <div className="preset-grid skill-cards">
                    {shownCards.map((card) => (
                      <SkillGroupCard
                        key={card.key}
                        mark={card.mark}
                        title={card.title}
                        blurb={card.blurb}
                        skills={card.skills}
                        needle={needle}
                        busyOf={(name) => pending.includes(name)}
                        onSetEnabled={setEnabled}
                        onKey={setKey}
                        askFirst={askFirst}
                        onApproval={setApproval}
                      />
                    ))}
                  </div>
                  {needle && !shownCards.length ? (
                    <p className="skill-none">Nothing matches “{query.trim()}”.</p>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              {signIn ? (
                <div className="mcp-signin" role="status" data-status={signIn.status}>
                  <span>
                    {signIn.status === "connected"
                      ? `${signIn.name} is connected.`
                      : signIn.status === "failed"
                        ? `Signing in to ${signIn.name} didn't work: ${signIn.error}`
                        : `Waiting for you to sign in to ${signIn.name} in the other tab…`}
                  </span>
                  {signIn.status === "pending" && signIn.url ? (
                    <a href={signIn.url} target="_blank" rel="noreferrer">
                      Open the sign-in page
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      clearInterval(signInPoll.current);
                      setSignIn(null);
                    }}
                  >
                    {signIn.status === "pending" ? "Cancel" : "Dismiss"}
                  </button>
                </div>
              ) : null}

              {/* Your own connectors: anything added by hand or imported, as
                  cards. Ones added from the gallery stay on their own card
                  below, which gains a toggle once added. */}
              <div>
                <div className="lane preset-lane" style={{ marginBottom: "12px" }}>
                  <span className="shelf-glyph" aria-hidden="true">
                    <Icon name="plus" />
                  </span>
                  <span className="mi" data-strong>
                    Your own connectors
                  </span>
                  <span className="mi preset-lane-count">{customServers.length}</span>
                  <i />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setImportOpen(false);
                        setCustomOpen((was) => !was);
                      }}
                    >
                      {customOpen ? "Close" : "+ Add a connector"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      title="Paste an mcpServers config from any install page"
                      onClick={() => {
                        setCustomOpen(false);
                        setImportOpen((was) => !was);
                      }}
                    >
                      {importOpen ? "Close" : "Import a config"}
                    </button>
                  </div>
                </div>

                {importOpen ? (
                  <form
                    onSubmit={handleImportConfig}
                    style={{
                      marginBottom: "16px",
                      padding: "16px",
                      background: "var(--rail)",
                      borderRadius: "var(--r-surface)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "12px",
                    }}
                  >
                    <span className="h" style={{ fontSize: "var(--t-md)" }}>
                      Import connectors
                    </span>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "var(--t-sm)",
                        color: "var(--text-dim)",
                        lineHeight: 1.5,
                      }}
                    >
                      Paste the <code>mcpServers</code> block from any connector&apos;s install page.
                      Both the whole config file and the bare mapping work. Connectors
                      whose names are already taken are reported and skipped, not
                      overwritten.
                    </p>
                    <textarea
                      value={importText}
                      required
                      rows={9}
                      spellCheck={false}
                      placeholder={'{\n  "mcpServers": {\n    "sqlite": {\n      "command": "uvx",\n      "args": ["mcp-server-sqlite", "--db-path", "/data/app.db"]\n    }\n  }\n}'}
                      style={{
                        padding: "10px",
                        borderRadius: "var(--r-surface)",
                        border: "1px solid var(--line)",
                        background: "var(--surface)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--t-sm)",
                        resize: "vertical",
                      }}
                      onChange={(e) => setImportText(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="btnp"
                      style={{ alignSelf: "flex-start" }}
                      disabled={mcpBusy}
                    >
                      {mcpBusy ? "Importing…" : "Import & Connect"}
                    </button>
                  </form>
                ) : null}

                {customOpen ? (
                  <form
                    onSubmit={handleAddCustomServer}
                    style={{
                      padding: "16px",
                      background: "var(--surface)",
                      border: "1px solid var(--line-soft)",
                      borderRadius: "var(--r-surface)",
                      marginBottom: "16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "12px",
                    }}
                  >
                    <span className="h" style={{ fontSize: "var(--t-md)" }}>
                      Add a connector
                    </span>
                    <div style={{ display: "flex", gap: "12px" }}>
                      <input
                        type="text"
                        placeholder="Name (e.g. postgres, filesystem)"
                        value={customServer.name}
                        required
                        style={{
                          flex: 1,
                          padding: "6px 10px",
                          borderRadius: "var(--r-surface)",
                          border: "1px solid var(--line)",
                        }}
                        onChange={(e) => setCustomServer({ ...customServer, name: e.target.value })}
                      />
                      <select
                        value={customServer.transport}
                        style={{
                          padding: "6px 10px",
                          borderRadius: "var(--r-surface)",
                          border: "1px solid var(--line)",
                        }}
                        onChange={(e) => setCustomServer({ ...customServer, transport: e.target.value })}
                      >
                        <option value="stdio">stdio (subprocess)</option>
                        <option value="sse">sse (HTTP/SSE)</option>
                      </select>
                    </div>

                    {customServer.transport === "stdio" ? (
                      <>
                        <input
                          type="text"
                          placeholder="Command (e.g. npx, uvx, python)"
                          value={customServer.command}
                          required
                          style={{
                            padding: "6px 10px",
                            borderRadius: "var(--r-surface)",
                            border: "1px solid var(--line)",
                          }}
                          onChange={(e) => setCustomServer({ ...customServer, command: e.target.value })}
                        />
                        <input
                          type="text"
                          placeholder="Arguments (space-separated, e.g. -y @mcp/server-sqlite /data/db.sqlite)"
                          value={customServer.args}
                          style={{
                            padding: "6px 10px",
                            borderRadius: "var(--r-surface)",
                            border: "1px solid var(--line)",
                          }}
                          onChange={(e) => setCustomServer({ ...customServer, args: e.target.value })}
                        />
                      </>
                    ) : (
                      <input
                        type="url"
                        placeholder="Endpoint URL (e.g. https://api.example.com/sse)"
                        value={customServer.url}
                        required
                        style={{
                          padding: "6px 10px",
                          borderRadius: "var(--r-surface)",
                          border: "1px solid var(--line)",
                        }}
                        onChange={(e) => setCustomServer({ ...customServer, url: e.target.value })}
                      />
                    )}

                    <input
                      type="text"
                      placeholder="Description (optional)"
                      value={customServer.description}
                      style={{
                        padding: "6px 10px",
                        borderRadius: "var(--r-surface)",
                        border: "1px solid var(--line)",
                      }}
                      onChange={(e) => setCustomServer({ ...customServer, description: e.target.value })}
                    />

                    <input
                      type="text"
                      placeholder={
                        customServer.transport === "stdio"
                          ? "Website for the logo (optional, e.g. sentry.io)"
                          : "Website for the logo (optional — taken from the URL if blank)"
                      }
                      value={customServer.homepage}
                      style={{
                        padding: "6px 10px",
                        borderRadius: "var(--r-surface)",
                        border: "1px solid var(--line)",
                      }}
                      onChange={(e) => setCustomServer({ ...customServer, homepage: e.target.value })}
                    />

                    <button type="submit" className="btnp" style={{ alignSelf: "flex-start" }} disabled={mcpBusy}>
                      {mcpBusy ? "Connecting…" : "Save & connect"}
                    </button>
                  </form>
                ) : null}

                {customServers.length ? (
                  <div className="preset-grid">
                    {customServers.map((server) => (
                      <CustomConnectorCard
                        key={server.id}
                        api={api}
                        server={server}
                        busy={mcpBusy}
                        controls={connectorControls}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="settings-note" style={{ margin: 0 }}>
                    Run a server of your own, or paste the config from any install page, and it
                    shows up here as a card.
                  </p>
                )}
              </div>

              {/* Presets, by section */}
              {PRESET_SECTIONS.map((section, index) => {
                const known = PRESET_SECTIONS.map((s) => s.id);
                const inSection = mcpPresets.filter((preset) =>
                  index === PRESET_SECTIONS.length - 1
                    ? preset.category === section.id || !known.includes(preset.category)
                    : preset.category === section.id,
                );
                if (!inSection.length) return null;
                return (
                  <div key={section.id}>
                    <div className="lane preset-lane" style={{ marginBottom: section.note ? "6px" : "12px" }}>
                      <span className="shelf-glyph" aria-hidden="true">
                        <Icon name={section.icon} />
                      </span>
                      <span className="mi" data-strong>
                        {section.label}
                      </span>
                      <span className="mi preset-lane-count">{inSection.length}</span>
                      <i />
                    </div>
                    {section.note ? (
                      <p className="settings-note" style={{ margin: "0 0 12px" }}>
                        {section.note}
                      </p>
                    ) : null}
                    <div className="preset-grid">
                      {inSection.map((preset) => (
                        <PresetCard
                          key={preset.id}
                          api={api}
                          preset={preset}
                          server={serverByName.get(preset.name) || null}
                          controls={connectorControls}
                          onInstall={handleInstallPreset}
                          busy={mcpBusy}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
