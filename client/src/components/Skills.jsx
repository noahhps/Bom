import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useSkills } from "../hooks/useSkills";
import { iconForServer } from "../lib/mcpIcons";
import { serverOrigin } from "../lib/serverOrigin";
import { SHELVES, serviceName, shelfOf, skillTitle } from "../lib/skillShelf";
import { useDialog } from "./Dialog";
import { Icon } from "./Icon";
import { ServiceIcon } from "./ServiceIcon";
import { SeekField } from "./bencho/SeekField";
import { Dock } from "./bencho/Dock";
import { Switch } from "./bencho/Switch";
import { TiltCard } from "./bencho/TiltCard";

function SkillRow({ skill, busy, onToggle, onKey, askFirst, onApproval }) {
  const [key, setKey] = useState("");
  const [open, setOpen] = useState(false);
  const blocked = skill.requires && !skill.available;

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (await onKey(skill.name, key.trim())) {
      setKey("");
      setOpen(false);
    }
  };

  return (
    <div className="skill-item" data-off={skill.enabled ? undefined : ""}>
      <div className="skill-item-text">
        <div className="skill-item-name">
          <span className="h">{skillTitle(skill.name)}</span>
          {/* The name the model calls it by, which is what a transcript
              shows when it runs. */}
          <code className="skill-id">{skill.name}</code>
          {/* Which server, not merely that there is one. Every MCP tool used
              to wear the same "MCP" badge, so a list of thirty of them said
              thirty times over the one thing they had in common. */}
          {skill.server ? (
            <span className="mcp-tag" title={`From the ${skill.server} MCP server`}>
              <Icon name={iconForServer(skill.server)} />
              {skill.server}
            </span>
          ) : skill.requires?.includes("MCP") ? (
            <span className="mcp-tag">
              <Icon name="device_hub" />
              MCP
            </span>
          ) : null}
        </div>
        <p className="skill-body" title={skill.description}>
          {skill.description}
        </p>

        {blocked ? (
          <div className="skill-needs">
            <span className="mi">Needs {skill.requires}</span>
            {skill.configurable ? (
              <button type="button" className="mi" onClick={() => setOpen((was) => !was)}>
                {open ? "cancel" : "add key"}
              </button>
            ) : null}
          </div>
        ) : null}

        {skill.configurable && skill.available ? (
          <div className="skill-needs">
            <span className="mi">Key saved</span>
            <button
              type="button"
              className="mi"
              disabled={busy}
              onClick={() => onKey(skill.name, "")}
            >
              remove
            </button>
          </div>
        ) : null}

        {open && blocked && skill.configurable ? (
          <form className="skill-key" onSubmit={save}>
            <input
              type="password"
              value={key}
              autoFocus
              autoComplete="off"
              spellCheck="false"
              placeholder="Paste the key"
              aria-label={`${skill.requires} for ${skill.name}`}
              onChange={(event) => setKey(event.target.value)}
            />
            <button type="submit" className="btnp" disabled={!key.trim() || busy}>
              {busy ? "Checking…" : "Save"}
            </button>
          </form>
        ) : null}
      </div>
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
      <Switch
        on={skill.enabled}
        label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
        disabled={busy || blocked}
        title={blocked ? `Needs ${skill.requires} first` : undefined}
        onToggle={() => onToggle(skill.name, !skill.enabled)}
      />
    </div>
  );
}

/* One MCP server's skills, folded under its name.
 *
 * An MCP server can register a dozen tools, and a handful of servers turns the
 * flat list into a wall of rows that all say the same "From X" tag. Grouping
 * them under the server -- a header with the server's glyph, how many of its
 * skills are on, and a chevron -- puts one line per server on screen and hides
 * the individual tools behind a disclosure until they are wanted.
 *
 * Forced open while a filter is active, so a search still reaches a tool inside
 * a collapsed server rather than appearing to find nothing. */
function McpSkillGroup({ server, skills, forceOpen, busyOf, onToggle, onKey, askFirst, onApproval }) {
  const [open, setOpen] = useState(false);
  const expanded = forceOpen || open;
  const on = skills.filter((s) => s.enabled).length;

  return (
    <div className="mcp-group" data-open={expanded ? "" : undefined}>
      <button
        type="button"
        className="mcp-group-head"
        aria-expanded={expanded}
        onClick={() => setOpen((was) => !was)}
      >
        <ServiceIcon name={server} />
        <span className="mcp-group-name h">{serviceName(server)}</span>
        <span className="mi mcp-group-count">
          {on} of {skills.length} on
        </span>
        <span className="spacer" />
        <span className="mcp-group-chevron" aria-hidden="true">
          <Icon name="chevron" />
        </span>
      </button>

      {expanded ? (
        <div className="mcp-group-body">
          {skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              busy={busyOf(skill.name)}
              onToggle={onToggle}
              onKey={onKey}
              askFirst={askFirst}
              onApproval={onApproval}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* A shelf's heading: its glyph, its name, and how much of it is on -- said in
 * words and drawn as a row of beads, one per skill, filled when it is on. The
 * beads are the page's at-a-glance read: a shelf with a gap in it shows one
 * from across the room, before any row is read. */
function ShelfHead({ icon, label, skills }) {
  const on = skills.filter((s) => s.enabled).length;
  return (
    <header className="shelf-head">
      <span className="shelf-glyph" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="h shelf-name">{label}</span>
      <span className="shelf-beads" aria-hidden="true">
        {skills.map((skill) => (
          <i key={skill.name} data-on={skill.enabled ? "" : undefined} title={skill.name} />
        ))}
      </span>
      <span className="mi shelf-count">
        {on === skills.length ? `all ${on} on` : `${on} of ${skills.length} on`}
      </span>
    </header>
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

function PresetCard({ api, preset, isInstalled, onInstall, busy }) {
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
    <TiltCard className="preset-card" still={open} data-open={open ? "" : undefined} data-installed={isInstalled ? "" : undefined}>
      <div className="preset-top">
        <ServiceIcon api={api} name={preset.name} presetId={preset.id} hasIcon={preset.has_icon} />
        <div className="preset-name">
          <span className="h">{serviceName(preset.name)}</span>
          <span className="preset-setup" data-tone={setup.tone}>
            {setup.label}
          </span>
        </div>
      </div>
      <p className="preset-body" title={preset.description}>
        {preset.description}
      </p>
      <div className="preset-foot">
        <code className="skill-id">{preset.name}</code>
        <span className="spacer" />
        {isInstalled ? (
          <span className="preset-active">
            <Icon name="check" />
            Added
          </span>
        ) : (
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

function McpServerRow({
  api,
  server,
  onToggle,
  onDelete,
  onSync,
  onLogo,
  onResetLogo,
  onSignIn,
  onSignOut,
  busy,
}) {
  const fileInput = useRef(null);

  const pickLogo = (event) => {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice still fires a change.
    event.target.value = "";
    if (file) onLogo(server.id, file);
  };

  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--surface)",
        border: "1px solid var(--line-soft)",
        borderRadius: "var(--r-surface)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}
    >
      <ServiceIcon
        api={api}
        name={server.name}
        serverId={server.id}
        hasIcon={server.has_icon}
        uploaded={server.icon_uploaded}
        off={!server.connected}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: server.connected ? "var(--green)" : "var(--text-faint)",
              display: "inline-block",
            }}
            title={server.connected ? "Connected" : "Disconnected"}
          />
          <span className="h" style={{ fontSize: "var(--t-md)" }}>
            {server.name}
          </span>
          {server.auth?.signed_in ? <span className="mcp-chip" data-on>Signed in</span> : null}
          <span
            style={{
              fontSize: "var(--t-micro)",
              fontFamily: "var(--font-mono)",
              color: "var(--text-faint)",
              background: "var(--rail)",
              padding: "2px 6px",
              borderRadius: "var(--r-pill)",
            }}
          >
            {server.transport}
          </span>
        </div>
        <p style={{ margin: "4px 0 0", color: "var(--text-dim)", fontSize: "var(--t-sm)" }}>
          {server.description ||
            (server.transport === "stdio" ? server.command : server.url)}
        </p>
        <div style={{ marginTop: "6px", display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)" }}>
            {server.tools?.length || 0} tool(s) registered
          </span>
          {server.error ? (
            <span style={{ fontSize: "var(--t-xs)", color: "var(--ochre)" }}>
              {server.error}
            </span>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {server.auth?.required && server.auth?.can_sign_in ? (
          <button
            type="button"
            className="btnp"
            disabled={busy}
            title={`Sign in to ${server.name} in a new tab`}
            onClick={() => onSignIn(server)}
          >
            Sign in
          </button>
        ) : null}
        {server.auth?.signed_in ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Forget this sign-in and disconnect"
            onClick={() => onSignOut(server)}
          >
            Sign out
          </button>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.ico"
          style={{ display: "none" }}
          onChange={pickLogo}
        />
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="Use your own logo for this server"
          onClick={() => fileInput.current?.click()}
        >
          Logo
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="Drop any custom logo and look the service's own up again"
          onClick={() => onResetLogo(server.id)}
        >
          ↻
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="Force tool re-discovery"
          onClick={() => onSync(server.id)}
        >
          Sync
        </button>
        <Switch
          on={server.enabled}
          label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          disabled={busy}
          onToggle={() => onToggle(server.id, !server.enabled)}
        />
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-faint)",
            cursor: "pointer",
            fontSize: "var(--t-lg)",
            padding: "4px 8px",
          }}
          title="Remove server"
          disabled={busy}
          onClick={() => onDelete(server.id, server.name)}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function Skills({ api }) {
  const { confirm, notify } = useDialog();
  const { skills, loading, error, refresh, setEnabled, setKey, pending, askFirst, setApproval } =
    useSkills(api);
  const [tab, setTab] = useState("skills"); // "skills" | "mcp"
  const [query, setQuery] = useState("");
  const [shelf, setShelf] = useState("all"); // a SHELVES key, "servers" or "all"

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
      await notify(`Failed activating preset: ${err.message || err}`);
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
      await notify(`Failed toggling server: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const handleDeleteMcpServer = async (serverId, serverName) => {
    const yes = await confirm(`Delete MCP server "${serverName}"?`, {
      title: "Delete server",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!yes) return;
    setMcpBusy(true);
    try {
      await api.deleteMcpServer(serverId);
      await loadMcpData();
      await refresh();
    } catch (err) {
      await notify(`Failed deleting server: ${err.message || err}`);
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
      await notify(`Failed adding server: ${err.message || err}`);
    } finally {
      setMcpBusy(false);
    }
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        (s.description || "").toLowerCase().includes(needle),
    );
  }, [skills, query]);

  // Built-in skills stay as their own rows; anything an MCP server registered
  // is folded under that server. Grouped from `shown`, so a filter narrows both
  // the loose rows and what is inside each server.
  const { builtin, groups } = useMemo(() => {
    const builtin = [];
    const byServer = new Map();
    for (const skill of shown) {
      if (skill.server) {
        if (!byServer.has(skill.server)) byServer.set(skill.server, []);
        byServer.get(skill.server).push(skill);
      } else {
        builtin.push(skill);
      }
    }
    const groups = [...byServer.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([server, list]) => ({ server, list }));
    return { builtin, groups };
  }, [shown]);

  // The built-in skills, shelved (lib/skillShelf). Every shelf is kept, even
  // one the filter has emptied, so the dock below does not reshuffle as you
  // type; an empty shelf is simply not drawn.
  const shelves = useMemo(() => {
    const all = new Map(SHELVES.map((def) => [def.key, { ...def, total: 0, list: [] }]));
    for (const skill of skills) if (!skill.server) all.get(shelfOf(skill.name)).total += 1;
    for (const skill of builtin) all.get(shelfOf(skill.name)).list.push(skill);
    return [...all.values()].filter((entry) => entry.total > 0);
  }, [skills, builtin]);
  const serverSkills = skills.filter((s) => s.server).length;

  const dockItems = [
    { key: "all", label: "Everything", icon: "apps", count: skills.length },
    ...shelves.map((entry) => ({ key: entry.key, label: entry.label, icon: entry.icon, count: entry.total })),
    ...(serverSkills
      ? [{ key: "servers", label: "From MCP servers", icon: "tools", count: serverSkills }]
      : []),
  ];
  // A search looks on every shelf: a match on a shelf the dock is not showing
  // would otherwise read as "nothing found".
  const everyShelf = shelf === "all" || Boolean(query.trim());
  const showing = (key) => everyShelf || shelf === key;
  const nothingShown =
    !shelves.some((entry) => showing(entry.key) && entry.list.length) &&
    !(showing("servers") && groups.length);

  useLayoutEffect(() => {
    const active = tabsRef.current?.querySelector("button[data-active]");
    if (active) setPill((was) => ({ x: active.offsetLeft, w: active.offsetWidth, ready: Boolean(was) }));
  }, [tab, skills.length, mcpServers.length]);

  const on = skills.filter((s) => s.enabled).length;
  const installedServerNames = new Set(mcpServers.map((s) => s.name));

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
            <h1 className="h">Skills & MCP</h1>
            <p>
              Tools and Model Context Protocol servers I can use. Switch one off
              and I stop being offered it.
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
          <div ref={tabsRef} className="segmented skills-tabs" role="tablist" aria-label="Skills and MCP servers">
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
              Active skills
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
              MCP servers &amp; presets
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
                  No skills registered. Go to the <strong>MCP Servers & Presets</strong> tab to activate GitHub, Figma, Google Workspace, or custom MCP servers.
                </p>
              ) : (
                <>
                  {/* Which shelf: the magnifying dock -- Bencho's, swelling
                      toward the pointer, naming what is under it. */}
                  <Dock items={dockItems} value={shelf} onChange={setShelf} label="Kind of skill" />

                  <div className="skill-shelves" data-one={everyShelf ? undefined : ""}>
                    {shelves.map((entry) =>
                      showing(entry.key) && entry.list.length ? (
                        <section key={entry.key} className="skill-shelf">
                          <ShelfHead icon={entry.icon} label={entry.label} skills={entry.list} />
                          <div className="skill-list">
                            {entry.list.map((skill) => (
                              <SkillRow
                                key={skill.name}
                                skill={skill}
                                busy={pending.includes(skill.name)}
                                onToggle={setEnabled}
                                onKey={setKey}
                                askFirst={askFirst}
                                onApproval={setApproval}
                              />
                            ))}
                          </div>
                        </section>
                      ) : null,
                    )}

                    {showing("servers") && groups.length ? (
                      <section className="skill-shelf" data-wide="">
                        <ShelfHead
                          icon="tools"
                          label="From MCP servers"
                          skills={groups.flatMap((g) => g.list)}
                        />
                        <div className="skill-list">
                          {groups.map(({ server, list }) => (
                            <McpSkillGroup
                              key={server}
                              server={server}
                              skills={list}
                              // Open every server while filtering, so a match
                              // inside a collapsed one is not hidden.
                              forceOpen={Boolean(query.trim())}
                              busyOf={(name) => pending.includes(name)}
                              onToggle={setEnabled}
                              onKey={setKey}
                              askFirst={askFirst}
                              onApproval={setApproval}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>

                  {nothingShown ? (
                    <p className="skill-none">
                      {query.trim() ? `Nothing here matches “${query.trim()}”.` : "Nothing on this shelf."}
                    </p>
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

              {/* Installed MCP Servers */}
              <div>
                <div
                  className="lane"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <span className="mi" data-strong>
                    Installed MCP Servers ({mcpServers.length})
                  </span>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setImportOpen(false);
                        setCustomOpen((was) => !was);
                      }}
                    >
                      {customOpen ? "Close Form" : "+ Add Custom MCP Server"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      title="Paste an mcpServers config from anywhere"
                      onClick={() => {
                        setCustomOpen(false);
                        setImportOpen((was) => !was);
                      }}
                    >
                      {importOpen ? "Close Import" : "Import Config"}
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
                      Import MCP Servers
                    </span>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "var(--t-sm)",
                        color: "var(--text-dim)",
                        lineHeight: 1.5,
                      }}
                    >
                      Paste the <code>mcpServers</code> block from any MCP install page.
                      Both the whole config file and the bare mapping work. Servers
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
                      Add Custom MCP Server
                    </span>
                    <div style={{ display: "flex", gap: "12px" }}>
                      <input
                        type="text"
                        placeholder="Server Name (e.g. postgres, filesystem)"
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
                      {mcpBusy ? "Connecting…" : "Save & Connect Server"}
                    </button>
                  </form>
                ) : null}

                {mcpServers.length === 0 ? (
                  <div className="mcp-empty">
                    <span className="shelf-glyph" aria-hidden="true">
                      <Icon name="apps" />
                    </span>
                    <p>
                      <b>Nothing connected yet.</b> Pick an integration from the gallery below — GitHub,
                      Figma, Exa, Context7 and more — or bring your own with “+ Add Custom MCP Server” or
                      “Import Config”.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {mcpServers.map((server) => (
                      <McpServerRow
                        key={server.id}
                        api={api}
                        server={server}
                        onToggle={handleToggleMcpServer}
                        onDelete={handleDeleteMcpServer}
                        onSync={handleSyncMcpServer}
                        onLogo={handleUploadLogo}
                        onResetLogo={handleResetLogo}
                        onSignIn={handleSignIn}
                        onSignOut={handleSignOut}
                        busy={mcpBusy}
                      />
                    ))}
                  </div>
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
                          isInstalled={installedServerNames.has(preset.name)}
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
