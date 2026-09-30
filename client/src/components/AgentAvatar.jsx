import { AgentFlower } from "./AgentFlower";

/* An agent, drawn: the app's flower with its accessories on.
 *
 * The flower is the same one beside every answer and at the head of the rail
 * -- an agent is Bom, specialised, so it looks like Bom dressed for the job
 * rather than like a different character. What it wears is one SVG laid over
 * the flower in the logo's own coordinates (bom-logo.svg): the flower spans
 * -13.5..13.5, the face is a circle of radius 5.68 at the centre, and the eyes
 * sit at x = ±2.11. The overlay overflows its box, so a tall hat or a held
 * magnifying glass can reach past the petals the way a real one would.
 *
 * Decorative, like the flower: the agent's name is always beside it. */

const INK = "#23232b";

const HATS = {
  explorer: (
    <g>
      <path d="M-5.6 -4.6 C-5.6 -11.8 5.6 -11.8 5.6 -4.6 Z" fill="#dcc38d" />
      <rect x="-5.6" y="-6.3" width="11.2" height="1.6" fill="#8a6a3c" />
      <ellipse cx="0" cy="-4.5" rx="8.4" ry="1.5" fill="#c4a771" />
      <circle cx="0" cy="-11.1" r="0.8" fill="#c4a771" />
    </g>
  ),
  beanie: (
    <g>
      <path d="M-5.9 -3.9 C-5.9 -12 5.9 -12 5.9 -3.9 Z" fill="#3b4a6b" />
      <path d="M-2 -10.6 L-2.4 -5.4 M2 -10.6 L2.4 -5.4" stroke="#4a5b80" strokeWidth="0.7" />
      <rect x="-6.4" y="-5.5" width="12.8" height="2.7" rx="1.35" fill="#2b3752" />
      <circle cx="0" cy="-11.7" r="1.9" fill="#f2c94c" />
    </g>
  ),
  beret: (
    <g transform="rotate(-12 0.6 -6.4)">
      <rect x="0.1" y="-10.4" width="1" height="1.9" rx="0.5" fill="#2b2d38" />
      <ellipse cx="0.6" cy="-6.6" rx="6.9" ry="2.8" fill="#2b2d38" />
      <ellipse cx="0.3" cy="-5.2" rx="5.5" ry="0.9" fill="#1b1d25" />
    </g>
  ),
  hardhat: (
    <g>
      <path d="M-5.8 -4.8 C-5.8 -12.2 5.8 -12.2 5.8 -4.8 Z" fill="#f2c94c" />
      <rect x="-0.9" y="-11.6" width="1.8" height="6.8" rx="0.9" fill="#e0ae2e" />
      <rect x="-7.8" y="-5.7" width="15.6" height="1.9" rx="0.95" fill="#e0ae2e" />
    </g>
  ),
  gradcap: (
    <g>
      <path d="M-4.6 -5.1 L-4.6 -8 L4.6 -8 L4.6 -5.1 C2.5 -4.2 -2.5 -4.2 -4.6 -5.1 Z" fill={INK} />
      <polygon points="0,-11.6 8.6,-8.8 0,-6 -8.6,-8.8" fill="#2f323e" />
      <path d="M0 -8.8 L6.2 -8.8 L6.2 -4.2" stroke="#f2c94c" strokeWidth="0.5" fill="none" />
      <rect x="5.5" y="-4.6" width="1.4" height="2.5" rx="0.5" fill="#f2c94c" />
      <circle cx="0" cy="-8.8" r="0.7" fill="#f2c94c" />
    </g>
  ),
  bucket: (
    <g>
      <path d="M-4.6 -5 L-3.8 -10.8 C-1.5 -11.9 1.5 -11.9 3.8 -10.8 L4.6 -5 Z" fill="#2fb8a6" />
      <circle cx="-1.6" cy="-8.8" r="0.7" fill="#f2c94c" />
      <circle cx="1.9" cy="-7.4" r="0.55" fill="#e564a8" />
      <circle cx="0.4" cy="-10" r="0.45" fill="#ffffff" />
      <ellipse cx="0" cy="-4.8" rx="7.4" ry="1.7" fill="#23947f" />
    </g>
  ),
  tophat: (
    <g>
      <ellipse cx="0" cy="-5" rx="7.2" ry="1.4" fill={INK} />
      <rect x="-4.2" y="-13.4" width="8.4" height="8.6" rx="0.9" fill="#2f323e" />
      <rect x="-4.2" y="-7.5" width="8.4" height="1.7" fill="#ef5b5b" />
      <ellipse cx="0" cy="-13.4" rx="4.2" ry="0.9" fill="#3d4150" />
    </g>
  ),
  party: (
    <g>
      <polygon points="0,-14.2 -4.4,-4.6 4.4,-4.6" fill="#8b6ce0" />
      <path d="M-2.3 -9.4 L2.3 -9.4 L3.2 -7.3 L-3.2 -7.3 Z" fill="#f2c94c" />
      <ellipse cx="0" cy="-4.6" rx="4.4" ry="0.7" fill="#6f53c4" />
      <circle cx="0" cy="-14.2" r="1.4" fill="#f2c94c" />
    </g>
  ),
  crown: (
    <g>
      <polygon points="-5.4,-5 -5.9,-11.2 -2.9,-8.2 0,-12.2 2.9,-8.2 5.9,-11.2 5.4,-5" fill="#f2c94c" />
      <rect x="-5.4" y="-6.5" width="10.8" height="1.6" fill="#e0ae2e" />
      <circle cx="0" cy="-9.2" r="0.8" fill="#ef5b5b" />
      <circle cx="-5.9" cy="-11.2" r="0.6" fill="#f2c94c" />
      <circle cx="5.9" cy="-11.2" r="0.6" fill="#f2c94c" />
      <circle cx="0" cy="-12.2" r="0.6" fill="#f2c94c" />
    </g>
  ),
};

const LENS = "rgba(255, 255, 255, 0.28)";

const ITEMS = {
  glasses_round: (
    <g stroke={INK} strokeWidth="0.55" fill={LENS}>
      <circle cx="-2.3" cy="0" r="1.95" />
      <circle cx="2.3" cy="0" r="1.95" />
      <path d="M-0.35 -0.3 Q0 -0.8 0.35 -0.3 M-4.25 -0.2 L-5.5 -0.8 M4.25 -0.2 L5.5 -0.8" fill="none" />
    </g>
  ),
  glasses_square: (
    <g stroke={INK} strokeWidth="0.6" fill={LENS}>
      <rect x="-4.35" y="-1.7" width="3.9" height="3.4" rx="0.7" />
      <rect x="0.45" y="-1.7" width="3.9" height="3.4" rx="0.7" />
      <path d="M-0.45 -0.4 L0.45 -0.4 M-4.35 -0.6 L-5.5 -1.1 M4.35 -0.6 L5.5 -1.1" fill="none" />
    </g>
  ),
  monocle: (
    <g>
      <circle cx="2.2" cy="0" r="2.3" stroke="#c9a24a" strokeWidth="0.6" fill={LENS} />
      <path d="M4.2 1.2 Q5.6 5 3.1 7.6" stroke="#c9a24a" strokeWidth="0.35" fill="none" />
    </g>
  ),
  headphones: (
    <g>
      <path d="M-6.5 0.4 C-6.5 -9.6 6.5 -9.6 6.5 0.4" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
      <rect x="-8.2" y="-1.9" width="2.7" height="4.5" rx="1.25" fill="#2fb8a6" />
      <rect x="5.5" y="-1.9" width="2.7" height="4.5" rx="1.25" fill="#2fb8a6" />
    </g>
  ),
  // Behind the left ear: on the right it lay across the buttercup petal,
  // yellow on yellow, and vanished.
  pencil: (
    <g transform="translate(-6.5 -2.4) rotate(-38)">
      <rect x="-0.75" y="-5.2" width="1.5" height="1.2" rx="0.3" fill="#e564a8" />
      <rect x="-0.75" y="-4.1" width="1.5" height="0.5" fill="#b8b8c2" />
      <rect x="-0.75" y="-3.6" width="1.5" height="6.6" fill="#f2c94c" />
      <polygon points="-0.75,3 0.75,3 0,4.9" fill="#f3d9a4" />
      <polygon points="-0.25,4.2 0.25,4.2 0,4.9" fill={INK} />
    </g>
  ),
  magnifier: (
    <g>
      <path d="M6.9 6.9 L10.3 10.3" stroke="#8a6a3c" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5.1" cy="5.1" r="2.6" stroke={INK} strokeWidth="0.8" fill="rgba(200, 228, 255, 0.5)" />
      <path d="M3.9 4.1 Q4.4 3.4 5.2 3.3" stroke="#ffffff" strokeWidth="0.45" fill="none" strokeLinecap="round" />
    </g>
  ),
  clipboard: (
    <g transform="translate(7.4 5.6) rotate(12)">
      <rect x="-2.6" y="-3.3" width="5.2" height="6.6" rx="0.6" fill="#b8865a" />
      <rect x="-2" y="-2.4" width="4" height="5.3" rx="0.3" fill="#ffffff" />
      <rect x="-1.1" y="-3.8" width="2.2" height="1.1" rx="0.4" fill="#9aa0ac" />
      <rect x="-1.4" y="-1.3" width="2.8" height="0.45" rx="0.2" fill="#c9ced7" />
      <rect x="-1.4" y="-0.1" width="2.8" height="0.45" rx="0.2" fill="#c9ced7" />
      <rect x="-1.4" y="1.1" width="1.9" height="0.45" rx="0.2" fill="#c9ced7" />
    </g>
  ),
  paintbrush: (
    <g transform="translate(7 5.4) rotate(-35)">
      <rect x="-0.6" y="-0.9" width="1.2" height="6.4" rx="0.6" fill="#8a6a3c" />
      <rect x="-0.7" y="-2.2" width="1.4" height="1.4" fill="#b8b8c2" />
      <path d="M-0.9 -2.2 C-0.9 -4.5 0 -5.6 0 -5.6 C0 -5.6 0.9 -4.5 0.9 -2.2 Z" fill="#e564a8" />
    </g>
  ),
  bowtie: (
    <g transform="translate(0 6.7)">
      <polygon points="-0.8,0 -3.6,-1.7 -3.6,1.7" fill="#ef5b5b" />
      <polygon points="0.8,0 3.6,-1.7 3.6,1.7" fill="#ef5b5b" />
      <rect x="-0.9" y="-0.9" width="1.8" height="1.8" rx="0.5" fill="#c94747" />
    </g>
  ),
};

/* Just the accessories, for a flower drawn somewhere else -- the one beside
 * an answer, which is positioned by the thread's own rules. The caller places
 * this box over the flower's span; the drawing fills it. */
export function AgentWear({ look, className }) {
  const hat = look?.hat ? HATS[look.hat] : null;
  const item = look?.item ? ITEMS[look.item] : null;
  if (!hat && !item) return null;
  return (
    <svg className={className ? `agent-avatar-wear ${className}` : "agent-avatar-wear"} viewBox="-13.5 -13.5 27 27" aria-hidden="true">
      {hat}
      {item}
    </svg>
  );
}

/**
 * `look` is `{ hat, item }` (either may be missing, or the whole thing null
 * for a bare flower). `blooming` keeps the flower blooming -- for an agent
 * that is answering right now -- and it blooms on hover regardless.
 */
export function AgentAvatar({ look, size = 40, blooming = false, className }) {
  const hat = look?.hat ? HATS[look.hat] : null;
  const item = look?.item ? ITEMS[look.item] : null;
  return (
    <span
      className={className ? `agent-avatar ${className}` : "agent-avatar"}
      style={{ "--avatar": `${size}px` }}
      aria-hidden="true"
    >
      <AgentFlower open mark size={size} blooming={blooming} />
      {hat || item ? (
        <svg className="agent-avatar-wear" viewBox="-13.5 -13.5 27 27">
          {hat}
          {item}
        </svg>
      ) : null}
    </span>
  );
}
