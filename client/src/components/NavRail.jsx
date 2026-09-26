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
const DESIGN_LIST_KEY = "unified-llm-rail-design-list-open";

// Chat and Design are not in this list: each is a group with a conversation
// list folded under it, drawn by `RailGroup` above the plain destinations.
const DESTINATIONS = [
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "skills", label: "Skills", icon: "skills" },
  { id: "agents", label: "Agents", icon: "agents" },
  // Named for the page it opens. It was "tools", but `view === "tools"` has
  // never had a branch of its own -- it fell through to the Settings page,
  // which is also where the mark at the head of the rail goes. The label was
  // describing a screen that does not exist; the id now matches the one it
  // actually lands on.
  { id: "settings", label: "Settings", icon: "settings" },
];

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

/* A destination with a list of conversations folded under it -- Chat, and
 * Design. Two controls in the head, because they are two different intents:
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
    <div className="navrail-group" data-group={id}>
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
    return (
    <li
      key={session.id}
      data-mode={design ? "design" : undefined}
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
        {design ? (
          <span
            className="navrail-session-icon"
            aria-label="Design"
            role="img"
            style={accent ? { color: accent } : undefined}
          >
            <Icon name="design" />
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
  view,
  onView,
  status,
  providers,
  provider,
  onProvider,
  onChooseModel,
  onManageProviders,
  pinned,
  onTogglePin,
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
  onNewDesign,
  onDelete,
}) {
  // Whether each conversation list is unfolded under its heading.
  const [listOpen, toggleList] = useFold(LIST_KEY);
  const [designOpen, toggleDesign] = useFold(DESIGN_LIST_KEY);
  const designSessions = (sessions || []).filter((s) => s.mode === "design");
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

  // The toggle is inside the rail so that hovering it counts as hovering the
  // rail -- but it must not count as focus *within* the panel. Clicking it to
  // close the sidebar leaves it focused, and focus holds the panel open, so
  // the one control that closes the rail was the one thing stopping it from
  // closing. It is the handle, not the contents.
  const holdsOpen = (el) =>
    Boolean(el && node.current?.contains(el) && !el.closest(".rail-toggle"));

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

        <div className="navrail-dest">
          {/* Every conversation, design ones included -- a design chat is
              still a conversation, and this is the list of them. */}
          <RailGroup
            id="chat"
            label="Chat"
            icon="chat_bubble"
            current={view === "chat"}
            open={listOpen}
            onToggle={toggleList}
            onGo={() => onView("chat")}
            newLabel="+ New conversation"
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
                sessions={sessions}
                projects={projects}
                agents={agents}
                activeId={activeId}
                onOpenSession={onOpenSession}
                onDelete={onDelete}
                empty="Nothing yet"
              />
            </ul>
          </RailGroup>

          {/* Design: pressing it starts a new design conversation, and the
              list under it is only the design ones. The standards library --
              the design.md files a result is held to -- is one row here, since
              it is what those conversations draw from. */}
          <RailGroup
            id="design"
            label="Design"
            icon="design"
            current={view === "design" || view === "standards"}
            open={designOpen}
            onToggle={toggleDesign}
            onGo={onNewDesign}
            hint="Start a new design"
            newLabel="+ New design"
            onNew={onNewDesign}
            extra={
              <button
                type="button"
                className="navrail-new navrail-link"
                aria-current={view === "standards" ? "page" : undefined}
                onClick={() => onView("standards")}
              >
                Design standards
              </button>
            }
          >
            <ul data-list="design">
              <SessionRows
                sessions={designSessions}
                projects={projects}
                agents={agents}
                activeId={activeId}
                onOpenSession={onOpenSession}
                onDelete={onDelete}
                empty="No designs yet"
              />
            </ul>
          </RailGroup>

          {DESTINATIONS.map((destination) => (
            <button
              key={destination.id}
              type="button"
              aria-current={view === destination.id ? "page" : undefined}
              onClick={() => onView(destination.id)}
            >
              <Icon name={destination.icon} />
              <Label label={destination.label} />
            </button>
          ))}
        </div>

        <div className="spacer" />

        <div className="navrail-foot">
          <button
            type="button"
            className="navrail-circle navrail-dot"
            data-tone={tone}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Answering with ${label} — change`}
            title={label}
            onClick={() => setMenuOpen((was) => !was)}
          />
          <span className="navrail-status" aria-hidden="true">
            {label}
          </span>
        </div>
      </div>

      {/* The sidebar's own control, and the only one: this used to be a pin
          inside the header doing the same job from one fixed spot.
          *
          * It lives at the sheet's top left while the sidebar is shut and
          * travels to the header when it opens, so the control is always
          * where the sidebar's edge is rather than parked over whichever
          * screen happens to be underneath.
          *
          * Inside .navrail on purpose. The rail opens on hover, and a button
          * that sits over the open panel without being part of it would close
          * the very thing it is standing on the moment the pointer reached
          * it. As a descendant, hovering it is hovering the rail.
          *
          * Outside .navrail-inner, which clips its overflow -- the same reason
          * ModelMenu is out here. */}
      {!narrow ? (
        <button
          type="button"
          className="rail-toggle"
          data-open={open ? "" : undefined}
          aria-pressed={pinned}
          aria-label={pinned ? "Close sidebar" : "Open sidebar"}
          title={pinned ? "Close sidebar" : "Open sidebar"}
          onClick={onTogglePin}
        >
          <Icon name="sidebar" filled={open} />
        </button>
      ) : null}

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
