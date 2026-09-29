import { useCallback, useEffect, useState } from "react";

/**
 * The folders conversations can be filed into. Server-owned; this mirrors it.
 *
 * Deliberately thin. A project is a name, an id and a kind -- chat, design or
 * code -- and a code project the folder on disk it is. Everything that makes
 * one useful (which chats are in it) lives on the sessions themselves, so this
 * hook never has to stay in step with the conversation list.
 */
export function useProjects(api) {
  const [projects, setProjects] = useState([]);
  // Where a new code project's folder is made, as the server has it.
  const [projectsDir, setProjectsDir] = useState("");
  const [error, setError] = useState(null);

  const take = useCallback((data) => {
    setProjects(data.projects || []);
    setProjectsDir(data.projects_dir || "");
    return data.projects || [];
  }, []);

  const refresh = useCallback(async () => {
    try {
      const listed = take(await api.listProjects());
      setError(null);
      return listed;
    } catch (problem) {
      setError(problem.message || String(problem));
      return [];
    }
  }, [api, take]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await api.listProjects();
        if (live) take(data);
      } catch (problem) {
        if (live) setError(problem.message || String(problem));
      }
    })();
    return () => {
      live = false;
    };
  }, [api, take]);

  // A code project comes back with `root`, its folder, and `written`, the
  // files put in it -- the designs it was built from, when it was.
  const create = useCallback(
    async (name, kind = "chat", extra = {}) => {
      const project = await api.createProject(name, kind, extra);
      await refresh();
      return project;
    },
    [api, refresh],
  );

  const rename = useCallback(
    async (id, name) => {
      await api.renameProject(id, name);
      await refresh();
    },
    [api, refresh],
  );

  // The conversations survive -- the column is ON DELETE SET NULL, so they
  // come back as unfiled -- and a code project's folder is never touched. The
  // caller still has to refresh the session list, because their `project_id`
  // changed underneath it.
  const remove = useCallback(
    async (id) => {
      await api.deleteProject(id);
      await refresh();
    },
    [api, refresh],
  );

  return { projects, projectsDir, error, refresh, create, rename, remove };
}
