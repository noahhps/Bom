import { useCallback, useEffect, useState } from "react";

/**
 * The agents a conversation can be run as. Server-owned; this mirrors it.
 *
 * An agent is a name, a persona, and an optional subset of the skills. Which
 * conversation is assigned to which lives on the sessions themselves (their
 * `agent_id`), so this hook holds only the agents and never has to stay in step
 * with the conversation list.
 */
export function useAgents(api) {
  const [agents, setAgents] = useState([]);
  // The ready-made agents, as the server ships them. Read here rather than on
  // the Agents page because a room and a card both need them: an agent made
  // before looks existed borrows its look and tagline from the preset it is
  // named after (lib/accessories.js).
  const [presets, setPresets] = useState([]);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listAgents();
      setAgents(data.agents || []);
      setError(null);
      return data.agents || [];
    } catch (problem) {
      setError(problem.message || String(problem));
      return [];
    }
  }, [api]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await api.listAgents();
        if (live) setAgents(data.agents || []);
      } catch (problem) {
        if (live) setError(problem.message || String(problem));
      }
    })();
    api
      .listAgentPresets()
      .then((data) => {
        if (live) setPresets(data.presets || []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  const create = useCallback(
    async (agent) => {
      const created = await api.createAgent(agent);
      await refresh();
      return created;
    },
    [api, refresh],
  );

  const update = useCallback(
    async (id, patch) => {
      const updated = await api.updateAgent(id, patch);
      await refresh();
      return updated;
    },
    [api, refresh],
  );

  // The conversations survive -- the column is ON DELETE SET NULL, so they
  // fall back to the default assistant. The caller still refreshes the session
  // list, since their `agent_id` changed underneath it.
  const remove = useCallback(
    async (id) => {
      await api.deleteAgent(id);
      await refresh();
    },
    [api, refresh],
  );

  return { agents, presets, error, refresh, create, update, remove };
}
