/* Settings: one window, opened from the gear at the top right of the app bar
 * (or ⌘,), with a menu down its left and one screen at a time on its right.
 *
 * It holds what used to be two pages of the rail -- this device's settings
 * and memory -- split into screens small enough to take in at a glance, and a
 * search over the menu for when the name of the screen is not the word that
 * comes to mind ("dark", "ollama", "delete").
 *
 * There is no account here to manage -- one user, one bearer token, one
 * machine -- so General is the honest version of "account": how this device
 * is set up, and how to stop being connected. */
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./Icon";
import { ManageChats } from "./ManageChats";
import { Memory } from "./Memory";
import { Providers } from "./Providers";
import { ThemePicker } from "./ThemePicker";
import { APPEARANCES } from "../lib/appearance";
import { DEFAULT_ACCENT } from "../lib/theme";

/* The menu. `words` are what the search also matches, beyond the label. */
export const SETTINGS_SCREENS = [
  {
    group: "Settings",
    id: "general",
    label: "General",
    icon: "gear",
    title: "General",
    lead: "How this app is set up on this device. Nothing is stored here except the token and how you like the sidebar — everything else lives on the server.",
    words: "sidebar pin rail device token sign out account",
  },
  {
    group: "Settings",
    id: "appearance",
    label: "Appearance",
    icon: "design",
    title: "Appearance",
    lead: "Light or dark for this device, and the accent the whole app wears.",
    words: "theme dark light system colour color accent mode",
  },
  {
    group: "Settings",
    id: "models",
    label: "Models",
    icon: "spark",
    title: "Models",
    lead: "Which backend answers, and with which model. Auto uses the local model and falls through to a cloud one only when it cannot answer.",
    words: "provider providers model local cloud ollama openrouter api key connection",
  },
  {
    group: "Your data",
    id: "memory",
    label: "Memory",
    icon: "memory",
    title: "What I remember",
    lead: "Two kinds. Things I've picked up about you, and documents you've given me to look things up in. Change or delete anything — I stop using it straight away.",
    words: "facts remember documents index forget recall",
  },
  {
    group: "Your data",
    id: "conversations",
    label: "Conversations",
    icon: "chat_bubble",
    title: "Conversations",
    lead: "Every conversation on the server, to clear out in bulk.",
    words: "chats sessions delete manage history clear",
  },
];

function matches(screen, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${screen.label} ${screen.title} ${screen.words}`.toLowerCase().includes(q);
}

function General({ pinned, onTogglePin, onSignOut }) {
  return (
    <>
      <div className="settings-rows">
        <div className="settings-row">
          <div>
            <b>Keep the sidebar open</b>
            <p>Pinned, it takes its own width beside the conversation. Otherwise it opens when the pointer reaches the edge of the window.</p>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={pinned}
            aria-pressed={pinned}
            aria-label="Keep the sidebar open"
            onClick={onTogglePin}
          >
            <i />
          </button>
        </div>
        <div className="settings-row">
          <div>
            <b>Sign out</b>
            <p>Forgets the token on this device only. Your conversations stay on the server.</p>
          </div>
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}

function Appearance({ theme, appearance }) {
  return (
    <>
      <h3 className="settings-sub">Mode</h3>
      {/* For this device only -- like the pinned rail, kept here rather than
          on the server. The accent below is drawn for whichever is in force. */}
      <div className="appearance" role="radiogroup" aria-label="Appearance">
        {APPEARANCES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={appearance?.preference === option.id}
            data-mode={option.id}
            onClick={() => appearance?.setPreference(option.id)}
          >
            <i aria-hidden="true" />
            {option.name}
          </button>
        ))}
      </div>
      <p className="settings-note">
        <b>System</b> follows this device and switches with it. Dark is black
        and grey with the accent kept for what you act on.
      </p>

      {/* The accent, app-wide: the bottom of the stack of three. A
          conversation with no accent of its own falls through to its project,
          and a project with none falls through to here -- so this is the one
          of the three that cannot decline to choose. */}
      <h3 className="settings-sub">
        Accent
        <span className="mi">{theme?.source === "app" ? "in use" : "overridden here"}</span>
      </h3>
      <div className="sur" style={{ padding: "18px" }}>
        <ThemePicker
          value={theme?.appAccent || DEFAULT_ACCENT}
          onChange={(accent) => theme?.setApp(accent || DEFAULT_ACCENT)}
          scope="app"
          seed={theme?.contextSeed}
        />
      </div>
      <p className="settings-note">
        <b>From the chat</b> reads what a conversation is about and colours the
        app to match — locally, from words already on this device, with nothing
        sent anywhere. A conversation or a project can override this.
      </p>
    </>
  );
}

export function Settings({
  section = "general",
  onSection,
  onClose,
  status,
  models,
  provider,
  onProvider,
  pinned,
  onTogglePin,
  onSignOut,
  api,
  sessions,
  onSessionsChanged,
  theme,
  appearance,
}) {
  const [query, setQuery] = useState("");
  const search = useRef(null);
  const main = useRef(null);
  const screen = SETTINGS_SCREENS.find((s) => s.id === section) || SETTINGS_SCREENS[0];
  const found = useMemo(() => SETTINGS_SCREENS.filter((s) => matches(s, query)), [query]);

  // The search has the caret on the way in, as it does in the apps this
  // window is drawn after.
  useEffect(() => {
    search.current?.focus();
  }, []);

  // Escape shuts it -- clearing a search first, so a stray Escape while
  // searching does not throw the whole window away. Not while a field on a
  // screen is being typed in (Escape cancels the edit there), and not when a
  // confirmation opened over the window took the key: that is decided once
  // every listener has had it, since both listen on the window.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      const field = event.target;
      const inSearch = field === search.current;
      if (!inSearch && field?.matches?.("input, textarea, select, [contenteditable]")) return;
      setTimeout(() => {
        if (event.defaultPrevented) return;
        if (inSearch && search.current?.value) setQuery("");
        else onClose();
      }, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, onClose]);

  // A new screen starts at its top.
  useEffect(() => {
    main.current?.scrollTo?.(0, 0);
  }, [section]);

  let lastGroup = null;

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="settings-window" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <label className="settings-search">
            <Icon name="search" />
            <input
              ref={search}
              type="search"
              placeholder="Search"
              aria-label="Search settings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && found[0]) onSection(found[0].id);
              }}
            />
          </label>
          {found.length === 0 ? <p className="settings-none">No settings match.</p> : null}
          {found.map((item) => {
            const head = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id} className="settings-nav-entry">
                {head ? <span className="settings-group">{head}</span> : null}
                <button
                  type="button"
                  className="settings-item"
                  aria-current={item.id === screen.id ? "page" : undefined}
                  onClick={() => onSection(item.id)}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </button>
              </div>
            );
          })}
        </nav>

        <div className="settings-main" ref={main}>
          <section className="settings-screen" data-screen={screen.id} aria-labelledby="settings-title">
            <header className="settings-head">
              <h2 className="h" id="settings-title">{screen.title}</h2>
              <p>{screen.lead}</p>
            </header>

            {screen.id === "general" ? (
              <General pinned={pinned} onTogglePin={onTogglePin} onSignOut={onSignOut} />
            ) : screen.id === "appearance" ? (
              <Appearance theme={theme} appearance={appearance} />
            ) : screen.id === "models" ? (
              <Providers models={models} provider={provider} onProvider={onProvider} serving={status?.serving} />
            ) : screen.id === "memory" ? (
              <Memory api={api} embedded />
            ) : (
              <ManageChats api={api} sessions={sessions} onDeleted={onSessionsChanged} />
            )}
          </section>
        </div>

        <button type="button" className="settings-close" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}
