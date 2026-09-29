/* A turn, in the order it happened.
 *
 * The server keeps a turn as three things -- the reasoning, the answer, and
 * the skills it ran -- and marks each skill with where it was called: how much
 * reasoning (`r`) and how much answer (`t`) existed at that moment (see the
 * tool_call event in server/app/orchestrator.py). Cutting the two strings at
 * those marks gives the turn back as it unfolded: thinking, then a skill,
 * then what it said, then more thinking, and so on.
 *
 * The same marks arrive live on each tool_call and are stored with the turn,
 * so a reopened conversation reads in the same order it streamed in.
 *
 * Within a stretch between two skills, the thinking comes before the words:
 * that is the order a model produces them in within a round.
 *
 * A skill stored before the marks existed has none. It is placed after all
 * the thinking and before all the words, which is how turns used to be drawn,
 * so older conversations read as they always did. */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * The parts of a turn, in order:
 *   { type: "reasoning", text }
 *   { type: "skills", skills: [...], start }   -- skills called one after
 *                                                  another with nothing
 *                                                  between; `start` is the
 *                                                  index of the first
 *   { type: "text", text }
 * Stretches that are only whitespace are left out.
 */
export function turnTimeline({ reasoning = "", content = "", skills = [] } = {}) {
  const thought = reasoning || "";
  const said = content || "";
  const parts = [];
  let r = 0;
  let t = 0;

  const add = (type, text) => {
    if (!text || !text.trim()) return;
    const last = parts[parts.length - 1];
    // Two pieces of the same kind with nothing between them are one piece.
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };

  (skills || []).forEach((skill, index) => {
    const nextR = clamp(Number.isFinite(skill?.r) ? skill.r : thought.length, r, thought.length);
    const nextT = clamp(Number.isFinite(skill?.t) ? skill.t : t, t, said.length);
    add("reasoning", thought.slice(r, nextR));
    add("text", said.slice(t, nextT));
    r = nextR;
    t = nextT;
    const last = parts[parts.length - 1];
    if (last && last.type === "skills") last.skills.push(skill);
    else parts.push({ type: "skills", skills: [skill], start: index });
  });

  add("reasoning", thought.slice(r));
  add("text", said.slice(t));
  return parts;
}
