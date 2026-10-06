// UI only. Zero durable state beyond the bearer token: if this device is
// wiped, nothing is lost, because the server is the source of truth.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentEditor } from "./components/AgentEditor";
import { AgentGreeting, AgentsScreen } from "./components/AgentRoom";
import { lookOf } from "./lib/accessories";
import { AgentGallery } from "./components/Agents";
import { AppBar } from "./components/AppBar";
import { DesignStarters, DesignStartersHead } from "./components/DesignStarters";
import { Canvas } from "./components/Canvas";
import { BrowserPanel } from "./components/BrowserPanel";
import { CodeStarters, CodeStartersHead } from "./components/code/CodeStarters";
import { CodeView } from "./components/code/CodeView";
import { FolderPicker } from "./components/code/FolderPicker";
import { NewProject } from "./components/code/NewProject";
import { Icon } from "./components/Icon";
import { Composer, STUDIO_KINDS } from "./components/Composer";
import { Projects } from "./components/Projects";
import { MessageList } from "./components/MessageList";
import { NavRail } from "./components/NavRail";
import { Settings } from "./components/Settings";
import { Skills } from "./components/Skills";
import { Starters } from "./components/Starters";
import { RemoteGate } from "./components/RemoteGate";
import { TokenGate } from "./components/TokenGate";
import { TopBar } from "./components/TopBar";
import { useAgents } from "./hooks/useAgents";
import { useDesigns } from "./hooks/useDesigns";
import { useDesignLibrary } from "./hooks/useDesignLibrary";
import { useBrowser } from "./hooks/useBrowser";
import { useCanvas } from "./hooks/useCanvas";
import { useCanvasWidth } from "./hooks/useCanvasWidth";
import { useReadWidth } from "./hooks/useReadWidth";
import { useChat } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { useProjects } from "./hooks/useProjects";
import { useRailWidth } from "./hooks/useRailWidth";
import { useSessions } from "./hooks/useSessions";
import { useAppearance } from "./hooks/useAppearance";
import { useTheme } from "./hooks/useTheme";
import { useWorkspace } from "./hooks/useWorkspace";
import { UnauthorizedError, createApi } from "./lib/api";
import { ApiContext } from "./lib/api-context";
import { AppActions } from "./lib/appActions";
import { listenForNew, listenForSettings } from "./lib/kinds";
import { HostUnreachable } from "./lib/relay";
import {
  REMOTE_ONLY,
  arrivedForRemote,
  forgetHost,
  openRelay,
  saveHost,
  savedHost,
  acceptAppLink,
  watchAppLinks,
} from "./lib/remote";
import { useDialog } from "./components/Dialog";

const TOKEN_KEY = "unified-llm-token";
// Whether the rail stays out. A layout preference rather than data, so it is
// the one thing besides the token this client is allowed to remember.
const PIN_KEY = "unified-llm-rail-pinned";
// Home or Studio, remembered on this device like the pinned rail.
const SPACE_KEY = "bom.space";
// Which space a conversation belongs to: designs and code are Studio's.
const spaceOf = (session) =>
  session && (session.mode === "design" || session.mode === "code") ? "studio" : "home";

// "boot" is the silent pass with a token already in storage -- the common
// case, and the one that must not flash a login screen on every launch.
// "connecting" is the same work with the gate on screen, after someone typed.
const BOOT = "boot";
const GATE = "gate";
const CONNECTING = "connecting";
const READY = "ready";

// A project folder by its last part, as the new-conversation page names it.
function folderName(root) {
  return String(root || "").replace(/\/+$/, "").split("/").pop() || root;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  // A host reached through the relay instead of this token's server:
  // `{id, name}`, remembered so the next launch goes straight back to it.
  const [remote, setRemote] = useState(() => savedHost());
  // Which way in the gate offers. The hosted web app has only the relay; a
  // page opened from a sign-in email or a device's link wants it too.
  const [gateMode, setGateMode] = useState(() =>
    REMOTE_ONLY || savedHost() || arrivedForRemote() ? "remote" : "token",
  );
  const [phase, setPhase] = useState(() => {
    // Through the relay, the first answer takes a few seconds, so the gate
    // is shown saying so rather than a blank window.
    if (savedHost()) return CONNECTING;
    if (REMOTE_ONLY || arrivedForRemote()) return GATE;
    return localStorage.getItem(TOKEN_KEY) ? BOOT : GATE;
  });
  const [gateError, setGateError] = useState("");
  const [focusToken, setFocusToken] = useState(0);
  // Which of the rail's destinations is on screen. "chat" is the conversation
  // screen, for a chat or a design and for every conversation not yet sent;
  // "code" is a code session's editor with the conversation beside it; and
  // "projects", "skills" and "agents" are the rail's pages. (The design
  // standards are a screen of Settings.)
  const [view, setView] = useState("chat");
  const talking = view === "chat";
  // What the conversation on the new-conversation page will be started as --
  // chosen in its composer. One page for all three: the composer and what is
  // under it change to suit, rather than each kind having a page of its own.
  const [newKind, setNewKind] = useState("chat");
  // The space the rail is in -- Home (chats, agents) or Studio (designs and
  // code). It follows what is on screen (see the effect below); the switch at
  // the head of the rail moves it, and it is remembered for the next launch.
  const [space, setSpace] = useState(() => {
    try {
      return localStorage.getItem(SPACE_KEY) === "studio" ? "studio" : "home";
    } catch {
      return "home";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SPACE_KEY, space);
    } catch {
      /* private window: the space is simply not remembered */
    }
  }, [space]);
  // What Studio starts as when there is nothing of its own to go back to:
  // whichever of design and code was picked last.
  const studioKind = useRef("design");
  useEffect(() => {
    if (newKind === "design" || newKind === "code") studioKind.current = newKind;
  }, [newKind]);
  const rail = useRailWidth();
  const canvasSize = useCanvasWidth();
  const screenRef = useRef(null);
  const readSize = useReadWidth(screenRef);
  // Light or dark, for this device. Up here, above every early return, so
  // the token gate follows it as well as the app behind it.
  const appearance = useAppearance();
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
  // The project picked in the composer's tray for a conversation not yet
  // sent. It rides on the first message; after that the conversation's own
  // row says where it is filed.
  const [newProjectId, setNewProjectId] = useState(null);
  // On the Agents page: whose room is open, or null for the roster. The room
  // runs the app's one conversation as that agent.
  const [roomAgentId, setRoomAgentId] = useState(null);
  // The customise sheet: null when shut, else `{ agent, initial }` -- the
  // stored agent being changed, or for a new one the preset it starts from.
  const [agentSheet, setAgentSheet] = useState(null);
  // The look picked on an empty design conversation, sent with its first
  // message so the answer is styled from the start and nothing is asked.
  const [newDesign, setNewDesign] = useState(null);

  const bootstrapped = useRef("");
  const signOutRef = useRef(() => {});
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  // Back to the gate. Through the relay that means back to the device list:
  // the relay account stays signed in, and a local token stays remembered.
  const signOut = useCallback((message) => {
    bootstrapped.current = "";
    if (remoteRef.current) {
      forgetHost();
      setRemote(null);
      setGateMode("remote");
    } else {
      localStorage.removeItem(TOKEN_KEY);
      setToken("");
    }
    setPhase(GATE);
    setGateError(message || "");
  }, []);
  signOutRef.current = signOut;

  // One connection per chosen host. Joined on the first request, and left
  // when another host is chosen or the gate comes back.
  const relay = useMemo(() => (remote ? openRelay(remote.id) : null), [remote]);
  // Closed when replaced rather than in an effect's cleanup: StrictMode runs
  // every cleanup once on mount, which would drop the channel mid-bootstrap.
  const lastRelay = useRef(null);
  useEffect(() => {
    if (lastRelay.current && lastRelay.current !== relay) lastRelay.current.close();
    lastRelay.current = relay;
  }, [relay]);
  // What the bootstrap below runs once for: this token, or this host.
  const identity = remote ? "relay:" + remote.id : token;

  // One client per token. The 401 handler goes through a ref so the identity
  // stays stable: every hook below keys its callbacks off this object.
  // With no token at all there is nothing to reject and nothing to sign out
  // of: the requests the hooks below make on mount come back 401, and that is
  // not news to someone who has not typed anything yet -- nor may it clear
  // the message a real rejection left a moment earlier.
  const api = useMemo(
    () =>
      relay
        ? createApi(
            "",
            () => signOutRef.current("Your host didn't accept this account. Sign in again, or pick another host."),
            { transport: relay.fetch },
          )
        : createApi(token, () => {
            if (token) signOutRef.current("That token was rejected.");
          }),
    [token, relay],
  );

  const sessions = useSessions(api);
  // After `api`, not before it: hooks run in source order, and reading `api`
  // above its own `const` is a temporal dead zone error that blanks the page.
  const projects = useProjects(api);
  const agents = useAgents(api);
  const designs = useDesigns(api);
  const { refresh } = sessions;
  const { refresh: refreshProjects } = projects;
  // The projects follow the conversations: the server files a code
  // conversation under its folder's project, making one for a new folder.
  const onSessionsChanged = useCallback(() => {
    refresh().catch(() => {});
    refreshProjects();
  }, [refresh, refreshProjects]);

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
  // And the browser panel: a browser step drew the page again.
  const browserApplyRef = useRef(() => {});
  const onBrowser = useCallback((view, sid) => browserApplyRef.current(view, sid), []);
  // The same for the Code view's editor: a code tool changed files.
  const workspaceApplyRef = useRef(() => {});
  const onWorkspace = useCallback((paths, sid) => workspaceApplyRef.current(paths, sid), []);
  // A tool made a project or filed the conversation -- or gave a code
  // conversation its folder. Everything that lists projects reads them again.
  const projectsApplyRef = useRef(() => {});
  const onProjects = useCallback((data, sid) => projectsApplyRef.current(data, sid), []);

  // The folder a new code conversation will work on. None to begin with: a
  // new code session opens on the project page, where a folder is picked --
  // recent, browsed to, or made new -- and a project card or "Open in Code"
  // names one outright.
  const [newWorkspace, setNewWorkspace] = useState(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  // The new-code-project dialog: null when shut, or what it opens with -- a
  // name and the designs to build from, when it was opened from those.
  const [newProject, setNewProject] = useState(null);
  // The first message of a project just made from designs, sent as soon as
  // the Code view is on the new folder.
  const [kickoffFor, setKickoffFor] = useState(null);

  const chat = useChat(api, {
    onSessionsChanged,
    onCanvas,
    onBrowser,
    onWorkspace,
    onProjects,
    provider,
    agentId: newAgentId,
    // Only read for a conversation not yet sent: what it is started as, and
    // for a code one the folder it will work on.
    mode: newKind,
    design: newKind === "design" ? newDesign : null,
    workspace: newWorkspace,
    projectId: newProjectId,
  });
  const { setBadge, openSession, startNew } = chat;

  // The agent whose room is on screen, if any. Looked up rather than stored,
  // so deleting the agent drops back to the roster by itself.
  const roomAgent =
    view === "agents" && roomAgentId ? agents.agents.find((a) => a.id === roomAgentId) || null : null;
  // A conversation is on screen: the chat screen, or an agent's chat -- which
  // is the same conversation with the agent above it, canvas and all.
  const conversing = talking || Boolean(roomAgent);

  // Each agent's one chat: the latest conversation run as it (a code session
  // aside, which lives in its editor). An agent is someone you keep talking
  // to, so the Agents screen opens where you left off rather than listing
  // conversations. Older ones from before an agent had a single chat stay in
  // the main list as ordinary conversations.
  const agentChats = useMemo(() => {
    const chats = new Map();
    for (const s of sessions.sessions) {
      if (!s.agent_id || s.mode === "code") continue;
      const was = chats.get(s.agent_id);
      if (!was || (s.updated_at || 0) > (was.updated_at || 0)) chats.set(s.agent_id, s);
    }
    return chats;
  }, [sessions.sessions]);
  const agentChatIds = useMemo(
    () => new Set([...agentChats.values()].map((s) => s.id)),
    [agentChats],
  );
  // The main list, without the agents' chats -- those are on the Agents
  // screen, the way a messenger's threads are not also in your inbox.
  const plainSessions = useMemo(
    () => sessions.sessions.filter((s) => !agentChatIds.has(s.id)),
    [sessions.sessions, agentChatIds],
  );
  // The rail's list is the space's own: chats in Home, designs and code in
  // Studio.
  const spaceSessions = useMemo(
    () => plainSessions.filter((s) => spaceOf(s) === space),
    [plainSessions, space],
  );

  // The open conversation's row, for its mode, its standard and its filing.
  const current = sessions.sessions.find((s) => s.id === chat.sessionId) || null;
  // What the conversation screen is dressed as. A sent conversation is what it
  // was started as, whichever list it was opened from; an unsent one is what
  // the rail said to start.
  // Between the first message creating the session and the list refreshing,
  // the row is not known yet -- the view it was started from still is.
  const designing = current ? current.mode === "design" : newKind === "design";
  // The new-conversation page, set to start a code session. It stays this
  // page only until the first message: that opens the Code view.
  const startingCode = !chat.sessionId && newKind === "code";
  // Its standard: the stored one, or -- before the first message, and until
  // the list catches up with the session it created -- the pick being sent.
  const look = current ? current.design ?? null : newDesign;

  // The Code view's project: the open conversation's folder, or the one a new
  // conversation will be started on. Until the list catches up with a session
  // the first message just created, that is still the one being sent.
  //
  // Held while another mode is on screen, so coming back to Code finds the
  // same folder with the same files open, unsaved edits and all.
  const codeRoot = current && current.mode === "code" ? current.workspace || null : newWorkspace;
  const lastCodeRoot = useRef(null);
  if (view === "code") lastCodeRoot.current = codeRoot;
  const workspaceRoot = view === "code" ? codeRoot : lastCodeRoot.current;
  const ws = useWorkspace(api, workspaceRoot);
  workspaceApplyRef.current = (paths) => {
    if (view === "code") ws.refresh(paths);
  };

  // The composer's Make menu, remembered per conversation. A design chat
  // starts on Wireframe -- design projects begin as screens -- and a chat on
  // Auto. What was picked before the first message follows the conversation
  // once the server gives it an id.
  const [makeBy, setMakeBy] = useState({});
  const makeKey = chat.sessionId || (designing ? "new-design" : "new-chat");
  const make = makeBy[makeKey] ?? (designing ? "wireframe" : "auto");
  const setMake = useCallback((value) => setMakeBy((m) => ({ ...m, [makeKey]: value })), [makeKey]);
  const lastMakeKey = useRef(makeKey);
  useEffect(() => {
    const was = lastMakeKey.current;
    lastMakeKey.current = makeKey;
    if (was.startsWith("new-") && !makeKey.startsWith("new-")) {
      setMakeBy((m) => {
        if (m[was] === undefined) return m;
        const { [was]: carried, ...rest } = m;
        return { ...rest, [makeKey]: carried };
      });
    }
  }, [makeKey]);
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
  // The page Bom's browser (or the user's) has open for this conversation.
  // It shares the side panel with the canvas: whichever the model touched
  // last is the one on screen, and the two toggles swap between them.
  const browser = useBrowser(api, chat.sessionId);
  // Every design, by design project: the Projects page, the Code view's
  // Designs panel and the new-project dialog all choose from it.
  const libraryShown = view === "projects" || view === "code" || Boolean(newProject);
  const library = useDesignLibrary(api, libraryShown);
  // Read again whenever the conversations are -- after every turn, which may
  // have made a design, and after every filing, which moves designs between
  // projects -- while something that shows the library is on screen.
  const { refresh: refreshLibrary } = library;
  useEffect(() => {
    if (libraryShown) refreshLibrary();
  }, [sessions.sessions, libraryShown, refreshLibrary]);
  projectsApplyRef.current = () => {
    projects.refresh();
    onSessionsChanged();
  };
  canvasApplyRef.current = (list, sid) => {
    if (!sid || sid === chat.sessionId) browser.closePanel();
    canvas.applyEvent(list, sid);
  };
  browserApplyRef.current = (view, sid) => {
    if (!sid || sid === chat.sessionId) canvas.closePanel();
    browser.applyEvent(view, sid);
  };
  const toggleCanvas = () => {
    if (!canvas.open) browser.closePanel();
    canvas.toggle();
  };
  const toggleBrowser = () => {
    if (!browser.open) canvas.closePanel();
    browser.toggle();
  };

  // The accent in force, and the three scopes it can be set from. Given the
  // open conversation as well as the lists, because an accent set to `auto`
  // is derived from what is being talked about -- it needs the messages, not
  // just the session row.
  // On the Agents screen with no agent open, the conversation still loaded
  // behind the gallery is not what is on screen, so its agent's colour should
  // not dress the page: the theme resolves as for nothing open.
  const themeIdle = view === "agents" && !roomAgent;
  const theme = useTheme({
    api,
    sessionId: themeIdle ? null : chat.sessionId,
    sessions: sessions.sessions,
    projects: projects.projects,
    // The accent is the agent's now, not the chat's -- useTheme resolves
    // agent -> project -> app.
    agents: agents.agents,
    pendingAgentId: themeIdle ? null : newAgentId,
    title: themeIdle ? "" : chat.title,
    messages: themeIdle ? [] : chat.messages,
    // The accent is derived per mode: the same hue, drawn on a dark ladder.
    mode: appearance.mode,
  });

  // -- bootstrap ------------------------------------------------------------

  useEffect(() => {
    if (!identity || bootstrapped.current === identity) return;
    bootstrapped.current = identity;

    // Abandoned when the token this run belongs to is no longer the live one --
    // a sign-out mid-bootstrap must not land its results on the gate. Deliberately
    // not a captured `cancelled` flag: StrictMode tears the first effect down
    // immediately, and this run is the only one the guard above will allow.
    const stale = () => bootstrapped.current !== identity;

    (async () => {
      try {
        const reported = await api.status();
        if (stale()) return;
        // Remembered only once it has answered, so a host that is down is
        // not what the next launch waits on.
        if (remote) saveHost(remote);
        else localStorage.setItem(TOKEN_KEY, token);
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
        // The newest conversation in the space the app was left in, so a
        // Studio day reopens on its design or code rather than on a chat.
        let remembered = "home";
        try {
          remembered = localStorage.getItem(SPACE_KEY) === "studio" ? "studio" : "home";
        } catch {
          /* no storage: Home */
        }
        const first = list.find((s) => spaceOf(s) === remembered) || list[0];
        if (first) {
          if (first.mode === "code") setView("code");
          // The newest conversation is, if it is an agent's, that agent's one
          // chat -- so it reopens where it lives, on the Agents screen.
          else if (first.agent_id) {
            setView("agents");
            setRoomAgentId(first.agent_id);
          }
          await openSession(first.id);
        } else startNew();
        setPhase(READY);
      } catch (error) {
        // A 401 has already been turned into a sign-out by the api client.
        if (!stale() && !(error instanceof UnauthorizedError)) {
          signOutRef.current(
            !remote
              ? "Couldn't reach the server."
              : error instanceof HostUnreachable
                ? error.message
                : `Couldn't reach ${remote.name || "your host"}: ${error.message || error}`,
          );
        }
      }
    })();
  }, [api, identity, remote, token, refresh, openSession, startNew, setBadge]);

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
    forgetHost();
    setRemote(null);
    bootstrapped.current = "";
    setToken(value);
    setPhase(CONNECTING);
  }, []);

  const handleRemoteConnect = useCallback((host) => {
    setGateError("");
    bootstrapped.current = "";
    setRemote({ id: host.id, name: host.name });
    setPhase(CONNECTING);
  }, []);

  // The desktop app: an emailed sign-in link, handed on by the web app as a
  // bom:// link, signs in to the relay here -- and, from the token screen,
  // goes on to the relay's device list.
  const { confirm } = useDialog();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useEffect(() => {
    let live = true;
    let stop = null;
    const ask = (email) =>
      confirmRef.current(
        `A sign-in link wants to sign this app in to the relay as ${email}. Only say yes if you asked to sign in as ${email} — a device you link afterwards will belong to that account.`,
        { title: "Sign in from a link?", confirmLabel: "Sign in" },
      );
    watchAppLinks(async (url) => {
      try {
        if (!(await acceptAppLink(url, ask)) || !live) return;
        setGateError("");
        setGateMode("remote");
        setPhase((current) => (current === READY ? current : GATE));
      } catch (exc) {
        if (live) setGateError(exc.message || String(exc));
      }
    })
      .then((off) => (live ? (stop = off) : off()))
      .catch(() => {});
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  // Going somewhere from the rail shuts it, on the layout where it is covering
  // what you are going to.
  // Back to the conversation from a page: a code session comes back to its
  // editor, anything else to the conversation screen.
  const currentMode = current?.mode;
  const goTo = useCallback(
    (next) => {
      setView(next === "chat" && currentMode === "code" ? "code" : next);
      setSidebarOpen(false);
    },
    [currentMode],
  );

  // A fresh conversation of a kind, on the one page every conversation starts
  // from. Nothing is created on the server until the first message. A code
  // session can be handed the folder it will work in; otherwise it keeps the
  // one last picked.
  const startNewOf = useCallback(
    (kind = "chat", { workspace } = {}) => {
      setView("chat");
      setSidebarOpen(false);
      setNewAgentId(null);
      setNewProjectId(null);
      setNewKind(kind);
      if (kind === "design") setNewDesign(null);
      if (kind === "code" && workspace !== undefined) setNewWorkspace(workspace);
      startNew();
      setFocusToken((n) => n + 1);
    },
    [startNew],
  );
  const handleNewSession = useCallback(() => startNewOf("chat"), [startNewOf]);
  const handleNewDesign = useCallback(() => startNewOf("design"), [startNewOf]);

  // To an agent's chat: its one conversation, opened where it was left, or --
  // before the first message -- a fresh one that will become it, run as the
  // agent from its first turn.
  const startWithAgent = useCallback(
    (agentId) => {
      setView("agents");
      setRoomAgentId(agentId);
      setSidebarOpen(false);
      setNewKind("chat");
      setNewAgentId(agentId);
      setNewProjectId(null);
      startNew();
      setFocusToken((n) => n + 1);
    },
    [startNew],
  );
  // The space follows what is on screen: a design or a code conversation
  // (or the empty page set to start one) is Studio's, a chat or an agent is
  // Home's. Projects and Skills are in both, and leave it where it is.
  const onScreen =
    view === "code" ? "studio"
    : view === "agents" ? "home"
    : view === "chat" ? (designing || startingCode ? "studio" : "home")
    : null;
  useEffect(() => {
    if (onScreen) setSpace(onScreen);
  }, [onScreen]);


  const enterRoom = useCallback(
    (agentId) => {
      const existing = agentChats.get(agentId);
      setView("agents");
      setRoomAgentId(agentId);
      setSidebarOpen(false);
      if (!existing) {
        startWithAgent(agentId);
        return;
      }
      if (existing.id !== chat.sessionId) openSession(existing.id).catch(() => {});
      setFocusToken((n) => n + 1);
    },
    [agentChats, chat.sessionId, openSession, startWithAgent],
  );
  // From a code session, the next one starts in the same project -- changed
  // under the composer if it should be another.
  const handleNewCode = useCallback(
    () => startNewOf("code", view === "code" && codeRoot ? { workspace: codeRoot } : {}),
    [startNewOf, view, codeRoot],
  );

  // The composer's type switch, on the new-conversation page. What was typed
  // stays in the box.
  const chooseKind = useCallback((kind) => {
    setNewKind(kind);
    // A chat project can hold a design, not the other way round, and a code
    // conversation is filed by its folder: drop a pick the new kind cannot use.
    setNewProjectId((id) => {
      const picked = id ? projects.projects.find((p) => p.id === id) : null;
      if (!picked || kind === "code") return null;
      return (picked.kind || "chat") === "design" && kind !== "design" ? null : id;
    });
    if (kind === "code") setNewWorkspace((was) => was || lastCodeRoot.current);
    setFocusToken((n) => n + 1);
  }, [projects.projects]);

  // The first message of a code session: sent from the new-conversation page,
  // then on to the Code view, where the editor shows its project as it works.
  const sendCode = useCallback(
    (text, files, effort) => {
      chat.send(text, files, effort, null);
      setView("code");
    },
    [chat.send],
  );

  // A folder picked for the Code view. An open code conversation moves to it;
  // otherwise it is where the next one starts.
  const handlePickFolder = useCallback(
    async (root) => {
      setPickingFolder(false);
      if (chat.sessionId && current?.mode === "code") {
        await api.setSessionWorkspace(chat.sessionId, root).catch(() => {});
        await onSessionsChanged();
      } else {
        setNewWorkspace(root);
      }
    },
    [api, chat.sessionId, current, onSessionsChanged],
  );

  // A code project's folder, opened in the Code view on a fresh conversation.
  // `message` is the first thing said there: sent at once with `start`,
  // otherwise left in the composer to be edited first.
  const openCodeFolder = useCallback(
    (root, { message = null, start = false } = {}) => {
      if (!root) return;
      // After the fresh conversation, which puts the new-conversation page
      // up: the later view is the one that stands.
      startNewOf("code", { workspace: root });
      setView("code");
      if (message && start) setKickoffFor({ root, text: message });
      else if (message) setDraft({ text: message });
    },
    [startNewOf],
  );

  // Sent once the Code view is on the new folder and nothing is in flight --
  // a render after openCodeFolder, when `send` has the new folder to send.
  useEffect(() => {
    if (!kickoffFor || view !== "code" || chat.sessionId || chat.streaming) return;
    if (newWorkspace !== kickoffFor.root) return;
    const text = kickoffFor.text;
    setKickoffFor(null);
    chat.send(text, [], null, null);
  }, [kickoffFor, view, chat.sessionId, chat.streaming, chat.send, newWorkspace]);

  // The new-code-project dialog's Create: make it, then go and work in it.
  const handleCreateCodeProject = useCallback(
    async (name, extra, { message, start }) => {
      const made = await projects.create(name, "code", extra);
      setNewProject(null);
      openCodeFolder(made.root || made.path, { message, start });
    },
    [projects, openCodeFolder],
  );

  // A design begun inside a design project: made up front, like a chat begun
  // inside a chat project, since there is nowhere else to record the folder.
  const handleNewDesignIn = useCallback(
    async (projectId) => {
      const created = await api.createSession({ mode: "design" });
      if (projectId) await api.setSessionProject(created.id, projectId);
      await onSessionsChanged();
      setView("chat");
      setNewKind("design");
      setNewDesign(null);
      await openSession(created.id).catch(() => {});
      setFocusToken((n) => n + 1);
    },
    [api, onSessionsChanged, openSession],
  );

  // "Build in code", from a design conversation's top bar: its design project
  // when it is filed in one, otherwise the conversation itself.
  const handleBuildThis = useCallback(() => {
    const filed = current?.project_id
      ? projects.projects.find((p) => p.id === current.project_id && p.kind === "design")
      : null;
    setNewProject(
      filed
        ? { source: `p:${filed.id}`, name: filed.name }
        : { source: `s:${chat.sessionId}`, name: chat.title !== "New conversation" ? chat.title : "" },
    );
  }, [current, projects.projects, chat.sessionId, chat.title]);

  // For cards in the thread: "Open in Code" on a project a tool just made.
  const appActions = useMemo(() => ({ openCodeFolder }), [openCodeFolder]);

  // "Start a design with this", from the standards page: a new design
  // conversation with that look already picked.
  const handleDesignWith = useCallback(
    (design) => {
      startNewOf("design");
      setNewDesign(design);
    },
    [startNewOf],
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
      setNewKind("chat");
      await openSession(created.id).catch(() => {});
      setFocusToken((n) => n + 1);
    },
    [api, onSessionsChanged, openSession],
  );

  const handleFileSession = useCallback(
    async (sessionId, projectId) => {
      try {
        await api.setSessionProject(sessionId, projectId);
      } catch (exc) {
        // A folder of the wrong kind: the server says which kind it takes.
        window.alert(exc.message || "That conversation cannot go there.");
      }
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
      // An agent's chat opens on the Agents screen, with the agent.
      if (known && agentChatIds.has(id)) {
        setView("agents");
        setRoomAgentId(known.agent_id);
        setSidebarOpen(false);
        openSession(id).catch(() => {});
        return;
      }
      const viewFor = (mode) => (mode === "code" ? "code" : "chat");
      // A code conversation's folder, before the conversation itself has
      // loaded: the editor stays on it rather than blinking to nothing.
      if (known?.mode === "code") setNewWorkspace(known.workspace || null);
      setView(viewFor(known?.mode));
      setSidebarOpen(false);
      openSession(id)
        .then((session) => {
          if (session && !known) setView(viewFor(session.mode));
        })
        .catch(() => {});
    },
    [openSession, sessions.sessions, agentChatIds],
  );

  // Each space's last conversation, so switching back is going back to where
  // you were rather than to a blank page. Only ever one conversation is open
  // in the app, so this is what lets each space keep its own.
  const lastInSpace = useRef({ home: null, studio: null });
  useEffect(() => {
    if (current && !agentChatIds.has(current.id)) lastInSpace.current[spaceOf(current)] = current.id;
  }, [current, agentChatIds]);

  // The switch in the app bar. Going to a space goes back to what it had on
  // screen -- still open, or the last conversation it had -- and otherwise
  // to a fresh one: a new chat in Home, a new design or code session in
  // Studio.
  const goToSpace = useCallback(
    (next) => {
      setSpace(next);
      setSidebarOpen(false);
      const open = current && !agentChatIds.has(current.id) ? current : null;
      if (open && spaceOf(open) === next) {
        setView(open.mode === "code" ? "code" : "chat");
        return;
      }
      const last = lastInSpace.current[next];
      if (last && sessions.sessions.some((s) => s.id === last)) {
        handleOpenSession(last);
        return;
      }
      startNewOf(next === "home" ? "chat" : studioKind.current);
    },
    [current, agentChatIds, sessions.sessions, handleOpenSession, startNewOf],
  );

  // The settings window: shut (null), or open on one of its screens. Opened
  // from the gear in the app bar, from ⌘, as on any Mac app, and on Models
  // from the model menu's "manage".
  const [settingsAt, setSettingsAt] = useState(null);
  const closeSettings = useCallback(() => setSettingsAt(null), []);
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsAt((was) => (was ? null : "general"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Bom ▸ Settings… (⌘,) in the desktop app's menu bar. Opens the window,
  // or leaves it open on the screen it is showing.
  useEffect(() => {
    let off = null;
    let live = true;
    listenForSettings(() => setSettingsAt((was) => was || "general"))
      .then((unlisten) => (live ? (off = unlisten) : unlisten()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // The desktop app's File menu and tray start new conversations too (New
  // Chat ⌘1, New Code Session ⌘2, New Design ⌘3).
  const startNewRef = useRef(startNewOf);
  startNewRef.current = startNewOf;
  useEffect(() => {
    let off = null;
    let live = true;
    listenForNew((kind) => startNewRef.current(kind))
      .then((unlisten) => (live ? (off = unlisten) : unlisten()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // -- render ---------------------------------------------------------------

  if (phase === BOOT) return null;

  if (phase !== READY) {
    if (gateMode === "remote") {
      return (
        <RemoteGate
          error={gateError}
          connectingTo={phase === CONNECTING && remote ? remote.id : null}
          onConnect={handleRemoteConnect}
          onUseToken={
            REMOTE_ONLY
              ? null
              : () => {
                  setGateError("");
                  setGateMode("token");
                }
          }
        />
      );
    }
    return (
      <TokenGate
        error={gateError}
        connecting={phase === CONNECTING}
        onSubmit={handleConnect}
        onRemote={() => {
          setGateError("");
          setGateMode("remote");
        }}
      />
    );
  }

  /* The conversation on screen -- top bar, thread, composer, openers -- for
   * the chat screen, or with `room` set for an agent's room. One definition,
   * so an agent's conversation is exactly the app's conversation: the room
   * only takes away what the room already answers (which agent, what kind)
   * and the width handles that belong to the full-width sheet. */
  // The folders this conversation can go in -- and the one it is in, so the
  // picker shows the truth for an older filing. A chat project also holds
  // designs; a design project holds only designs.
  const fileable = projects.projects.filter((p) => {
    const kind = p.kind || "chat";
    if (p.id === current?.project_id) return true;
    if (kind === "code") return false;
    return designing ? true : kind === "chat";
  });

  const renderConversation = (room) => (
    <>
      {room ? null : ["left", "right"].map((side) => (
        <div
          key={side}
          className="read-resize"
          data-side={side}
          role="separator"
          aria-orientation="vertical"
          aria-label="Conversation width"
          tabIndex={0}
          onPointerDown={readSize.start(side)}
          onKeyDown={readSize.nudge(side)}
          onDoubleClick={() => readSize.nudge(side)({ key: "Reset", preventDefault() {} })}
        >
          <i />
        </div>
      ))}
{/* An agent's chat is headed by the agent (AgentsScreen), not by a
          conversation title and its pickers. */}
      {room ? null : (
              <TopBar
          // Until the server names it after the first exchange.
          title={
            !chat.sessionId || chat.title === "New conversation"
              ? designing
                ? "New design"
                : startingCode
                  ? "New code session"
                  : chat.title
              : chat.title
          }
          mode={designing ? "design" : startingCode ? "code" : "chat"}
          looks={looks}
          look={look}
          onLook={(design) => handleLook(design).catch(() => {})}
          badge={chat.badge}
          // Only the folders this conversation can go in -- and the one
          // it is in, so the picker shows the truth for an older filing.
          projects={projects.projects.filter(
            (p) =>
              (p.kind || "chat") === (designing ? "design" : "chat") ||
              p.id === current?.project_id,
          )}
          canFile={false}
          onBuildInCode={designing && chat.sessionId && canvas.count > 0 ? handleBuildThis : null}
          projectId={current?.project_id || null}
          onProject={(projectId) => handleFileSession(chat.sessionId, projectId)}
          onNewSession={
            room
              ? () => startWithAgent(room.id)
              : designing
                ? handleNewDesign
                : startingCode
                  ? handleNewCode
                  : handleNewSession
          }
          canvasCount={canvas.count}
          canvasOpen={canvas.open}
          onToggleCanvas={toggleCanvas}
          browserShown={browser.has}
          browserOpen={browser.open}
          onToggleBrowser={toggleBrowser}
          // In a room the agent is the room; there is nothing to pick.
          agents={room ? [] : agents.agents}
          agentId={current?.agent_id || null}
          onAgent={async (agentId) => {
            await api.setSessionAgent(chat.sessionId, agentId);
            await onSessionsChanged();
          }}
        />
      )}

      <MessageList
        messages={chat.messages}
        look={room ? lookOf(room, agents.presets) : null}
        model={chat.badge?.text}
        scrollToken={chat.scrollToken}
        onDecide={chat.decide}
        onChooseDesign={chat.chooseDesign}
        onContinue={chat.continueTurn}
        head={
          room ? (
            <AgentGreeting agent={room} presets={agents.presets} />
          ) : designing ? (
            <DesignStartersHead />
          ) : startingCode ? (
            <CodeStartersHead name={newWorkspace ? folderName(newWorkspace) : null} />
          ) : null
        }
      />

      <Composer
        disabled={chat.streaming}
        onStop={chat.stop}
        focusToken={focusToken}
        draft={draft}
        // No name chip in an agent's chat: it has one chat, named by the agent.
        sessionLabel={chat.sessionId && !room ? chat.title : null}
        // Whichever side is actually answering describes its own
        // reasoning control; the composer draws what it is handed.
        thinking={thinking}
        onSend={startingCode ? sendCode : (text, files, effort) => chat.send(text, files, effort, make)}
        make={make}
        onMake={startingCode ? null : setMake}
        // Only before the first message: a conversation is what
        // it was started as.
        kind={newKind}
        // Design or Code, in Studio, before the first message. Home starts
        // chats and has nothing to choose.
        onKind={
          !room && space === "studio" && !chat.sessionId && chat.messages.length === 0 ? chooseKind : null
        }
        kinds={STUDIO_KINDS}
        agents={chat.sessionId || room ? [] : agents.agents}
        // The project, in the tray: picked before the first message and sent
        // with it, or -- once the conversation exists -- filed straight away.
        // Not for an agent's chat, and not for code, which goes by its folder.
        // (The top bar no longer files: this is the one place.)
        projects={fileable}
        projectId={current ? current.project_id || null : newProjectId}
        onProject={
          // Not drawn with nothing to choose: a picker offering only "None"
          // is clutter.
          room || startingCode || fileable.length === 0
            ? null
            : chat.sessionId
              ? (projectId) => handleFileSession(chat.sessionId, projectId)
              : setNewProjectId
        }
        agentId={newAgentId}
        onAgent={setNewAgentId}
        placeholder={
          designing
            ? "Describe what you want to make."
            : startingCode
              ? newWorkspace
                ? `Ask about ${folderName(newWorkspace)}, or describe a change.`
                : "Describe a change, or a new project to set up."
              : undefined
        }
      />

      {chat.messages.length === 0 ? (
        designing ? (
          <DesignStarters
            onPick={(text) => setDraft({ text })}
            presets={designs.presets}
            designs={designs.designs}
            value={look}
            onChoose={(design) => handleLook(design).catch(() => {})}
            onManage={() => setSettingsAt("standards")}
          />
        ) : startingCode ? (
          <CodeStarters
            onPick={(text) => setDraft({ text })}
            project={{
              api,
              value: newWorkspace,
              onChoose: setNewWorkspace,
              onOpenFolder: () => setPickingFolder(true),
              onNewProject: () => setNewProject({}),
              onManage: () => goTo("projects"),
              refreshKey: projects.projects,
            }}
          />
        ) : (
          <Starters onPick={(text) => setDraft({ text })} />
        )
      ) : null}
    </>
  );

  return (
    <ApiContext.Provider value={api}>
      <AppActions.Provider value={appActions}>
        <div
          className="app"
          data-rail={railPinned ? "pinned" : undefined}
          // While the drag is live the width transition has to come off, or the
          // panel arrives a couple of frames after the pointer and the handle
          // feels loose.
          data-resizing={rail.resizing || canvasSize.resizing || readSize.resizing ? "" : undefined}
          // Splits the sheet when the canvas is open, so the thread and the
          // document sit side by side rather than one over the other.
          data-canvas={conversing && (canvas.open || browser.open) ? "" : undefined}
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
          {pickingFolder ? (
            <FolderPicker
              api={api}
              onPick={handlePickFolder}
              onCancel={() => setPickingFolder(false)}
              onNewProject={() => {
                setPickingFolder(false);
                setNewProject({});
              }}
            />
          ) : null}
          {newProject ? (
            <NewProject
              api={api}
              library={library.groups}
              projectsDir={projects.projectsDir}
              initial={newProject}
              onCreate={handleCreateCodeProject}
              onCancel={() => setNewProject(null)}
            />
          ) : null}

          {agentSheet ? (
            <AgentEditor
              api={api}
              agent={agentSheet.agent}
              initial={agentSheet.initial}
              presets={agents.presets}
              onSave={async (body) => {
                if (agentSheet.agent) {
                  await agents.update(agentSheet.agent.id, body);
                } else {
                  const created = await agents.create(body);
                  if (created?.id) startWithAgent(created.id);
                }
                // An agent's accent is worn by its conversations, so the list
                // and the theme pick the change up from the sessions.
                await onSessionsChanged();
              }}
              onDelete={async (id) => {
                await agents.remove(id);
                if (roomAgentId === id) setRoomAgentId(null);
                // Its conversations are kept, unassigned: refetch their rows.
                await onSessionsChanged();
              }}
              onClose={() => setAgentSheet(null)}
            />
          ) : null}

          {/* The top row: the sidebar's toggle at its left -- on the narrow
              layout it opens the full-screen panel, on the wide one it pins
              the rail -- and the settings gear at its right. */}
          <AppBar
            sidebarOpen={narrow ? sidebarOpen : railPinned}
            onToggleSidebar={narrow ? () => setSidebarOpen((was) => !was) : togglePin}
            settingsOpen={Boolean(settingsAt)}
            onSettings={() => setSettingsAt((was) => (was ? null : "general"))}
            space={space}
            onSpace={goToSpace}
          />

          {settingsAt ? (
            <Settings
              section={settingsAt}
              onSection={setSettingsAt}
              onClose={closeSettings}
              status={status}
              models={models}
              provider={provider}
              onProvider={setProvider}
              pinned={railPinned}
              onTogglePin={togglePin}
              api={api}
              sessions={sessions.sessions}
              onSessionsChanged={onSessionsChanged}
              onSignOut={() => {
                setSettingsAt(null);
                signOut("");
              }}
              remoteName={remote?.name || null}
              theme={theme}
              appearance={appearance}
              // The design standards live in Settings now. "Use" starts a
              // design with one, in Studio, and shuts the window.
              standards={{
                designs: designs.designs,
                presets: designs.presets,
                onCreate: designs.create,
                onUpdate: designs.update,
                onDelete: designs.remove,
                onUse: (design) => {
                  setSettingsAt(null);
                  handleDesignWith(design);
                },
              }}
            />
          ) : null}

          <div className="app-body">
            {/* The conversation list lives inside the rail now -- it unfolds under
                Chat when the rail opens, so there is no drawer to slide over the
                thread and no second place to look for the same list. */}
            <NavRail
              view={view}
              space={space}
              onView={(next) => {
                // The space's conversations, from a page: back to what the
                // space had open, or a fresh one if what is loaded belongs to
                // the other space.
                if (next === "chat" && (!current || spaceOf(current) !== space || agentChatIds.has(current.id))) {
                  if (space === "studio") startNewOf(studioKind.current);
                  else handleNewSession();
                  return;
                }
                // Back to Agents: the agent you were talking to, still open.
                if (next === "agents" && roomAgentId && agents.agents.some((a) => a.id === roomAgentId)) {
                  enterRoom(roomAgentId);
                  return;
                }
                goTo(next);
              }}
              narrow={narrow}
              forceOpen={sidebarOpen}
              status={status}
              providers={backends}
              provider={provider}
              onProvider={setProvider}
              onChooseModel={chooseModel}
              onManageProviders={() => setSettingsAt("models")}
              pinned={railPinned}
              resizable={rail.enabled}
              resizing={rail.resizing}
              onResizeStart={rail.start}
              onResizeKey={rail.nudge}
              railWidth={rail.width}
              sessions={spaceSessions}
              projects={projects.projects}
              agents={agents.agents}
              onFileSession={handleFileSession}
              activeId={chat.sessionId}
              onOpenSession={handleOpenSession}
              // "+ New" and the logo start the space's own kind of thing.
              onNewSession={space === "studio" ? () => startNewOf(studioKind.current) : handleNewSession}
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
              ref={screenRef}
              style={talking && readSize.width ? { "--read-w": `${readSize.width}px` } : undefined}
              data-view={talking ? (designing ? "design" : "chat") : roomAgent ? "agent" : view}
              data-empty={(conversing || view === "code") && chat.messages.length === 0 ? "" : undefined}
              // No conversation on screen -- an empty chat or design, or the
              // Code view's project page -- and the sheet turns to glass, the
              // way QuickView is: the frost behind the window shows through.
              data-glass={
                chat.messages.length === 0 && (conversing || (view === "code" && !workspaceRoot))
                  ? ""
                  : undefined
              }
            >
              {view === "code" ? (
                <CodeView
                  api={api}
                  ws={ws}
                  mode={appearance.mode}
                  themeKey={`${appearance.mode}:${theme.seed?.hue ?? "off"}:${theme.seed?.chroma ?? ""}`}
                  busy={chat.streaming}
                  onChangeFolder={() => setPickingFolder(true)}
                  onPickFolder={handlePickFolder}
                  onNewProject={() => setNewProject({})}
                  designs={library.groups}
                  linkedDesign={
                    projects.projects.find((p) => p.kind === "code" && p.path === workspaceRoot)?.source_id || null
                  }
                  onRefreshDesigns={library.refresh}
                  onAskAboutDesign={(text) => setDraft({ text })}
                  chat={
                    <>
                      <div className="code-chat-head">
                        <span className="code-chat-title">
                          {chat.sessionId && chat.title !== "New conversation" ? chat.title : "New code session"}
                        </span>
                        {chat.badge ? (
                          <span className="code-chat-badge mi" data-tone={chat.badge.tone || undefined}>
                            {chat.badge.text}
                          </span>
                        ) : null}
                        <span className="spacer" />
                        <button
                          type="button"
                          className="code-icon-btn"
                          title="New code session"
                          aria-label="New code session"
                          onClick={handleNewCode}
                        >
                          <Icon name="plus" />
                        </button>
                      </div>
                      <MessageList
                        messages={chat.messages}
                        model={chat.badge?.text}
                        scrollToken={chat.scrollToken}
                        onDecide={chat.decide}
                        onChooseDesign={chat.chooseDesign}
                        onContinue={chat.continueTurn}
                        head={<CodeStartersHead name={ws.info?.name} />}
                      />
                      <Composer
                        disabled={chat.streaming}
                        onStop={chat.stop}
                        focusToken={focusToken}
                        draft={draft}
                        // No name chip: the column's own header carries the
                        // conversation's name, and the column is too narrow to
                        // say it twice.
                        thinking={thinking}
                        onSend={(text, files, effort) => chat.send(text, files, effort, null)}
                        agents={chat.sessionId ? [] : agents.agents}
                        agentId={newAgentId}
                        onAgent={setNewAgentId}
                        placeholder={
                          workspaceRoot ? "Ask about this project, or describe a change." : "Pick a project on the left, or describe a new one."
                        }
                      />
                      {chat.messages.length === 0 ? <CodeStarters onPick={(text) => setDraft({ text })} /> : null}
                    </>
                  }
                />
              ) : talking ? (
                renderConversation(null)
              ) : view === "projects" ? (
                <Projects
                  // The space's kinds: chat projects in Home, design and code
                  // in Studio.
                  kinds={space === "studio" ? ["design", "code"] : ["chat"]}
                  projects={projects.projects}
                  sessions={sessions.sessions}
                  library={library.groups}
                  projectsDir={projects.projectsDir}
                  onOpenSession={handleOpenSession}
                  onNewProject={(name, kind) => projects.create(name, kind)}
                  onNewDesignIn={handleNewDesignIn}
                  onNewCodeIn={(project) => startNewOf("code", { workspace: project.path })}
                  onBuildInCode={(initial) => setNewProject(initial)}
                  onNewCodeProject={() => setNewProject({})}
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
              ) : view === "skills" ? (
                <Skills api={api} />
              ) : view === "agents" ? (
                <AgentsScreen
                  agents={agents.agents}
                  presets={agents.presets}
                  chatOf={(id) => agentChats.get(id) || null}
                  selected={roomAgent}
                  busy={chat.streaming}
                  onSelect={enterRoom}
                  onGallery={() => setRoomAgentId(null)}
                  onCustomize={(agent) => setAgentSheet({ agent, initial: null })}
                  canvasCount={canvas.count}
                  canvasOpen={canvas.open}
                  onToggleCanvas={toggleCanvas}
                  browserShown={browser.has}
                  browserOpen={browser.open}
                  onToggleBrowser={toggleBrowser}
                  gallery={
                    <AgentGallery
                      presets={agents.presets}
                      onNew={() => setAgentSheet({ agent: null, initial: null })}
                      onCustomizePreset={(preset) => setAgentSheet({ agent: null, initial: preset })}
                      // Added as it comes -- look, specialty and all -- and
                      // opened, the way adding a contact opens the chat.
                      onAddPreset={async (preset) => {
                        const created = await agents.create({
                          name: preset.name,
                          instructions: preset.instructions || null,
                          skills: preset.skills ?? null,
                          look: preset.look || null,
                        });
                        if (created?.id) startWithAgent(created.id);
                      }}
                    />
                  }
                >
                  {roomAgent ? renderConversation(roomAgent) : null}
                </AgentsScreen>
              ) : null}
            </div>

            {/* The document beside the conversation. A sibling of the sheet rather
                than a child of it, so it splits the width with the thread instead
                of scrolling inside it -- and only in chat, where a conversation is
                what a canvas belongs to. */}
            {conversing && browser.open ? (
              <BrowserPanel
                view={browser.view}
                onClose={browser.closePanel}
                resizable={canvasSize.enabled}
                width={canvasSize.width}
                onResizeStart={canvasSize.start}
                onResizeKey={canvasSize.nudge}
              />
            ) : conversing && canvas.open ? (
              <Canvas
                canvases={canvas.canvases}
                active={canvas.active}
                onSelect={canvas.select}
                onClose={canvas.closePanel}
                onSave={canvas.save}
                onCreate={canvas.create}
                onImport={canvas.importCanvas}
                onDelete={canvas.remove}
                fallbackTheme={lookTokens}
                resizable={canvasSize.enabled}
                width={canvasSize.width}
                onResizeStart={canvasSize.start}
                onResizeKey={canvasSize.nudge}
              />
            ) : null}
          </div>

        </div>
      </AppActions.Provider>
    </ApiContext.Provider>
  );
}
