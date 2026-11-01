/* Asking a question and waiting for the answer, without the platform's help.
 *
 * `prompt`, `confirm` and `alert` are not available here. WKWebView only
 * provides them when the host implements the UI delegate that draws them, and
 * the Tauri shell does not -- so every one of them was a silent no-op in the
 * desktop app: "+ New project" appeared to do nothing at all, because the
 * prompt that should have asked for a name never opened and returned
 * undefined.
 *
 * Replacing them rather than reaching for Tauri's dialog plugin, for two
 * reasons. The plugin has ask/confirm/message but no text input, so it could
 * not have answered the project-name question at all. And a dialog drawn here
 * is one implementation for every host -- the phone gets it too, where iOS
 * Safari's own prompt is a grey slab with none of the app's typography.
 *
 * The API is promise-shaped so a call site reads almost the way it did:
 *
 *     if (await confirm("Delete this conversation?")) onDelete(id);
 *     const name = await ask("Name for the new project");
 *
 * The app draws no other modals on purpose -- recall sits in the margin, not
 * over the top. This is the exception, because a question that blocks what
 * happens next has nowhere else to go.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

import { Modal } from "./ui";

const DialogContext = createContext(null);

/** The three shapes. `notify` is the one that takes no answer. */
const ASK = "ask";
const CONFIRM = "confirm";
const NOTIFY = "notify";

export function DialogProvider({ children }) {
  // One at a time. A second request while one is open would either stack --
  // which nothing here needs -- or silently drop an unresolved promise.
  const [request, setRequest] = useState(null);
  const [draft, setDraft] = useState("");
  const resolver = useRef(null);
  const inputRef = useRef(null);
  const confirmRef = useRef(null);

  const open = useCallback((next) => {
    // Any request still open is answered negatively rather than abandoned. An
    // unresolved promise would leave its caller awaiting forever.
    if (resolver.current) resolver.current(next.kind === ASK ? null : false);
    setDraft(next.value || "");
    setRequest(next);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((answer) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    setDraft("");
    if (resolve) resolve(answer);
  }, []);

  const api = useMemo(
    () => ({
      /** Ask for a line of text. Resolves to the trimmed string, or null. */
      ask: (message, options = {}) =>
        open({ kind: ASK, message, ...options }),
      /** Ask a yes/no question. Resolves true only on the affirmative. */
      confirm: (message, options = {}) =>
        open({ kind: CONFIRM, message, ...options }),
      /** Say something. Resolves when it has been dismissed. */
      notify: (message, options = {}) =>
        open({ kind: NOTIFY, message, ...options }),
    }),
    [open],
  );

  // Focus follows the dialog: the field when there is one to type in, the
  // confirming button otherwise. Without this, Escape and Enter would go to
  // whatever was focused behind the dialog.
  useEffect(() => {
    if (!request) return;
    const target = request.kind === ASK ? inputRef.current : confirmRef.current;
    target?.focus();
    if (request.kind === ASK) inputRef.current?.select();
  }, [request]);

  const submit = (event) => {
    event.preventDefault();
    if (!request) return;
    if (request.kind === ASK) {
      const value = draft.trim();
      // An empty answer is a cancel. Every caller checked for that anyway,
      // and it saves each of them repeating the trim.
      settle(value || null);
    } else {
      settle(true);
    }
  };

  const cancel = () => settle(request?.kind === ASK ? null : false);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {/* BoardUI's modal: a dimmed overlay and a rounded-3xl panel, with its
          Input for the one-line answer and its Buttons for the choice. React
          Aria handles Escape, the click outside and the focus trap. */}
      <Modal
        isOpen={Boolean(request)}
        onClose={cancel}
        title={request?.title || null}
        showClose={false}
        role={request?.kind === NOTIFY ? "alertdialog" : "dialog"}
        className="max-w-[420px]"
        bodyClassName="pt-5 pb-0"
      >
        {request ? (
          <form onSubmit={submit} className="flex flex-col gap-4" aria-label={request.title || request.message}>
            <p className="text-body-regular whitespace-pre-wrap text-text-secondary">{request.message}</p>

            {request.kind === ASK ? (
              <Input
                aria-label={request.title || request.message}
                value={draft}
                onChange={setDraft}
                ref={inputRef}
                placeholder={request.placeholder || ""}
                autoComplete="off"
              />
            ) : null}

            <div className="-mx-6 mt-1 flex items-center justify-end gap-2 border-t border-separator-border px-6 py-4">
              {request.kind === NOTIFY ? null : (
                <Button type="button" variant="secondary" size="small" onClick={cancel}>
                  {request.cancelLabel || "Cancel"}
                </Button>
              )}
              <Button
                ref={confirmRef}
                type="submit"
                size="small"
                variant={request.destructive ? "danger" : "primary"}
              >
                {request.confirmLabel ||
                  (request.kind === NOTIFY ? "OK" : request.kind === ASK ? "Save" : "Confirm")}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </DialogContext.Provider>
  );
}

/**
 * The three askers.
 *
 * Throws when used outside the provider rather than returning a no-op, because
 * a silently absent dialog is precisely the bug this file exists to fix.
 */
export function useDialog() {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used inside <DialogProvider>");
  }
  return context;
}
