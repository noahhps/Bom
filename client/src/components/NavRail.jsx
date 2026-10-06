import { useCallback, useRef, useState } from "react";

import { AgentFlower } from "./AgentFlower";
import { useDialog } from "./Dialog";
import { Icon } from "./Icon";
import { ModelMenu } from "./ModelMenu";
import { seedFromContext } from "../lib/autotheme";
import { swatchOf } from "../lib/theme";

/* The rail from artboard 1a, which opens out under the pointer.
 *
 * Three destinations set vertically between two circles, and the circles are
 * controls rather than decoration: the mark at the head starts a fresh
 * conversation, while the one at the foot chooses which provider answers and
 * which of its models it answers with. Both stay put
 * and stay clickable when the rail is shut, which is most of the time -- they
 * are the two things you reach for without wanting to read a menu first.
 *
 * The foot circle also still reports reachability by its colour, so the thing
 * you click to change the provider is the same thing that tells you the
 * current one has stopped answering.
 *
 * Two modes. Left alone the rail opens on hover and closes again, overlaying
 * the conversation without reflowing it. Pinned, it stays open and takes real
 * width so the sheet sits beside it. Openness is computed here rather than in
 * CSS: hover, keyboard focus, the pin and an open menu all have to produce the
 * same visual state, and expressing that as four selector variants on a dozen
 * rules is how one of them ends up forgotten.
 */

const LIST_KEY = "unified-llm-rail-list-open";

// The conversations are not in this list: they are a group with the list
// folded under it, drawn by `RailGroup` below the plain destinations.
/* Each space's pages (the spaces themselves are switched in the app bar --
   see AppBar.jsx). Skills is in both, being what the model can do wherever
   it is asked. */
const DESTINATIONS = {
  // Home's conversations are Messages, whose own list sits beside the thread
  // the way a messenger's does -- so here it is a page, not a fold.
  home: [
    { id: "chat", label: "Messages", icon: "chat_bubble" },
    { id: "agents", label: "Agents", icon: "agents" },
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "skills", label: "Skills", icon: "skills" },
  ],
  studio: [
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "skills", label: "Skills", icon: "skills" },
  ],
  // Memory, Settings and the design standards are not here: they are
  // screens of the settings window, behind the gear in the app bar.
};

/* The destination's name.
 *
 * One copy now. There used to be a second, set vertically, which was what the
 * rail showed while shut -- the glyphs were held at zero width and the labels
 * were the whole of the closed state. Shut, it is a column of icons instead,
 * so the sideways copy has nothing left to do.
 *
 * This one stays in the DOM at every width, hidden with opacity rather than
 * `display: none`, which is what keeps the button's accessible name the same
 * whether the rail is open or shut. A screen reader reads "Calendar" either
 * way; only the eye sees the difference. */
function Label({ label }) {
  return <span className="lbl-h">{label}</span>;
}

/* The colour a conversation wears in the list.
 *
 * Its own accent if it has one, otherwise its project's -- the same order
 * `useTheme` resolves in when it dresses the conversation itself, so a chat
 * shows the same colour in the rail as it does once opened.
 *
 * An assigned agent always gets a bead. Agents without an explicit theme use a
 * stable color derived from their name, while unassigned chats still fall back
 * to the project accent when one exists. */
function accentOf(session, projects) {
  // The dot says which project a conversation is filed in, and nothing else:
  // no project, no dot -- not an agent's colour, not the app's. A project
  // that has not chosen a colour still gets one of its own, derived from its
  // name, so the dot always tells projects apart (the Projects page draws its
  // beads the same way).
  if (!session.project_id) return null;
  const project = projects?.find((p) => p.id === session.project_id);
  if (!project) return null;
  return swatchOf(
    project.theme || { mode: "auto" },
    seedFromContext({ title: project.name, id: project.id }),
  );
}

/* A fold's open/shut state, remembered. A layout preference, so it persists
   like the pin does -- someone who keeps a list shut wants it shut tomorrow. */
function useFold(key) {
  const [open, setOpen] = useState(() => localStorage.getItem(key) !== "0");
  const toggle = useCallback(() => {
    setOpen((was) => {
      localStorage.setItem(key, was ? "0" : "1");
      return !was;
    });
  }, [key]);
  return [open, toggle];
}

/* A destination with a list of conversations folded under it. Two controls in the head, because they are two different intents:
 * the row goes somewhere, the chevron beside it shows or hides the list. One
 * button doing both meant you could not fold the list away without also
 * being taken to the page it belongs to.
 *
 * The chevron only appears once the rail is open; shut, the rail is a column
 * of icons and the lists are not on screen at all. */
function RailGroup({
  id,
  label,
  icon,
  current,
  open,
  onToggle,
  onGo,
  hint,
  newLabel,
  onNew,
  extra,
  children,
}) {
  const listId = `navrail-${id}-list`;
  return (
    <div className="navrail-group" data-group={id} data-area={id}>
      <button
        type="button"
        className="navrail-section"
        aria-current={current ? "page" : undefined}
        title={hint}
        onClick={onGo}
      >
        <Icon name={icon} />
        <Label label={label} />
      </button>
      <button
        type="button"
        className="navrail-fold"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={open ? `Hide ${label.toLowerCase()} list` : `Show ${label.toLowerCase()} list`}
        title={open ? "Hide list" : "Show list"}
        onClick={onToggle}
      >
        <Icon name="chevron" />
      </button>

      {/* Collapsed to nothing until the rail opens. Deliberately not `inert`
          while shut: the rail opens on focus, so making its contents
          unfocusable would mean a keyboard user could never open it -- tabbing
          in is the only way they have. */}
      <div className="navrail-sessions">
        <div className="navrail-sessions-inner">
          {newLabel ? (
            <button type="button" className="navrail-new" onClick={onNew}>
              {newLabel}
            </button>
          ) : null}
          {extra}
          <div id={listId} hidden={!open}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/* One conversation, wherever it is filed. */
function SessionRows({ sessions, projects, agents, activeId, onOpenSession, onDelete, empty }) {
  const { confirm } = useDialog();
  if (sessions.length === 0) {
    return (
      <li data-empty="true">
        <span className="navrail-empty">{empty}</span>
      </li>
    );
  }
  return sessions.map((session) => {
    const accent = accentOf(session, projects);
    const design = session.mode === "design";
    const code = session.mode === "code";
    return (
    <li
      key={session.id}
      data-mode={design ? "design" : code ? "code" : undefined}
      data-active={String(session.id === activeId)}
      draggable
      onDragStart={(event) => {
        // A custom type rather than text/plain, so dragging a conversation
        // over a text field somewhere does not offer to paste an id.
        event.dataTransfer.setData("text/session", session.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button className="navrail-session" onClick={() => onOpenSession(session.id)}>
        {/* Its project's colour, as a dot -- only when it is in one. A
            design or code conversation keeps its glyph beside the dot, in
            the text's colour: the glyph says what kind it is, the dot where
            it is filed. */}
        {accent ? (
          <span className="accent-bead" aria-hidden="true" style={{ background: accent }} />
        ) : null}
        {design || code ? (
          <span className="navrail-session-icon" aria-label={design ? "Design" : "Code"} role="img">
            <Icon name={design ? "design" : "code"} />
          </span>
        ) : null}
        <span className="navrail-session-title">{session.title || "Untitled"}</span>
      </button>
      <button
        className="navrail-session-delete"
        aria-label={`Delete ${session.title || "Untitled"}`}
        onClick={async (event) => {
          // Stopped synchronously, before the await: the row underneath opens
          // the conversation, and letting the click through while the dialog
          // is deciding would open the very thing being deleted.
          event.stopPropagation();
          const yes = await confirm("Delete this conversation?", {
            title: "Delete conversation",
            confirmLabel: "Delete",
            destructive: true,
          });
          if (yes) onDelete(session.id);
        }}
      >
        ×
      </button>
    </li>
    );
  });
}

export function NavRail({
  space = "home",
  view,
  onView,
  status,
  providers,
  provider,
  onProvider,
  onChooseModel,
  onManageProviders,
  pinned,
  resizable,
  resizing,
  onResizeStart,
  onResizeKey,
  railWidth,
  narrow = false,
  forceOpen = false,
  sessions,
  projects,
  agents,
  onFileSession,
  activeId,
  onOpenSession,
  onNewSession,
  onDelete,
}) {
  // Whether the conversation list is unfolded under its heading.
  const [listOpen, toggleList] = useFold(LIST_KEY);
  // Whether a dragged conversation is currently over the list. One at a time,
  // so one id rather than a set.
  const [dropOver, setDropOver] = useState(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const node = useRef(null);

  // The menu counts: it is a child of the rail, so letting the rail collapse
  // underneath an open menu would leave the menu floating beside nothing.
  // So does a drag: the pointer leaves the rail almost immediately when it is
  // widening it, and a rail that shut halfway through its own resize would be
  // impossible to use.
  //
  // None of that applies on the narrow layout, where the rail is a full-screen
  // panel worked by one button: there it is open exactly when that button says
  // so. Hover and focus would open it under a finger that was only scrolling.
  const open = narrow
    ? forceOpen
    : pinned || hovered || focused || menuOpen || resizing;

  // Focus anywhere in the panel holds it open, so a keyboard can reach
  // everything in it.
  const holdsOpen = (el) => Boolean(el && node.current?.contains(el));

  // Focus moving between two children fires blur then focus, which would flap
  // the panel shut and open again. Asking where focus actually landed after
  // the browser has moved it is the cheap fix.
  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const el = node.current;
      if (el && !holdsOpen(document.activeElement)) setFocused(false);
    });
  }, []);

  const serving = status?.serving;
  // Grey when local is answering, ochre when it fell through to a cloud
  // backend, flat when nothing is reachable at all.
  const tone =
    serving === "none" ? "down" : serving && serving !== "local" ? "warn" : undefined;
  // What the circle says, which is the model rather than the backend wherever
  // one is known: "gpt-oss" and "anthropic/claude-sonnet-4.5" are the two
  // things worth telling apart at a glance, and both of them are cloud or
  // local as a second question.
  const chosen = (providers || []).find((p) => p.id === (provider || serving));
  const label =
    chosen?.model ||
    (provider === "local"
      ? status?.local?.model || "Local"
      : provider === "cloud"
        ? status?.cloud?.model || "Cloud"
        : provider === "openrouter"
          ? status?.openrouter?.model || "OpenRouter"
          : serving === "none"
            ? "No model"
            : status?.[serving]?.model || "Local model");

  return (
    <nav
      className="navrail"
      aria-label="Sections"
      ref={node}
      data-open={open ? "" : undefined}
      data-narrow={narrow ? "" : undefined}
      // Nothing to reach for while it is shut on the narrow layout, and an
      // off-screen panel should not be in the tab order.
      aria-hidden={narrow && !open ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => {
        if (holdsOpen(event.target)) setFocused(true);
      }}
      onBlur={handleBlur}
    >
      {/* The reveal. Unpinned, the rail takes no width at all, so there is
          nothing left to hover -- this strip along the very edge of the window
          is what the pointer arrives at instead.

          It sits inside `.navrail` rather than beside it so the existing
          enter/leave handlers do the work: entering any descendant enters the
          rail, which is the same route the opened panel already takes when the
          pointer moves onto it from the sheet.

          Hidden when pinned (there is nothing to reveal) and on narrow screens,
          where the rail keeps a visible strip and opens on tap -- a hover
          target is no use to a finger. */}
      <div className="navrail-edge" aria-hidden="true" />

      <div className="navrail-inner">

        {/* The logo, small: the flower at 20px, a touch over a page glyph --
            and the name beside it, heading the rail like a label rather
            than as the largest thing in it. It starts a new conversation,
            as it always has. */}
        <div className="navrail-top">
          <button
            type="button"
            className="navrail-mark"
            aria-label="Start a new conversation"
            title="New conversation"
            onClick={onNewSession}
          >
            <AgentFlower open mark size={20} />
          </button>
          <span className="navrail-wordmark" aria-hidden="true">
            Bom
          </span>
        </div>

        <div className="navrail-dest">
          {/* The app's pages first, then the conversations -- the list is the
              one part of the rail that grows, so it goes last, where it can
              run on without pushing the pages out of reach. */}
          {/* New chat, first of the pages and drawn like them: starting
              something is the thing you do most, so it heads the list -- a
              chat in Home, a design or code session in Studio (the caller
              decides which). */}
          <button
            type="button"
            className="navrail-start"
            onClick={onNewSession}
            title={space === "studio" ? "New design or code session" : "New message"}
          >
            <Icon name={space === "studio" ? "plus" : "pen"} />
            <Label label={space === "studio" ? "New session" : "New message"} />
          </button>

          {DESTINATIONS[space].map((destination) => (
            <button
              key={destination.id}
              type="button"
              data-area={destination.id}
              aria-current={view === destination.id ? "page" : undefined}
              onClick={() => onView(destination.id)}
            >
              <Icon name={destination.icon} />
              <Label label={destination.label} />
            </button>
          ))}

          {/* The line between the app's pages and the conversations: the
              pages are places you go, the list below is things you made.
              Studio's only: Home's list is on the Messages screen. */}
          {space === "studio" ? <hr className="navrail-rule" aria-hidden="true" /> : null}

          {/* Every conversation -- chats, designs and code sessions -- in one
              list, newest first. A design or a code session wears its glyph at
              the left, so the three can be told apart at a glance; which kind
              a new one is gets chosen in its composer. */}
          {space === "studio" ? (
          <RailGroup
            id="chat"
            label={space === "studio" ? "Designs & code" : "Conversations"}
            icon={space === "studio" ? "design" : "chat_bubble"}
            current={view === "chat" || view === "code"}
            open={listOpen}
            onToggle={toggleList}
            onGo={() => onView("chat")}
            // Starting one is the button at the head of the rail now.
            newLabel={null}
            onNew={onNewSession}
          >
            {/* Every conversation, in one flat list.
             *
             * The projects used to be here too, each an unfoldable section
             * with its own chats nested inside and its own context menu --
             * which made this a second, worse copy of the Projects page inside
             * a 252px column. Projects live in one place now; this is the list
             * of conversations, and a chat's project shows as its colour rather
             * than as a folder it has to be dug out of. */}
            <ul
              id="navrail-session-list"
              data-over={dropOver === "unfiled" ? "" : undefined}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("text/session")) {
                  event.preventDefault();
                  setDropOver("unfiled");
                }
              }}
              onDragLeave={() =>
                setDropOver((was) => (was === "unfiled" ? null : was))
              }
              onDrop={(event) => {
                event.preventDefault();
                setDropOver(null);
                const id = event.dataTransfer.getData("text/session");
                // Dropping on the list takes a chat out of its project.
                // Filing it into one is done on the Projects page, which
                // is where the projects are.
                if (id) onFileSession(id, null);
              }}
            >
              <SessionRows
                sessions={sessions || []}
                projects={projects}
                agents={agents}
                activeId={activeId}
                onOpenSession={onOpenSession}
                onDelete={onDelete}
                empty="Nothing yet"
              />
            </ul>
          </RailGroup>
          ) : null}

        </div>

        <div className="spacer" />

        <div className="navrail-foot">
          {/* The connection is the flower, small: bright when the local model
              is answering, drooping when a cloud backend has taken over, grey
              with its eyes shut when nothing can answer. It was a green dot,
              which said the same thing in a colour the logo never uses. */}
          <button
            type="button"
            className="navrail-circle navrail-dot"
            data-tone={tone}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Answering with ${label} — change`}
            title={label}
            onClick={() => setMenuOpen((was) => !was)}
          >
            <AgentFlower open mark size={24} mood={tone} />
          </button>
          <span className="navrail-status" aria-hidden="true">
            {label}
          </span>
        </div>
      </div>

      {/* The sidebar's toggle is in the app bar (see AppBar.jsx) -- above
          the rail rather than floating over the sheet, so no screen has to
          leave room for it. */}

      {/* The right edge, as a drag handle. Only while the rail is open: shut,
          its width is the icons' width and there is nothing to choose. */}
      {open && resizable ? (
        <div
          className="navrail-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Sidebar width"
          aria-valuenow={railWidth}
          aria-valuemin={200}
          aria-valuemax={460}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
          // Double-click restores the drawn width, which is otherwise only
          // reachable by dragging back to a number nobody remembers.
          onDoubleClick={() => onResizeKey({ key: "Reset", preventDefault() {} })}
        >
          <i />
        </div>
      ) : null}

      {/* Outside .navrail-inner on purpose: the inner clips its overflow so the
          panel can animate its width, which would slice a menu in half. */}
      <ModelMenu
        open={menuOpen}
        status={status}
        providers={providers}
        value={provider}
        onChange={onProvider}
        onChooseModel={onChooseModel}
        onManage={() => {
          setMenuOpen(false);
          onManageProviders?.();
        }}
        onClose={() => setMenuOpen(false)}
      />
    </nav>
  );
}
