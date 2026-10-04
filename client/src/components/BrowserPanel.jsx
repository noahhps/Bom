import { Icon } from "./Icon";

/* The page the model has open, beside the conversation.
 *
 * For Bom's own browser it is a picture: the server takes one after every
 * step, so the reader sees what the model saw, a step at a time, without a
 * browser window popping up over their work. It is not live -- nothing here
 * can be clicked -- and the foot says so.
 *
 * For the user's own browser there is no picture to take (the page is in a
 * window of theirs, which they can look at), so the panel shows which page is
 * open and in which browser.
 *
 * Built on the canvas panel's shell -- the same aside, head and resize handle
 * -- so it sits where the canvas sits and the two can swap. */

function when(at) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export function BrowserPanel({ view, onClose, resizable, width, onResizeStart, onResizeKey }) {
  const mine = view?.where === "mine";
  const label = mine ? `your browser${view?.browser ? ` · ${view.browser}` : ""}` : "Bom's browser";
  const title = view?.title || (view?.url ? "" : "Nothing open yet");

  return (
    <aside className="canvas browser-panel" aria-label="Browser">
      {resizable ? (
        <div
          className="canvas-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Browser panel width"
          aria-valuenow={width}
          aria-valuemin={320}
          aria-valuemax={900}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
          onDoubleClick={() => onResizeKey({ key: "Reset", preventDefault() {} })}
        >
          <i />
        </div>
      ) : null}

      <header className="canvas-head">
        <span className="canvas-title-input browser-panel-title" data-empty={title ? undefined : ""} title={title}>
          {title || view?.url || ""}
        </span>
        <span className="canvas-kind mi">{label}</span>
        <div className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close browser panel" title="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div className="browser-panel-url mi">
        <Icon name="globe" />
        <span title={view?.url || ""}>{view?.url || "—"}</span>
        {view?.url ? (
          <a
            className="icon-btn"
            href={view.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open this page in your own browser"
            title="Open in your browser"
          >
            <Icon name="external" />
          </a>
        ) : null}
      </div>

      <div className="canvas-body browser-panel-body">
        {view?.shot ? (
          <img
            src={`data:image/jpeg;base64,${view.shot}`}
            alt={`Bom's browser, showing ${view.title || view.url || "a page"}`}
            draggable={false}
          />
        ) : (
          <div className="canvas-empty">
            <Icon name="globe" />
            <p>
              {mine
                ? "This page is open in your own browser. Look there -- Bom cannot take a picture of it."
                : view?.url
                  ? "No picture of this page yet."
                  : "When the model opens a page, it appears here."}
            </p>
          </div>
        )}
      </div>

      <footer className="browser-panel-foot mi">
        {view?.at ? `As of ${when(view.at)} · ` : ""}
        {mine
          ? "Each step here was approved by you."
          : "A picture after each step, not a live page -- nothing here can be clicked."}
      </footer>
    </aside>
  );
}
