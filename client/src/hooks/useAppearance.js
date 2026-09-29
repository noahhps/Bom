import { useCallback, useEffect, useState } from "react";

import {
  applyAppearance,
  resolveAppearance,
  saveAppearance,
  storedAppearance,
  watchSystem,
} from "../lib/appearance";
import { isDesktop } from "../lib/serverOrigin";

/**
 * The device's light/dark preference, and the mode it resolves to right now.
 *
 * `mode` is what everything downstream reads -- the stylesheet through
 * `data-theme`, the accent generator through useTheme -- so a "System"
 * preference follows the OS live, without a reload.
 */
export function useAppearance() {
  const [preference, setPreferenceState] = useState(storedAppearance);
  const [mode, setMode] = useState(() => resolveAppearance(storedAppearance()));

  useEffect(() => {
    setMode(resolveAppearance(preference));
    if (preference !== "system") return undefined;
    return watchSystem(setMode);
  }, [preference]);

  useEffect(() => {
    applyAppearance(mode);
  }, [mode]);

  // In the desktop app the window's own appearance follows too: the frost
  // behind the glass empty states is a native material, pale or dark by the
  // window's appearance, and it has to match the page drawn over it rather
  // than the system's setting. "System" hands the choice back to macOS.
  useEffect(() => {
    if (!isDesktop()) return;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(preference === "system" ? null : mode))
      .catch(() => {});
  }, [preference, mode]);

  const setPreference = useCallback((next) => {
    saveAppearance(next);
    setPreferenceState(next);
  }, []);

  return { preference, mode, setPreference };
}
