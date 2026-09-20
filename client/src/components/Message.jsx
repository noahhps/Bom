import { memo, useMemo } from "react";

import { renderMarkdown } from "../lib/markdown";
import { AgentFlower } from "./AgentFlower";
import { MessageAttachments } from "./Attachments";
import { Reasoning } from "./Reasoning";
import { SkillApproval } from "./SkillApproval";
import { SkillTrace } from "./SkillTrace";

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
  onContinue,
  truncated,
  continuable,
  model,
}) {
  // renderMarkdown escapes the source before emitting a single tag, so no
  // model output reaches the DOM as markup. That is the whole contract; see
  // lib/markdown.js.
  const html = useMemo(
    () => (role === "assistant" && content ? { __html: renderMarkdown(content) } : null),
    [role, content],
  );

  if (role === "user") {
    return (
      <div className="turn-user">
        <div className="turn-user-stack">
          <MessageAttachments attachments={attachments} />
          {/* A turn can be nothing but a dropped file, in which case there is
              no bubble to draw -- only what was attached. */}
          {content ? <div className="bubble">{content}</div> : null}
        </div>
      </div>
    );
  }

  if (role === "error") {
    return (
      <div className="turn-error">
        {content}
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
        {model ? (
          <>
            <span className="mi">Answered by</span>
            <p data-soft>{model}</p>
          </>
        ) : null}
      </div>
      <div className="margin-rule" data-soft={model ? undefined : true} />

      <div className="answer">
        <AgentFlower open={Boolean(streaming)} />

        {reasoning ? (
          <Reasoning text={reasoning} answering={Boolean(content)} />
        ) : null}

        {/* Anything the turn is currently blocked on, above the trace. The
            server is holding the answer open until one of these is pressed, so
            it goes where the eye lands first rather than inside the compact
            list of what has already run. */}
        {skills
          ?.filter((s) => s.approval)
          .map((s) => (
            <SkillApproval key={s.approval.id} skill={s} onDecide={onDecide} />
          ))}

        <SkillTrace skills={skills} />

        {html ? (
          <div className="body" dangerouslySetInnerHTML={html} />
        ) : streaming ? (
          // The gap between the turn starting and its first token. Without
          // something here the answer column is simply blank.
          <span className="working">{thinking ? "Thinking" : "Working"}</span>
        ) : (
          <div className="body">{content}</div>
        )}

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
