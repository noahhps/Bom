import { useEffect, useLayoutEffect, useRef, useState } from "react";

/* A right-click menu: a short list at the pointer, shut by a pick, a click
 * anywhere else, Escape, or scrolling. Kept on screen -- a menu opened near
 * the right or bottom edge opens towards the middle instead. */
export function ContextMenu({ x, y, items, onClose }) {
  const node = useRef(null);
  const [place, setPlace] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = node.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({
      left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const away = (event) => {
      if (!node.current?.contains(event.target)) onClose();
    };
    const key = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={node}
      className="code-menu"
      role="menu"
      style={{ left: place.left, top: place.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === "-" ? (
          <div key={`sep-${index}`} className="code-menu-sep" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span>{item.label}</span>
            {item.keys ? <kbd className="code-menu-keys">{item.keys}</kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}
