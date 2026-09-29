import { useEffect, useState } from "react";

import { Icon } from "../Icon";

/* What an empty code conversation offers: the jobs people open a codebase for,
   as the same row of chips the chat opens with -- and, on the page a new one
   is started from, the project it will work in, the way a design's look is
   chosen under a new design. */

const STARTERS = [
  {
    icon: "compass",
    label: "Explain the project",
    prompt: "Give me a tour of this project: what it does, how it is organised, and where the main entry points are.",
  },
  {
    icon: "bolt",
    label: "Fix a bug",
    prompt: "There is a bug: ",
  },
  {
    icon: "pen",
    label: "Build a feature",
    prompt: "Add a feature: ",
  },
  {
    icon: "check",
    label: "Write tests",
    prompt: "Write tests for ",
  },
  {
    icon: "branch",
    label: "Review changes",
    prompt: "Review my uncommitted changes (git diff) and point out anything that looks wrong.",
  },
];

export function CodeStartersHead({ name }) {
  return (
    <div className="starters-head design-head">
      <div className="starters-greeting">
        <span className="design-mark" aria-hidden="true">
          <Icon name="code" />
        </span>
        <h2 className="h">{name ? `What are we building in ${name}?` : "What are we building?"}</h2>
      </div>
      <p className="p">
        {name
          ? "I can read, search and edit this project and run its commands. Changes show in the editor as I make them, and I ask before each one."
          : "Pick a project, or describe a new one and I will set it up. I can read, search and edit it and run its commands, and I ask before each change."}
      </p>
    </div>
  );
}

const MAX_RECENT = 6;

function folderName(root) {
  return String(root || "").replace(/\/+$/, "").split("/").pop() || root;
}

/* The project a new code session works in: the recent ones as chips, the one
   picked lit, and ways to open any other folder or make a new project. */
function ProjectChoice({ api, value, onChoose, onOpenFolder, onNewProject, onManage, refreshKey }) {
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    let live = true;
    api
      .recentFolders()
      .then((data) => live && setRecent(data.folders || []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, refreshKey]);

  const shown = recent.slice(0, MAX_RECENT);
  // A folder opened from elsewhere, not among the recent ones yet, still shows
  // as the one chosen.
  if (value && !shown.some((f) => f.root === value)) shown.unshift({ root: value, name: folderName(value) });

  return (
    <div className="design-looks code-projects">
      <div className="design-looks-head">
        <span className="mi">Project</span>
        {onManage ? (
          <button type="button" className="design-looks-manage mi" onClick={onManage}>
            All projects
          </button>
        ) : null}
      </div>
      <div className="design-looks-row" role="radiogroup" aria-label="Project">
        {shown.map((folder) => (
          <button
            key={folder.root}
            type="button"
            role="radio"
            aria-checked={value === folder.root}
            className="design-look"
            data-on={value === folder.root ? "" : undefined}
            title={folder.root}
            // Pressed again, a project is put down: the session then starts
            // with none, and can make one.
            onClick={() => onChoose(value === folder.root ? null : folder.root)}
          >
            <Icon name="folder" />
            {folder.name}
          </button>
        ))}
        <button type="button" className="design-look" data-action="" onClick={onOpenFolder}>
          <Icon name="search" />
          Open folder…
        </button>
        {onNewProject ? (
          <button type="button" className="design-look" data-action="" onClick={onNewProject}>
            <Icon name="plus" />
            New project…
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function CodeStarters({ onPick, project = null }) {
  return (
    <div className="starters code-starters">
      <div className="starters-row">
        {STARTERS.map((starter) => (
          <button key={starter.label} type="button" className="starter" onClick={() => onPick(starter.prompt)}>
            <Icon name={starter.icon} />
            {starter.label}
          </button>
        ))}
      </div>
      {project ? <ProjectChoice {...project} /> : null}
    </div>
  );
}
