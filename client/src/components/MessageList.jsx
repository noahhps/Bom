import { useLayoutEffect, useRef } from "react";

import { Message } from "./Message";
import { StartersHead } from "./Starters";

// Anything within this much of the bottom counts as "reading the end", so a
// new token follows the reader down. Further up and they are looking at
// something; the thread must not yank them away from it.
// How close to the end counts as "still reading the newest thing". Exported
// because the composer needs the same threshold: it decides whether growing
// the reserve under the thread should carry the view with it.
export const STICK_PX = 120;

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function dividerText(m) {
  const when = m.sentAt ? DAY.format(new Date(m.sentAt)) : "";
  return [m.content, when].filter(Boolean).join(" · ") || "Earlier";
}

export function MessageList({
  messages,
  model,
  scrollToken,
  onDecide,
  onChooseDesign,
  onContinue,
  // What an empty conversation says above the composer. The chat's greeting
  // by default; a design conversation hands in its own.
  head = null,
  // What the answering flower wears -- the agent's look, in its room.
  look = null,
  // Who wrote an answer, in a group chat: `(agentId) => { name, look }`.
  // Each answer is named, and its flower dressed, as the one who wrote it.
  senderOf = null,
}) {
  const ref = useRef(null);

  // Opening a session or sending a message: go to the bottom, wherever the
  // reader was.
  useLayoutEffect(() => {
    const node = ref.current;
    node.scrollTop = node.scrollHeight;
  }, [scrollToken]);

  // A token landed. Follow it only if the reader was already at the end --
  // measured after the paint, so one delta's worth of growth stays inside the
  // threshold.
  useLayoutEffect(() => {
    const node = ref.current;
    const { scrollTop, scrollHeight, clientHeight } = node;
    if (scrollHeight - scrollTop - clientHeight < STICK_PX) {
      node.scrollTop = scrollHeight;
    }
  }, [messages]);

  return (
    <main className="messages" ref={ref}>
      {messages.length === 0 ? (
        head || <StartersHead />
      ) : (
        messages.map((m, index) => {
          // Where one of an agent's older conversations gives way to the next
          // -- the same thread, picked up again.
          if (m.role === "divider") {
            return (
              <div key={m.key} className="turn-divider" role="separator">
                <span>{dividerText(m)}</span>
              </div>
            );
          }
          const sender = m.role === "assistant" && senderOf ? senderOf(m.agentId) : null;
          // Named at the start of a run, as a messenger does: once over a
          // string of answers from the same member, not over every one.
          const before = messages[index - 1];
          const named = sender && !(before?.role === "assistant" && before.agentId === m.agentId);
          return (
          <Message
            key={m.key}
            onDecide={onDecide}
            onChooseDesign={onChooseDesign}
            onContinue={onContinue}
            role={m.role}
            content={m.content}
            streaming={m.streaming}
            thinking={m.thinking}
            reasoning={m.reasoning}
            attachments={m.attachments}
            skills={m.skills}
            truncated={m.truncated}
            continuable={m.continuable}
            pin={m.pin}
            compaction={m.compaction}
            usage={m.usage}
            sentAt={m.sentAt}
            look={m.role === "assistant" ? (sender ? sender.look : look) : null}
            sender={named ? sender.name : null}
            // Only the turn that is actually from the assistant carries the
            // provenance line; a user bubble and an error have no model.
            model={m.role === "assistant" ? model : null}
          />
          );
        })
      )}
    </main>
  );
}
