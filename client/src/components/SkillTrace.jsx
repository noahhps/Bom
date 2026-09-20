import { useState } from "react";

import { describeSkill } from "../lib/skillWidgets";
import { Icon } from "./Icon";
import { ServiceIcon } from "./ServiceIcon";

/**
 * What the model reached for, and what came back.
 *
 * One card per call, above the answer in the same column, because it happened
 * before the answer and reads as the working that produced it -- the same
 * argument as `Reasoning`.
 *
 * Each card says three things: which service answered, in a line what the call
 * was for, and the head of the result. The full text is one press away rather
 * than on screen by default -- a turn that read four pages should not bury the
 * reply under them. See `lib/skillWidgets` for where the summary comes from;
 * nothing here costs a model call.
 *
 * A card with no `result` yet is still running. That state is the whole point
 * of the component: without it a turn that calls a slow skill looks identical
 * to a turn that has hung.
 */
function Card({ skill }) {
  const [open, setOpen] = useState(false);
  const running = skill.result === undefined;
  const widget = describeSkill(skill);

  return (
    <div
      className="skill-card"
      data-running={running ? "" : undefined}
      data-denied={skill.denied ? "" : undefined}
    >
      <div className="skill-card-head">
        {/* A built-in wears the shell's own glyph; anything from an MCP server
            wears that service's mark, so a card is found as a brand. */}
        {widget.icon ? (
          <span className="skill-card-mark">
            <Icon name={widget.icon} />
          </span>
        ) : (
          <ServiceIcon name={widget.server || widget.name} />
        )}
        <span className="skill-card-source">{widget.source}</span>
        <span className="skill-card-tool mi">{widget.name}</span>
        <span className="spacer" />
        {running ? (
          <span className="mi">running</span>
        ) : skill.denied ? (
          <span className="mi">declined</span>
        ) : null}
      </div>

      {widget.title ? <p className="skill-card-title">{widget.title}</p> : null}

      {widget.rows.length ? (
        <dl className="skill-card-rows">
          {widget.rows.map((row) => (
            <div key={row.label}>
              <dt className="mi">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {running ? (
        <p className="skill-card-preview" data-soft="">
          Working…
        </p>
      ) : (
        <>
          {widget.preview ? (
            <p className="skill-card-preview">{widget.preview}</p>
          ) : null}
          {/* Only worth offering when there is more than the preview showed. */}
          {skill.result && skill.result.trim().length > widget.preview.length ? (
            <button
              type="button"
              className="skill-card-more mi"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
            >
              {open ? "Hide full result" : "Show full result"}
            </button>
          ) : null}
          {open ? <div className="skill-card-full">{skill.result}</div> : null}
        </>
      )}
    </div>
  );
}

export function SkillTrace({ skills }) {
  if (!skills?.length) return null;

  // The one still waiting, rather than the last in the list. They are usually
  // the same row and are not when a turn calls two skills at once, where the
  // last to be called can be the first to answer -- and naming a skill that
  // has already answered is worse than naming none.
  const running = skills.find((s) => s.result === undefined);

  return (
    <div className="skill-trace" data-live={running ? "" : undefined}>
      <div className="skill-trace-label mi">
        {running
          ? `Using ${running.name}…`
          : `Used ${skills.length === 1 ? "1 skill" : `${skills.length} skills`}`}
      </div>
      {skills.map((skill, index) => (
        <Card key={`${skill.name}-${index}`} skill={skill} />
      ))}
    </div>
  );
}
