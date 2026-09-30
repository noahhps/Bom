/* What an agent's flower can wear.
 *
 * Two slots, chosen together and stored together as the agent's `look`: a hat
 * on its head and one item on or beside its face. The ids are what the server
 * stores (validated there for shape only), so renaming one here orphans every
 * agent wearing it -- add, do not rename. The drawings live in
 * components/AgentAvatar.jsx; this is the catalogue the pickers read.
 *
 * The presets (server/app/agent_presets.py) each come with a look that says
 * what they are for at a glance: a researcher's explorer helmet and magnifying
 * glass, a coder's beanie and headphones. */

export const HATS = [
  { id: "explorer", label: "Explorer" },
  { id: "beanie", label: "Beanie" },
  { id: "beret", label: "Beret" },
  { id: "hardhat", label: "Hard hat" },
  { id: "gradcap", label: "Mortarboard" },
  { id: "bucket", label: "Bucket hat" },
  { id: "tophat", label: "Top hat" },
  { id: "party", label: "Party hat" },
  { id: "crown", label: "Crown" },
];

export const ITEMS = [
  { id: "magnifier", label: "Magnifying glass" },
  { id: "headphones", label: "Headphones" },
  { id: "pencil", label: "Pencil" },
  { id: "clipboard", label: "Clipboard" },
  { id: "glasses_round", label: "Round glasses" },
  { id: "glasses_square", label: "Square glasses" },
  { id: "monocle", label: "Monocle" },
  { id: "paintbrush", label: "Paintbrush" },
  { id: "bowtie", label: "Bow tie" },
];

/* The look an agent made before looks existed should still say what it is:
 * one named like a preset wears that preset's look until someone chooses
 * otherwise. Only a fallback for a stored null -- a chosen look, even a bare
 * one saved as `{}`, is never second-guessed. */
export function lookOf(agent, presets = []) {
  if (!agent) return null;
  if (agent.look) return agent.look;
  const name = (agent.name || "").trim().toLowerCase();
  const match = presets.find(
    (preset) => preset.id === name || (preset.name || "").toLowerCase() === name,
  );
  return match?.look || null;
}

/* The line under an agent's name: the preset's tagline for one made from a
 * preset, otherwise the first sentence of its instructions. */
export function taglineOf(agent, presets = []) {
  if (!agent) return "";
  const name = (agent.name || "").trim().toLowerCase();
  const match = presets.find(
    (preset) => preset.id === name || (preset.name || "").toLowerCase() === name,
  );
  if (match?.tagline && (!agent.instructions || agent.instructions === match.instructions)) {
    return match.tagline;
  }
  const text = (agent.instructions || "").trim();
  if (!text) return "Bom, with nothing added.";
  const first = text.match(/^[^.!?]*[.!?]/);
  const line = first ? first[0] : text;
  return line.length > 90 ? `${line.slice(0, 87).trimEnd()}…` : line;
}
