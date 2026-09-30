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
/* The two spaces, switched at the head of the rail. Home is conversation:
   chats, quick asks, and the agents you keep talking to. Studio is the
   longer work -- designs and code -- with its own conversations and
   projects. Each has its own pages; Skills is in both, being what the model
   can do wherever it is asked. */
export const SPACES = [
  { id: "home", label: "Home", icon: "home" },
  { id: "studio", label: "Studio", icon: "code" },
];

const DESTINATIONS = {
  home: [
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "skills", label: "Skills", icon: "skills" },
    { id: "agents", label: "Agents", icon: "agents" },
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
function accentOf(session, projects, agents) {
  // The agent it is run as wins, then the project it is filed under -- the same
  // order `useTheme` resolves in, so the bead is the colour the conversation
  // actually opens in. An assigned agent always has a stable color, including
  // when its theme is automatic.
  const agent = session.agent_id && agents?.find((a) => a.id === session.agent_id);
  if (agent) {
    return swatchOf(
      agent.theme || { mode: "auto" },
      seedFromContext({ id: agent.id, title: agent.name }),
    );
  }

  if (!session.project_id) return null;
  const project = projects?.find((p) => p.id === session.project_id);
  if (!project?.theme) return null;
  // A project has a name rather than a title and no messages, so an auto
  // accent seeds from what little it has.
  return swatchOf(
    project.theme,
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
          <button type="button" className="navrail-new" onClick={onNew}>
            {newLabel}
          </button>
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
    const accent = accentOf(session, projects, agents);
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
        {/* A design conversation wears the design glyph at its left, in both
            lists, so it can be told from a chat at a glance -- tinted with
            the conversation's accent where it has one, which is the colour
            the bead would otherwise have carried.

            Otherwise the bead shows the assigned agent's color first, then
            the project's color for chats that have no agent. */}
        {design || code ? (
          <span
            className="navrail-session-icon"
            aria-label={design ? "Design" : "Code"}
            role="img"
            style={accent ? { color: accent } : undefined}
          >
            <Icon name={design ? "design" : "code"} />
          </span>
        ) : accent ? (
          <span className="accent-bead" aria-hidden="true" style={{ background: accent }} />
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
  onSpace,
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
        <div className="navrail-top">
          {/* The mark is the agent's flower, open, at 42px -- the logo, and
              the largest thing in the rail's head. It turns while hovered. */}
          <button
            type="button"
            className="navrail-mark"
            aria-label="Start a new conversation"
            title="New conversation"
            onClick={onNewSession}
          >
            <AgentFlower open mark size={42} />
          </button>
          <span className="navrail-wordmark" aria-hidden="true">
            Bom
          </span>

        </div>

        {/* Home or Studio -- the app's segmented control, at the head of the
            rail the way Claude puts Home and Code. Open, the two sit side by
            side with their names; shut, the rail is a column of glyphs and so
            are they. */}
        <div className="segmented navrail-spaces" role="tablist" aria-label="Space">
          {SPACES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={space === item.id}
              data-active={space === item.id ? "" : undefined}
              title={item.label}
              onClick={() => onSpace?.(item.id)}
            >
              <Icon name={item.icon} />
              <span className="navrail-space-label">{item.label}</span>
            </button>
          ))}
        </div>

        <div className="navrail-dest">
          {/* The app's pages first, then the conversations -- the list is the
              one part of the rail that grows, so it goes last, where it can
              run on without pushing the pages out of reach. */}
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
              pages are places you go, the list below is things you made. */}
          <hr className="navrail-rule" aria-hidden="true" />

          {/* Every conversation -- chats, designs and code sessions -- in one
              list, newest first. A design or a code session wears its glyph at
              the left, so the three can be told apart at a glance; which kind
              a new one is gets chosen in its composer. */}
          <RailGroup
            id="chat"
            label={space === "studio" ? "Designs & code" : "Conversations"}
            icon={space === "studio" ? "design" : "chat_bubble"}
            current={view === "chat" || view === "code"}
            open={listOpen}
            onToggle={toggleList}
            onGo={() => onView("chat")}
            newLabel={space === "studio" ? "+ New design or code" : "+ New conversation"}
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
