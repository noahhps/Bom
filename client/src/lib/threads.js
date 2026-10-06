/* Conversations as a messenger lists them: by who is in them.
 *
 * A thread is what the Messages screen lists. Who it is with is read off the
 * session rows the server already sends -- `members` for a group, otherwise
 * `agent_id` -- and the default assistant, with neither, is "Bom". Designs and
 * code sessions are Studio's and are not threads.
 *
 * Each agent has one conversation, so an agent's thread is every chat session
 * it has had alone with the user: one, from now on (the server carries a new
 * message to an agent on in its existing conversation), or several left by
 * builds that started a fresh one each time -- shown as one thread, the
 * newest carrying on and the older ones above it. Group chats and chats with
 * Bom are made as often as they are started, and each is its own thread.
 *
 * `BOM` stands for the default assistant wherever a list of recipients is
 * handled, so "a chat with Bom" and "a chat with the Analyst" go through the
 * same code. It is never sent to the server: no agent is how Bom is said. */

export const BOM = "bom";

/* In an agent's skill list, every connector's tools (the server's
   group.CONNECTORS): whatever its MCP servers offer, now or later. */
export const CONNECTORS = "@connectors";

/* Who a session is with, as recipient ids: the group in order, the one agent,
   or Bom. */
export function membersOf(session) {
  if (!session) return [];
  if (session.members?.length > 1) return session.members;
  return [session.agent_id || BOM];
}

export const isThread = (session) => !session.mode || session.mode === "chat";

/* The same people in any order are the same conversation, as they are in a
   messenger: "Analyst and Writer" and "Writer and Analyst" open one thread. */
export function keyOf(ids) {
  const unique = [...new Set(ids.length ? ids : [BOM])];
  return unique.sort().join("|");
}

/* The newest thread with exactly these people in it, or null. */
export function findThread(sessions, ids) {
  const wanted = keyOf(ids);
  let best = null;
  for (const session of sessions) {
    if (!isThread(session) || keyOf(membersOf(session)) !== wanted) continue;
    if (!best || (session.updated_at || 0) > (best.updated_at || 0)) best = session;
  }
  return best;
}

/* An agent alone, as opposed to a group or Bom: the conversations there is
   only one of. */
export const soloAgent = (ids) => (ids.length === 1 && ids[0] !== BOM ? ids[0] : null);

/* Every thread, newest first. `id` is the session that carries the thread
   on -- where a new message goes -- and `sessions` all of it, newest first. */
export function threadsOf(sessions) {
  const byKey = new Map();
  for (const session of sessions) {
    if (!isThread(session)) continue;
    const members = membersOf(session);
    const agent = soloAgent(members);
    const key = agent ? `agent:${agent}` : `session:${session.id}`;
    const thread = byKey.get(key);
    if (thread) thread.sessions.push(session);
    else byKey.set(key, { key, agent, members, sessions: [session] });
  }
  const threads = [...byKey.values()].map((thread) => {
    thread.sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    const [session] = thread.sessions;
    return { ...thread, id: session.id, session, updated_at: session.updated_at };
  });
  return threads.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

/* The thread a session belongs to. */
export const threadOf = (threads, sessionId) =>
  threads.find((thread) => thread.sessions.some((s) => s.id === sessionId)) || null;

/* An agent's one thread, or null before the first message. */
export const agentThread = (threads, agentId) =>
  threads.find((thread) => thread.agent === agentId) || null;

/* The threads already with exactly these people -- the groups (or chats with
   Bom) a new message to them could carry on instead of starting another. */
export const threadsWith = (threads, ids) => {
  const wanted = keyOf(ids);
  return threads.filter((thread) => !thread.agent && keyOf(thread.members) === wanted);
};

/* What a thread is called in the list: an agent by its name; a group or a
   chat with Bom -- of which there can be many -- by what it is about, once
   the server has named it, and by who is in it until then. */
export function titleOf(thread, people) {
  if (thread.agent) return people[0]?.name || "Agent";
  return thread.session.title || namesOf(people);
}

/* A recipient id as someone to show: an agent, or Bom. Null for an agent that
   has since been deleted. */
export function personOf(id, agents) {
  if (id === BOM) return { id: BOM, name: "Bom", look: null, bom: true };
  return agents.find((agent) => agent.id === id) || null;
}

/* The names of a thread, the way a messenger heads it: one name, two joined
   with "&", and past three the first two and how many more. */
export function namesOf(people) {
  const names = people.map((p) => p.name);
  if (names.length <= 1) return names[0] || "Bom";
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} & ${names[2]}`;
  return `${names[0]}, ${names[1]} & ${names.length - 2} more`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/* When a thread last moved, as a messenger's list says it: the time today,
   "Yesterday", the weekday within the week, the date before that. */
export function whenOf(at) {
  if (!at) return "";
  const when = new Date(at);
  const now = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(when)) / 86_400_000);
  if (days <= 0) return TIME.format(when);
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY.format(when);
  return DAY.format(when);
}
