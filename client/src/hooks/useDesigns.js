import { useCallback, useEffect, useState } from "react";

/**
 * The design standards a result can be held to. Server-owned; this mirrors it.
 *
 * Two lists that are offered as one. The presets ship with the server and are
 * read-only — they are the same eight documents on every install, so they are
 * fetched once and never change under us. The reader's own are stored and
 * editable, and are what `create`/`update`/`remove` touch.
 *
 * Kept apart here rather than merged, because the page needs the difference:
 * you can fork a preset into your own, but you cannot save over it.
 */
export function useDesigns(api) {
  const [designs, setDesigns] = useState([]);
  const [presets, setPresets] = useState([]);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listDesigns();
      setDesigns(data.designs || []);
      setError(null);
      return data.designs || [];
    } catch (problem) {
      setError(problem.message || String(problem));
      return [];
    }
  }, [api]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [mine, shipped] = await Promise.all([
          api.listDesigns(),
          api.listDesignPresets(),
        ]);
        if (!live) return;
        setDesigns(mine.designs || []);
        setPresets(shipped.presets || []);
      } catch (problem) {
        if (live) setError(problem.message || String(problem));
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const create = useCallback(
    async (design) => {
      const created = await api.createDesign(design);
      await refresh();
      return created;
    },
    [api, refresh],
  );

  const update = useCallback(
    async (id, patch) => {
      const updated = await api.updateDesign(id, patch);
      await refresh();
      return updated;
    },
    [api, refresh],
  );

  // Nothing points at a design — it is copied into the window when it is
  // chosen, not referenced — so deleting one cannot orphan anything. A result
  // already written under it stays written under it.
  const remove = useCallback(
    async (id) => {
      await api.deleteDesign(id);
      await refresh();
    },
    [api, refresh],
  );

  return { designs, presets, error, refresh, create, update, remove };
}
