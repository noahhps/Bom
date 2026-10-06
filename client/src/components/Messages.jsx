import { useEffect, useMemo, useRef, useState } from "react";

import { lookOf, taglineOf } from "../lib/accessories";
import {
  BOM,
  namesOf,
  personOf,
  soloAgent,
  threadOf,
  threadsWith,
  titleOf,
  whenOf,
} from "../lib/threads";
import { AgentAvatar } from "./AgentAvatar";
import { useDialog } from "./Dialog";
import { Icon } from "./Icon";

/* Messages: the home screen, laid out like a messenger.
 *
 * Down the left, every conversation, newest first, with a line of the last
 * thing said. On the right, the open one.
 *
 * Each agent has one conversation, like a contact: writing to an agent -- the
 * pencil and its name on the "To:" line, or "Message" on the Agents page --
 * always opens that one, carried on where it was left. Conversations with
 * more than one agent are made, as many as you like, each named by what it is
 * about: put two or more agents on the "To:" line (the + adds another, and
 * "New group" starts with the picker open), and the first message makes it.
 * Chats with Bom itself work the same way. When the people on a new message
 * already have a conversation or two, those are offered under the "To:" line
 * to carry on instead.
 *
 * The conversation itself -- thread, composer, canvas -- is the app's own,
 * handed in as `children`, so a chat here has every ability a chat anywhere
 * has. This file only decides who it is with and how that reads. */

/* One person's face, or a group's: two faces, the second tucked behind the
   first, the way a messenger draws a group without a photo of its own. */
export function ThreadAvatar({ people, presets, size = 44, live = false }) {
  if (people.length > 1) {
    const small = Math.round(size * 0.72);
    return (
      <span className="msgs-avatar-group" style={{ "--size": `${size}px` }} aria-hidden="true">
        <AgentAvatar look={lookOf(people[1], presets)} size={small} className="msgs-avatar-back" />
        <AgentAvatar look={lookOf(people[0], presets)} size={small} blooming={live} className="msgs-avatar-front" />
      </span>
    );
  }
  return <AgentAvatar look={people[0] ? lookOf(people[0], presets) : null} size={size} blooming={live} />;
}

/* "is typing": three dots, while a reply is being written in that thread. */
function Typing() {
  return (
    <span className="msgs-typing" role="status" aria-label="Writing a reply">
      <i />
      <i />
      <i />
    </span>
  );
}

function ThreadRow({ thread, people, presets, active, live, onOpen, onDelete }) {
  const name = titleOf(thread, people);
  const names = namesOf(people);
  return (
    <li className="msgs-row-wrap">
      <button
        type="button"
        className="msgs-row"
        aria-current={active ? "true" : undefined}
        // Who is in it, for a conversation named by what it is about.
        title={thread.agent ? undefined : names}
        onClick={() => onOpen(thread.id)}
      >
        <ThreadAvatar people={people} presets={presets} size={42} live={live} />
        <span className="msgs-row-text">
          <span className="msgs-row-top">
            <span className="msgs-row-name">{name}</span>
            <span className="msgs-row-when">{whenOf(thread.updated_at)}</span>
          </span>
          <span className="msgs-row-line">
            {live ? <Typing /> : thread.session.preview || "No messages yet"}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="msgs-row-delete"
        aria-label={`Delete ${thread.agent ? `your conversation with ${name}` : name}`}
        title="Delete conversation"
        onClick={() => onDelete(thread)}
      >
        <Icon name="trash" />
      </button>
    </li>
  );
}

/* The "To:" line of a new message.
 *
 * People are chips; typing filters who else can be added; Enter or a click
 * adds the highlighted one, Backspace on an empty field takes the last one
 * off, and Enter with nothing typed moves on to the message. Bom is one of
 * the choices, but only on its own: it is the app itself, not a member of a
 * group of its agents. */
function RecipientField({ chosen, agents, presets, onChange, onDone, autoFocus, pickToken = 0, grouping = false }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const field = useRef(null);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // "New group", or the +: the picker, open, with the caret in it.
  useEffect(() => {
    if (!pickToken) return;
    field.current?.focus();
    setOpen(true);
  }, [pickToken]);

  const people = chosen.map((id) => personOf(id, agents)).filter(Boolean);
  const options = useMemo(() => {
    const typed = query.trim().toLowerCase();
    const everyone = [personOf(BOM, agents), ...agents];
    return everyone.filter(
      (p) =>
        !chosen.includes(p.id) &&
        // Bom alone, or agents together -- never Bom in a group.
        (p.bom ? chosen.length === 0 : !chosen.includes(BOM)) &&
        (!typed || p.name.toLowerCase().includes(typed)),
    );
  }, [query, agents, chosen]);

  const add = (person) => {
    // Picking an agent while Bom is the only one chosen swaps Bom out: a
    // conversation with Bom and an agent is not one there is a way to have.
    const base = person.bom ? [] : chosen.filter((id) => id !== BOM);
    const next = [...base, person.id];
    onChange(next);
    setQuery("");
    setIndex(0);
    // Shut until the next keystroke or the +: an agent's conversation may
    // just have appeared underneath, and it is what to look at now. Picking
    // a group, it stays open until there are two.
    setOpen(grouping && next.length < 2);
    field.current?.focus();
  };

  return (
    <div className="msgs-to" onClick={() => field.current?.focus()}>
      <span className="msgs-to-label">To:</span>
      <ul className="msgs-to-chips" aria-label="Recipients">
        {people.map((p) => (
          <li key={p.id} className="msgs-chip">
            <AgentAvatar look={lookOf(p, presets)} size={18} />
            <span>{p.name}</span>
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(chosen.filter((id) => id !== p.id));
                field.current?.focus();
              }}
            >
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ul>
      <div className="msgs-to-field">
        <input
          ref={field}
          value={query}
          placeholder={
            grouping && chosen.length < 2
              ? "Choose two or more agents"
              : chosen.length === 0
                ? "Bom, an agent, or several for a group"
                : chosen.includes(BOM)
                  ? ""
                  : "Add another for a group"
          }
          aria-label="Add a recipient"
          aria-expanded={open && options.length > 0}
          aria-controls="msgs-to-options"
          role="combobox"
          aria-autocomplete="list"
          onFocus={() => setOpen(chosen.length === 0)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              setIndex((i) => (options.length ? (i + step + options.length) % options.length : 0));
            } else if (event.key === "Enter" || (event.key === "Tab" && query)) {
              if (query.trim() && options.length) {
                event.preventDefault();
                add(options[Math.min(index, options.length - 1)]);
              } else if (event.key === "Enter") {
                event.preventDefault();
                onDone();
              }
            } else if (event.key === "Backspace" && !query && chosen.length) {
              onChange(chosen.slice(0, -1));
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {open && options.length > 0 ? (
          <ul className="msgs-to-options" id="msgs-to-options" role="listbox">
            {grouping ? <li className="msgs-to-hint" role="presentation">Choose two or more agents</li> : null}
            {options.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === index}>
                <button
                  type="button"
                  // On press, before the field blurs and the list goes.
                  onPointerDown={(event) => {
                    event.preventDefault();
                    add(p);
                  }}
                  onPointerEnter={() => setIndex(i)}
                >
                  <AgentAvatar look={lookOf(p, presets)} size={28} />
                  <span className="msgs-option-text">
                    <span className="msgs-option-name">{p.name}</span>
                    <span className="msgs-option-line">
                      {p.bom ? "Every skill, no specialty" : taglineOf(p, presets)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* Add someone, the visible way -- the picker otherwise opens only on
          typing, and a conversation with more than one agent is made right
          here. */}
      {chosen.includes(BOM) ? null : (
        <button
          type="button"
          className="msgs-to-add"
          aria-label="Add an agent"
          title="Add an agent"
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            field.current?.focus();
            setOpen(true);
          }}
        >
          <Icon name="plus" />
        </button>
      )}
    </div>
  );
}

/* Who is in an open conversation, and the ways to change that: customise an
   agent, add someone, take someone out of a group. A popover from the name
   in the header, so it grows out of the thing that opened it. */
function ThreadDetails({ people, agents, presets, onCustomize, onMembers, onDelete, onClose }) {
  const [adding, setAdding] = useState(false);
  const panel = useRef(null);
  const group = people.length > 1;
  const ids = people.map((p) => p.id);
  const others = agents.filter((a) => !ids.includes(a.id));

  useEffect(() => {
    const away = (event) => {
      if (!panel.current?.contains(event.target)) onClose();
    };
    const key = (event) => event.key === "Escape" && onClose();
    // On the next tick: the click that opened this is still bubbling.
    const timer = setTimeout(() => document.addEventListener("pointerdown", away), 0);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div className="msgs-details" ref={panel} role="dialog" aria-label="Conversation details">
      <ul className="msgs-details-people">
        {people.map((p) => (
          <li key={p.id}>
            <AgentAvatar look={lookOf(p, presets)} size={34} />
            <span className="msgs-option-text">
              <span className="msgs-option-name">{p.name}</span>
              <span className="msgs-option-line">
                {p.bom ? "Every skill, no specialty" : taglineOf(p, presets)}
              </span>
            </span>
            {p.bom ? null : (
              <button type="button" className="icon-btn" title={`Customize ${p.name}`} aria-label={`Customize ${p.name}`} onClick={() => onCustomize(p)}>
                <Icon name="pen" />
              </button>
            )}
            {group && people.length > 2 ? (
              <button
                type="button"
                className="icon-btn"
                title={`Remove ${p.name} from the group`}
                aria-label={`Remove ${p.name} from the group`}
                onClick={() => onMembers(ids.filter((id) => id !== p.id))}
              >
                <Icon name="close" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {people[0]?.bom || others.length === 0 ? null : adding ? (
        <ul className="msgs-details-add">
          {others.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => onMembers([...ids, a.id])}>
                <AgentAvatar look={lookOf(a, presets)} size={24} />
                <span>{a.name}</span>
                <Icon name="plus" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <button type="button" className="btn msgs-details-more" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          {group ? "Add to the group" : "New group with…"}
        </button>
      )}
      <button type="button" className="msgs-details-delete" onClick={onDelete}>
        <Icon name="trash" />
        Delete conversation
      </button>
    </div>
  );
}

export function MessagesScreen({
  threads,
  agents,
  presets,
  activeId,
  liveId,
  composing,
  recipients,
  onRecipients,
  // Enter on an empty "To:" line: on to the message itself.
  onRecipientsDone,
  // Back out of a new message without sending it.
  onComposeCancel,
  onOpen,
  onCompose,
  onDelete,
  onCustomize,
  onMembers,
  canvasCount = 0,
  canvasOpen = false,
  onToggleCanvas,
  browserShown = false,
  browserOpen = false,
  onToggleBrowser,
  children,
}) {
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState(false);
  // On a phone the list and the thread take turns: back shows the list
  // without closing the conversation, and opening one shows it again.
  const [listed, setListed] = useState(false);
  // "New group": the picker opens, and stays open until there are two.
  const [grouping, setGrouping] = useState(false);
  const [pickToken, setPickToken] = useState(0);
  const { confirm } = useDialog();

  const peopleOf = (ids) => ids.map((id) => personOf(id, agents)).filter(Boolean);
  const rows = useMemo(() => {
    const typed = search.trim().toLowerCase();
    return threads
      .map((thread) => ({ thread, people: peopleOf(thread.members) }))
      .filter(({ thread, people }) => {
        if (!typed) return true;
        const haystack = [titleOf(thread, people), namesOf(people), thread.session.preview]
          .join(" ")
          .toLowerCase();
        return haystack.includes(typed);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, agents, search]);

  const openThread = composing ? null : threadOf(threads, activeId);
  const people = composing ? peopleOf(recipients) : openThread ? peopleOf(openThread.members) : [];
  const group = people.length > 1;
  const titled = openThread && !openThread.agent && openThread.session.title;
  // A new message to a group, or to Bom: the conversations already with
  // exactly them, to carry on instead of starting another.
  const existing =
    composing && recipients.length && !soloAgent(recipients) && !(grouping && recipients.length < 2)
      ? threadsWith(threads, recipients).slice(0, 3)
      : [];

  // A different conversation is a different set of people: the details of the
  // last one should not stay open over it.
  useEffect(() => {
    setDetails(false);
    setListed(false);
  }, [activeId, composing]);
  useEffect(() => {
    if (!composing) setGrouping(false);
  }, [composing]);

  const remove = async (thread) => {
    const who = peopleOf(thread.members);
    const name = titleOf(thread, who);
    const sure = await confirm(
      thread.agent
        ? `Your conversation with ${name}, and everything in it, will be deleted. ${name} stays in your agents.`
        : `“${name}”, and everything in it, will be deleted.`,
      { title: "Delete this conversation?", confirmLabel: "Delete", destructive: true },
    );
    if (sure) onDelete(thread.id);
  };

  return (
    <div
      className="msgs"
      data-composing={composing ? "" : undefined}
      data-open={(openThread || composing) && !listed ? "" : undefined}
    >
      <aside className="msgs-side" aria-label="Conversations">
        <div className="msgs-side-head">
          <h1 className="msgs-heading">Messages</h1>
          <button
            type="button"
            className="msgs-compose"
            title="New group"
            aria-label="New group"
            aria-pressed={composing && grouping}
            onClick={() => {
              onCompose();
              setGrouping(true);
              setPickToken((n) => n + 1);
            }}
          >
            <Icon name="agents" />
          </button>
          <button
            type="button"
            className="msgs-compose"
            title="New message"
            aria-label="New message"
            aria-pressed={composing && !grouping}
            onClick={() => {
              setGrouping(false);
              onCompose();
            }}
          >
            <Icon name="pen" />
          </button>
        </div>
        <label className="msgs-search">
          <Icon name="search" />
          <input
            type="search"
            value={search}
            placeholder="Search"
            aria-label="Search conversations"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {rows.length === 0 ? (
          <p className="msgs-empty">
            {search ? "Nothing matches that." : "No conversations yet. Write to Bom or one of your agents to start one."}
          </p>
        ) : (
          <ul className="msgs-list">
            {rows.map(({ thread, people: who }) => (
              <ThreadRow
                key={thread.key}
                thread={thread}
                people={who}
                presets={presets}
                active={!composing && thread.id === activeId}
                live={Boolean(liveId) && thread.sessions.some((s) => s.id === liveId)}
                onOpen={(id) => {
                  setListed(false);
                  onOpen(id);
                }}
                onDelete={remove}
              />
            ))}
          </ul>
        )}
      </aside>

      <div className="msgs-main">
        <header className="msgs-head">
          {composing ? (
            <>
              <button
                type="button"
                className="icon-btn msgs-back"
                aria-label="Back to conversations"
                onClick={() => {
                  onComposeCancel();
                  setListed(true);
                }}
              >
                <Icon name="chevron" />
              </button>
              <RecipientField
                chosen={recipients}
                agents={agents}
                presets={presets}
                onChange={(ids) => onRecipients(ids, { grouping })}
                onDone={onRecipientsDone}
                autoFocus={recipients.length === 0}
                pickToken={pickToken}
                grouping={grouping}
              />
            </>
          ) : (
            <>
              <button type="button" className="icon-btn msgs-back" aria-label="Back to conversations" onClick={() => setListed(true)}>
                <Icon name="chevron" />
              </button>
              <button
                type="button"
                className="msgs-who"
                aria-expanded={details}
                aria-haspopup="dialog"
                onClick={() => setDetails((was) => !was)}
              >
                <ThreadAvatar people={people} presets={presets} size={30} />
                <span className="msgs-who-name">{openThread ? titleOf(openThread, people) : namesOf(people)}</span>
                {group ? (
                  <span className="msgs-who-count" title={namesOf(people)}>
                    {titled ? namesOf(people) : `${people.length} agents`}
                  </span>
                ) : null}
                <Icon name="chevron" />
              </button>
              <span className="msgs-head-tools">
                {canvasCount > 0 ? (
                  <button
                    type="button"
                    className="icon-btn canvas-btn"
                    data-on={canvasOpen ? "" : undefined}
                    aria-label={canvasOpen ? "Hide canvas" : "Show canvas"}
                    aria-pressed={canvasOpen}
                    title="Canvas"
                    onClick={onToggleCanvas}
                  >
                    <Icon name="canvas" />
                  </button>
                ) : null}
                {browserShown ? (
                  <button
                    type="button"
                    className="icon-btn canvas-btn"
                    data-on={browserOpen ? "" : undefined}
                    aria-label={browserOpen ? "Hide browser" : "Show browser"}
                    aria-pressed={browserOpen}
                    title="Browser"
                    onClick={onToggleBrowser}
                  >
                    <Icon name="globe" />
                  </button>
                ) : null}
              </span>
              {details && openThread ? (
                <ThreadDetails
                  people={people}
                  agents={agents}
                  presets={presets}
                  onCustomize={(agent) => {
                    setDetails(false);
                    onCustomize(agent);
                  }}
                  onMembers={(ids) => {
                    setDetails(false);
                    onMembers(openThread.session, ids);
                  }}
                  onDelete={() => {
                    setDetails(false);
                    remove(openThread);
                  }}
                  onClose={() => setDetails(false)}
                />
              ) : null}
            </>
          )}
        </header>
        {existing.length > 0 ? (
          <div className="msgs-existing" aria-label="Conversations already with them">
            <span className="msgs-existing-label">Carry on</span>
            {existing.map((thread) => (
              <button key={thread.key} type="button" onClick={() => onOpen(thread.id)}>
                <span className="msgs-existing-name">{titleOf(thread, people)}</span>
                <span className="msgs-existing-when">{whenOf(thread.updated_at)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/* Above an empty conversation: who it is with and what they are for, in
   place of the app's own greeting -- and for a group, how to ask one of
   them in particular. */
export function ThreadGreeting({ people, presets }) {
  const group = people.length > 1;
  const one = people[0];
  return (
    <div className="starters-head msgs-greeting">
      <div className="starters-greeting">
        <ThreadAvatar people={people} presets={presets} size={56} />
        <h2 className="h">
          {group ? namesOf(people) : one?.bom || !one ? "What are we working on?" : `Hi, I’m ${one.name}.`}
        </h2>
      </div>
      <p className="p">
        {group
          ? "A group chat. Whoever answered last picks up the next message -- type @ and a name to ask someone else, or @everyone to hear from all of them."
          : one && !one.bom
            ? taglineOf(one, presets)
            : "Everything here runs on your own hardware. Nothing leaves the machine unless you send it to the cloud provider on purpose."}
      </p>
    </div>
  );
}
