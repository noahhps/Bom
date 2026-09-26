import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { renderMarkdown } from "../lib/markdown";
import {
  LAYOUTS,
  SLIDE_CSS,
  deckDocument,
  resolveTheme,
  svgSource,
  themeVars,
} from "../lib/slides";

/* The slide stylesheet, installed once. It is a string rather than rules in
   styles.css so that an exported deck carries exactly the same CSS -- see
   lib/slides. */
function ensureDeckCss() {
  if (typeof document === "undefined" || document.getElementById("deck-css")) return;
  const style = document.createElement("style");
  style.id = "deck-css";
  style.textContent = SLIDE_CSS;
  document.head.appendChild(style);
}

const LAYOUT_NAMES = {
  title: "Title",
  section: "Section",
  bullets: "Bullets",
  content: "Text",
  two_column: "Two columns",
  stat: "Big numbers",
  quote: "Quote",
  image: "Visual",
  table: "Table",
  closing: "Closing",
};

/**
 * A line of text on a slide that the reader can click and retype.
 *
 * Plain text only, committed on blur. It is keyed on its value by the caller,
 * so a commit remounts it clean -- which is what keeps a paste of rich text
 * from leaving nodes behind that React does not know about.
 */
function Text({ as: Tag = "div", className, value, edit, placeholder, multiline, onCommit }) {
  if (!edit) return value ? <Tag className={className}>{value}</Tag> : null;
  return (
    <Tag
      className={className}
      data-edit=""
      data-placeholder={placeholder}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, multiline ? text : text.replace(/\s+/g, " "));
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !(multiline && event.shiftKey)) {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.currentTarget.textContent = value || "";
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = event.currentTarget.innerText.replace(/ /g, " ").trim();
        if (next !== (value || "")) onCommit(next);
      }}
    >
      {value || ""}
    </Tag>
  );
}

/** Markdown on a slide. Not editable in place -- it is edited in Source. */
function Markdown({ className, value }) {
  const html = useMemo(() => ({ __html: renderMarkdown(value || "") }), [value]);
  if (!value) return null;
  return <div className={`deck-md ${className || ""}`} dangerouslySetInnerHTML={html} />;
}

const looksNumeric = (text) => /^[-+]?[$€£¥]?\d[\d,.]*%?$/.test(String(text).trim());

/**
 * One slide, drawn from its data. Exported for the HTML export, which renders
 * these to static markup.
 */
export function Slide({ slide, number, total, edit = false, onEdit }) {
  const put = (field) => (text) => onEdit?.({ ...slide, [field]: text });
  const text = (field, props = {}) => (
    <Text
      key={`${field}:${slide[field] || ""}`}
      value={slide[field]}
      edit={edit}
      onCommit={put(field)}
      {...props}
    />
  );
  const layout = slide.layout;
  const numbered = !["title", "section", "closing"].includes(layout);
  const heading = (props = {}) =>
    text("title", { as: "h2", className: "deck-h deck-title-top", placeholder: "Title", ...props });

  let body = null;
  switch (layout) {
    case "title":
      body = (
        <>
          <div className="deck-rule" />
          {text("kicker", { className: "deck-kicker", placeholder: "Kicker" })}
          {text("title", { as: "h1", className: "deck-h", placeholder: "Title" })}
          {text("subtitle", { className: "deck-sub", placeholder: "Subtitle", multiline: true })}
        </>
      );
      break;
    case "section":
      body = (
        <>
          {text("kicker", { className: "deck-kicker", placeholder: "Part" })}
          {text("title", { as: "h2", className: "deck-h", placeholder: "Section" })}
          {text("subtitle", { className: "deck-sub", placeholder: "What this part covers", multiline: true })}
        </>
      );
      break;
    case "content":
      body = (
        <>
          {heading()}
          <Markdown className="deck-body" value={slide.body} />
        </>
      );
      break;
    case "two_column":
      body = (
        <>
          {heading()}
          <div className="deck-cols">
            <div className="deck-col">
              {text("left_title", { className: "deck-col-title", placeholder: "Left" })}
              <Markdown value={slide.left} />
            </div>
            <div className="deck-col">
              {text("right_title", { className: "deck-col-title", placeholder: "Right" })}
              <Markdown value={slide.right} />
            </div>
          </div>
        </>
      );
      break;
    case "stat": {
      const stats = slide.stats || [];
      const putStat = (i, key) => (value) =>
        onEdit?.({ ...slide, stats: stats.map((s, n) => (n === i ? { ...s, [key]: value } : s)) });
      body = (
        <>
          {slide.title || edit ? heading() : null}
          <div className="deck-stats" data-count={stats.length}>
            {stats.map((stat, i) => (
              <div className="deck-stat" key={i}>
                <Text key={`v${i}:${stat.value}`} className="deck-stat-value" value={stat.value}
                  edit={edit} onCommit={putStat(i, "value")} placeholder="42%" />
                <Text key={`l${i}:${stat.label}`} className="deck-stat-label" value={stat.label}
                  edit={edit} onCommit={putStat(i, "label")} placeholder="What it measures" />
              </div>
            ))}
          </div>
        </>
      );
      break;
    }
    case "quote":
      body = (
        <>
          <div className="deck-quote-mark" aria-hidden="true">“</div>
          {text("quote", { as: "blockquote", className: "deck-quote", placeholder: "The quote", multiline: true })}
          {text("attribution", { className: "deck-attribution", placeholder: "Who said it" })}
        </>
      );
      break;
    case "image": {
      const src = svgSource(slide.visual);
      body = (
        <>
          {heading()}
          <div className="deck-visual">{src ? <img src={src} alt={slide.caption || slide.title || ""} /> : null}</div>
          {text("caption", { className: "deck-caption", placeholder: "Caption" })}
        </>
      );
      break;
    }
    case "table":
      body = (
        <>
          {heading()}
          <table className="deck-table">
            <thead>
              <tr>
                {(slide.columns || []).map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(slide.rows || []).map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} data-num={looksNumeric(cell) ? "" : undefined}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
      break;
    case "closing":
      body = (
        <>
          <div className="deck-rule" />
          {text("title", { as: "h2", className: "deck-h", placeholder: "Thank you" })}
          {text("subtitle", { className: "deck-sub", placeholder: "Contact, next step", multiline: true })}
        </>
      );
      break;
    default: {
      const bullets = slide.bullets || [];
      const putBullet = (i) => (value) => {
        const next = value ? bullets.map((b, n) => (n === i ? value : b)) : bullets.filter((_, n) => n !== i);
        onEdit?.({ ...slide, bullets: next });
      };
      body = (
        <>
          {heading()}
          <ul className="deck-bullets">
            {bullets.map((b, i) => (
              <Text key={`${i}:${b}`} as="li" value={b} edit={edit} onCommit={putBullet(i)} />
            ))}
          </ul>
          {slide.body ? <Markdown className="deck-body" value={slide.body} /> : null}
        </>
      );
    }
  }

  return (
    <div className="deck-slide" data-layout={layout}>
      {body}
      {numbered ? (
        <>
          <span className="deck-brand" aria-hidden="true" />
          <span className="deck-num">
            {String(number).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** What a new slide of each layout starts with, so it is never a blank box. */
function starterSlide(layout) {
  switch (layout) {
    case "title": return { layout, kicker: "Kicker", title: "Title", subtitle: "Subtitle" };
    case "section": return { layout, title: "Section title", subtitle: "What this part covers" };
    case "content": return { layout, title: "Title", body: "A short paragraph that makes one point." };
    case "two_column":
      return { layout, title: "Title", left_title: "Before", left: "- One\n- Two", right_title: "After", right: "- One\n- Two" };
    case "stat": return { layout, title: "Title", stats: [{ value: "42%", label: "What it measures" }] };
    case "quote": return { layout, quote: "The quote goes here.", attribution: "Who said it" };
    case "image": return { layout, title: "Title", caption: "Ask for a drawing to go here." };
    case "table": return { layout, title: "Title", columns: ["Option", "Cost", "Time"], rows: [["A", "$10", "2 wk"], ["B", "$25", "1 wk"]] };
    case "closing": return { layout, title: "Thank you", subtitle: "Questions?" };
    default: return { layout: "bullets", title: "Title", bullets: ["First point", "Second point", "Third point"] };
  }
}

/** Carry what a slide already says into a different layout, as far as it goes. */
function relayout(slide, layout) {
  const starter = starterSlide(layout);
  const next = { ...starter, ...slide, layout };
  if (layout === "bullets" && !slide.bullets?.length) next.bullets = starter.bullets;
  if (layout === "stat" && !slide.stats?.length) next.stats = starter.stats;
  if (layout === "quote" && !slide.quote) next.quote = slide.title || starter.quote;
  return next;
}

/** Full screen, one slide at a time. Arrows, space and a click move; Esc ends. */
function Presenter({ deck, start, style, onClose }) {
  const [at, setAt] = useState(start);
  const node = useRef(null);
  const total = deck.slides.length;
  const go = useCallback((n) => setAt(Math.max(0, Math.min(total - 1, n))), [total]);

  useEffect(() => {
    const el = node.current;
    el?.focus();
    el?.requestFullscreen?.().catch(() => {});
    const onFullscreen = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [onClose]);

  return (
    <div
      className="deck-present"
      ref={node}
      tabIndex={-1}
      style={style}
      role="dialog"
      aria-label="Presenting"
      onKeyDown={(event) => {
        if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(event.key)) {
          event.preventDefault();
          go(at + 1);
        } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) {
          event.preventDefault();
          go(at - 1);
        } else if (event.key === "Home") go(0);
        else if (event.key === "End") go(total - 1);
        else if (event.key === "Escape") onClose();
      }}
      onClick={(event) => go(event.clientX < window.innerWidth / 3 ? at - 1 : at + 1)}
    >
      <div className="deck-present-stage">
        <div className="deck-frame">
          <Slide slide={deck.slides[at]} number={at + 1} total={total} />
        </div>
      </div>
      <div className="deck-present-count mi">
        {at + 1} / {total} · Esc to stop
      </div>
    </div>
  );
}

/** The deck as a standalone HTML file: every slide, the stylesheet, a present
 *  mode. Rendered with the same component the panel draws with. */
export async function exportDeck(deck, fallbackTheme, title) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const style = themeVars(resolveTheme(deck.theme, fallbackTheme));
  const total = deck.slides.length;
  const frames = deck.slides
    .map((slide, i) =>
      renderToStaticMarkup(
        <div className="deck-frame" style={style}>
          <Slide slide={slide} number={i + 1} total={total} />
        </div>,
      ),
    )
    .join("\n");
  return deckDocument(title, frames);
}

/**
 * The deck in the canvas panel: the current slide large and editable, its
 * speaker notes under it, and every slide in a filmstrip below.
 *
 * Edits go back up as a whole new deck through `onChange`; the panel owns
 * saving, the same debounce the text editor uses.
 */
export function DeckView({ deck, fallbackTheme, onChange }) {
  ensureDeckCss();
  const [at, setAt] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const strip = useRef(null);
  const total = deck.slides.length;
  const current = Math.min(at, Math.max(0, total - 1));
  const slide = deck.slides[current];

  const style = useMemo(
    () => themeVars(resolveTheme(deck.theme, fallbackTheme)),
    [deck.theme, fallbackTheme],
  );

  // Keep the current thumbnail in view as the reader pages through.
  useEffect(() => {
    strip.current
      ?.querySelector(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const replace = useCallback(
    (index, next) =>
      onChange({ ...deck, slides: deck.slides.map((s, i) => (i === index ? next : s)) }),
    [deck, onChange],
  );

  const insert = (index, next) => {
    const slides = [...deck.slides];
    slides.splice(index, 0, next);
    onChange({ ...deck, slides });
    setAt(index);
  };

  const remove = () => {
    if (total <= 1) return;
    onChange({ ...deck, slides: deck.slides.filter((_, i) => i !== current) });
    setAt(Math.max(0, current - 1));
  };

  const move = (delta) => {
    const to = current + delta;
    if (to < 0 || to >= total) return;
    const slides = [...deck.slides];
    [slides[current], slides[to]] = [slides[to], slides[current]];
    onChange({ ...deck, slides });
    setAt(to);
  };

  const closePresenter = useCallback(() => setPresenting(false), []);

  if (!total) {
    return (
      <div className="deck-view deck-empty">
        <p>This deck has no slides yet.</p>
        <button type="button" className="canvas-foot-btn" onClick={() => insert(0, starterSlide("title"))}>
          Add a title slide
        </button>
      </div>
    );
  }

  return (
    <div
      className="deck-view"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.target.isContentEditable || /^(TEXTAREA|INPUT|SELECT)$/.test(event.target.tagName)) return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") setAt(Math.min(total - 1, current + 1));
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") setAt(Math.max(0, current - 1));
      }}
    >
      <div className="deck-toolbar">
        <div className="deck-pager">
          <button type="button" className="deck-tool" aria-label="Previous slide"
            disabled={current === 0} onClick={() => setAt(current - 1)}>‹</button>
          <span className="mi">{current + 1} / {total}</span>
          <button type="button" className="deck-tool" aria-label="Next slide"
            disabled={current === total - 1} onClick={() => setAt(current + 1)}>›</button>
        </div>
        <select
          className="deck-layout"
          aria-label="Layout of this slide"
          value={slide.layout}
          onChange={(event) => replace(current, relayout(slide, event.target.value))}
        >
          {LAYOUTS.map((l) => (
            <option key={l} value={l}>{LAYOUT_NAMES[l]}</option>
          ))}
        </select>
        <div className="spacer" />
        <button type="button" className="deck-tool" title="Move left" aria-label="Move slide earlier"
          disabled={current === 0} onClick={() => move(-1)}>←</button>
        <button type="button" className="deck-tool" title="Move right" aria-label="Move slide later"
          disabled={current === total - 1} onClick={() => move(1)}>→</button>
        <button type="button" className="deck-tool" title="Duplicate slide" aria-label="Duplicate slide"
          onClick={() => insert(current + 1, { ...slide })}>⧉</button>
        <button type="button" className="deck-tool" title="Delete slide" aria-label="Delete slide"
          disabled={total <= 1} onClick={remove}>✕</button>
        <button type="button" className="deck-present-btn" onClick={() => setPresenting(true)}>
          Present
        </button>
      </div>

      <div className="deck-stage" style={style}>
        <div className="deck-frame">
          <Slide
            slide={slide}
            number={current + 1}
            total={total}
            edit
            onEdit={(next) => replace(current, next)}
          />
        </div>
      </div>

      <label className="deck-notes">
        <span className="mi">Speaker notes</span>
        <textarea
          value={slide.notes || ""}
          placeholder="What you say on this slide."
          rows={2}
          onChange={(event) => replace(current, { ...slide, notes: event.target.value })}
        />
      </label>

      <div className="deck-strip" ref={strip} style={style} aria-label="Slides">
        {deck.slides.map((s, i) => (
          // A div acting as a button rather than a <button>: a slide is block
          // content -- headings, lists, tables -- which a button may not hold.
          <div
            key={i}
            role="button"
            tabIndex={0}
            className="deck-thumb"
            data-index={i}
            data-on={i === current ? "" : undefined}
            aria-label={`Slide ${i + 1}: ${s.title || s.quote || LAYOUT_NAMES[s.layout]}`}
            aria-current={i === current ? "true" : undefined}
            onClick={() => setAt(i)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setAt(i);
              }
            }}
          >
            <div className="deck-frame" aria-hidden="true">
              <Slide slide={s} number={i + 1} total={total} />
            </div>
          </div>
        ))}
        <div className="deck-add">
          <select
            className="deck-add-select"
            aria-label="Add a slide"
            value=""
            onChange={(event) => {
              if (event.target.value) insert(current + 1, starterSlide(event.target.value));
            }}
          >
            <option value="">+ Slide</option>
            {LAYOUTS.map((l) => (
              <option key={l} value={l}>{LAYOUT_NAMES[l]}</option>
            ))}
          </select>
        </div>
      </div>

      {presenting ? (
        <Presenter deck={deck} start={current} style={style} onClose={closePresenter} />
      ) : null}
    </div>
  );
}
