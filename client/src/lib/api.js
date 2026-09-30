// Transport. Knows about HTTP and SSE framing; knows nothing about React.

import { clientContext } from "./clientContext";
import { serverOrigin } from "./serverOrigin";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** The server answered and said no. Distinct from the network giving out. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// FastAPI puts the readable part in `detail` -- a string for the errors we
// raise, a list of field problems for a failed validation. Either way the
// composer should show a sentence, not a serialised object.
async function reason(response) {
  const body = await response.text();
  try {
    const { detail } = JSON.parse(body);
    if (typeof detail === "string") return detail;
    // A refusal that carries more than a sentence -- a save conflict says when
    // the file on disk was written -- still leads with one.
    if (detail && typeof detail.message === "string") return detail.message;
    if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  } catch {
    // not JSON; the raw body is the best thing we have
  }
  return body || response.statusText;
}

// SSE over fetch rather than EventSource: EventSource can't set an
// Authorization header, and this way a dropped connection surfaces as a
// normal rejected promise we can show in the thread.
export async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) {
        yield { event, data: JSON.parse(data.join("\n")) };
      }
    }
  }
}

/**
 * Bind a bearer token to the endpoints the UI actually calls.
 *
 * `onUnauthorized` fires before the rejection propagates, so a token that has
 * stopped working drops the whole app back to the gate no matter which call
 * happened to notice first.
 */
export function createApi(token, onUnauthorized = () => {}) {
  async function request(path, options = {}) {
    // Absolute under Tauri, relative in a browser -- see serverOrigin.
    const response = await fetch(serverOrigin() + "/api" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new UnauthorizedError();
    }
    if (!response.ok) {
      throw new ApiError(await reason(response), response.status);
    }
    return response;
  }

  const json = async (path, options) => (await request(path, options)).json();

  return {
    request,
    status: () => json("/status"),

    // -- providers and models -------------------------------------------
    // One call for the whole picker: every backend, whether it is reachable,
    // what it is pointed at, and everything it could be pointed at instead.
    listModels: () => json("/models"),
    // Server state, not a per-request preference. The phone and the laptop are
    // looking at the same assistant, so a model chosen on one is chosen.
    setProviderModel: (provider, model) =>
      json("/providers/" + encodeURIComponent(provider) + "/model", {
        method: "PUT",
        body: JSON.stringify({ model }),
      }),
    // Empty disconnects. The server checks a non-empty key against OpenRouter
    // before writing it down, so a rejected key comes back as a 400 here
    // rather than as a failed message an hour later.
    setOpenRouterKey: (key) =>
      json("/providers/openrouter/key", {
        method: "PUT",
        body: JSON.stringify({ key }),
      }),
    // An Ollama on another machine on this network. Empty disconnects; the
    // server checks it is local and that Ollama answers before keeping it.
    setNetworkOllama: (url) =>
      json("/providers/network/url", {
        method: "PUT",
        body: JSON.stringify({ url }),
      }),
    // A scan of this server's own subnet for the Ollama port.
    discoverNetworkOllama: () => json("/providers/network/discover"),
    // The sign-in. The server mints the URL; opening it is this side's job,
    // because the server has no browser and is often not even on the device
    // being used. `callback_base` is this origin -- how the browser reached
    // the server -- which is the only address it can be sent back to.
    startOpenRouterSignIn: (callbackBase) =>
      json("/providers/openrouter/signin", {
        method: "POST",
        body: JSON.stringify({ callback_base: callbackBase }),
      }),
    openRouterSignInStatus: (state) =>
      json("/providers/openrouter/signin/" + encodeURIComponent(state)),
    listSkills: () => json("/skills"),
    listTools: () => json("/tools"),
    listMcpServers: () => json("/mcp/servers"),
    listMcpPresets: () => json("/mcp/presets"),
    createMcpServer: (server) =>
      json("/mcp/servers", { method: "POST", body: JSON.stringify(server) }),
    instantiateMcpPreset: (data) =>
      json("/mcp/presets/instantiate", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    updateMcpServer: (id, patch) =>
      json("/mcp/servers/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    deleteMcpServer: (id) =>
      request("/mcp/servers/" + encodeURIComponent(id), { method: "DELETE" }),
    syncMcpServer: (id) =>
      json("/mcp/servers/" + encodeURIComponent(id) + "/sync", {
        method: "POST",
      }),

    // -- MCP icons and import -------------------------------------------
    // Blobs, not URLs, for the same reason attachments are: these endpoints
    // are authenticated, and a bare <img src> cannot set a bearer header, so
    // it would 401 on every icon. The bytes come through fetch and get wrapped
    // in an object URL locally.
    mcpServerIcon: async (id) =>
      (await request("/mcp/servers/" + encodeURIComponent(id) + "/icon")).blob(),
    mcpPresetIcon: async (id) =>
      (await request("/mcp/presets/" + encodeURIComponent(id) + "/icon")).blob(),
    uploadMcpIcon: (id, data, mime) =>
      json("/mcp/servers/" + encodeURIComponent(id) + "/icon", {
        method: "PUT",
        body: JSON.stringify({ data, mime }),
      }),
    clearMcpIcon: (id) =>
      json("/mcp/servers/" + encodeURIComponent(id) + "/icon", { method: "DELETE" }),
    refreshMcpIcon: (id) =>
      json("/mcp/servers/" + encodeURIComponent(id) + "/icon/refresh", {
        method: "POST",
      }),
    importMcpServers: (config, enabled = true) =>
      json("/mcp/servers/import", {
        method: "POST",
        body: JSON.stringify({ config, enabled }),
      }),
    // Signing in to a hosted MCP server (Atlassian, Linear, Notion, ...):
    // start it, then poll. `callbackBase` is this origin, which the sign-in
    // page sends the browser back to.
    startMcpSignIn: (id, callbackBase) =>
      json("/mcp/servers/" + encodeURIComponent(id) + "/signin", {
        method: "POST",
        body: JSON.stringify({ callback_base: callbackBase }),
      }),
    mcpSignInStatus: (state) => json("/mcp/signin/" + encodeURIComponent(state)),
    mcpSignOut: (id) =>
      json("/mcp/servers/" + encodeURIComponent(id) + "/signin", { method: "DELETE" }),
    mcpSettings: () => json("/mcp/settings"),
    setMcpSettings: (patch) =>
      json("/mcp/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    setSkillKey: (name, key) =>
      json("/skills/" + encodeURIComponent(name) + "/key", {
        method: "PUT",
        body: JSON.stringify({ key }),
      }),
    setSkillEnabled: (name, enabled) =>
      json("/skills/" + encodeURIComponent(name), {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    // Enterprise mode: the switch, and the limits either side of it.
    getEnterprise: () => json("/enterprise"),
    setEnterprise: (enabled) =>
      json("/enterprise", { method: "PATCH", body: JSON.stringify({ enabled }) }),
    // The approval switch, and the standing per-skill grants behind it. Both
    // optional on the wire, so a page can send one without the other.
    setApprovalSettings: (patch) =>
      json("/skills/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    // Answer one pending prompt. The turn is still streaming on another
    // connection and resumes the moment this lands.
    answerApproval: (id, decision) =>
      json("/chat/approve/" + encodeURIComponent(id), {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    // -- designs ---------------------------------------------------------
    // A design.md is the styling brief a result is held to. The presets ship
    // with the server; these are the reader's own, which sit beside them in
    // the chooser the model raises mid-turn.
    listDesigns: () => json("/designs"),
    listDesignPresets: () => json("/designs/presets"),
    createDesign: (design) =>
      json("/designs", { method: "POST", body: JSON.stringify(design) }),
    updateDesign: (id, patch) =>
      json("/designs/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    deleteDesign: (id) =>
      request("/designs/" + encodeURIComponent(id), { method: "DELETE" }),
    // Answer the question a turn is holding open. Like answerApproval, the
    // turn is still streaming on another connection and resumes when this
    // lands; the chosen document goes back into the window as the result.
    answerDesign: (id, choice) =>
      json("/chat/design/" + encodeURIComponent(id), {
        method: "POST",
        body: JSON.stringify({ choice }),
      }),

    listSessions: () => json("/sessions"),
    // `mode` is "chat" or "design"; `design` a standard picked up front.
    createSession: ({ mode = null, design = null } = {}) =>
      json("/sessions", {
        method: "POST",
        body: JSON.stringify({ client: clientContext(), mode, design }),
      }),
    // The design standard a conversation is styled to: a preset id, one of
    // the reader's own, "none", or null to forget it so the next deck asks.
    setSessionDesign: (sessionId, design) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/design", {
        method: "PUT",
        body: JSON.stringify({ design }),
      }),
    listProjects: () => json("/projects"),
    // `kind` is chat, design or code. A code project also takes `folder` (an
    // existing one to register; otherwise a new folder is made) and the
    // designs it is built from: `source_id` (a design project), `session_id`
    // (a design conversation) and/or `designs` (canvas ids).
    createProject: (name, kind = "chat", extra = {}) =>
      json("/projects", { method: "POST", body: JSON.stringify({ name, kind, ...extra }) }),
    designLibrary: () => json("/designs/library"),
    renameProject: (id, name) =>
      json("/projects/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    deleteProject: (id) =>
      json("/projects/" + encodeURIComponent(id), { method: "DELETE" }),
    setSessionProject: (sessionId, projectId) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/project", {
        method: "PUT",
        body: JSON.stringify({ project_id: projectId }),
      }),

    // -- agents ----------------------------------------------------------
    // A named persona with an optional subset of the skills, that a
    // conversation can be run as. No agent -- the default -- is the one
    // assistant with the whole shelf.
    listAgents: () => json("/agents"),
    // Ready-made agents to start from. Instantiated by posting one to
    // createAgent, or dropped into the editor to be tweaked first.
    listAgentPresets: () => json("/agents/presets"),
    createAgent: (agent) =>
      json("/agents", { method: "POST", body: JSON.stringify(agent) }),
    // Only the fields that changed. Sending `skills: null` resets an agent to
    // every skill; omitting it leaves the subset alone -- see AgentPatch.
    updateAgent: (id, patch) =>
      json("/agents/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    deleteAgent: (id) =>
      request("/agents/" + encodeURIComponent(id), { method: "DELETE" }),
    setSessionAgent: (sessionId, agentId) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/agent", {
        method: "PUT",
        body: JSON.stringify({ agent_id: agentId }),
      }),

    // -- accents ---------------------------------------------------------
    // Three scopes, one body. `theme: null` clears a scope rather than
    // turning colour off -- a cleared chat takes its project's accent, where
    // an accent of `{mode: "off"}` is a decision to wear none.
    getAppTheme: () => json("/theme"),
    setAppTheme: (theme) =>
      json("/theme", { method: "PUT", body: JSON.stringify({ theme }) }),
    setSessionTheme: (sessionId, theme) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/theme", {
        method: "PUT",
        body: JSON.stringify({ theme }),
      }),
    setProjectTheme: (projectId, theme) =>
      json("/projects/" + encodeURIComponent(projectId) + "/theme", {
        method: "PUT",
        body: JSON.stringify({ theme }),
      }),
    getSession: (id) => json("/sessions/" + id),
    deleteSession: (id) => request("/sessions/" + id, { method: "DELETE" }),

    // -- canvases --------------------------------------------------------
    // The document shown in the side panel. The model writes it through the
    // write_canvas skill, which streams the change down the /chat connection;
    // these are the other half -- what the client loads when it opens a
    // conversation, and what a reader editing the panel by hand saves back to.
    listCanvases: (sessionId) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/canvases"),
    createCanvas: (sessionId, body) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/canvases", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Only the fields that changed -- the server merges the rest, so a save
    // from the editor sends `content` alone and a rename sends `title` alone.
    updateCanvas: (id, patch) =>
      json("/canvases/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    deleteCanvas: (id) =>
      request("/canvases/" + encodeURIComponent(id), { method: "DELETE" }),
    // Every canvas in every conversation, without content -- the list "open
    // from another conversation" chooses from -- and a copy of one into this
    // conversation, pictures and all.
    listAllCanvases: () => json("/canvases"),
    copyCanvas: (id, sessionId) =>
      json("/canvases/" + encodeURIComponent(id) + "/copy", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      }),
    // -- images ----------------------------------------------------------
    // A conversation's own pictures, cleaned by the server on the way in and
    // referenced by id from decks and pages. Blobs rather than URLs for the
    // same reason as attachments: the route is behind the bearer token.
    listImages: (sessionId) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/images"),
    uploadImage: (sessionId, body) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/images", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Whether pictures can be generated here, and whether that leaves the
    // machine -- asked before the picker offers to.
    imageGenerator: () => json("/images/generator"),
    generateImage: (sessionId, body) =>
      json("/sessions/" + encodeURIComponent(sessionId) + "/images/generate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    imageBlob: async (id) => (await request("/images/" + encodeURIComponent(id))).blob(),
    updateImage: (id, patch) =>
      json("/images/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(patch) }),
    deleteImage: (id) => request("/images/" + encodeURIComponent(id), { method: "DELETE" }),
    deleteSessions: (ids) =>
      json("/sessions/delete", {
        method: "POST",
        body: JSON.stringify({ ids, confirm: true }),
      }),
    // Resolves to the raw response -- the caller drives it with readEvents().
    // `provider` is "local", "cloud", "openrouter", or null for whatever the
    // router picks.
    // Never switch silently -- the server records which one answered and the
    // reply's meta frame says so.
    // `signal` is what makes a turn abortable. Aborting it drops the
    // connection, which the server already treats as a finished turn: /chat
    // checks `request.is_disconnected()` between frames, and the orchestrator
    // persists whatever arrived in its `finally`. So stopping keeps the half
    // of the answer that was written rather than discarding it.
    chat: (
      message,
      sessionId,
      attachments = [],
      thinkingLevel = null,
      provider = null,
      agentId = null,
      signal = undefined,
      // For a brand-new conversation only: "chat", "design" or "code", a design
      // standard chosen on the empty screen, and a code conversation's project
      // folder, and the project a chat or design is filed in. The server
      // ignores all four once the session exists.
      // `make` is per message: the composer's Make menu, or null for auto.
      { mode = null, design = null, workspace = null, projectId = null, make = null } = {},
    ) =>
      request("/chat", {
        method: "POST",
        signal,
        body: JSON.stringify({
          message,
          session_id: sessionId,
          // Only the three fields the server's AttachmentIn declares -- the
          // reader also hands back `size`, which would fail validation.
          attachments: attachments.map(({ name, mime, data }) => ({ name, mime, data })),
          think: thinkingLevel,
          provider,
          agent_id: agentId,
          mode,
          design,
          workspace,
          project_id: projectId,
          make,
          // Sent every time, kept only the first time. This is the path that
          // matters most: the composer posts here with a null session_id to
          // start a conversation, so without it a new chat begun by typing --
          // rather than by pressing New -- would know nothing about the device
          // that started it.
          client: clientContext(),
        }),
      }),
    // A blob, not a URL: the endpoint is authenticated, so the bytes have to
    // come through fetch with the bearer header and be wrapped locally.
    attachment: async (id) => (await request("/attachments/" + id)).blob(),

    // -- the project folder, for the Code view ------------------------------
    // Every call names the folder: the server checks it each time rather than
    // remembering which one is open.
    browseFolders: (path = null) =>
      json("/workspace/browse" + (path ? "?path=" + encodeURIComponent(path) : "")),
    recentFolders: () => json("/workspace/recent"),
    openFolder: (path) =>
      json("/workspace/open", { method: "POST", body: JSON.stringify({ path }) }),
    folderTree: (root, path = ".") =>
      json(`/workspace/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    folderFiles: (root) => json(`/workspace/files?root=${encodeURIComponent(root)}`),
    readProjectFile: (root, path) =>
      json(`/workspace/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    saveProjectFile: (root, path, content, mtime, force = false) =>
      json("/workspace/file", {
        method: "PUT",
        body: JSON.stringify({ root, path, content, mtime, force }),
      }),
    createProjectEntry: (root, path, kind = "file") =>
      json("/workspace/entry", { method: "POST", body: JSON.stringify({ root, path, kind }) }),
    // -- the workbench: terminals and the preview ---------------------------
    // A terminal is a WebSocket, which cannot carry the bearer header -- so
    // the token goes as the first message rather than into the URL, where
    // it would sit in logs. `hello` names the folder for a new shell, or the
    // id of one to reattach to.
    openTerminal: (hello) => {
      const base = serverOrigin() || window.location.origin;
      const socket = new WebSocket(base.replace(/^http/, "ws") + "/api/terminal");
      socket.addEventListener("open", () => socket.send(JSON.stringify({ token, ...hello })));
      return socket;
    },
    listTerminals: (root) => json(`/terminals?root=${encodeURIComponent(root)}`),
    closeTerminal: (id) => json(`/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }),
    // Where the project's own files are served for the preview frame, and the
    // page to start on when there is an obvious one. The path is relative to
    // the server, so it is joined to its origin here.
    previewFiles: async (root) => {
      const found = await json("/workspace/preview", { method: "POST", body: JSON.stringify({ root }) });
      const base = (serverOrigin() || window.location.origin) + found.base;
      return { base, entry: found.entry };
    },
    importDesigns: (root, designs, into = "design") =>
      json("/workspace/designs", { method: "POST", body: JSON.stringify({ root, designs, into }) }),
    setSessionWorkspace: (sessionId, workspace) =>
      json(`/sessions/${encodeURIComponent(sessionId)}/workspace`, {
        method: "PUT",
        body: JSON.stringify({ workspace }),
      }),

    // -- memory ---------------------------------------------------------
    // Facts, switches, document counts and index size arrive together: the
    // page renders them as one screen, so it fetches them as one call.
    getMemory: () => json("/memory"),
    addFact: (text, category = null, pinned = false) =>
      json("/memory", {
        method: "POST",
        body: JSON.stringify({ text, category, pinned }),
      }),
    // Only the fields that changed. The server treats every one as optional,
    // which is what lets Edit, Keep always and Looks right? share a route.
    editFact: (id, patch) =>
      json("/memory/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    forgetFact: (id) =>
      request("/memory/" + encodeURIComponent(id), { method: "DELETE" }),
    forgetAllFacts: () =>
      json("/memory/forget-all", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      }),
    setMemorySettings: (patch) =>
      json("/memory/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    reindexMemory: () => json("/memory/reindex", { method: "POST" }),
    // A blob for the same reason as an attachment: the route is behind the
    // bearer token, so a plain link would 401.
    exportMemory: async () => (await request("/memory/export")).blob(),
  };
}
