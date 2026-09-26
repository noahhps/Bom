import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The canvases beside a conversation, and whether the panel is open.
 *
 * Durable state lives on the server; this is a view of it. The list is loaded
 * when a conversation opens and replaced wholesale when the model rewrites a
 * canvas mid-turn -- that arrives as a `canvas` frame on the chat stream, which
 * App hands to `applyEvent`. A reader editing the panel by hand saves through
 * `save`, and the optimistic local update keeps the editor from flickering
 * back to the old text while the request is in flight.
 */
export function useCanvas(api, sessionId) {
  const [canvases, setCanvases] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [open, setOpen] = useState(false);

  // Readable from an async callback that outlived its render: "is this still
  // the open conversation?" cannot be answered from a stale closure, and a
  // load or an event that resolves after the reader has moved on must not land
  // on the conversation they moved to.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  // A canvas written in the very first turn of a new conversation can arrive
  // before this hook has seen that conversation's id -- the `session` frame
  // and the `canvas` frame are a few milliseconds apart, and a render need not
  // fall between them. Kept here until the id lands, rather than dropped.
  const early = useRef(null);
  // Bumped by every model write, so a list fetched before one cannot land on
  // top of it and put back the version without the new canvas.
  const writes = useRef(0);

  // A conversation's canvases load when it opens. A conversation with none is
  // the common case, so the panel starts shut and stays shut until there is
  // something to show or the reader opens it themselves.
  useEffect(() => {
    setActiveId(null);
    setOpen(false);
    if (!sessionId) {
      setCanvases([]);
      return undefined;
    }
    const held = early.current?.sessionId === sessionId ? early.current.list : null;
    early.current = null;
    if (held?.length) {
      setCanvases(held);
      setActiveId(held[0].id);
      setOpen(true);
    }
    let ignore = false;
    const seen = writes.current;
    api
      .listCanvases(sessionId)
      .then((data) => {
        if (!ignore && sessionRef.current === sessionId && writes.current === seen) {
          setCanvases(data.canvases || []);
        }
      })
      .catch(() => {
        if (!ignore) setCanvases([]);
      });
    return () => {
      ignore = true;
    };
  }, [api, sessionId]);

  // The model rewrote a canvas. Replace the list, focus whichever it touched
  // (the server orders most-recent-first, so that is the head), and open the
  // panel so the change is not something the reader has to go looking for.
  const applyEvent = useCallback((list, forSessionId) => {
    if (forSessionId && forSessionId !== sessionRef.current) {
      // Only a conversation still being created is held for later. One the
      // reader has navigated away from is theirs to reopen.
      if (!sessionRef.current) early.current = { sessionId: forSessionId, list: list || [] };
      return;
    }
    writes.current += 1;
    const next = list || [];
    setCanvases(next);
    if (next.length) {
      setActiveId(next[0].id);
      setOpen(true);
    }
  }, []);

  const active =
    canvases.find((c) => c.id === activeId) || canvases[0] || null;

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const select = useCallback((id) => {
    setActiveId(id);
    setOpen(true);
  }, []);

  const save = useCallback(
    async (id, patch) => {
      const updated = await api.updateCanvas(id, patch);
      setCanvases((prev) => prev.map((c) => (c.id === id ? updated : c)));
      return updated;
    },
    [api],
  );

  // A title alone makes a blank document, as it always has; an object makes
  // any kind with the starter content the panel's + menu hands it.
  const create = useCallback(
    async (spec = "Untitled") => {
      if (!sessionId) return null;
      const body = typeof spec === "string" ? { title: spec } : spec;
      const canvas = await api.createCanvas(sessionId, body);
      setCanvases((prev) => [canvas, ...prev]);
      setActiveId(canvas.id);
      setOpen(true);
      return canvas;
    },
    [api, sessionId],
  );

  const remove = useCallback(
    async (id) => {
      await api.deleteCanvas(id);
      setCanvases((prev) => {
        const next = prev.filter((c) => c.id !== id);
        // Leaving the removed one selected would blank the panel; fall through
        // to the next canvas, or shut the panel when that was the last.
        setActiveId((current) => (current === id ? next[0]?.id || null : current));
        if (!next.length) setOpen(false);
        return next;
      });
    },
    [api],
  );

  return {
    canvases,
    active,
    activeId: active?.id || null,
    open,
    count: canvases.length,
    applyEvent,
    select,
    openPanel,
    closePanel,
    toggle,
    save,
    create,
    remove,
  };
}
