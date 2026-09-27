import { useCallback, useEffect, useState } from "react";

import {
  applyAppearance,
  resolveAppearance,
  saveAppearance,
  storedAppearance,
  watchSystem,
} from "../lib/appearance";

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

  const setPreference = useCallback((next) => {
    saveAppearance(next);
    setPreferenceState(next);
  }, []);

  return { preference, mode, setPreference };
}
