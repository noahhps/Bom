import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useImageUrls, useSessionImages } from "../hooks/useImages";
import { useApi } from "../lib/api-context";
import { fileStem, saveFile } from "../lib/files";
import { imageData, resolveAll } from "../lib/images";
import { serializeSheet } from "../lib/sheet";
import { serializeDeck } from "../lib/slides";
import { Icon } from "./Icon";
import {
  FRAME_PRESETS,
  buildPdf,
  buildZip,
  canvasBlob,
  frameToCanvas,
  loadPictures,
  newId,
  newLayer,
  palette,
  renderFrame,
  toDeck,
  toDocument,
  toHtmlCss,
  toSheet,
  wireframeImageIds,
} from "../lib/wireframe";

/* The wireframe editor: a small Figma.
 *
 * A board of frames you pan and zoom, layers you draw, select, drag, resize and
 * restyle, snapping guides while you move, a layers panel, a properties
 * inspector, undo, and a prototype mode that clicks through the links between
 * frames. Drawn with HTML and CSS -- lib/wireframe renders every frame to
 * markup, and this component only adds the chrome and the pointer work.
 *
 * The document is edited in local state while a gesture is under way, so a
 * drag is not a save per pixel; the finished edit goes up through `onChange`
 * and the panel saves it on its usual debounce. Undo is a stack of documents.
 */

const POINTERS = [
  { id: "move", label: "Move", key: "V", glyph: "↖" },
  { id: "hand", label: "Hand", key: "H", glyph: "✋︎" },
];

const TOOLS = [
  { id: "move", label: "Move", key: "V", glyph: "↖" },
  { id: "frame", label: "Frame", key: "F", glyph: "#" },
  { id: "rect", label: "Rectangle", key: "R", glyph: "▢" },
  { id: "ellipse", label: "Ellipse", key: "O", glyph: "◯" },
  { id: "line", label: "Line", key: "L", glyph: "╱" },
  { id: "text", label: "Text", key: "T", glyph: "T" },
  { id: "image", label: "Image", key: "I", glyph: "▨" },
  { id: "hand", label: "Hand", key: "H", glyph: "✋︎" },
];

const COMPONENTS = [
  { id: "button", label: "Button", key: "B" },
  { id: "input", label: "Input" },
  { id: "checkbox", label: "Checkbox" },
  { id: "toggle", label: "Toggle" },
  { id: "nav", label: "Nav bar" },
  { id: "card", label: "Card" },
  { id: "lines", label: "Text lines" },
  { id: "avatar", label: "Avatar" },
  { id: "icon", label: "Icon" },
];

const TYPE_GLYPH = {
  rect: "▢", ellipse: "◯", line: "╱", text: "T", image: "▨", button: "⏺", input: "▭",
  checkbox: "☑", toggle: "◐", avatar: "◉", icon: "★", nav: "☰", card: "▤", lines: "≡",
};

const ICON_NAMES = ["menu", "search", "heart", "star", "user", "bell", "cart", "home", "settings",
  "close", "plus", "arrow", "back", "check", "mail", "play", "share", "more", "filter", "calendar"];

const ALIGNS = [
  ["left", "⇤", "Left"], ["hcenter", "↔", "Centre"], ["right", "⇥", "Right"],
  ["top", "⤒", "Top"], ["vcenter", "↕", "Middle"], ["bottom", "⤓", "Bottom"],
];

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const SNAP = 6;
const MIN_Z = 0.05;
const MAX_Z = 8;
const TEXTISH = new Set(["text", "button", "input", "checkbox", "toggle", "nav", "card", "avatar"]);

const layerLabel = (layer) =>
  layer.name || (layer.text ? `${layer.text}`.slice(0, 28) : layer.type[0].toUpperCase() + layer.type.slice(1));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v) => Math.round(v);

/* -- small fields for the inspector ---------------------------------------------- */

function NumField({ label, value, onCommit, step = 1, min = -100000 }) {
  const [text, setText] = useState(String(Math.round((value ?? 0) * 100) / 100));
  useEffect(() => setText(String(Math.round((value ?? 0) * 100) / 100)), [value]);
  const commit = (raw) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n !== value) onCommit(Math.max(min, n));
    else setText(String(Math.round((value ?? 0) * 100) / 100));
  };
  return (
    <label className="wf-num">
      <span>{label}</span>
      <input
        value={text}
        inputMode="decimal"
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const next = (Number(text) || 0) + (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
            setText(String(next));
            onCommit(Math.max(min, next));
          }
        }}
      />
    </label>
  );
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const toHex6 = (c) => {
  if (HEX6.test(c || "")) return c;
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(c || "");
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : "#cccccc";
};

function ColorField({ label, value, placeholder, onCommit }) {
  const [text, setText] = useState(value || "");
  useEffect(() => setText(value || ""), [value]);
  return (
    <div className="wf-color">
      <span className="wf-color-label">{label}</span>
      <input
        type="color"
        aria-label={`${label} colour`}
        value={toHex6(value || placeholder)}
        onChange={(event) => onCommit(event.target.value.toUpperCase())}
      />
      <input
        className="wf-color-text"
        value={text}
        placeholder={placeholder || "Default"}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onCommit(text.trim() || null)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {value ? (
        <button type="button" className="wf-x" title="Back to default" onClick={() => onCommit(null)}>×</button>
      ) : null}
    </div>
  );
}

function TextField({ label, value, onCommit, multiline = false }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const Tag = multiline ? "textarea" : "input";
  return (
    <label className="wf-field">
      <span>{label}</span>
      <Tag
        value={text}
        rows={multiline ? 3 : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => text !== (value ?? "") && onCommit(text)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !(multiline && event.shiftKey)) {
            if (!multiline || event.metaKey || event.ctrlKey) event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/* -- dropdowns ------------------------------------------------------------------------ */

/* One menu in the toolbar or a panel. Which one is open is the editor's
   `menu` state, so opening one shuts any other; picking an item shuts it. */
function Dropdown({ id, menu, setMenu, label, title, disabled = false, right = false, compact = false, children }) {
  const open = menu === id;
  const anchor = useRef(null);
  // Placed against the viewport, not its parent: a menu inside a scrolling
  // panel would otherwise be clipped by it. It opens toward whichever side
  // keeps it inside the editor, where nothing else draws over it, and below
  // or above its button, whichever has the room.
  const [place, setPlace] = useState(null);
  const menuNode = useRef(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) {
      setPlace(null);
      return;
    }
    const box = anchor.current.getBoundingClientRect();
    const bounds = anchor.current.closest(".wf")?.getBoundingClientRect() ||
      { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    const width = Math.max(menuNode.current?.offsetWidth || 0, 200);
    let toRight = right;
    if (box.left + width > bounds.right) toRight = true;
    else if (box.right - width < bounds.left) toRight = false;
    const left = toRight ? Math.max(bounds.left + 4, box.right - width) : Math.min(box.left, bounds.right - width - 4);
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const up = below < 240 && above > below;
    setPlace({
      left,
      ...(up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }),
      maxHeight: Math.min(560, up ? above : below),
    });
  }, [open, right]);
  return (
    <div className="wf-menu-anchor" ref={anchor}>
      <button
        type="button"
        className="wf-drop"
        data-compact={compact ? "" : undefined}
        data-on={open ? "" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setMenu(open ? null : id);
        }}
      >
        {label}
        <span className="wf-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          className="wf-menu"
          role="menu"
          ref={menuNode}
          data-fixed=""
          style={place ? { ...place, visibility: "visible" } : { visibility: "hidden" }}
          onClick={(event) => {
            if (event.target.closest?.("[role^=menuitem]:not(:disabled)")) setMenu(null);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* A row in a dropdown: its mark, its name, its shortcut, and a tick when it
   is the current choice. */
function Item({ glyph, icon, keys, on, disabled, onClick, children }) {
  return (
    <button
      type="button"
      role={on === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={on === undefined ? undefined : Boolean(on)}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} /> : <span className="wf-tree-glyph">{glyph ?? ""}</span>}
      <span className="wf-item-label">{children}</span>
      {keys ? <kbd className="wf-kbd">{keys}</kbd> : null}
      {on ? <span className="wf-tick" aria-hidden="true">✓</span> : null}
    </button>
  );
}

const MenuLabel = ({ children }) => <span className="wf-menu-label mi">{children}</span>;
const MenuRule = () => <div className="wf-menu-rule" role="separator" />;

/* -- the prototype player ------------------------------------------------------------ */

function Prototype({ doc, P, images, start, onClose }) {
  const [at, setAt] = useState(start);
  const [hint, setHint] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const node = useRef(null);
  const frame = doc.frames.find((f) => f.id === at) || doc.frames[0];
  const index = doc.frames.indexOf(frame);
  const html = useMemo(() => renderFrame(frame, P, images), [frame, P, images]);

  useEffect(() => {
    node.current?.focus();
    const resize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const scale = Math.min((size.w - 48) / frame.w, (size.h - 72) / frame.h, 2);
  const go = (i) => setAt(doc.frames[(i + doc.frames.length) % doc.frames.length].id);

  // On the body, not in the panel: the panel is its own stacking context, and
  // a fixed overlay inside it would sit under the rail.
  return createPortal(
    <div
      className="wf-proto"
      ref={node}
      tabIndex={-1}
      role="dialog"
      aria-label="Prototype"
      data-hint={hint ? "" : undefined}
      onKeyDown={(event) => {
        // A portal still bubbles through React to the editor, whose arrows
        // would nudge the selection behind the prototype.
        event.stopPropagation();
        if (event.key === "Escape") onClose();
        if (event.key === "ArrowRight") go(index + 1);
        if (event.key === "ArrowLeft") go(index - 1);
      }}
      onClick={(event) => {
        const link = event.target.closest?.("[data-link]")?.getAttribute("data-link");
        if (link && doc.frames.some((f) => f.id === link)) {
          setAt(link);
          return;
        }
        // Clicking somewhere that goes nowhere shows where you could click,
        // the way Figma's prototype flashes its hotspots.
        setHint(true);
        setTimeout(() => setHint(false), 600);
      }}
    >
      <div className="wf-proto-stage" style={{ width: frame.w * scale, height: frame.h * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <div className="wf-proto-bar">
        <button type="button" onClick={(e) => { e.stopPropagation(); go(index - 1); }}>‹</button>
        {frame.name} · {index + 1} / {doc.frames.length}
        <button type="button" onClick={(e) => { e.stopPropagation(); go(index + 1); }}>›</button>
        <button type="button" onClick={(e) => { e.stopPropagation(); onClose(); }}>Close (Esc)</button>
      </div>
    </div>,
    document.body,
  );
}

/* -- the editor ---------------------------------------------------------------------- */

export function WireframeView({ doc, fallbackTheme, onChange, sessionId, onMakeCanvas, title }) {
  const api = useApi();
  const [work, setWork] = useState(doc);
  const workRef = useRef(work);
  workRef.current = work;
  const history = useRef({ past: [], future: [] });
  const [, bump] = useState(0);
  const gesture = useRef(null);

  // An outside rewrite -- the model's, or Source -- replaces the working copy,
  // unless a gesture is under way, when it would yank the thing being dragged.
  // One that arrives mid-gesture is held and wins when the gesture ends.
  const incoming = useRef(null);
  useEffect(() => {
    if (gesture.current) incoming.current = doc;
    else setWork(doc);
  }, [doc]);

  const [tool, setTool] = useState("move");
  const [sel, setSel] = useState({ frame: null, layers: [], frameSelected: false });
  const [view, setView] = useState({ x: 40, y: 40, z: 0.6 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [guides, setGuides] = useState([]);
  const [marquee, setMarquee] = useState(null);
  const [draft, setDraft] = useState(null);
  const [hover, setHover] = useState(null);
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  // An open dropdown shuts on a press anywhere outside it.
  useEffect(() => {
    if (!menu) return undefined;
    const away = (event) => {
      if (!event.target.closest?.(".wf-menu-anchor")) setMenu(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);
  const [proto, setProto] = useState(null);
  const [full, setFull] = useState(false);
  const [wide, setWide] = useState(true);
  // Which side panels show. Narrow, they are overlays and start shut; wide,
  // they are columns and start open. Either way the View menu switches them.
  const [panels, setPanels] = useState({ layers: false, design: false });
  const [hidden, setHidden] = useState({ layers: false, design: false });
  const [busy, setBusy] = useState("");
  const clipboard = useRef([]);
  const space = useRef(false);
  const root = useRef(null);
  const vp = useRef(null);

  const P = useMemo(() => palette(work, fallbackTheme), [work.fidelity, work.theme, fallbackTheme]); // eslint-disable-line react-hooks/exhaustive-deps
  const images = useImageUrls(wireframeImageIds(work));
  const library = useSessionImages(sessionId);

  // Each frame's markup, cached by the frame object: an edit replaces only the
  // frames it touches, so only those are rendered again.
  const cache = useRef(new Map());
  const frameHtml = useCallback(
    (frame) => {
      const hit = cache.current.get(frame);
      if (hit && hit.P === P && hit.images === images) return hit.html;
      const html = renderFrame(frame, P, images);
      cache.current.set(frame, { P, images, html });
      return html;
    },
    [P, images],
  );

  // Side columns when there is room; overlays over the board when there is not.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const observe = new ResizeObserver(() => setWide(el.clientWidth >= 900));
    observe.observe(el);
    return () => observe.disconnect();
  }, [full]);

  const fit = useCallback((frames = workRef.current.frames) => {
    const el = vp.current;
    if (!el || !frames.length) return;
    const minX = Math.min(...frames.map((f) => f.x));
    const minY = Math.min(...frames.map((f) => f.y));
    const maxX = Math.max(...frames.map((f) => f.x + f.w));
    const maxY = Math.max(...frames.map((f) => f.y + f.h));
    const w = el.clientWidth;
    const h = el.clientHeight;
    const z = clamp(Math.min((w - 80) / (maxX - minX), (h - 80) / (maxY - minY), 1), MIN_Z, MAX_Z);
    setView({ z, x: (w - (maxX - minX) * z) / 2 - minX * z, y: (h - (maxY - minY) * z) / 2 - minY * z + 8 });
  }, []);
  // Fit to the frames until the reader takes the view into their own hands:
  // on opening, whenever the viewport changes size (the panel sliding open,
  // full screen) and whenever the document is replaced from outside.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = vp.current;
    if (!el) return undefined;
    const observe = new ResizeObserver(() => {
      if (!placed.current && el.clientWidth > 0) fit();
    });
    observe.observe(el);
    return () => observe.disconnect();
  }, [fit, full]);
  useEffect(() => {
    // Only a document from outside -- an edit here hands back the very object
    // already being worked on, and refitting under the reader would jump.
    if (!placed.current && doc !== workRef.current) requestAnimationFrame(() => fit(doc.frames));
  }, [doc, fit]);

  /* -- editing the document ---------------------------------------------------- */

  const commit = useCallback(
    (next, before = workRef.current) => {
      history.current.past.push(before);
      if (history.current.past.length > 100) history.current.past.shift();
      history.current.future = [];
      setWork(next);
      onChange(next);
      bump((n) => n + 1);
    },
    [onChange],
  );

  const undo = useCallback(() => {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push(workRef.current);
    setWork(prev);
    onChange(prev);
    bump((n) => n + 1);
  }, [onChange]);

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(workRef.current);
    setWork(next);
    onChange(next);
    bump((n) => n + 1);
  }, [onChange]);

  const mapFrame = (d, frameId, fn) => ({ ...d, frames: d.frames.map((f) => (f.id === frameId ? fn(f) : f)) });
  const mapLayers = (d, frameId, ids, fn) =>
    mapFrame(d, frameId, (f) => ({ ...f, layers: f.layers.map((l) => (ids.includes(l.id) ? fn(l) : l)) }));

  const patchLayers = (patch) => {
    if (!sel.frame || !sel.layers.length) return;
    commit(mapLayers(workRef.current, sel.frame, sel.layers, (l) => {
      const next = { ...l, ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === null || v === undefined) delete next[k];
      return next;
    }));
  };
  const patchFrame = (patch) => {
    if (!sel.frame) return;
    commit(mapFrame(workRef.current, sel.frame, (f) => {
      const next = { ...f, ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
      return next;
    }));
  };

  const currentFrame = work.frames.find((f) => f.id === sel.frame) || null;
  const selectedLayers = currentFrame ? currentFrame.layers.filter((l) => sel.layers.includes(l.id)) : [];
  const single = selectedLayers.length === 1 ? selectedLayers[0] : null;

  const removeSelection = () => {
    if (sel.frameSelected && sel.frame) {
      commit({ ...workRef.current, frames: workRef.current.frames.filter((f) => f.id !== sel.frame) });
      setSel({ frame: null, layers: [], frameSelected: false });
      return;
    }
    if (!sel.layers.length) return;
    commit(mapFrame(workRef.current, sel.frame, (f) => ({ ...f, layers: f.layers.filter((l) => !sel.layers.includes(l.id)) })));
    setSel({ frame: sel.frame, layers: [], frameSelected: false });
  };

  const duplicate = () => {
    if (sel.frameSelected && currentFrame) {
      const copy = {
        ...currentFrame,
        id: newId("f"),
        name: `${currentFrame.name} copy`,
        x: currentFrame.x + currentFrame.w + 80,
        layers: currentFrame.layers.map((l) => ({ ...l, id: newId("l") })),
      };
      commit({ ...workRef.current, frames: [...workRef.current.frames, copy] });
      setSel({ frame: copy.id, layers: [], frameSelected: true });
      return;
    }
    if (!selectedLayers.length) return;
    const copies = selectedLayers.map((l) => ({ ...l, id: newId("l"), x: l.x + 12, y: l.y + 12 }));
    commit(mapFrame(workRef.current, sel.frame, (f) => ({ ...f, layers: [...f.layers, ...copies] })));
    setSel({ frame: sel.frame, layers: copies.map((c) => c.id), frameSelected: false });
  };

  const arrange = (how) => {
    if (!currentFrame || !sel.layers.length) return;
    const layers = [...currentFrame.layers];
    const picked = layers.filter((l) => sel.layers.includes(l.id));
    const rest = layers.filter((l) => !sel.layers.includes(l.id));
    let next;
    if (how === "front") next = [...rest, ...picked];
    else if (how === "back") next = [...picked, ...rest];
    else {
      next = [...layers];
      const order = how === "forward" ? [...picked].reverse() : picked;
      for (const layer of order) {
        const i = next.indexOf(layer);
        const j = how === "forward" ? i + 1 : i - 1;
        if (j < 0 || j >= next.length || sel.layers.includes(next[j].id)) continue;
        [next[i], next[j]] = [next[j], next[i]];
      }
    }
    commit(mapFrame(workRef.current, sel.frame, (f) => ({ ...f, layers: next })));
  };

  const align = (how) => {
    if (!currentFrame || !selectedLayers.length) return;
    // One layer aligns to its frame; several align to their shared bounds.
    const box = selectedLayers.length === 1
      ? { x: 0, y: 0, r: currentFrame.w, b: currentFrame.h }
      : {
          x: Math.min(...selectedLayers.map((l) => l.x)),
          y: Math.min(...selectedLayers.map((l) => l.y)),
          r: Math.max(...selectedLayers.map((l) => l.x + l.w)),
          b: Math.max(...selectedLayers.map((l) => l.y + l.h)),
        };
    const place = {
      left: (l) => ({ x: box.x }),
      hcenter: (l) => ({ x: round((box.x + box.r) / 2 - l.w / 2) }),
      right: (l) => ({ x: box.r - l.w }),
      top: (l) => ({ y: box.y }),
      vcenter: (l) => ({ y: round((box.y + box.b) / 2 - l.h / 2) }),
      bottom: (l) => ({ y: box.b - l.h }),
    }[how];
    if (place) {
      commit(mapLayers(workRef.current, sel.frame, sel.layers, (l) => ({ ...l, ...place(l) })));
      return;
    }
    // Distribute: equal gaps between neighbours, first and last left in place.
    const axis = how === "hdist" ? ["x", "w"] : ["y", "h"];
    const sorted = [...selectedLayers].sort((a, b) => a[axis[0]] - b[axis[0]]);
    if (sorted.length < 3) return;
    const span = sorted.at(-1)[axis[0]] + sorted.at(-1)[axis[1]] - sorted[0][axis[0]];
    const gap = (span - sorted.reduce((n, l) => n + l[axis[1]], 0)) / (sorted.length - 1);
    let cursor = sorted[0][axis[0]];
    const at = new Map();
    for (const l of sorted) {
      at.set(l.id, round(cursor));
      cursor += l[axis[1]] + gap;
    }
    commit(mapLayers(workRef.current, sel.frame, sel.layers, (l) => ({ ...l, [axis[0]]: at.get(l.id) })));
  };

  /* -- pointer work -------------------------------------------------------------- */

  const toBoard = (event) => {
    const r = vp.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (event.clientX - r.left - v.x) / v.z, y: (event.clientY - r.top - v.y) / v.z };
  };
  const frameAt = (p) =>
    [...workRef.current.frames].reverse().find((f) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h);

  // Where a moving box may snap to: its frame's edges and middle, and every
  // other visible layer's edges and middle -- Figma's smart guides.
  const snapTargets = (frame, exclude) => {
    const xs = [0, frame.w / 2, frame.w];
    const ys = [0, frame.h / 2, frame.h];
    for (const l of frame.layers) {
      if (exclude.includes(l.id) || l.hidden) continue;
      xs.push(l.x, l.x + l.w / 2, l.x + l.w);
      ys.push(l.y, l.y + l.h / 2, l.y + l.h);
    }
    return { xs, ys };
  };
  const snap = (edges, targets, threshold) => {
    let best = null;
    for (const edge of edges) {
      for (const t of targets) {
        const d = t - edge;
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
      }
    }
    return best;
  };

  const onPointerDown = (event) => {
    if (editing) return;
    if (event.button === 2) return;
    const p = toBoard(event);
    const target = event.target;
    root.current?.focus({ preventScroll: true });
    setMenu(null);

    // Panning: the middle button, or space held, as in every design tool.
    if (event.button === 1 || space.current || tool === "hand") {
      event.preventDefault();
      placed.current = true;
      gesture.current = { kind: "pan", sx: event.clientX, sy: event.clientY, view: viewRef.current };
      vp.current.setPointerCapture(event.pointerId);
      return;
    }

    const start = workRef.current;
    const handle = target.closest?.("[data-handle]")?.getAttribute("data-handle");
    if (handle) {
      const frame = start.frames.find((f) => f.id === sel.frame);
      const box = sel.frameSelected ? frame : frame?.layers.find((l) => l.id === sel.layers[0]);
      if (box) {
        gesture.current = { kind: "resize", handle, p, start, box: { x: box.x, y: box.y, w: box.w, h: box.h }, isFrame: sel.frameSelected };
        vp.current.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (tool !== "move") {
      if (tool === "frame") {
        gesture.current = { kind: "draw", tool, p, frameId: null };
      } else {
        const frame = frameAt(p);
        if (!frame) return;
        gesture.current = { kind: "draw", tool, p, frameId: frame.id };
      }
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      vp.current.setPointerCapture(event.pointerId);
      return;
    }

    const label = target.closest?.("[data-frame-label]")?.getAttribute("data-frame-label");
    if (label) {
      setSel({ frame: label, layers: [], frameSelected: true });
      const frame = start.frames.find((f) => f.id === label);
      gesture.current = { kind: "moveFrame", p, start, id: label, origin: { x: frame.x, y: frame.y } };
      vp.current.setPointerCapture(event.pointerId);
      return;
    }

    const layerId = target.closest?.("[data-layer]")?.getAttribute("data-layer");
    const frameId = target.closest?.("[data-frame]")?.getAttribute("data-frame");
    const frame = start.frames.find((f) => f.id === frameId);
    const layer = frame?.layers.find((l) => l.id === layerId);
    if (layer && !layer.locked) {
      let ids;
      if (event.shiftKey) {
        ids = sel.frame === frame.id
          ? (sel.layers.includes(layer.id) ? sel.layers.filter((id) => id !== layer.id) : [...sel.layers, layer.id])
          : [layer.id];
      } else {
        ids = sel.frame === frame.id && sel.layers.includes(layer.id) ? sel.layers : [layer.id];
      }
      setSel({ frame: frame.id, layers: ids, frameSelected: false });
      const origins = Object.fromEntries(frame.layers.filter((l) => ids.includes(l.id)).map((l) => [l.id, { x: l.x, y: l.y }]));
      gesture.current = { kind: "move", p, start, frameId: frame.id, ids, origins, alt: event.altKey };
      vp.current.setPointerCapture(event.pointerId);
      return;
    }
    if (frame) {
      setSel({ frame: frame.id, layers: [], frameSelected: false });
      gesture.current = { kind: "marquee", p, frameId: frame.id, add: event.shiftKey ? sel.layers : [] };
      setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
      vp.current.setPointerCapture(event.pointerId);
      return;
    }
    setSel({ frame: null, layers: [], frameSelected: false });
  };

  const onPointerMove = (event) => {
    const g = gesture.current;
    if (!g) {
      const layerId = event.target.closest?.("[data-layer]")?.getAttribute("data-layer");
      setHover(layerId || null);
      return;
    }
    const v = viewRef.current;
    if (g.kind === "pan") {
      setView({ ...g.view, x: g.view.x + event.clientX - g.sx, y: g.view.y + event.clientY - g.sy });
      return;
    }
    const p = toBoard(event);
    const dx = p.x - g.p.x;
    const dy = p.y - g.p.y;

    if (g.kind === "move") {
      const frame = g.start.frames.find((f) => f.id === g.frameId);
      const moving = frame.layers.filter((l) => g.ids.includes(l.id));
      const box = {
        x: Math.min(...moving.map((l) => g.origins[l.id].x)) + dx,
        y: Math.min(...moving.map((l) => g.origins[l.id].y)) + dy,
        r: Math.max(...moving.map((l) => g.origins[l.id].x + l.w)) + dx,
        b: Math.max(...moving.map((l) => g.origins[l.id].y + l.h)) + dy,
      };
      let sx = 0;
      let sy = 0;
      const next = [];
      if (!event.metaKey && !event.ctrlKey) {
        const targets = snapTargets(frame, g.ids);
        const threshold = SNAP / v.z;
        const hx = snap([box.x, (box.x + box.r) / 2, box.r], targets.xs, threshold);
        const hy = snap([box.y, (box.y + box.b) / 2, box.b], targets.ys, threshold);
        if (hx) {
          sx = hx.d;
          next.push({ axis: "x", at: frame.x + hx.at, from: frame.y, to: frame.y + frame.h });
        }
        if (hy) {
          sy = hy.d;
          next.push({ axis: "y", at: frame.y + hy.at, from: frame.x, to: frame.x + frame.w });
        }
      }
      setGuides(next);
      g.moved = true;
      setWork(mapLayers(g.start, g.frameId, g.ids, (l) => ({
        ...l, x: round(g.origins[l.id].x + dx + sx), y: round(g.origins[l.id].y + dy + sy),
      })));
      return;
    }
    if (g.kind === "moveFrame") {
      g.moved = true;
      setWork(mapFrame(g.start, g.id, (f) => ({ ...f, x: round(g.origin.x + dx), y: round(g.origin.y + dy) })));
      return;
    }
    if (g.kind === "resize") {
      const b = g.box;
      let { x, y, w, h } = b;
      const hd = g.handle;
      if (hd.includes("e")) w = b.w + dx;
      if (hd.includes("s")) h = b.h + dy;
      if (hd.includes("w")) { w = b.w - dx; x = b.x + dx; }
      if (hd.includes("n")) { h = b.h - dy; y = b.y + dy; }
      if (event.shiftKey && b.w && b.h) {
        const ratio = b.w / b.h;
        if (hd === "n" || hd === "s") w = h * ratio;
        else h = w / ratio;
        if (hd.includes("n")) y = b.y + b.h - h;
        if (hd.includes("w")) x = b.x + b.w - w;
      }
      const min = g.isFrame ? 40 : 1;
      if (w < min) { if (hd.includes("w")) x -= min - w; w = min; }
      if (h < min) { if (hd.includes("n")) y -= min - h; h = min; }
      g.moved = true;
      const box = { x: round(x), y: round(y), w: round(w), h: round(h) };
      setWork(g.isFrame
        ? mapFrame(g.start, sel.frame, (f) => ({ ...f, ...box }))
        : mapLayers(g.start, sel.frame, [sel.layers[0]], (l) => ({ ...l, ...box })));
      return;
    }
    if (g.kind === "marquee") {
      const rect = { x: Math.min(g.p.x, p.x), y: Math.min(g.p.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      setMarquee(rect);
      const frame = workRef.current.frames.find((f) => f.id === g.frameId);
      const hits = frame.layers
        .filter((l) => !l.locked && !l.hidden)
        .filter((l) => {
          const lx = frame.x + l.x;
          const ly = frame.y + l.y;
          return lx < rect.x + rect.w && lx + l.w > rect.x && ly < rect.y + rect.h && ly + l.h > rect.y;
        })
        .map((l) => l.id);
      setSel({ frame: frame.id, layers: [...new Set([...g.add, ...hits])], frameSelected: false });
      return;
    }
    if (g.kind === "draw") {
      let w = dx;
      let h = dy;
      if (event.shiftKey) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      setDraft({ x: Math.min(g.p.x, g.p.x + w), y: Math.min(g.p.y, g.p.y + h), w: Math.abs(w), h: Math.abs(h) });
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setGuides([]);
    setMarquee(null);
    if (!g) return;
    if (incoming.current) {
      // The document was rewritten under the drag: the drag was of something
      // that is no longer there, so it is dropped rather than saved over it.
      const next = incoming.current;
      incoming.current = null;
      setDraft(null);
      setWork(next);
      return;
    }
    if ((g.kind === "move" || g.kind === "moveFrame" || g.kind === "resize") && g.moved) {
      commit(workRef.current, g.start);
      return;
    }
    if (g.kind === "draw") {
      const d = draft || { x: g.p.x, y: g.p.y, w: 0, h: 0 };
      setDraft(null);
      const clicked = d.w < 4 && d.h < 4;
      const doc = workRef.current;
      if (g.tool === "frame") {
        const preset = FRAME_PRESETS[0];
        const frame = {
          id: newId("f"),
          name: clicked ? preset.name : `Frame ${doc.frames.length + 1}`,
          x: round(d.x), y: round(d.y),
          w: clicked ? preset.w : Math.max(40, round(d.w)),
          h: clicked ? preset.h : Math.max(40, round(d.h)),
          layers: [],
        };
        commit({ ...doc, frames: [...doc.frames, frame] });
        setSel({ frame: frame.id, layers: [], frameSelected: true });
      } else {
        const frame = doc.frames.find((f) => f.id === g.frameId);
        const type = g.tool === "rect" ? "rect" : g.tool;
        const layer = newLayer(type, d.x - frame.x, d.y - frame.y, clicked ? 0 : d.w, clicked ? 0 : d.h);
        commit(mapFrame(doc, frame.id, (f) => ({ ...f, layers: [...f.layers, layer] })));
        setSel({ frame: frame.id, layers: [layer.id], frameSelected: false });
        if (type === "text") setEditing({ frame: frame.id, layer: layer.id });
      }
      setTool("move");
    }
  };

  // By position rather than by event target: the pointer is captured on the
  // viewport during the clicks before it, so the double-click lands there.
  const onDoubleClick = (event) => {
    const p = toBoard(event);
    const frame = frameAt(p);
    const layer = frame && [...frame.layers].reverse().find((l) =>
      !l.hidden && p.x >= frame.x + l.x && p.x <= frame.x + l.x + l.w && p.y >= frame.y + l.y && p.y <= frame.y + l.y + l.h);
    if (layer && TEXTISH.has(layer.type) && !layer.locked) {
      setSel({ frame: frame.id, layers: [layer.id], frameSelected: false });
      setEditing({ frame: frame.id, layer: layer.id });
    }
  };

  // Wheel: pan by default, zoom about the pointer with ⌘/Ctrl -- which is
  // also what a trackpad pinch arrives as.
  useEffect(() => {
    const el = vp.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      placed.current = true;
      const v = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const r = el.getBoundingClientRect();
        const cx = event.clientX - r.left;
        const cy = event.clientY - r.top;
        const z = clamp(v.z * Math.exp(-event.deltaY * 0.01), MIN_Z, MAX_Z);
        setView({ z, x: cx - ((cx - v.x) / v.z) * z, y: cy - ((cy - v.y) / v.z) * z });
      } else {
        setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [full]);

  const zoomBy = (factor) => {
    placed.current = true;
    const el = vp.current;
    const v = viewRef.current;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const z = clamp(v.z * factor, MIN_Z, MAX_Z);
    setView({ z, x: cx - ((cx - v.x) / v.z) * z, y: cy - ((cy - v.y) / v.z) * z });
  };

  /* -- commands shared by the menus and the keys ------------------------------- */

  const copySelection = () => {
    clipboard.current = selectedLayers.map((l) => ({ ...l }));
  };
  const paste = () => {
    const frame = currentFrame || workRef.current.frames[0];
    if (!frame || !clipboard.current.length) return false;
    const copies = clipboard.current.map((l) => ({ ...l, id: newId("l"), x: l.x + 16, y: l.y + 16 }));
    clipboard.current = copies;
    commit(mapFrame(workRef.current, frame.id, (f) => ({ ...f, layers: [...f.layers, ...copies] })));
    setSel({ frame: frame.id, layers: copies.map((c) => c.id), frameSelected: false });
    return true;
  };
  const selectAll = () => {
    const frame = currentFrame || workRef.current.frames[0];
    if (!frame) return false;
    setSel({ frame: frame.id, layers: frame.layers.filter((l) => !l.locked && !l.hidden).map((l) => l.id), frameSelected: false });
    return true;
  };
  // A new screen of a preset size, to the right of the last one.
  const addScreen = (preset) => {
    const doc = workRef.current;
    const right = doc.frames.length ? Math.max(...doc.frames.map((f) => f.x + f.w)) + 80 : 0;
    const top = doc.frames.length ? Math.min(...doc.frames.map((f) => f.y)) : 0;
    const frame = { id: newId("f"), name: preset.name, x: right, y: top, w: preset.w, h: preset.h, layers: [] };
    commit({ ...doc, frames: [...doc.frames, frame] });
    setSel({ frame: frame.id, layers: [], frameSelected: true });
    requestAnimationFrame(() => fit([...doc.frames, frame]));
  };
  const toggleLayer = (frameId, layerId, key) =>
    commit(mapLayers(workRef.current, frameId, [layerId], (l) => ({ ...l, [key]: !l[key] || undefined })));

  /* -- keys ------------------------------------------------------------------------ */

  const onKeyDown = (event) => {
    const t = event.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const cmd = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (key === " ") {
      space.current = true;
      event.preventDefault();
      return;
    }
    if (cmd && key === "z") { event.preventDefault(); (event.shiftKey ? redo : undo)(); return; }
    if (cmd && key === "y") { event.preventDefault(); redo(); return; }
    if (cmd && key === "d") { event.preventDefault(); duplicate(); return; }
    if (cmd && key === "c") { copySelection(); return; }
    if (cmd && key === "v") { if (paste()) event.preventDefault(); return; }
    if (cmd && key === "a") { if (selectAll()) event.preventDefault(); return; }
    if (cmd && (key === "]" || key === "[")) {
      event.preventDefault();
      arrange(key === "]" ? (event.shiftKey ? "front" : "forward") : event.shiftKey ? "back" : "backward");
      return;
    }
    if (cmd && (key === "=" || key === "+")) { event.preventDefault(); zoomBy(1.25); return; }
    if (cmd && key === "-") { event.preventDefault(); zoomBy(0.8); return; }
    if (cmd && key === "0") { event.preventDefault(); setView((v) => ({ ...v, z: 1 })); return; }
    if (event.shiftKey && key === "1") { fit(); return; }
    if (key === "backspace" || key === "delete") { event.preventDefault(); removeSelection(); return; }
    if (key === "escape") {
      if (menu) setMenu(null);
      else if (tool !== "move") setTool("move");
      else setSel({ frame: null, layers: [], frameSelected: false });
      return;
    }
    if (key === "enter" && single && TEXTISH.has(single.type)) {
      event.preventDefault();
      setEditing({ frame: sel.frame, layer: single.id });
      return;
    }
    if (key.startsWith("arrow")) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const [dx, dy] = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key];
      if (sel.frameSelected && sel.frame) patchFrame({ x: currentFrame.x + dx, y: currentFrame.y + dy });
      else if (sel.layers.length) {
        commit(mapLayers(workRef.current, sel.frame, sel.layers, (l) => ({ ...l, x: l.x + dx, y: l.y + dy })));
      }
      return;
    }
    if (!cmd && !event.altKey) {
      const toolKey = { v: "move", f: "frame", r: "rect", o: "ellipse", l: "line", t: "text", i: "image", h: "hand", b: "button" }[key];
      if (toolKey) setTool(toolKey);
    }
  };
  const onKeyUp = (event) => {
    if (event.key === " ") space.current = false;
  };

  /* -- exports --------------------------------------------------------------------- */

  const dataUris = () => resolveAll(wireframeImageIds(workRef.current), (id) => imageData(api, id));
  const stem = fileStem(title || "wireframe");
  const exportFrame = currentFrame || work.frames[0];

  const run = async (label, job) => {
    setMenu(null);
    setBusy(label);
    try {
      await job();
    } catch (problem) {
      window.alert?.(problem.message || "That export failed.");
    } finally {
      setBusy("");
    }
  };

  const exports = {
    png: () => run("PNG", async () => {
      const pictures = await loadPictures(await dataUris());
      const blob = await canvasBlob(frameToCanvas(exportFrame, P, pictures, 2));
      saveFile(`${stem}-${fileStem(exportFrame.name)}.png`, blob, "image/png");
    }),
    pngs: () => run("PNGs", async () => {
      const pictures = await loadPictures(await dataUris());
      const files = [];
      for (const frame of workRef.current.frames) {
        const blob = await canvasBlob(frameToCanvas(frame, P, pictures, 2));
        files.push({ name: `${fileStem(frame.name)}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      saveFile(`${stem}-frames.zip`, buildZip(files), "application/zip");
    }),
    pdf: () => run("PDF", async () => {
      const pictures = await loadPictures(await dataUris());
      const pages = [];
      for (const frame of workRef.current.frames) {
        const canvas = frameToCanvas(frame, P, pictures, 2);
        const blob = await canvasBlob(canvas, "image/jpeg", 0.92);
        pages.push({ w: frame.w, h: frame.h, pw: canvas.width, ph: canvas.height, jpeg: new Uint8Array(await blob.arrayBuffer()) });
      }
      saveFile(`${stem}.pdf`, buildPdf(pages), "application/pdf");
    }),
    zip: () => run("HTML", async () => {
      const out = toHtmlCss(workRef.current, P, await dataUris(), title || "Wireframe");
      saveFile(`${stem}-html.zip`, buildZip([{ name: "index.html", data: out.html }, { name: "styles.css", data: out.css }]), "application/zip");
    }),
    html: () => run("HTML", async () => {
      const out = toHtmlCss(workRef.current, P, await dataUris(), title || "Wireframe");
      saveFile(`${stem}.html`, out.single, "text/html");
    }),
    slides: () => run("Slides", async () => {
      await onMakeCanvas?.({
        title: `${title || "Wireframe"} — deck`,
        kind: "slides",
        content: serializeDeck(toDeck(workRef.current)),
      });
    }),
    sheet: () => run("Sheet", async () => {
      await onMakeCanvas?.({
        title: `${title || "Wireframe"} — inventory`,
        kind: "sheet",
        content: serializeSheet(toSheet(workRef.current)),
      });
    }),
    document: () => run("Document", async () => {
      await onMakeCanvas?.({
        title: `${title || "Wireframe"} — spec`,
        kind: "markdown",
        content: toDocument(workRef.current, title || "Wireframe"),
      });
    }),
  };

  /* -- render ---------------------------------------------------------------------- */

  const selBox = (() => {
    if (!currentFrame) return null;
    if (sel.frameSelected) return { x: currentFrame.x, y: currentFrame.y, w: currentFrame.w, h: currentFrame.h };
    if (!selectedLayers.length) return null;
    const x = Math.min(...selectedLayers.map((l) => l.x));
    const y = Math.min(...selectedLayers.map((l) => l.y));
    const r = Math.max(...selectedLayers.map((l) => l.x + l.w));
    const b = Math.max(...selectedLayers.map((l) => l.y + l.h));
    return { x: currentFrame.x + x, y: currentFrame.y + y, w: r - x, h: b - y };
  })();
  const hovered = (() => {
    if (!hover || sel.layers.includes(hover)) return null;
    for (const f of work.frames) {
      const l = f.layers.find((x) => x.id === hover);
      if (l) return { x: f.x + l.x, y: f.y + l.y, w: l.w, h: l.h };
    }
    return null;
  })();
  const editLayer = editing
    ? work.frames.find((f) => f.id === editing.frame)?.layers.find((l) => l.id === editing.layer)
    : null;
  const editFrame = editing ? work.frames.find((f) => f.id === editing.frame) : null;
  const z = view.z;
  // The ruling in board units, coarsened as the view zooms out so it never
  // turns into a grey haze of lines a pixel apart.
  let grid = 22 * z;
  while (grid < 10) grid *= 5;

  const pointer = POINTERS.find((t) => t.id === tool) || POINTERS[0];
  const drawing = TOOLS.find((t) => t.id === tool && !POINTERS.some((p) => p.id === t.id)) ||
    COMPONENTS.find((c) => c.id === tool) || null;
  const showLayers = wide ? !hidden.layers : panels.layers;
  const showDesign = wide ? !hidden.design : panels.design;
  const togglePanel = (which) =>
    wide ? setHidden((h) => ({ ...h, [which]: !h[which] })) : setPanels((p) => ({ ...p, [which]: !p[which] }));

  const layersPanel = (
    <aside className="wf-panel wf-layers" aria-label="Layers">
      <div className="wf-panel-head mi">Layers</div>
      {work.frames.map((frame) => (
        <div key={frame.id} className="wf-tree-frame">
          <button
            type="button"
            className="wf-tree-row"
            data-frame-row=""
            data-on={sel.frame === frame.id && sel.frameSelected ? "" : undefined}
            onClick={() => setSel({ frame: frame.id, layers: [], frameSelected: true })}
          >
            <span className="wf-tree-glyph">#</span>
            <span className="wf-tree-name">{frame.name}</span>
          </button>
          {[...frame.layers].reverse().map((layer) => (
            <div
              key={layer.id}
              className="wf-tree-row wf-tree-layer"
              data-on={sel.frame === frame.id && sel.layers.includes(layer.id) ? "" : undefined}
              data-dim={layer.hidden ? "" : undefined}
              role="button"
              tabIndex={0}
              onClick={(event) =>
                setSel((s) => ({
                  frame: frame.id,
                  frameSelected: false,
                  layers: event.shiftKey && s.frame === frame.id
                    ? (s.layers.includes(layer.id) ? s.layers.filter((id) => id !== layer.id) : [...s.layers, layer.id])
                    : [layer.id],
                }))
              }
              onMouseEnter={() => setHover(layer.id)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="wf-tree-glyph">{TYPE_GLYPH[layer.type] || "▢"}</span>
              <span className="wf-tree-name">{layerLabel(layer)}</span>
              {layer.link ? <span className="wf-tree-link" title="Prototype link">⇢</span> : null}
              {layer.locked ? <span className="wf-tree-state" title="Locked">🔒︎</span> : null}
              {layer.hidden ? <span className="wf-tree-state" title="Hidden">◌</span> : null}
              <span className="wf-tree-more" onClick={(event) => event.stopPropagation()}>
                <Dropdown id={`row:${layer.id}`} menu={menu} setMenu={setMenu} right compact
                  title={`${layerLabel(layer)} actions`} label="⋯">
                  <Item glyph={layer.locked ? "🔓︎" : "🔒︎"} onClick={() => toggleLayer(frame.id, layer.id, "locked")}>
                    {layer.locked ? "Unlock" : "Lock"}
                  </Item>
                  <Item glyph={layer.hidden ? "●" : "◌"} onClick={() => toggleLayer(frame.id, layer.id, "hidden")}>
                    {layer.hidden ? "Show" : "Hide"}
                  </Item>
                  <MenuRule />
                  <Item glyph="⊕" onClick={() => {
                    const copy = { ...layer, id: newId("l"), x: layer.x + 12, y: layer.y + 12 };
                    commit(mapFrame(workRef.current, frame.id, (f) => ({ ...f, layers: [...f.layers, copy] })));
                    setSel({ frame: frame.id, layers: [copy.id], frameSelected: false });
                  }}>Duplicate</Item>
                  <Item glyph="⌫" onClick={() => {
                    commit(mapFrame(workRef.current, frame.id, (f) => ({ ...f, layers: f.layers.filter((l) => l.id !== layer.id) })));
                    setSel((was) => ({ ...was, layers: was.layers.filter((id) => id !== layer.id) }));
                  }}>Delete</Item>
                </Dropdown>
              </span>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );

  const frameOptions = work.frames.filter((f) => f.id !== sel.frame);
  const designPanel = (
    <aside className="wf-panel wf-design" aria-label="Design">
      <div className="wf-panel-head mi">
        {sel.frameSelected ? "Frame" : single ? layerLabel(single) : selectedLayers.length ? `${selectedLayers.length} layers` : "Design"}
      </div>

      {!sel.frameSelected && !selectedLayers.length ? (
        <div className="wf-section">
          <label className="wf-field">
            <span>Fidelity</span>
            <select value={work.fidelity === "styled" ? "styled" : "wireframe"}
              onChange={(e) => commit({ ...workRef.current, fidelity: e.target.value })}>
              <option value="wireframe">Wireframe — Bom's kit</option>
              <option value="styled">Styled — the design standard</option>
            </select>
          </label>
          <p className="wf-hint">
            Wireframe is greyscale, for structure. Styled draws in the
            conversation's design standard. Select a frame or a layer to edit it;
            double-click text to type. Space or the middle button pans, ⌘/Ctrl +
            scroll zooms.
          </p>
        </div>
      ) : null}

      {sel.frameSelected && currentFrame ? (
        <>
          <div className="wf-section">
            <TextField label="Name" value={currentFrame.name} onCommit={(name) => patchFrame({ name: name || currentFrame.name })} />
            <label className="wf-field">
              <span>Size</span>
              <select
                value=""
                onChange={(event) => {
                  const preset = FRAME_PRESETS.find((p) => p.id === event.target.value);
                  if (preset) patchFrame({ w: preset.w, h: preset.h });
                }}
              >
                <option value="">Preset…</option>
                {FRAME_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.w}×{p.h}</option>
                ))}
              </select>
            </label>
            <div className="wf-grid2">
              <NumField label="X" value={currentFrame.x} onCommit={(x) => patchFrame({ x })} />
              <NumField label="Y" value={currentFrame.y} onCommit={(y) => patchFrame({ y })} />
              <NumField label="W" value={currentFrame.w} min={40} onCommit={(w) => patchFrame({ w })} />
              <NumField label="H" value={currentFrame.h} min={40} onCommit={(h) => patchFrame({ h })} />
            </div>
            <ColorField label="Fill" value={currentFrame.fill} placeholder={P.bg} onCommit={(fill) => patchFrame({ fill })} />
          </div>
          <div className="wf-section">
            <Dropdown id="frame-actions" menu={menu} setMenu={setMenu} label="Screen actions" title="Screen actions">
              <Item glyph="⊕" keys="⌘D" onClick={duplicate}>Duplicate screen</Item>
              <Item glyph="▶" onClick={() => setProto(currentFrame.id)}>Play from here</Item>
              <Item glyph="▣" keys="⌘A" onClick={selectAll}>Select its layers</Item>
              <MenuRule />
              <Item glyph="⌫" keys="⌫" onClick={removeSelection}>Delete screen</Item>
            </Dropdown>
          </div>
        </>
      ) : null}

      {selectedLayers.length > 1 ? (
        <div className="wf-section">
          <label className="wf-field">
            <span>Align {selectedLayers.length} layers</span>
            <select value="" onChange={(e) => e.target.value && align(e.target.value)}>
              <option value="">Choose…</option>
              {ALIGNS.map(([how, g, label]) => <option key={how} value={how}>{g}  {label}</option>)}
              <option value="hdist" disabled={selectedLayers.length < 3}>⋯  Distribute horizontally</option>
              <option value="vdist" disabled={selectedLayers.length < 3}>⋮  Distribute vertically</option>
            </select>
          </label>
        </div>
      ) : null}

      {single ? (
        <>
          <div className="wf-section">
            <div className="wf-grid2">
              <NumField label="X" value={single.x} onCommit={(x) => patchLayers({ x })} />
              <NumField label="Y" value={single.y} onCommit={(y) => patchLayers({ y })} />
              <NumField label="W" value={single.w} min={1} onCommit={(w) => patchLayers({ w })} />
              <NumField label="H" value={single.h} min={1} onCommit={(h) => patchLayers({ h })} />
            </div>
            <label className="wf-field">
              <span>Align in screen</span>
              <select value="" onChange={(e) => e.target.value && align(e.target.value)}>
                <option value="">Choose…</option>
                {ALIGNS.map(([how, g, label]) => <option key={how} value={how}>{g}  {label}</option>)}
              </select>
            </label>
            <TextField label="Name" value={single.name || ""} onCommit={(name) => patchLayers({ name: name || null })} />
          </div>

          {TEXTISH.has(single.type) || single.type === "icon" ? (
            <div className="wf-section">
              <span className="wf-section-title mi">Content</span>
              {single.type !== "icon" ? (
                <TextField label={single.type === "input" ? "Placeholder" : single.type === "nav" ? "Brand" : "Text"}
                  value={single.text || ""} multiline={single.type === "text"} onCommit={(text) => patchLayers({ text })} />
              ) : (
                <label className="wf-field">
                  <span>Icon</span>
                  <select value={single.icon || "star"} onChange={(e) => patchLayers({ icon: e.target.value })}>
                    {ICON_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
              {single.type === "nav" ? (
                <TextField label="Links" value={(single.items || []).join(", ")}
                  onCommit={(text) => patchLayers({ items: text.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6) })} />
              ) : null}
              {single.type === "button" ? (
                <label className="wf-field">
                  <span>Style</span>
                  <select value={single.variant || "primary"} onChange={(e) => patchLayers({ variant: e.target.value })}>
                    <option value="primary">Primary</option>
                    <option value="secondary">Secondary</option>
                    <option value="ghost">Ghost</option>
                  </select>
                </label>
              ) : null}
              {single.type === "checkbox" || single.type === "toggle" ? (
                <label className="wf-check">
                  <input type="checkbox" checked={Boolean(single.checked)} onChange={(e) => patchLayers({ checked: e.target.checked || null })} />
                  On
                </label>
              ) : null}
              {single.type === "text" ? (
                <>
                  <div className="wf-grid2">
                    <NumField label="Size" value={single.size || 16} min={6} onCommit={(size) => patchLayers({ size })} />
                    <label className="wf-num">
                      <span>Wt</span>
                      <select value={single.weight || (single.font === "heading" ? 700 : 400)} onChange={(e) => patchLayers({ weight: Number(e.target.value) })}>
                        {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="wf-grid2">
                    <select className="wf-select" value={single.align || "left"} aria-label="Align text"
                      onChange={(e) => patchLayers({ align: e.target.value })}>
                      <option value="left">Left</option>
                      <option value="center">Centre</option>
                      <option value="right">Right</option>
                    </select>
                    <select className="wf-select" value={single.font || "body"} aria-label="Font"
                      onChange={(e) => patchLayers({ font: e.target.value === "body" ? null : e.target.value })}>
                      <option value="body">Body</option>
                      <option value="heading">Heading</option>
                      <option value="mono">Mono</option>
                    </select>
                  </div>
                  <ColorField label="Color" value={single.color} placeholder={P.text} onCommit={(color) => patchLayers({ color })} />
                </>
              ) : null}
            </div>
          ) : null}

          {single.type === "lines" ? (
            <div className="wf-section">
              <NumField label="Lines" value={single.count || 3} min={1} onCommit={(count) => patchLayers({ count: Math.min(12, Math.round(count)), h: Math.min(12, Math.round(count)) * 18 - 10 })} />
            </div>
          ) : null}

          {["image", "card", "avatar"].includes(single.type) ? (
            <div className="wf-section">
              <span className="wf-section-title mi">Image</span>
              <div className="wf-images">
                <button type="button" className="wf-image" data-on={!single.image ? "" : undefined} onClick={() => patchLayers({ image: null })}>
                  <span>✕</span>
                </button>
                {library.images.map((img) => (
                  <ImageChoice key={img.id} image={img} on={single.image === img.id} onPick={() => patchLayers({ image: img.id })} />
                ))}
              </div>
              <p className="wf-hint">Pictures come from this conversation — attach them in the chat or upload them in a deck.</p>
            </div>
          ) : null}

          {!["text", "icon", "lines", "line"].includes(single.type) ? (
            <div className="wf-section">
              <span className="wf-section-title mi">Fill & stroke</span>
              <ColorField label="Fill" value={single.fill} placeholder={single.type === "button" ? P.accent : P.surface} onCommit={(fill) => patchLayers({ fill })} />
              <ColorField label="Stroke" value={single.stroke} placeholder={P.line} onCommit={(stroke) => patchLayers({ stroke })} />
              <div className="wf-grid2">
                <NumField label="Radius" value={single.radius ?? (["button", "input"].includes(single.type) ? P.radius : 0)} min={0} onCommit={(radius) => patchLayers({ radius })} />
                <NumField label="Border" value={single.strokeWidth ?? 1} min={0} onCommit={(strokeWidth) => patchLayers({ strokeWidth })} />
              </div>
            </div>
          ) : single.type === "line" || single.type === "lines" ? (
            <div className="wf-section">
              <ColorField label="Color" value={single.type === "line" ? single.stroke : single.fill} placeholder={P.line}
                onCommit={(c) => patchLayers(single.type === "line" ? { stroke: c } : { fill: c })} />
            </div>
          ) : null}

          <div className="wf-section">
            <NumField label="Opacity %" value={Math.round((single.opacity ?? 1) * 100)} min={0}
              onCommit={(o) => patchLayers({ opacity: o >= 100 ? null : Math.max(0, Math.min(100, o)) / 100 })} />
          </div>

          <div className="wf-section">
            <span className="wf-section-title mi">Prototype</span>
            <label className="wf-field">
              <span>On click, go to</span>
              <select value={single.link || ""} onChange={(e) => patchLayers({ link: e.target.value || null })}>
                <option value="">Nothing</option>
                {frameOptions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          </div>
        </>
      ) : null}

      {selectedLayers.length ? (
        <div className="wf-section">
          <Dropdown id="layer-actions" menu={menu} setMenu={setMenu} title="Layer actions"
            label={selectedLayers.length > 1 ? `${selectedLayers.length} layers` : "Layer actions"}>
            <Item glyph="⤒" keys="⇧⌘]" onClick={() => arrange("front")}>Bring to front</Item>
            <Item glyph="↑" keys="⌘]" onClick={() => arrange("forward")}>Bring forward</Item>
            <Item glyph="↓" keys="⌘[" onClick={() => arrange("backward")}>Send backward</Item>
            <Item glyph="⤓" keys="⇧⌘[" onClick={() => arrange("back")}>Send to back</Item>
            <MenuRule />
            <Item glyph="⧉" keys="⌘C" onClick={copySelection}>Copy</Item>
            <Item glyph="⊕" keys="⌘D" onClick={duplicate}>Duplicate</Item>
            <Item glyph="⌫" keys="⌫" onClick={removeSelection}>Delete</Item>
          </Dropdown>
        </div>
      ) : null}
    </aside>
  );

  const editor = (
    <div
      className="wf"
      ref={root}
      tabIndex={-1}
      data-full={full ? "" : undefined}
      data-wide={wide ? "" : undefined}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {/* Everything in the toolbar is a dropdown: what the pointer does,
          what to insert, editing, arranging, the view, the prototype and the
          exports. Each shows its current state on its face. */}
      <div className="wf-toolbar" role="toolbar" aria-label="Wireframe">
        <div className="wf-tools">
          <Dropdown id="tool" menu={menu} setMenu={setMenu} title="Pointer"
            label={<><span className="wf-tree-glyph">{pointer.glyph}</span>{pointer.label}</>}>
            {POINTERS.map((t) => (
              <Item key={t.id} glyph={t.glyph} keys={t.key} on={tool === t.id} onClick={() => setTool(t.id)}>{t.label}</Item>
            ))}
          </Dropdown>

          <Dropdown id="insert" menu={menu} setMenu={setMenu} title="Insert an element"
            label={drawing
              ? <><span className="wf-tree-glyph">{TYPE_GLYPH[drawing.id] || drawing.glyph}</span>{drawing.label}</>
              : <><span className="wf-tree-glyph">＋</span>Insert</>}>
            <MenuLabel>Shapes</MenuLabel>
            {TOOLS.filter((t) => !POINTERS.some((p) => p.id === t.id)).map((t) => (
              <Item key={t.id} glyph={t.glyph} keys={t.key} on={tool === t.id} onClick={() => setTool(t.id)}>{t.label}</Item>
            ))}
            <MenuRule />
            <MenuLabel>Components</MenuLabel>
            {COMPONENTS.map((c) => (
              <Item key={c.id} glyph={TYPE_GLYPH[c.id]} keys={c.key} on={tool === c.id} onClick={() => setTool(c.id)}>{c.label}</Item>
            ))}
            <MenuRule />
            <MenuLabel>New screen</MenuLabel>
            {FRAME_PRESETS.map((preset) => (
              <Item key={preset.id} glyph="#" onClick={() => addScreen(preset)}>
                {preset.name} <span className="wf-dim">{preset.w}×{preset.h}</span>
              </Item>
            ))}
          </Dropdown>

          <Dropdown id="edit" menu={menu} setMenu={setMenu} label="Edit" title="Edit">
            <Item glyph="↶" keys="⌘Z" disabled={!history.current.past.length} onClick={undo}>Undo</Item>
            <Item glyph="↷" keys="⇧⌘Z" disabled={!history.current.future.length} onClick={redo}>Redo</Item>
            <MenuRule />
            <Item glyph="⧉" keys="⌘C" disabled={!selectedLayers.length} onClick={copySelection}>Copy</Item>
            <Item glyph="⎘" keys="⌘V" disabled={!clipboard.current.length} onClick={paste}>Paste</Item>
            <Item glyph="⊕" keys="⌘D" disabled={!selectedLayers.length && !sel.frameSelected} onClick={duplicate}>Duplicate</Item>
            <Item glyph="⌫" keys="⌫" disabled={!selectedLayers.length && !sel.frameSelected} onClick={removeSelection}>Delete</Item>
            <MenuRule />
            <Item glyph="▣" keys="⌘A" disabled={!work.frames.length} onClick={selectAll}>Select all</Item>
            <Item glyph="✎" keys="↵" disabled={!single || !TEXTISH.has(single?.type)}
              onClick={() => single && setEditing({ frame: sel.frame, layer: single.id })}>Edit text</Item>
          </Dropdown>

          <Dropdown id="arrange" menu={menu} setMenu={setMenu} label="Arrange" title="Arrange the selection"
            disabled={!selectedLayers.length}>
            <MenuLabel>Order</MenuLabel>
            <Item glyph="⤒" keys="⇧⌘]" onClick={() => arrange("front")}>Bring to front</Item>
            <Item glyph="↑" keys="⌘]" onClick={() => arrange("forward")}>Bring forward</Item>
            <Item glyph="↓" keys="⌘[" onClick={() => arrange("backward")}>Send backward</Item>
            <Item glyph="⤓" keys="⇧⌘[" onClick={() => arrange("back")}>Send to back</Item>
            <MenuRule />
            <MenuLabel>{selectedLayers.length > 1 ? "Align to each other" : "Align in screen"}</MenuLabel>
            {ALIGNS.map(([how, g, label]) => (
              <Item key={how} glyph={g} onClick={() => align(how)}>{label}</Item>
            ))}
            <Item glyph="⋯" disabled={selectedLayers.length < 3} onClick={() => align("hdist")}>Distribute horizontally</Item>
            <Item glyph="⋮" disabled={selectedLayers.length < 3} onClick={() => align("vdist")}>Distribute vertically</Item>
          </Dropdown>
        </div>
        <div className="spacer" />
        <div className="wf-tools">
          <Dropdown id="view" menu={menu} setMenu={setMenu} title="View" right
            label={<span className="mi">{Math.round(z * 100)}%</span>}>
            <MenuLabel>Zoom</MenuLabel>
            <Item glyph="+" keys="⌘+" onClick={() => zoomBy(1.25)}>Zoom in</Item>
            <Item glyph="−" keys="⌘−" onClick={() => zoomBy(0.8)}>Zoom out</Item>
            <Item glyph="⤢" keys="⇧1" onClick={() => fit()}>Zoom to fit</Item>
            <Item glyph="1" keys="⌘0" onClick={() => setView((v) => ({ ...v, z: 1 }))}>Actual size</Item>
            <MenuRule />
            <MenuLabel>Panels</MenuLabel>
            <Item glyph="☰" on={showLayers} onClick={() => togglePanel("layers")}>Layers</Item>
            <Item glyph="⚙" on={showDesign} onClick={() => togglePanel("design")}>Design</Item>
            <Item glyph={full ? "⤡" : "⤢"} on={full} onClick={() => setFull((f) => !f)}>Full screen</Item>
            <MenuRule />
            <MenuLabel>Fidelity</MenuLabel>
            <Item glyph="▭" on={work.fidelity !== "styled"} onClick={() => commit({ ...workRef.current, fidelity: "wireframe" })}>Wireframe</Item>
            <Item glyph="◆" on={work.fidelity === "styled"} onClick={() => commit({ ...workRef.current, fidelity: "styled" })}>Styled</Item>
          </Dropdown>

          <Dropdown id="proto" menu={menu} setMenu={setMenu} title="Prototype" right disabled={!work.frames.length}
            label={<><span className="wf-tree-glyph">▶</span>Play</>}>
            <Item glyph="▶" onClick={() => setProto(work.frames[0]?.id)}>From the first screen</Item>
            <Item glyph="▷" disabled={!currentFrame} onClick={() => setProto(currentFrame?.id)}>
              From {currentFrame ? currentFrame.name : "the selected screen"}
            </Item>
          </Dropdown>

          {/* Export, presentation first: it is the first item and the default. */}
          <div className="wf-export">
            <Dropdown id="export" menu={menu} setMenu={setMenu} right title="Export"
              disabled={!work.frames.length || Boolean(busy)}
              label={busy ? `${busy}…` : "Export"}>
              <MenuLabel>Make a document</MenuLabel>
              <Item icon="slides" disabled={!onMakeCanvas} onClick={exports.slides}>Presentation <span className="wf-dim">default</span></Item>
              <Item icon="sheet" disabled={!onMakeCanvas} onClick={exports.sheet}>Sheet — element inventory</Item>
              <Item icon="document" disabled={!onMakeCanvas} onClick={exports.document}>Document — screen spec</Item>
              <MenuRule />
              <MenuLabel>Download</MenuLabel>
              <Item icon="code" onClick={exports.zip}>HTML + CSS (.zip)</Item>
              <Item icon="canvas" onClick={exports.html}>HTML, one file</Item>
              <Item icon="document" onClick={exports.pdf}>PDF — every screen</Item>
              <Item icon="image" onClick={exports.png}>PNG — {exportFrame?.name}</Item>
              <Item icon="image" onClick={exports.pngs}>PNG — every screen (.zip)</Item>
            </Dropdown>
          </div>
        </div>
      </div>

      <div className="wf-body">
        {showLayers ? layersPanel : null}
        <div
          className="wf-viewport"
          ref={vp}
          data-tool={tool}
          data-panning={gesture.current?.kind === "pan" ? "" : undefined}
          // The ruled ground moves and scales with the board, so it reads as
          // the surface the frames sit on rather than a pattern behind glass.
          style={{
            backgroundSize: `${grid}px ${grid}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onPointerLeave={() => setHover(null)}
        >
          <div className="wf-board" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${z})` }}>
            {work.frames.map((frame) => (
              <div key={frame.id} className="wf-frame-wrap" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
                <div
                  className="wf-frame-label"
                  data-frame-label={frame.id}
                  data-on={sel.frame === frame.id ? "" : undefined}
                  style={{ transform: `scale(${1 / z})`, maxWidth: frame.w * z }}
                >
                  {frame.name}
                </div>
                <div className="wf-frame-host" dangerouslySetInnerHTML={{ __html: frameHtml(frame) }} />
              </div>
            ))}

            {hovered ? (
              <div className="wf-hover" style={{ left: hovered.x, top: hovered.y, width: hovered.w, height: hovered.h, borderWidth: 1 / z }} />
            ) : null}

            {selBox ? (
              <div className="wf-sel" style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h, borderWidth: 1.5 / z }}>
                {(sel.frameSelected || single) && !editing
                  ? HANDLES.map((h) => (
                      <span key={h} className="wf-handle" data-handle={h} data-pos={h}
                        style={{ width: 8 / z, height: 8 / z, borderWidth: 1 / z, margin: -4 / z }} />
                    ))
                  : null}
                <span className="wf-dims" style={{ transform: `translateX(-50%) scale(${1 / z})` }}>
                  {Math.round(selBox.w)} × {Math.round(selBox.h)}
                </span>
              </div>
            ) : null}

            {guides.map((g, i) => (
              <div key={i} className="wf-guide" style={g.axis === "x"
                ? { left: g.at, top: g.from, width: 1 / z, height: g.to - g.from }
                : { left: g.from, top: g.at, width: g.to - g.from, height: 1 / z }} />
            ))}

            {marquee ? (
              <div className="wf-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / z }} />
            ) : null}
            {draft ? (
              <div className="wf-draft" style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h, borderWidth: 1 / z }} />
            ) : null}

            {editLayer && editFrame ? (
              <textarea
                className="wf-edit"
                autoFocus
                defaultValue={editLayer.text || ""}
                style={{
                  left: editFrame.x + editLayer.x, top: editFrame.y + editLayer.y,
                  width: Math.max(editLayer.w, 40), height: Math.max(editLayer.h, 24),
                  fontSize: editLayer.type === "text" ? editLayer.size || 16 : 15,
                  fontWeight: editLayer.weight || (editLayer.font === "heading" ? 700 : 400),
                  textAlign: editLayer.type === "text" ? editLayer.align || "left" : "center",
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey || editLayer.type !== "text"))) {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  const text = e.target.value;
                  const { frame, layer } = editing;
                  setEditing(null);
                  if (text !== (editLayer.text || "")) {
                    commit(mapLayers(workRef.current, frame, [layer], (l) => ({ ...l, text })));
                  }
                  root.current?.focus({ preventScroll: true });
                }}
              />
            ) : null}
          </div>
          {!work.frames.length ? (
            <div className="wf-empty">Press F and click to add a frame.</div>
          ) : null}
        </div>
        {showDesign ? designPanel : null}
      </div>

      {proto ? (
        <Prototype doc={work} P={P} images={images} start={proto} onClose={() => { setProto(null); root.current?.focus(); }} />
      ) : null}
    </div>
  );
  // Full screen is the editor moved onto the body, over everything -- the
  // same component and state, only its DOM re-parented.
  return full ? createPortal(editor, document.body) : editor;
}

function ImageChoice({ image, on, onPick }) {
  const urls = useImageUrls([image.id]);
  return (
    <button type="button" className="wf-image" data-on={on ? "" : undefined} title={image.alt || image.name} onClick={onPick}>
      {urls[image.id] ? <img src={urls[image.id]} alt="" /> : null}
    </button>
  );
}
