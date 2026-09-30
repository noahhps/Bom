import { Fragment, memo, useMemo } from "react";

import { useReveal } from "../hooks/useReveal";
import { workingWord } from "../lib/skillWidgets";
import { turnTimeline } from "../lib/timeline";
import { AgentWear } from "./AgentAvatar";
import { AgentFlower } from "./AgentFlower";
import { MessageAttachments } from "./Attachments";
import { Decode } from "./Decode";
import { DesignChoice } from "./DesignChoice";
import { Reasoning } from "./Reasoning";
import { SkillApproval } from "./SkillApproval";
import { SkillTrace } from "./SkillTrace";

/* When a turn was sent, as a person would say it: the time alone for today,
 * the day and time for earlier this year, the full date past that. The whole
 * date and time is the tooltip, and `dateTime` carries it for a machine. */
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const YEAR = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function SentAt({ at }) {
  if (!at) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const now = new Date();
  const clock = TIME.format(when);
  const label =
    when.toDateString() === now.toDateString()
      ? clock
      : when.getFullYear() === now.getFullYear()
        ? `${DAY.format(when)}, ${clock}`
        : `${YEAR.format(when)}, ${clock}`;
  return (
    <time className="turn-time" dateTime={when.toISOString()} title={FULL.format(when)}>
      {label}
    </time>
  );
}

/* One stretch of the answer's words. Its own component so each stretch
 * keeps its own fade-in state: only the one still being written is live. */
function AnswerText({ text, live }) {
  // renderMarkdown escapes the source before emitting a single tag, so no
  // model output reaches the DOM as markup. That is the whole contract; see
  // lib/markdown.js. useReveal only wraps what it is given -- it inserts its
  // own spans after the escaping, never before it.
  const html = useReveal(text, live);
  return <div className="body" dangerouslySetInnerHTML={html} />;
}

/**
 * One turn.
 *
 * The user's words are a bubble on the right. An answer is the margin-and-rule
 * layout from artboard 1a: a narrow column of what the system drew on, a
 * hairline, then the prose.
 *
 * The margin is deliberately rendered even when it is empty. It is where
 * recalled facts and read documents will go once there is a memory layer to
 * fill it, and reserving the column now means the answer does not shift
 * sideways the day it arrives. Until then it carries the one piece of
 * provenance the server does report: which model produced the turn.
 *
 * Memoised because a streaming answer re-renders on every animation frame and
 * the settled turns above it have not changed a character.
 */
export const Message = memo(function Message({
  role,
  content,
  streaming,
  thinking,
  reasoning,
  attachments,
  skills,
  onDecide,
  onChooseDesign,
  onContinue,
  truncated,
  continuable,
  model,
  pin = null,
  sentAt,
  look = null,
}) {
  // The answer in the order it happened: thinking, skills and words as they
  // came, rather than all the thinking, then all the skills, then the words.
  const parts = useMemo(
    () => (role === "assistant" ? turnTimeline({ reasoning, content, skills }) : []),
    [role, reasoning, content, skills],
  );

  if (role === "user") {
    return (
      <div className="turn-user">
        <div className="turn-user-stack">
          <MessageAttachments attachments={attachments} />
          {/* A turn can be nothing but a dropped file, in which case there is
              no bubble to draw -- only what was attached. */}
          {content ? <div className="bubble">{content}</div> : null}
          <SentAt at={sentAt} />
        </div>
      </div>
    );
  }

  if (role === "error") {
    return (
      <div className="turn-error">
        <AgentFlower open mark size={26} mood="down" className="turn-error-mark" />
        <span className="turn-error-text">{content}</span>
        {continuable && onContinue ? (
          <button type="button" className="continue-btn" onClick={onContinue}>
            Continue
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="turn-answer">
      <div className="margin">
        <SentAt at={sentAt} />
        {model ? (
          <>
            <span className="mi">Answered by</span>
            <p data-soft>{model}</p>
          </>
        ) : null}
        {/* What the Make menu pinned this answer to, and whether it was
            honoured -- checked by the server against what was actually
            made, not taken from the model. */}
        {pin ? (
          <>
            <span className="mi">Make</span>
            <p data-soft data-pin={pin.status}>
              {pin.label || "Pinned"} ·{" "}
              {pin.status === "done"
                ? "made"
                : pin.status === "missed"
                  ? "not made"
                  : pin.status === "off"
                    ? "switched off in Skills, not enforced"
                    : `asking again (${pin.attempt || 1}/2)`}
            </p>
          </>
        ) : null}
      </div>
      <div className="margin-rule" data-soft={model ? undefined : true} />

      <div className="answer">
        <AgentFlower open={Boolean(streaming)} />
        {/* In an agent's room the answering flower is the agent, so it wears
            what the agent wears. */}
        <AgentWear look={look} className="answer-wear" />

        {parts.map((part, index) => {
          const last = index === parts.length - 1;
          if (part.type === "reasoning") {
            // Folded once anything follows it -- a skill or the words -- and
            // open while it is the last thing happening.
            const next = parts[index + 1];
            return (
              <Reasoning
                key={`reasoning-${index}`}
                text={part.text}
                answering={!(streaming && last)}
                label={next?.type === "skills" ? "Thought" : "Thought before answering"}
              />
            );
          }
          if (part.type === "text") {
            return <AnswerText key={`text-${index}`} text={part.text} live={Boolean(streaming && last)} />;
          }
          return (
            <Fragment key={`skills-${index}`}>
              {/* Anything the turn is blocked on, above the skills it came
                  from. The server is holding the answer open until one of
                  these is pressed, so it goes where the eye lands first
                  rather than inside the compact list of what has run. */}
              {part.skills
                .filter((s) => s.approval)
                .map((s) => (
                  <SkillApproval key={s.approval.id} skill={s} onDecide={onDecide} />
                ))}
              {/* The other thing a turn can be stopped on: a question about
                  how the result should look. Same place, same reason. */}
              {part.skills
                .filter((s) => s.design)
                .map((s) => (
                  <DesignChoice key={s.design.id} skill={s} onChoose={onChooseDesign} />
                ))}
              <SkillTrace skills={part.skills} />
            </Fragment>
          );
        })}

        {streaming && parts[parts.length - 1]?.type !== "text" ? (
          // Between the turn starting and its first word, and again while a
          // skill runs or it thinks after one. Without something here the
          // answer simply stops growing. The word is read off the turn -- see
          // workingWord -- so it says what is actually happening: the skill
          // that is running, a prompt waiting on the reader, or the model's
          // own thinking.
          <Decode className="working" word={workingWord(skills, thinking)} />
        ) : null}

        {/* The model stopped because it ran out of skill rounds, not because it
            was done. One press sends another turn so it can pick up where it
            left off. Hidden while streaming -- there is nothing to continue
            until this turn has actually stopped. */}
        {truncated && !streaming && onContinue ? (
          <button type="button" className="continue-btn" onClick={onContinue}>
            Continue
          </button>
        ) : null}
      </div>
    </div>
  );
});
