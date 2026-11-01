import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDialog } from "./Dialog";
import { useImageUrls, useSessionImages } from "../hooks/useImages";
import { deckImageIds, imageData, resolveAll } from "../lib/images";
import { renderMarkdown } from "../lib/markdown";
import {
  IMAGE_LAYOUTS,
  LAYOUTS,
  MADE_LAYOUTS,
  SLIDE_CSS,
  deckDocument,
  resolveTheme,
  svgSource,
  themeVars,
} from "../lib/slides";
import { cleanFrame, palette, renderFrame } from "../lib/wireframe";

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
  image: "Picture with caption",
  table: "Table",
  closing: "Closing",
  photo: "Full-bleed photo",
  split: "Photo beside text",
  board: "Wireframe screen",
};

/* A wireframe frame drawn on a slide. The frame keeps its own pixel size and
   an SVG viewBox scales it into whatever room the slide has, so the markup is
   the editor's and the exported page's, unchanged. `wire` is the deck's theme
   and the conversation's standard, which a styled frame is drawn in. */
function Board({ board, wire, images }) {
  const frame = useMemo(() => cleanFrame(board.frame), [board.frame]);
  const html = useMemo(
    () => renderFrame(frame, palette({ fidelity: board.fidelity, theme: wire?.theme }, wire?.fallback), images),
    [frame, board.fidelity, wire?.theme, wire?.fallback, images],
  );
  return (
    <div className="deck-board">
      <svg viewBox={`0 0 ${frame.w} ${frame.h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={frame.name}>
        <foreignObject className="deck-board-frame" x="0" y="0" width={frame.w} height={frame.h}>
          <div style={{ width: frame.w, height: frame.h }} dangerouslySetInnerHTML={{ __html: html }} />
        </foreignObject>
      </svg>
    </div>
  );
}

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
export function Slide({ slide, number, total, edit = false, onEdit, images = {}, wire = null }) {
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

  // The slide's picture: one of the user's images, by id, drawn from an
  // address the caller resolved -- a blob: URL in the app, a data: URI in an
  // export. Nothing here ever names a web address.
  const picture = () => {
    const ref = slide.image;
    const url = ref ? images[ref.id] : null;
    if (url) {
      return (
        <>
          <img className="deck-pic" data-fit={ref.fit} src={url} alt={ref.alt || slide.title || ""} />
          {/* Said on the picture, so a generated scene is never taken for a
              photograph of something real -- in the app and in every export. */}
          {ref.generated ? <span className="deck-pic-credit">AI-generated</span> : null}
        </>
      );
    }
    return (
      <div className="deck-pic-empty">
        {edit ? (ref ? "Loading image…" : "No picture yet — choose one with Picture above") : null}
      </div>
    );
  };

  const bullets = slide.bullets || [];
  const putBullet = (i) => (value) => {
    const next = value ? bullets.map((b, n) => (n === i ? value : b)) : bullets.filter((_, n) => n !== i);
    onEdit?.({ ...slide, bullets: next });
  };
  const bulletList = () =>
    bullets.length ? (
      <ul className="deck-bullets">
        {bullets.map((b, i) => (
          <Text key={`${i}:${b}`} as="li" value={b} edit={edit} onCommit={putBullet(i)} />
        ))}
      </ul>
    ) : null;

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
      // A user's picture when it has one, otherwise the SVG the model drew.
      const src = svgSource(slide.visual);
      body = (
        <>
          {heading()}
          <div className="deck-visual">
            {slide.image || !src ? picture() : <img src={src} alt={slide.caption || slide.title || ""} />}
          </div>
          {text("caption", { className: "deck-caption", placeholder: "Caption" })}
        </>
      );
      break;
    }
    case "photo":
      body = (
        <>
          <div className="deck-photo">{picture()}</div>
          <div className="deck-photo-copy">
            {text("kicker", { className: "deck-kicker", placeholder: "Kicker" })}
            {text("title", { as: "h2", className: "deck-h", placeholder: "Title" })}
            {text("subtitle", { className: "deck-sub", placeholder: "Subtitle", multiline: true })}
          </div>
        </>
      );
      break;
    case "split":
      body = (
        <>
          <div className="deck-split-pic">{picture()}</div>
          <div className="deck-split-copy">
            {heading()}
            {bulletList()}
            {slide.body ? <Markdown className="deck-body" value={slide.body} /> : null}
          </div>
        </>
      );
      break;
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
    case "board":
      body = (
        <>
          {heading()}
          {slide.board ? <Board board={slide.board} wire={wire} images={images} /> : null}
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
    default:
      body = (
        <>
          {heading()}
          {bulletList() || <ul className="deck-bullets" />}
          {slide.body ? <Markdown className="deck-body" value={slide.body} /> : null}
        </>
      );
  }

  return (
    <div className="deck-slide" data-layout={layout} data-side={slide.image?.side || undefined}>
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
    case "image": return { layout, title: "Title", caption: "Caption" };
    case "photo": return { layout, kicker: "Kicker", title: "Title", subtitle: "Subtitle" };
    case "split": return { layout, title: "Title", bullets: ["First point", "Second point"] };
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

/** The larger an upload may be before it is refused here rather than after
 *  the whole thing has crossed the wire. Matches the server's limit. */
const MAX_UPLOAD = 25 * 1024 * 1024;

/**
 * Choosing the current slide's picture: the conversation's own images --
 * uploaded here or attached in the chat -- plus an upload button, and the
 * three things worth setting about a picture on a slide: how it fills its
 * frame, which side it sits on in a split, and its alt text.
 */
function ImagePicker({ sessionId, layout, value, onChange, onClose }) {
  const { images, error, upload, generator, generate } = useSessionImages(sessionId);
  const { confirm } = useDialog();
  const [prompt, setPrompt] = useState("");
  const [shape, setShape] = useState(layout === "split" ? "portrait" : "landscape");
  const [making, setMaking] = useState(false);
  const urls = useImageUrls(images.map((i) => i.id));
  const [tooBig, setTooBig] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef(null);

  const choose = (image) =>
    onChange({
      id: image.id,
      fit: value?.fit || "cover",
      ...(value?.side ? { side: value.side } : null),
      ...(value?.alt || image.alt ? { alt: value?.alt || image.alt } : null),
      ...(image.generated ? { generated: true } : null),
    });

  // Generating is the person's own request, so no approval prompt -- except
  // that a generator off this machine is told what they are working on, and
  // they are asked before that happens.
  const make = async () => {
    const text = prompt.trim();
    if (!text || making) return;
    if (generator?.remote) {
      const yes = await confirm(
        `This sends your description to ${generator.host}, outside this machine, to make the picture.`,
        { title: "Send to the image generator?", confirmLabel: "Send" },
      );
      if (!yes) return;
    }
    setMaking(true);
    const image = await generate(text, shape);
    setMaking(false);
    if (image) {
      setPrompt("");
      choose(image);
    }
  };

  return (
    <div className="deck-picker" role="dialog" aria-label="Choose a picture">
      <div className="deck-picker-head">
        <span className="mi">Pictures in this conversation</span>
        <button type="button" className="deck-tool" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="deck-picker-grid">
        {images.map((image) => (
          <button
            key={image.id}
            type="button"
            className="deck-picker-item"
            data-on={value?.id === image.id ? "" : undefined}
            title={image.alt || image.name}
            onClick={() => choose(image)}
          >
            {urls[image.id] ? <img src={urls[image.id]} alt={image.alt || image.name} /> : null}
            {image.generated ? <span className="deck-picker-badge" title="AI-generated">AI</span> : null}
          </button>
        ))}
        <button
          type="button"
          className="deck-picker-upload"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          {busy ? "Adding…" : "+ Upload"}
        </button>
      </div>
      {!images.length ? (
        <p className="deck-picker-note">
          No pictures yet. Upload one here, or attach it in the chat — either way
          it is cleaned (location data removed) and kept only in this conversation.
        </p>
      ) : null}
      {generator?.available ? (
        <div className="deck-picker-gen">
          <textarea
            value={prompt}
            rows={2}
            placeholder="Or describe a picture to generate — subject, composition, mood. No text in it."
            aria-label="Describe a picture to generate"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                make();
              }
            }}
          />
          <div className="deck-picker-gen-row">
            <select value={shape} aria-label="Shape" onChange={(event) => setShape(event.target.value)}>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
            </select>
            <span className="deck-picker-gen-where mi">
              {generator.remote ? `Sent to ${generator.host}` : "On your machine"}
            </span>
            <button type="button" className="deck-present-btn" disabled={!prompt.trim() || making} onClick={make}>
              {making ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
      ) : null}
      {tooBig || error ? <p className="deck-picker-note" data-error="">{tooBig || error}</p> : null}

      {value ? (
        <div className="deck-picker-opts">
          <div className="canvas-modes" role="group" aria-label="Fit">
            {[["cover", "Fill"], ["contain", "Fit"]].map(([fit, label]) => (
              <button key={fit} type="button" className="canvas-mode"
                data-on={value.fit === fit ? "" : undefined}
                onClick={() => onChange({ ...value, fit })}>{label}</button>
            ))}
          </div>
          {layout === "split" ? (
            <div className="canvas-modes" role="group" aria-label="Side">
              {[["left", "Left"], ["right", "Right"]].map(([side, label]) => (
                <button key={side} type="button" className="canvas-mode"
                  data-on={(value.side || "left") === side ? "" : undefined}
                  onClick={() => onChange({ ...value, side })}>{label}</button>
              ))}
            </div>
          ) : null}
          <input
            key={value.id}
            className="deck-picker-alt"
            defaultValue={value.alt || ""}
            placeholder="Alt text — what the picture shows"
            aria-label="Alt text"
            onBlur={(event) => {
              const alt = event.target.value.trim();
              if (alt !== (value.alt || "")) onChange({ ...value, alt: alt || undefined });
            }}
          />
          <button type="button" className="deck-tool" onClick={() => onChange(null)}>Remove</button>
        </div>
      ) : null}

      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={async (event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (!picked) return;
          if (picked.size > MAX_UPLOAD) {
            setTooBig(`${picked.name} is larger than 25 MB.`);
            return;
          }
          setTooBig("");
          setBusy(true);
          const image = await upload(picked);
          setBusy(false);
          if (image) choose(image);
        }}
      />
    </div>
  );
}

/** Full screen, one slide at a time. Arrows, space and a click move; Esc ends. */
function Presenter({ deck, start, style, images, onClose, wire }) {
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
          <Slide slide={deck.slides[at]} number={at + 1} total={total} images={images} wire={wire} />
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
export async function exportDeck(deck, fallbackTheme, title, api) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  // Pictures go inside the file, so the deck stands on its own anywhere.
  const images = api ? await resolveAll(deckImageIds(deck), (id) => imageData(api, id)) : {};
  const style = themeVars(resolveTheme(deck.theme, fallbackTheme));
  const wire = { theme: deck.theme, fallback: fallbackTheme };
  const total = deck.slides.length;
  const frames = deck.slides
    .map((slide, i) =>
      renderToStaticMarkup(
        <div className="deck-frame" style={style}>
          <Slide slide={slide} number={i + 1} total={total} images={images} wire={wire} />
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
export function DeckView({ deck, fallbackTheme, onChange, sessionId = null }) {
  ensureDeckCss();
  const [at, setAt] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [picking, setPicking] = useState(false);
  const images = useImageUrls(deckImageIds(deck));
  const strip = useRef(null);
  const total = deck.slides.length;
  const current = Math.min(at, Math.max(0, total - 1));
  const slide = deck.slides[current];

  const style = useMemo(
    () => themeVars(resolveTheme(deck.theme, fallbackTheme)),
    [deck.theme, fallbackTheme],
  );
  const wire = useMemo(() => ({ theme: deck.theme, fallback: fallbackTheme }), [deck.theme, fallbackTheme]);

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
          {LAYOUTS.filter((l) => !MADE_LAYOUTS.has(l) || l === slide.layout).map((l) => (
            <option key={l} value={l}>{LAYOUT_NAMES[l]}</option>
          ))}
        </select>
        {IMAGE_LAYOUTS.has(slide.layout) && sessionId ? (
          <button
            type="button"
            className="deck-tool deck-picture-btn"
            aria-expanded={picking}
            data-on={picking ? "" : undefined}
            onClick={() => setPicking((was) => !was)}
          >
            Picture
          </button>
        ) : null}
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

      {picking && IMAGE_LAYOUTS.has(slide.layout) && sessionId ? (
        <ImagePicker
          sessionId={sessionId}
          layout={slide.layout}
          value={slide.image || null}
          onChange={(ref) => {
            const next = { ...slide };
            if (ref) next.image = ref;
            else delete next.image;
            replace(current, next);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}

      <div className="deck-stage" style={style}>
        <div className="deck-frame">
          <Slide
            slide={slide}
            number={current + 1}
            total={total}
            edit
            onEdit={(next) => replace(current, next)}
            images={images}
            wire={wire}
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
              <Slide slide={s} number={i + 1} total={total} images={images} wire={wire} />
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
            {LAYOUTS.filter((l) => !MADE_LAYOUTS.has(l)).map((l) => (
              <option key={l} value={l}>{LAYOUT_NAMES[l]}</option>
            ))}
          </select>
        </div>
      </div>

      {presenting ? (
        <Presenter deck={deck} start={current} style={style} images={images} onClose={closePresenter} wire={wire} />
      ) : null}
    </div>
  );
}
