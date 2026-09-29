import { useCallback, useEffect, useState } from "react";

/**
 * Every design, grouped by design project -- then design conversations filed
 * in none. Read from the server when something that shows it is on screen,
 * and again whenever the caller knows it moved on.
 */
export function useDesignLibrary(api, active = true) {
  const [groups, setGroups] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.designLibrary();
      setGroups(data.groups || []);
    } catch {
      // Keep what was there: the library is a view, not something to lose.
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  return { groups, loaded, refresh };
}
