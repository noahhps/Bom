import { createContext, useContext, useState } from "react";

/* What a code tool did, drawn for the conversation: the change as a diff, the
 * command and what it printed, the task list as a checklist. Used by the tool
 * cards in the thread and by the approval prompt, which is the one place the
 * reader decides whether a change happens -- and a diff is what that decision
 * is about, not a JSON blob of old_string and new_string. */

/** Provided by the Code view so a path in the thread opens in the editor. */
export const CodeContext = createContext(null);
export const useCode = () => useContext(CodeContext);

/** A path that opens the file when the Code view is there to open it in. */
export function PathLink({ path, line = null }) {
  const code = useCode();
  if (!path) return null;
  const label = line ? `${path}:${line}` : path;
  if (!code) return <span className="code-path">{label}</span>;
  return (
    <button type="button" className="code-path" data-link="" onClick={() => code.openFile(path, line)}>
      {label}
    </button>
  );
}

const asText = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));

/** The edits a code_edit call carries, however they were shaped. */
export function editsOf(args = {}) {
  const listed = Array.isArray(args.edits) ? args.edits : [];
  const out = [];
  if (args.old_string !== undefined || args.new_string !== undefined) {
    out.push({ old: asText(args.old_string), new: asText(args.new_string), all: Boolean(args.replace_all) });
  }
  for (const edit of listed) {
    if (edit && typeof edit === "object") {
      out.push({ old: asText(edit.old_string), new: asText(edit.new_string), all: Boolean(edit.replace_all) });
    }
  }
  return out;
}

/* A line diff of one replacement: the lines both sides share at the start and
 * end are trimmed to a little context, so a one-line change inside a twenty-
 * line old_string reads as one line changed. */
function hunk(before, after, context = 2) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const lines = [];
  for (let i = Math.max(0, start - context); i < start; i += 1) lines.push([" ", a[i]]);
  for (let i = start; i <= endA; i += 1) lines.push(["-", a[i]]);
  for (let i = start; i <= endB; i += 1) lines.push(["+", b[i]]);
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + context); i += 1) lines.push([" ", a[i]]);
  return lines;
}

function Lines({ lines, limit }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, limit);
  return (
    <>
      <pre className="code-diff">
        {shown.map(([mark, text], i) => (
          <span key={i} className="code-diff-line" data-mark={mark === "+" ? "add" : mark === "-" ? "del" : undefined}>
            <span className="code-diff-sign">{mark}</span>
            {text || " "}
          </span>
        ))}
      </pre>
      {lines.length > limit ? (
        <button type="button" className="skill-card-more mi" onClick={() => setAll((was) => !was)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </>
  );
}

export function EditDiff({ args, limit = 24 }) {
  const edits = editsOf(args);
  if (!edits.length) return null;
  const lines = [];
  edits.forEach((edit, i) => {
    if (i) lines.push([" ", "⋯"]);
    lines.push(...hunk(edit.old, edit.new));
  });
  const added = lines.filter(([m]) => m === "+").length;
  const removed = lines.filter(([m]) => m === "-").length;
  return (
    <div className="code-change">
      <div className="code-change-head">
        <PathLink path={args.path || args.file_path} />
        <span className="code-change-count">
          <span data-mark="add">+{added}</span> <span data-mark="del">−{removed}</span>
        </span>
      </div>
      <Lines lines={lines} limit={limit} />
    </div>
  );
}

export function WritePreview({ args, limit = 14 }) {
  const content = asText(args.content);
  const lines = content.replace(/\n$/, "").split("\n").map((line) => ["+", line]);
  return (
    <div className="code-change">
      <div className="code-change-head">
        <PathLink path={args.path || args.file_path} />
        <span className="code-change-count">
          <span data-mark="add">+{lines.length}</span>
        </span>
      </div>
      <Lines lines={lines} limit={limit} />
    </div>
  );
}

/** A command, and -- once it has run -- the tail of what it printed. */
export function BashView({ args, result, running = false }) {
  const [all, setAll] = useState(false);
  const command = asText(args.command || args.cmd);
  // The result opens with "$ command" and closes with "[exit code N]".
  const body = (result || "").split("\n");
  const status = body.length && /^\[(exit code|stopped)/.test(body.at(-1)) ? body.pop() : "";
  if (body.length && body[0].startsWith("$ ")) body.shift();
  const output = body.join("\n").replace(/^\(no output\)$/, "");
  const lines = output ? output.split("\n") : [];
  const shown = all ? lines : lines.slice(-14);
  const failed = /exit code [1-9]|stopped/.test(status);
  return (
    <div className="code-bash">
      {args.description ? <p className="code-bash-what">{asText(args.description)}</p> : null}
      <pre className="code-bash-command">
        <span className="code-bash-prompt">$</span> {command}
      </pre>
      {running ? null : (
        <>
          {lines.length ? (
            <pre className="code-bash-output">
              {!all && lines.length > shown.length ? "…\n" : ""}
              {shown.join("\n")}
            </pre>
          ) : null}
          <div className="code-bash-foot">
            {status ? (
              <span className="code-bash-status" data-failed={failed ? "" : undefined}>
                {status.replace(/^\[|\]$/g, "")}
              </span>
            ) : null}
            {lines.length > 14 ? (
              <button type="button" className="skill-card-more mi" onClick={() => setAll((was) => !was)}>
                {all ? "Show the end" : `Show all ${lines.length} lines`}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function TodoList({ todos }) {
  if (!Array.isArray(todos) || !todos.length) return null;
  return (
    <ul className="code-todos">
      {todos.map((todo, i) => (
        <li key={i} data-status={todo.status}>
          <span className="code-todo-box" aria-hidden="true" />
          <span>{asText(todo.content)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The body of a code tool's card in the thread. Null for one with none. */
export function CodeCardBody({ skill }) {
  const args = skill.arguments || {};
  const running = skill.result === undefined;
  const refused = typeof skill.result === "string" &&
    /^(Nothing was changed|Read .* first|.* does not exist|.* is outside the project|No project folder)/.test(skill.result);
  switch (skill.name) {
    case "code_edit":
      return (
        <>
          <EditDiff args={args} />
          {refused ? <p className="skill-card-preview">{skill.result.split("\n")[0]}</p> : null}
        </>
      );
    case "code_write":
      return (
        <>
          <WritePreview args={args} />
          {refused ? <p className="skill-card-preview">{skill.result}</p> : null}
        </>
      );
    case "code_bash":
      return <BashView args={args} result={skill.result} running={running} />;
    case "code_todo":
      return <TodoList todos={args.todos} />;
    default:
      return null;
  }
}
