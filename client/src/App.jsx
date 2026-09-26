// UI only. Zero durable state beyond the bearer token: if this device is
// wiped, nothing is lost, because the server is the source of truth.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Agents } from "./components/Agents";
import { Design } from "./components/Design";
import { DesignStarters, DesignStartersHead } from "./components/DesignStarters";
import { Canvas } from "./components/Canvas";
import { Icon } from "./components/Icon";
import { Composer } from "./components/Composer";
import { Projects } from "./components/Projects";
import { Memory } from "./components/Memory";
import { MessageList } from "./components/MessageList";
import { NavRail } from "./components/NavRail";
import { Settings } from "./components/Settings";
import { Skills } from "./components/Skills";
import { Starters } from "./components/Starters";
import { TokenGate } from "./components/TokenGate";
import { TopBar } from "./components/TopBar";
import { useAgents } from "./hooks/useAgents";
import { useDesigns } from "./hooks/useDesigns";
import { useCanvas } from "./hooks/useCanvas";
import { useCanvasWidth } from "./hooks/useCanvasWidth";
import { useChat } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { useProjects } from "./hooks/useProjects";
import { useRailWidth } from "./hooks/useRailWidth";
import { useSessions } from "./hooks/useSessions";
import { useTheme } from "./hooks/useTheme";
import { UnauthorizedError, createApi } from "./lib/api";
import { ApiContext } from "./lib/api-context";

const TOKEN_KEY = "unified-llm-token";
// Whether the rail stays out. A layout preference rather than data, so it is
// the one thing besides the token this client is allowed to remember.
const PIN_KEY = "unified-llm-rail-pinned";

// "boot" is the silent pass with a token already in storage -- the common
// case, and the one that must not flash a login screen on every launch.
// "connecting" is the same work with the gate on screen, after someone typed.
const BOOT = "boot";
const GATE = "gate";
const CONNECTING = "connecting";
const READY = "ready";

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [phase, setPhase] = useState(() => (localStorage.getItem(TOKEN_KEY) ? BOOT : GATE));
  const [gateError, setGateError] = useState("");
  const [focusToken, setFocusToken] = useState(0);
  // Which of the rail's destinations is on screen. "chat" and "design" are
  // both the conversation screen -- a design conversation reads a different
  // preamble and opens on a different empty screen -- and "standards" is the
  // library of design.md files the Design group links to.
  const [view, setView] = useState("chat");
  const talking = view === "chat" || view === "design";
  const rail = useRailWidth();
  const canvasSize = useCanvasWidth();
  // Below 900px the rail stops being a strip beside the sheet and becomes a
  // full-screen panel behind one button, so the shell has to know which layout
  // it is in rather than leaving it all to the stylesheet.
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setNarrow(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Widening the window puts the rail back where it belongs, so a panel left
  // open on a phone is not still covering the sheet on a laptop.
  useEffect(() => {
    if (!narrow) setSidebarOpen(false);
  }, [narrow]);
  // The prompt a starter put in the composer. An object, not a string, so
  // picking the same starter twice is two distinct values.
  const [draft, setDraft] = useState(null);
  const [railPinned, setRailPinned] = useState(
    () => localStorage.getItem(PIN_KEY) === "1",
  );
  const togglePin = useCallback(
    () =>
      setRailPinned((was) => {
        localStorage.setItem(PIN_KEY, was ? "0" : "1");
        return !was;
      }),
    [],
  );
  // The last /status payload. Drives the circle at the foot of the rail and
  // the settings page; the per-turn badge in the top bar is separate and more
  // current, because it reports which provider actually answered.
  const [status, setStatus] = useState(null);
  // "local" | "cloud" | "openrouter" | null. Null lets the server's router
  // decide, which is the default and usually the right answer. Kept here
  // rather than on the server: it is a per-turn field, and "answer this one
  // locally" should not follow you to another device. Which *model* each
  // backend uses is the opposite case and lives on the server -- see
  // useModels.
  const [provider, setProvider] = useState(null);
  // The agent picked on the empty new-conversation screen. It is sent with
  // the first turn so the server can assign it before the model runs.
  const [newAgentId, setNewAgentId] = useState(null);
  // The look picked on an empty design conversation, sent with its first
  // message so the answer is styled from the start and nothing is asked.
  const [newDesign, setNewDesign] = useState(null);

  const bootstrapped = useRef("");
  const signOutRef = useRef(() => {});

  const signOut = useCallback((message) => {
    localStorage.removeItem(TOKEN_KEY);
    bootstrapped.current = "";
    setToken("");
    setPhase(GATE);
    setGateError(message || "");
  }, []);
  signOutRef.current = signOut;

  // One client per token. The 401 handler goes through a ref so the identity
  // stays stable: every hook below keys its callbacks off this object.
  const api = useMemo(
    () => createApi(token, () => signOutRef.current("That token was rejected.")),
    [token],
  );

  const sessions = useSessions(api);
  // After `api`, not before it: hooks run in source order, and reading `api`
  // above its own `const` is a temporal dead zone error that blanks the page.
  const projects = useProjects(api);
  const agents = useAgents(api);
  const designs = useDesigns(api);
  const { refresh } = sessions;
  const onSessionsChanged = useCallback(() => {
    refresh().catch(() => {});
  }, [refresh]);

  // Every backend, what it is pointed at, and everything it could be pointed
  // at instead. Fetched once at mount and again whenever something changes it.
  const models = useModels(api);

  // The canvas panel forwards the model's mid-turn rewrites through a ref, so
  // `onCanvas` stays a stable identity and the two hooks can be defined either
  // side of each other without a chicken-and-egg on the callback.
  const canvasApplyRef = useRef(() => {});
  const onCanvas = useCallback(
    (list, sid) => canvasApplyRef.current(list, sid),
    [],
  );

  const chat = useChat(api, {
    onSessionsChanged,
    onCanvas,
    provider,
    agentId: newAgentId,
    // Only read for a conversation not yet sent: what it is started as.
    mode: view === "design" ? "design" : "chat",
    design: view === "design" ? newDesign : null,
  });
  const { setBadge, openSession, startNew } = chat;

  // The open conversation's row, for its mode, its standard and its filing.
  const current = sessions.sessions.find((s) => s.id === chat.sessionId) || null;
  // What the conversation screen is dressed as. A sent conversation is what it
  // was started as, whichever list it was opened from; an unsent one is what
  // the rail said to start.
  // Between the first message creating the session and the list refreshing,
  // the row is not known yet -- the view it was started from still is.
  const designing = current ? current.mode === "design" : view === "design";
  // Its standard: the stored one, or -- before the first message, and until
  // the list catches up with the session it created -- the pick being sent.
  const look = current ? current.design ?? null : newDesign;
  // What the canvas falls back to for a sheet or a deck with no theme of its
  // own: the conversation's standard, when that is a preset with tokens.
  const lookTokens = useMemo(
    () => designs.presets.find((p) => p.id === look)?.tokens || null,
    [designs.presets, look],
  );
  // Every standard, for the top bar's picker: yours first, then the presets.
  const looks = useMemo(
    () => [...designs.designs, ...designs.presets].map((d) => ({ id: d.id, name: d.name })),
    [designs.designs, designs.presets],
  );

  const canvas = useCanvas(api, chat.sessionId);
  canvasApplyRef.current = canvas.applyEvent;

  // The accent in force, and the three scopes it can be set from. Given the
  // open conversation as well as the lists, because an accent set to `auto`
  // is derived from what is being talked about -- it needs the messages, not
  // just the session row.
  const theme = useTheme({
    api,
    sessionId: chat.sessionId,
    sessions: sessions.sessions,
    projects: projects.projects,
    // The accent is the agent's now, not the chat's -- useTheme resolves
    // agent -> project -> app.
    agents: agents.agents,
    pendingAgentId: newAgentId,
    title: chat.title,
    messages: chat.messages,
  });

  // -- bootstrap ------------------------------------------------------------

  useEffect(() => {
    if (!token || bootstrapped.current === token) return;
    bootstrapped.current = token;

    // Abandoned when the token this run belongs to is no longer the live one --
    // a sign-out mid-bootstrap must not land its results on the gate. Deliberately
    // not a captured `cancelled` flag: StrictMode tears the first effect down
    // immediately, and this run is the only one the guard above will allow.
    const stale = () => bootstrapped.current !== token;

    (async () => {
      try {
        const reported = await api.status();
        if (stale()) return;
        localStorage.setItem(TOKEN_KEY, token);
        setStatus(reported);

        if (reported.serving === "none") {
          setBadge({ text: "no model reachable", tone: "down" });
        } else if (reported.serving !== "local") {
          // Named rather than called "cloud": there are two of those now, and
          // which one is answering is the thing worth saying.
          setBadge({
            text: reported.serving + " · " + (reported[reported.serving]?.model || ""),
            tone: "warn",
          });
        }

        const list = await refresh();
        if (stale()) return;
        if (list.length) {
          if (list[0].mode === "design") setView("design");
          await openSession(list[0].id);
        } else startNew();
        setPhase(READY);
      } catch (error) {
        // A 401 has already been turned into a sign-out by the api client.
        if (!stale() && !(error instanceof UnauthorizedError)) {
          signOutRef.current("Couldn't reach the server.");
        }
      }
    })();
  }, [api, token, refresh, openSession, startNew, setBadge]);

  // Which backend the next message actually goes to: the one chosen, or --
  // on Auto -- whichever the router reports it is using.
  const answering =
    provider || (status?.serving && status.serving !== "none" ? status.serving : "local");
  // The reasoning control to draw, from the backend that will answer.
  //
  // `/status` describes the control a *family* takes, which is all it can know
  // from a provider and a model name. Whether one particular model reasons at
  // all is a per-model fact, and on OpenRouter it varies inside every family --
  // so the catalogue row wins where there is one, and a model that says it
  // cannot reason gets no control rather than one that does nothing.
  // Depending on the list rather than on the hook's return value: that is a
  // fresh object every render, and a memo keyed on it would recompute every
  // time regardless.
  const backends = models.providers;
  const thinking = useMemo(() => {
    const backend = backends.find((p) => p.id === answering) || status?.[answering] || null;
    if (!backend) return null;
    const row = (backend.models || []).find((m) => m.id === backend.model);
    if (row && row.reasoning === false) return null;
    return backend.thinking || null;
  }, [answering, backends, status]);

  const { choose } = models;
  const chooseModel = useCallback(
    async (providerId, model) => {
      try {
        await choose(providerId, model);
      } catch (problem) {
        // The picker is a menu, not a page: there is nowhere in it to put a
        // sentence. The badge is where "what is answering" already lives.
        setBadge({ text: problem.message || "could not switch model", tone: "down" });
      }
    },
    [choose, setBadge],
  );

  // -- actions --------------------------------------------------------------

  const handleConnect = useCallback((value) => {
    if (!value) return;
    setGateError("");
    setToken(value);
    setPhase(CONNECTING);
  }, []);

  // Going somewhere from the rail shuts it, on the layout where it is covering
  // what you are going to.
  const goTo = useCallback((next) => {
    setView(next);
    setSidebarOpen(false);
  }, []);

  const handleNewSession = useCallback(() => {
    setView("chat");
    setSidebarOpen(false);
    setNewAgentId(null);
    startNew();
    setFocusToken((n) => n + 1);
  }, [startNew]);

  // The Design tab: a fresh conversation, started as a design one. Nothing is
  // created on the server until the first message, the same as a chat.
  const handleNewDesign = useCallback(() => {
    setView("design");
    setSidebarOpen(false);
    setNewAgentId(null);
    setNewDesign(null);
    startNew();
    setFocusToken((n) => n + 1);
  }, [startNew]);

  // "Start a design with this", from the standards page: a new design
  // conversation with that look already picked.
  const handleDesignWith = useCallback(
    (design) => {
      handleNewDesign();
      setNewDesign(design);
    },
    [handleNewDesign],
  );

  // The look, from the top bar or the empty screen. Before the first message
  // it is only remembered here; after, it is the conversation's.
  const handleLook = useCallback(
    async (design) => {
      if (!chat.sessionId) {
        setNewDesign(design);
        return;
      }
      await api.setSessionDesign(chat.sessionId, design);
      await onSessionsChanged();
    },
    [api, chat.sessionId, onSessionsChanged],
  );

  // A chat that begins life already filed. Sessions are normally created
  // lazily by the first message, so this is the one path that has to make an
  // empty one up front -- there is nowhere else to record the project.
  const handleNewSessionIn = useCallback(
    async (projectId) => {
      const created = await api.createSession();
      if (projectId) await api.setSessionProject(created.id, projectId);
      await onSessionsChanged();
      setView("chat");
      await openSession(created.id).catch(() => {});
      setFocusToken((n) => n + 1);
    },
    [api, onSessionsChanged, openSession],
  );

  const handleFileSession = useCallback(
    async (sessionId, projectId) => {
      await api.setSessionProject(sessionId, projectId);
      await onSessionsChanged();
    },
    [api, onSessionsChanged],
  );

  const handleDelete = useCallback(
    async (id) => {
      await sessions.remove(id);
      if (id === chat.sessionId) startNew();
    },
    [sessions, chat.sessionId, startNew],
  );

  // A conversation opens on the screen it was started on: a design one in the
  // design view, whichever list it was picked from.
  const handleOpenSession = useCallback(
    (id) => {
      const known = sessions.sessions.find((s) => s.id === id);
      setView(known?.mode === "design" ? "design" : "chat");
      setSidebarOpen(false);
      openSession(id)
        .then((session) => {
          if (session && !known) setView(session.mode === "design" ? "design" : "chat");
        })
        .catch(() => {});
    },
    [openSession, sessions.sessions],
  );

  // -- render ---------------------------------------------------------------

  if (phase === BOOT) return null;

  if (phase !== READY) {
    return (
      <TokenGate
        error={gateError}
        connecting={phase === CONNECTING}
        onSubmit={handleConnect}
      />
    );
  }

  return (
    <ApiContext.Provider value={api}>
      <div
        className="app"
        data-rail={railPinned ? "pinned" : undefined}
        // While the drag is live the width transition has to come off, or the
        // panel arrives a couple of frames after the pointer and the handle
        // feels loose.
        data-resizing={rail.resizing || canvasSize.resizing ? "" : undefined}
        // Splits the sheet when the canvas is open, so the thread and the
        // document sit side by side rather than one over the other.
        data-canvas={talking && canvas.open ? "" : undefined}
        // Both omitted below 900px so the stylesheet's phone sizing survives:
        // there the rail is a full-screen panel and the canvas a full overlay,
        // and an inline custom property would outrank the rules that say so.
        style={
          rail.enabled || canvasSize.enabled
            ? {
                ...(rail.enabled ? { "--rail-open": `${rail.width}px` } : null),
                ...(canvasSize.enabled ? { "--canvas-w": `${canvasSize.width}px` } : null),
              }
            : undefined
        }
      >
        {/* On the narrow layout the rail has no strip of its own, so this is
            the whole of its handle: one button, top left.

            Only while the panel is shut. It used to stay and turn into an X,
            which is the conventional thing and the wrong thing here: every row
            in the open panel already closes it -- a conversation, a
            destination, a new chat -- so the X was a second way to do what
            whatever you came for does anyway, sitting on top of the panel's
            own header. Leaving it out is not a trap: there is nothing in the
            panel that does not lead back out of it. */}
        {narrow && !sidebarOpen ? (
          <button
            type="button"
            className="rail-toggle"
            aria-label="Open sidebar"
            aria-expanded={false}
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="sidebar" />
          </button>
        ) : null}
        {/* The conversation list lives inside the rail now -- it unfolds under
            Chat when the rail opens, so there is no drawer to slide over the
            thread and no second place to look for the same list. */}
        <NavRail
          view={view}
          onView={goTo}
          narrow={narrow}
          forceOpen={sidebarOpen}
          status={status}
          providers={backends}
          provider={provider}
          onProvider={setProvider}
          onChooseModel={chooseModel}
          onManageProviders={() => setView("settings")}
          pinned={railPinned}
          resizable={rail.enabled}
          resizing={rail.resizing}
          onResizeStart={rail.start}
          onResizeKey={rail.nudge}
          railWidth={rail.width}
          onTogglePin={togglePin}
          sessions={sessions.sessions}
          projects={projects.projects}
          agents={agents.agents}
          onFileSession={handleFileSession}
          activeId={chat.sessionId}
          onOpenSession={handleOpenSession}
          onNewSession={handleNewSession}
          onNewDesign={handleNewDesign}
          onDelete={handleDelete}
        />

        {/* One column beside the rail. The drawer overlays it rather than
            sitting in the flow, so switching destinations never reflows the
            thread underneath. */}
        {/* An empty conversation centres its composer instead of pinning it to
            the bottom of an empty sheet. Flagged here rather than inside the
            thread because the composer is the thread's sibling, not its
            child. */}
        <div
          className="screen"
          data-view={talking ? (designing ? "design" : "chat") : view}
          data-empty={talking && chat.messages.length === 0 ? "" : undefined}
        >
          {talking ? (
            <>
              <TopBar
                // Until the server names it after the first exchange.
                title={
                  designing && (!chat.sessionId || chat.title === "New conversation")
                    ? "New design"
                    : chat.title
                }
                mode={designing ? "design" : "chat"}
                looks={looks}
                look={look}
                onLook={(design) => handleLook(design).catch(() => {})}
                badge={chat.badge}
                projects={projects.projects}
                canFile={Boolean(chat.sessionId)}
                projectId={current?.project_id || null}
                onProject={async (projectId) => {
                  await api.setSessionProject(chat.sessionId, projectId);
                  await onSessionsChanged();
                }}
                onNewSession={designing ? handleNewDesign : handleNewSession}
                canvasCount={canvas.count}
                canvasOpen={canvas.open}
                onToggleCanvas={canvas.toggle}
                agents={agents.agents}
                agentId={current?.agent_id || null}
                onAgent={async (agentId) => {
                  await api.setSessionAgent(chat.sessionId, agentId);
                  await onSessionsChanged();
                }}
              />

              <MessageList
                messages={chat.messages}
                model={chat.badge?.text}
                scrollToken={chat.scrollToken}
                onDecide={chat.decide}
                onChooseDesign={chat.chooseDesign}
                onContinue={chat.continueTurn}
                head={designing ? <DesignStartersHead /> : null}
              />

              <Composer
                disabled={chat.streaming}
                onStop={chat.stop}
                focusToken={focusToken}
                draft={draft}
                sessionLabel={chat.sessionId ? chat.title : null}
                // Whichever side is actually answering describes its own
                // reasoning control; the composer draws what it is handed.
                thinking={thinking}
                onSend={chat.send}
                agents={chat.sessionId ? [] : agents.agents}
                agentId={newAgentId}
                onAgent={setNewAgentId}
                placeholder={designing ? "Describe what you want to make." : undefined}
              />

              {chat.messages.length === 0 ? (
                designing ? (
                  <DesignStarters
                    onPick={(text) => setDraft({ text })}
                    presets={designs.presets}
                    designs={designs.designs}
                    value={look}
                    onChoose={(design) => handleLook(design).catch(() => {})}
                    onManage={() => goTo("standards")}
                  />
                ) : (
                  <Starters onPick={(text) => setDraft({ text })} />
                )
              ) : null}
            </>
          ) : view === "projects" ? (
            <Projects
              projects={projects.projects}
              sessions={sessions.sessions}
              onOpenSession={handleOpenSession}
              onNewProject={(name) => projects.create(name)}
              onRenameProject={(id, name) => projects.rename(id, name)}
              onDeleteProject={async (id) => {
                await projects.remove(id);
                await onSessionsChanged();
              }}
              onNewSessionIn={handleNewSessionIn}
              onFileSession={handleFileSession}
              accentOf={theme.accentFor}
              seedOfRecord={theme.seedFor}
              onProjectAccent={async (id, accent) => {
                await theme.setForProject(id, accent);
                await projects.refresh();
              }}
            />
          ) : view === "memory" ? (
            <Memory api={api} />
          ) : view === "skills" ? (
            <Skills api={api} />
          ) : view === "agents" ? (
            <Agents
              api={api}
              agents={agents.agents}
              onCreate={agents.create}
              onUpdate={agents.update}
              onDelete={agents.remove}
              // A deleted or reassigned agent changes sessions' agent_id, so the
              // conversation list has to be refetched for the top-bar picker to
              // show the truth.
              onChanged={onSessionsChanged}
            />
          ) : view === "standards" ? (
            <Design
              designs={designs.designs}
              presets={designs.presets}
              onCreate={designs.create}
              onUpdate={designs.update}
              onDelete={designs.remove}
              onUse={handleDesignWith}
            />
          ) : (
            <Settings
              status={status}
              models={models}
              provider={provider}
              onProvider={setProvider}
              pinned={railPinned}
              onTogglePin={togglePin}
              api={api}
              sessions={sessions.sessions}
              onSessionsChanged={onSessionsChanged}
              onSignOut={() => signOut("")}
              theme={theme}
            />
          )}
        </div>

        {/* The document beside the conversation. A sibling of the sheet rather
            than a child of it, so it splits the width with the thread instead
            of scrolling inside it -- and only in chat, where a conversation is
            what a canvas belongs to. */}
        {talking && canvas.open ? (
          <Canvas
            canvases={canvas.canvases}
            active={canvas.active}
            onSelect={canvas.select}
            onClose={canvas.closePanel}
            onSave={canvas.save}
            onCreate={canvas.create}
            onDelete={canvas.remove}
            fallbackTheme={lookTokens}
            resizable={canvasSize.enabled}
            width={canvasSize.width}
            onResizeStart={canvasSize.start}
            onResizeKey={canvasSize.nudge}
          />
        ) : null}
      </div>
    </ApiContext.Provider>
  );
}
