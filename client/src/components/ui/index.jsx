/* Bom's seam onto BoardUI.
 *
 * BoardUI's components (components/base, vendored as source from
 * boardui.com) are used directly wherever their API already fits. The few
 * wrappers here exist where Bom's call sites speak a different shape:
 *
 *   QuietIconButton  the borderless icon control BoardUI's sidebar and app
 *                    bar draw by hand (its IconButton is the bordered,
 *                    secondary one), built from the same tokens
 *   OptionSelect     BoardUI's Select driven by a plain value/options pair,
 *                    the way every native <select> in Bom was -- including
 *                    the empty-string "none" value React Aria cannot key on
 *   Modal            a React Aria modal dressed as a BoardUI panel
 *   Glyph            a Bom icon name rendered at a BoardUI icon size
 */
import { Dialog, Heading, Modal as AriaModal, ModalOverlay } from "react-aria-components";

import { CloseButton } from "@/components/base/buttons/close-button";
import { Select, SelectItem } from "@/components/base/select/select";
import { cx } from "@/utils/cx";

import { GLYPHS } from "../Icon";

/** A Bom icon (by its shell name) as a component BoardUI can be handed as
 *  `leadingIcon` / `icon`. Cached so the reference is stable per name. */
const glyphCache = new Map();
export function glyph(name) {
  if (!glyphCache.has(name)) {
    const Drawn = GLYPHS[name];
    const Component = ({ className, ...rest }) =>
      Drawn ? <Drawn className={className} {...rest} /> : null;
    Component.displayName = `Glyph(${name})`;
    glyphCache.set(name, Component);
  }
  return glyphCache.get(name);
}

export function Glyph({ name, className }) {
  const Drawn = GLYPHS[name];
  return Drawn ? <Drawn className={cx("size-5 shrink-0", className)} aria-hidden="true" /> : null;
}

/** BoardUI's quiet icon control: no border or fill until hovered, the icon
 *  in the secondary foreground, the primary one when pressed or active. */
export function QuietIconButton({
  icon,
  label,
  pressed,
  size = "medium",
  className,
  children,
  ...props
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx(
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-2lg",
        "text-foreground-icon-secondary transition-[background-color,color] duration-150 ease",
        "hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
        "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-pressed:text-foreground-icon-primary",
        size === "small" ? "size-8" : "size-9",
        className,
      )}
      {...props}
    >
      {typeof icon === "string" ? (
        <Glyph name={icon} className={size === "small" ? "size-[18px]" : "size-5"} />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

const NONE = "__none__";
const toKey = (value) => (value === "" || value == null ? NONE : String(value));
const fromKey = (key) => (key === NONE ? "" : key);

/**
 * BoardUI's Select over `options: [{ value, label, disabled? }]`, reporting
 * the chosen value (a string, "" for none) the way a native select's
 * `event.target.value` did.
 */
export function OptionSelect({
  value,
  onChange,
  options,
  label,
  size = "sm",
  className,
  triggerClassName,
  popoverClassName,
  isDisabled,
  renderValue,
}) {
  return (
    <Select
      aria-label={label}
      size={size}
      className={className}
      triggerClassName={triggerClassName}
      popoverClassName={cx("w-auto min-w-[var(--trigger-width)] max-w-[360px]", popoverClassName)}
      selectedKey={toKey(value)}
      onSelectionChange={(key) => onChange?.(fromKey(String(key)))}
      isDisabled={isDisabled}
      renderValue={renderValue}
    >
      {options.map((option) => (
        <SelectItem
          key={toKey(option.value)}
          id={toKey(option.value)}
          textValue={String(option.label)}
          isDisabled={option.disabled}
        >
          {option.label}
        </SelectItem>
      ))}
    </Select>
  );
}

/**
 * A modal panel in BoardUI's dress: a dimmed, softly blurred overlay and a
 * white rounded-3xl card with the sidebar's elevation. Dismissed by Escape or
 * a click outside unless `isDismissable` is false.
 */
export function Modal({
  isOpen = true,
  onClose,
  title,
  description,
  children,
  footer,
  isDismissable = true,
  className,
  bodyClassName,
  showClose = true,
  role = "dialog",
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose?.()}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className={cx(
        "fixed inset-0 z-[1000] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]",
        "transition-opacity duration-200 ease-out data-[entering]:opacity-0 data-[exiting]:opacity-0",
      )}
    >
      <AriaModal
        className={cx(
          "w-full max-w-[440px] rounded-3xl border border-border-button-white bg-background-primary-default shadow-waitlist",
          "transition duration-200 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0",
          className,
        )}
      >
        <Dialog role={role} className="flex max-h-[calc(100dvh-32px)] flex-col outline-none">
          {title || showClose ? (
            <div className="flex items-start gap-3 px-6 pt-5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {title ? (
                  <Heading slot="title" className="text-headline-semibold text-text-primary">
                    {title}
                  </Heading>
                ) : null}
                {description ? (
                  <p className="text-body-regular text-text-secondary">{description}</p>
                ) : null}
              </div>
              {showClose && onClose ? <CloseButton onClick={onClose} aria-label="Close" /> : null}
            </div>
          ) : null}
          <div className={cx("min-h-0 overflow-y-auto px-6 py-5", bodyClassName)}>{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-separator-border px-6 py-4">
              {footer}
            </div>
          ) : null}
        </Dialog>
      </AriaModal>
    </ModalOverlay>
  );
}
