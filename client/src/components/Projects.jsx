import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./Icon";
import { ThemePicker } from "./ThemePicker";
import { useDialog } from "./Dialog";
import { swatchOf } from "../lib/theme";
import { KIND_ICON, KIND_LABEL } from "../lib/designs";

/* A project's two editable properties, in one popup.
 *
 * The colour used to open a swatch row inside the card and the name used to
 * turn the heading into an input -- two different disclosures for two settings
 * on the same folder, each shoving the conversations below it out of the way.
 * Both are here now, over the card rather than inside it, so opening either
 * one costs the page no layout at all.
 *
 * The name commits on Enter and on dismissal, and is abandoned on Escape.
 * Committing on dismissal is the part worth stating: the colour swatches are
 * in this same popup, so clicking one after typing a name has to keep the
 * name -- a blur that discarded it, which is what the inline rename did, would
 * throw the edit away for touching the control next to it.
 */
function ProjectEditor({ project, accent, seed, onRename, onAccent, onClose }) {
  const node = useRef(null);
  const [draft, setDraft] = useState(project.name);
  // Read through a ref by the dismissal handlers, which are bound once and
  // would otherwise close over the name as it was when the popup opened.
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => {
    const commit = () => {
      const clean = latest.current.trim();
      if (clean && clean !== project.name) onRename(clean);
      onClose();
    };
    const away = (event) => {
      if (node.current && !node.current.contains(event.target)) commit();
    };
    const key = (event) => {
      if (event.key === "Escape") onClose();
    };
    // pointerdown rather than click: a click that begins inside and ends
    // outside -- dragging across a swatch row -- should not count as leaving.
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [project.name, onRename, onClose]);

  return (
    <div
      ref={node}
      className="popover prj-popover"
      role="dialog"
      aria-label={`Edit ${project.name}`}
    >
      <form
        className="prj-popover-row"
        onSubmit={(event) => {
          event.preventDefault();
          const clean = draft.trim();
          if (clean && clean !== project.name) onRename(clean);
          onClose();
        }}
      >
        <span className="mi">Name</span>
        <input
          type="text"
          value={draft}
          autoFocus
          aria-label={`Rename ${project.name}`}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>

      <div className="prj-popover-row">
        <span className="mi">Accent</span>
        <ThemePicker
          value={accent || null}
          onChange={onAccent}
          scope="project"
          seed={seed}
          inheritedLabel="Follow the app-wide accent"
        />
        <p className="caveat" style={{ margin: 0 }}>
          Worn by every conversation in here that has not chosen a colour of
          its own.
        </p>
      </div>
    </div>
  );
}

const TAB_KEY = "bom.projects.tab";

const TABS = [
  {
    id: "chat",
    label: "Chats",
    intro:
      "Folders for conversations. Drag a conversation onto a project to file it, or drop it on Unfiled to take it out again.",
  },
  {
    id: "design",
    label: "Design",
    intro:
      "Each design project is a folder of design conversations and the wireframes, pages and decks they made. Build one into a code project when it is ready.",
  },
  {
    id: "code",
    label: "Code",
    intro:
      "Each code project is a folder on this computer and the code conversations working in it. Start one from nothing or from your designs.",
  },
];

// What each kind of folder takes when a conversation is dropped on it: a chat
// project has always held design conversations too; a code project is a
// folder, and dropping a code conversation there moves it to work in it.
const ACCEPTS = {
  chat: ["chat", "design"],
  design: ["design"],
  code: ["code"],
};

/* Projects, as a screen rather than a fold in the rail.
 *
 * The rail's version is for moving around while you work. This one is for
 * organising: it shows every project beside its conversations at once, which
 * is the view you want when deciding where something belongs -- and the rail,
 * at 252px, can never show two folders at the same time.
 *
 * Three sections, one per kind of project: chats, designs and code. Each shows
 * its projects as folders, and each can make one.
 */
export function Projects({
  projects,
  sessions,
  library = [],
  projectsDir = "",
  onOpenSession,
  onNewProject,
  onRenameProject,
  onDeleteProject,
  onNewSessionIn,
  onNewDesignIn,
  onNewCodeIn,
  onBuildInCode,
  onNewCodeProject,
  onFileSession,
  accentOf,
  seedOfRecord,
  onProjectAccent,
}) {
  const { confirm } = useDialog();
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return TABS.some((t) => t.id === saved) ? saved : "chat";
    } catch {
      return "chat";
    }
  });
  const [name, setName] = useState("");
  // Which folder has its editor open. One at a time -- the popup overlays the
  // card, and two of them would be two dialogs fighting for the same corner.
  const [editing, setEditing] = useState(null);
  // Which folder the pointer is currently over, so exactly one lights up.
  const [over, setOver] = useState(null);

  const choose = (id) => {
    setTab(id);
    setEditing(null);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      // Not remembered; still switched.
    }
  };

  const kindOf = (project) => project.kind || "chat";
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const mine = useMemo(() => projects.filter((p) => kindOf(p) === tab), [projects, tab]);

  const byProject = useMemo(() => {
    const map = new Map();
    for (const session of sessions) {
      const key = session.project_id || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(session);
    }
    return map;
  }, [sessions]);

  // Designs by the conversation that made them.
  const designsOf = useMemo(() => {
    const map = new Map();
    for (const group of library) {
      for (const design of group.designs) {
        if (!map.has(design.session_id)) map.set(design.session_id, []);
        map.get(design.session_id).push(design);
      }
    }
    return map;
  }, [library]);

  const modeOf = (session) => session.mode || "chat";
  const unfiled = sessions.filter((s) => !s.project_id && modeOf(s) === tab);

  const create = (event) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    onNewProject(clean, tab);
    setName("");
  };

  // `key` is what lights up and `projectId` is what gets written -- they differ
  // for Unfiled, whose project id is null but which still needs a distinct
  // handle, since `null` is also "nothing is being hovered".
  const dropProps = (projectId, key, kind) => ({
    onDragOver: (event) => {
      // Without preventDefault the browser refuses the drop entirely. What is
      // dragged is only known by its types until the drop.
      const types = [...event.dataTransfer.types];
      if (!types.includes("text/session")) return;
      const takes = projectId ? ACCEPTS[kind] : [kind];
      if (takes.some((mode) => types.includes(`application/x-bom-${mode}`))) {
        event.preventDefault();
        setOver(key);
      }
    },
    onDragLeave: () => setOver((was) => (was === key ? null : was)),
    onDrop: (event) => {
      event.preventDefault();
      setOver(null);
      const id = event.dataTransfer.getData("text/session");
      if (id) onFileSession(id, projectId);
    },
  });

  const Row = ({ session, detail }) => (
    <li
      key={session.id}
      draggable
      onDragStart={(event) => {
        // A custom type, not text/plain: dropping a conversation into a text
        // field elsewhere should do nothing rather than paste an id. The mode
        // rides along as a type of its own, since data is unreadable until
        // the drop and a folder has to say during the drag whether it takes it.
        event.dataTransfer.setData("text/session", session.id);
        event.dataTransfer.setData(`application/x-bom-${modeOf(session)}`, "");
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button className="prj-session" onClick={() => onOpenSession(session.id)}>
        <span className="prj-session-title">{session.title || "Untitled"}</span>
        <span className="mi">
          {detail ??
            (session.message_count === 1 ? "1 message" : `${session.message_count ?? 0} messages`)}
        </span>
      </button>
    </li>
  );

  const bead = (project) => (
    <span
      className="accent-bead"
      aria-hidden="true"
      style={{ background: swatchOf(accentOf?.(project), seedOfRecord?.(project)) }}
    />
  );

  const editor = (project) =>
    editing === project.id ? (
      <ProjectEditor
        project={project}
        accent={accentOf?.(project)}
        seed={seedOfRecord?.(project)}
        onRename={(next) => onRenameProject(project.id, next)}
        onAccent={(accent) => onProjectAccent?.(project.id, accent)}
        onClose={() => setEditing(null)}
      />
    ) : null;

  const editButton = (project) => (
    <button
      type="button"
      className="mi"
      aria-expanded={editing === project.id}
      aria-haspopup="dialog"
      onClick={() => setEditing((was) => (was === project.id ? null : project.id))}
    >
      edit
    </button>
  );

  const deleteButton = (project, label, question) => (
    <button
      type="button"
      className="mi"
      onClick={async () => {
        const yes = await confirm(question, {
          title: label === "remove" ? "Remove project" : "Delete project",
          confirmLabel: label === "remove" ? "Remove" : "Delete",
          destructive: true,
        });
        if (yes) onDeleteProject(project.id);
      }}
    >
      {label}
    </button>
  );

  const DesignList = ({ designs }) =>
    designs.length ? (
      <ul className="prj-designs" aria-label="Designs">
        {designs.map((design) => (
          <li key={design.id}>
            <button
              type="button"
              className="prj-design"
              title={`${KIND_LABEL[design.kind] || design.kind} in "${design.session_title || "Untitled"}"`}
              onClick={() => onOpenSession(design.session_id)}
            >
              <Icon name={KIND_ICON[design.kind] || "document"} />
              <span className="prj-design-title">{design.title}</span>
              <span className="mi">{design.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    ) : null;

  const chatCard = (project) => {
    const inside = byProject.get(project.id) || [];
    return (
      <section
        key={project.id}
        className="prj-card"
        data-over={over === project.id ? "" : undefined}
        {...dropProps(project.id, project.id, "chat")}
      >
        <div className="prj-head">
          <span className="h">
            {bead(project)}
            {project.name}
          </span>
          <span className="mi">{inside.length}</span>
        </div>
        <ul className="prj-list">
          {inside.length === 0 ? (
            <li className="prj-empty mi">Drop a conversation here</li>
          ) : (
            inside.map((session) => <Row key={session.id} session={session} />)
          )}
        </ul>
        {editor(project)}
        <div className="prj-actions">
          <button type="button" className="mi" onClick={() => onNewSessionIn(project.id)}>
            new chat
          </button>
          {editButton(project)}
          {deleteButton(
            project,
            "delete",
            `Delete the project "${project.name}"? Its conversations are kept and become unfiled.`,
          )}
        </div>
      </section>
    );
  };

  const designCard = (project) => {
    const inside = (byProject.get(project.id) || []).filter((s) => modeOf(s) === "design");
    const designs = inside.flatMap((s) => designsOf.get(s.id) || []);
    return (
      <section
        key={project.id}
        className="prj-card"
        data-kind="design"
        data-over={over === project.id ? "" : undefined}
        {...dropProps(project.id, project.id, "design")}
      >
        <div className="prj-head">
          <span className="h">
            {bead(project)}
            {project.name}
          </span>
          <span className="mi">
            {designs.length} design{designs.length === 1 ? "" : "s"}
          </span>
        </div>
        <DesignList designs={designs} />
        <span className="prj-sub mi">Conversations</span>
        <ul className="prj-list">
          {inside.length === 0 ? (
            <li className="prj-empty mi">Start a design here, or drop one in</li>
          ) : (
            inside.map((session) => {
              const count = (designsOf.get(session.id) || []).length;
              return (
                <Row
                  key={session.id}
                  session={session}
                  detail={count === 1 ? "1 design" : `${count} designs`}
                />
              );
            })
          )}
        </ul>
        {editor(project)}
        <div className="prj-actions">
          <button type="button" className="mi" onClick={() => onNewDesignIn(project.id)}>
            new design
          </button>
          <button
            type="button"
            className="mi"
            disabled={!designs.length}
            title={designs.length ? "Make a code project from these designs" : "Nothing to build yet"}
            onClick={() => onBuildInCode({ source: `p:${project.id}`, name: project.name })}
          >
            build in code
          </button>
          {editButton(project)}
          {deleteButton(
            project,
            "delete",
            `Delete the design project "${project.name}"? Its conversations and designs are kept and become unfiled.`,
          )}
        </div>
      </section>
    );
  };

  const codeCard = (project) => {
    const inside = (byProject.get(project.id) || []).filter((s) => modeOf(s) === "code");
    const source = project.source_id ? byId.get(project.source_id) : null;
    return (
      <section
        key={project.id}
        className="prj-card"
        data-kind="code"
        data-over={over === project.id ? "" : undefined}
        {...dropProps(project.id, project.id, "code")}
      >
        <div className="prj-head">
          <span className="h">
            {bead(project)}
            {project.name}
          </span>
          {project.branch ? (
            <span className="prj-branch mi" title="Git branch">
              <Icon name="branch" />
              {project.branch}
            </span>
          ) : null}
        </div>
        <span className="prj-path" title={project.path}>
          <bdi>{project.path}</bdi>
        </span>
        {project.missing ? (
          <p className="prj-warn mi">This folder is not there any more. Removing the project forgets it.</p>
        ) : null}
        {source ? (
          <button type="button" className="prj-source mi" onClick={() => choose("design")}>
            <Icon name="design" />
            Built from {source.name}
          </button>
        ) : null}
        <ul className="prj-list">
          {inside.length === 0 ? (
            <li className="prj-empty mi">No conversations yet</li>
          ) : (
            inside.map((session) => <Row key={session.id} session={session} />)
          )}
        </ul>
        {editor(project)}
        <div className="prj-actions">
          <button
            type="button"
            className="mi"
            disabled={project.missing}
            onClick={() => (inside.length ? onOpenSession(inside[0].id) : onNewCodeIn(project))}
          >
            open
          </button>
          <button type="button" className="mi" disabled={project.missing} onClick={() => onNewCodeIn(project)}>
            new session
          </button>
          {editButton(project)}
          {deleteButton(
            project,
            "remove",
            `Remove "${project.name}" from Projects? The folder and its files are not touched, and its conversations are kept.`,
          )}
        </div>
      </section>
    );
  };

  const current = TABS.find((t) => t.id === tab);

  return (
    <div className="page">
      <div className="page-head" data-tint="accent">
        <div className="sw" style={{ left: "-90px", top: "-110px", width: "280px", height: "280px", background: "var(--accent-field)" }} />
        <div className="inner">
          <div>
            <h1 className="h">Projects</h1>
            <p>{current.intro}</p>
          </div>
          {tab === "code" ? (
            <div className="actions">
              <button type="button" className="btnp" onClick={() => onNewCodeProject()}>
                New code project
              </button>
            </div>
          ) : (
            <form className="actions" onSubmit={create}>
              <input
                className="prj-new"
                type="text"
                value={name}
                placeholder={tab === "design" ? "New design project" : "New project"}
                aria-label={tab === "design" ? "Name for a new design project" : "Name for a new project"}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="btnp" disabled={!name.trim()}>
                Create
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="page-body" style={{ flexDirection: "column" }}>
        <div className="page-col" style={{ alignSelf: "stretch" }}>
          <div className="prj-tabs" role="tablist" aria-label="Kinds of project">
            {TABS.map((t) => {
              const count = projects.filter((p) => kindOf(p) === t.id).length;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  data-active={tab === t.id ? "" : undefined}
                  onClick={() => choose(t.id)}
                >
                  <Icon name={t.id === "chat" ? "chat_bubble" : t.id === "design" ? "design" : "code"} />
                  {t.label}
                  <span className="mi">{count}</span>
                </button>
              );
            })}
          </div>

          {mine.length === 0 ? (
            <p className="p prj-none">
              {tab === "chat"
                ? "No projects yet. Make one above, then drag conversations into it."
                : tab === "design"
                  ? "No design projects yet. Make one above, then start designs in it -- or drag design conversations in."
                  : `No code projects yet. Make one from your designs or from nothing${projectsDir ? ` -- new folders go in ${projectsDir}` : ""}. A folder opened in the Code view shows up here too.`}
            </p>
          ) : null}

          <div className="prj-grid">
            {tab === "chat" ? mine.map(chatCard) : tab === "design" ? mine.map(designCard) : mine.map(codeCard)}

            {/* Unfiled is a drop target too, so taking a conversation back out
                is the same gesture as putting it in. A code conversation always
                has a folder, so there is no unfiled code. */}
            {tab !== "code" ? (
              <section
                className="prj-card"
                data-unfiled=""
                data-over={over === "unfiled" ? "" : undefined}
                {...dropProps(null, "unfiled", tab)}
              >
                <div className="prj-head">
                  <span className="h">{tab === "design" ? "Not in a project" : "Unfiled"}</span>
                  <span className="mi">{unfiled.length}</span>
                </div>
                <ul className="prj-list">
                  {unfiled.length === 0 ? (
                    <li className="prj-empty mi">Everything is filed</li>
                  ) : (
                    unfiled.map((session) => {
                      if (tab !== "design") return <Row key={session.id} session={session} />;
                      const count = (designsOf.get(session.id) || []).length;
                      return (
                        <Row
                          key={session.id}
                          session={session}
                          detail={count === 1 ? "1 design" : `${count} designs`}
                        />
                      );
                    })
                  )}
                </ul>
                {tab === "design" && unfiled.some((s) => (designsOf.get(s.id) || []).length) ? (
                  <div className="prj-actions">
                    <button
                      type="button"
                      className="mi"
                      onClick={() => {
                        const first = unfiled.find((s) => (designsOf.get(s.id) || []).length);
                        onBuildInCode({ source: `s:${first.id}`, name: first.title || "" });
                      }}
                    >
                      build one in code
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
