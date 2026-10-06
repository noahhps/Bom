import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The page a browser has open for this conversation, and whether the panel
 * showing it is up.
 *
 * The server keeps the latest picture of each conversation's tab; this is a
 * view of it. A `browser` frame arrives on the chat stream after every step
 * the model takes in a browser and replaces the view wholesale -- App hands it
 * to `applyEvent`. Opening a conversation asks the server for whatever it
 * last drew, so a panel closed and reopened still has the page.
 *
 * Shaped after useCanvas, including its two awkward cases: a frame for a
 * conversation that is still being created (held until its id lands), and a
 * fetch that resolves after the reader moved on (dropped).
 */
export function useBrowser(api, sessionId) {
  const [view, setView] = useState(null);
  const [open, setOpen] = useState(false);

  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const early = useRef(null);
  const writes = useRef(0);

  useEffect(() => {
    setOpen(false);
    if (!sessionId) {
      setView(null);
      return undefined;
    }
    const held = early.current?.sessionId === sessionId ? early.current.view : null;
    early.current = null;
    if (held) {
      setView(held);
      setOpen(true);
    } else {
      setView(null);
    }
    let ignore = false;
    const seen = writes.current;
    api
      .browserView(sessionId)
      .then((data) => {
        if (!ignore && sessionRef.current === sessionId && writes.current === seen && data?.view) {
          setView(data.view);
        }
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [api, sessionId]);

  // The model took a step in a browser. Show the page, and open the panel so
  // the reader sees what it is looking at without going to find it.
  const applyEvent = useCallback((next, forSessionId) => {
    if (forSessionId && forSessionId !== sessionRef.current) {
      if (!sessionRef.current) early.current = { sessionId: forSessionId, view: next };
      return;
    }
    writes.current += 1;
    setView(next || null);
    if (next) setOpen(true);
  }, []);

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((was) => !was), []);

  return { view, open, has: Boolean(view), applyEvent, openPanel, closePanel, toggle };
}
