# UI / UX consistency

Bom's client is six surfaces — the chat thread, QuickView, the four
management screens (Settings, Memory, Skills, Projects), the sidebar, and the
token gate — drawn over one stylesheet and one token set. Most of it already
reads as one product. This document is about the places where it does not, why
they drifted, and the order in which they are worth fixing.

It is written after a pass that read every screen against `client/src/styles.css`
and its history. The `.ui-revert/` directory at the repo root is the clearest
evidence of how the drift happened: it preserves a chain of past restyles —
`yiqi-paper`, `bloom`, `deepseek-restyle`, `kimi-restyle`, `1c-blueprint` —
each layered over the last without the previous one being fully removed. The
current stylesheet carries sediment from several of them at once.

Read `../README.md` for what the client is and how it is served.

---

## The one-line diagnosis

There is not one design system in `:root` — there are two, and neither won.
A flat, near-square, single-shadow, cobalt system (drawn from the `1c` /
`bloom` boards) sits underneath a bolted-on **Liquid Glass** palette
(translucent surfaces, blur, rounded, glowing). The management screens follow
the first. The composer, the gate, and QuickView follow pieces of the second.
Everything else is a value that belongs to one system living on a surface built
for the other.

Unifying the UI is mostly one decision — *pick one* — followed by deleting
every value that contradicts it.

---

## What already holds the app together

These are working and should be protected, not touched:

- **One token set.** Every surface pulls from `:root` custom properties: the
  `--t-*` type scale (seven sizes, deliberately collapsed from ~19), three
  tracking values, the `--line-*` hairlines.
- **One typeface.** `DM Mono` everywhere, via `--font-mono`. This was a real
  unification — the app used to run a grotesque for prose and mono for labels.
- **Three type roles.** `.mi` (tracked-out uppercase machine label), `.h`
  (heading), `.p` (prose), used consistently across the management screens.
- **A shared control vocabulary.** `.btn` / `.btnp` / `.chip` / `.switch` /
  `.sur` / `.icon-btn`, reused rather than reinvented per screen.
- **The `.page-head` scaffold.** The tinted banner with decorative soft circles
  (`.sw`) and `.mi` lane dividers is the through-line binding Settings, Memory,
  Skills, and Projects into one family.
- **The accent engine.** `lib/theme.js` rewrites `--accent` per chat, per
  project, then app-wide, and every surface — the sidebar wash, the composer
  glow, project beads, page tints — derives from it without knowing about it.
  This is the most elegant unifier in the codebase and the model the rest of
  the system should aspire to: one decision, applied everywhere, automatically.

---

## Findings

Ordered roughly by how much they fracture the product, not by effort.

### 1. Two design languages in `:root`

The Liquid Glass palette renamed the five surface tokens with a `-base` suffix
and left the ~3,000 lines below it asking for the old names. An unresolved
`var()` computes to `transparent`, so at one point `body`, `.screen`,
`.topbar`, and `.composer-box` all stopped painting. It is currently held
together by an alias layer (`--surface: var(--surface-base)`) and `!important`.
The `--glass-*` tokens (lines ~19–25) are now dead — nothing references them.

**Remedy:** choose the flat-cobalt system as canonical (it already governs four
of six surfaces), demote glass to a single named treatment used only where a
native material genuinely sits behind the window, collapse the `-base` alias
layer so each surface is named once, and delete the dead `--glass-*` tokens.

### 2. Radius drift

The system states its own rule plainly: *"Rounding is not part of its
vocabulary… all four radii collapse and all of them are nearly square (3px)."*
In practice the surfaces a user actually touches ignore it — the composer is
`16px`, the gate inputs `14px`, QuickView `18px`. The near-square identity holds
on structural cards and breaks on every primary input.

**Remedy:** two radii, not four-plus. `--r-card: 3px` for structural surfaces,
one `--r-control` (propose `10px`) for inputs and the composer. Point the
composer, gate, and QuickView at `--r-control`. The rounded composer is a
defensible affordance; `14`/`16`/`18` doing the same job three ways is not.

### 3. Shadow policy contradicts itself

Stated rule: *"The only shadow in the system is under a floating card."* In
practice the composer carries a shadow **and** an accent glow, the gate card a
heavy drop shadow, structural cards nothing, and the sidebar had its shadows
removed. There is no single answer to "does this surface float".

**Remedy:** write the rule once and enforce it. Flat structural surfaces
(`.sur`, `.page-head`, cards) = hairline border, no shadow. Floating transient
surfaces (composer, popovers, gate card, menus) = one shared `--elevation-float`
token. Make the composer's glow a named `--glow-accent` token reused by any
focused floating surface, so it is a system property rather than a one-off.

### 4. QuickView is effectively a second product

QuickView (`client/src/quickview.jsx`, `quickview.css`) is a separate entry
point with a **duplicated** font token (`--qv-mono` is `--font-mono` written
out again), an **inverted** colour scheme (dark-on-glass vs. the main app's
dark-on-white), a **different accent blue** (`#4d7dfa` vs. the app's `#1f4fd8`),
a different radius, and a **re-implemented** Composer, Turn renderer, and
attachment components. It even renders messages by a different paradigm — a
fade-in "decode" reveal with no markdown — where the main thread uses a
margin-rule-plus-markdown layout. Same conversation concept, two visual worlds
and two codebases.

**Remedy:** keep QuickView's *identity* (a dark Spotlight-style overlay is a
legitimate difference) but drive it from the shared tokens via a
`[data-surface="quickview"]` scope that overrides ink/ground only — not a
duplicated palette and font. Then either (4a, preferred) extract a shared
`Turn` / composer used by both surfaces, parameterised by density and reveal
style, or (4b, cheaper) leave the logic separate but make QuickView consume the
same tokens, type roles, radius, and spacing so it reads as the dark-mode
sibling rather than a fork.

### 5. Two message renderers

Related to (4), but worth calling out on its own: `components/Message.jsx` and
QuickView's `Turn`/`FadingText` are independent implementations of the same
thing, including duplicate attachment/file components (`Attachments.jsx` vs the
re-implemented `FileGroup`/`TurnFiles`). Any change to how a turn looks has to
be made twice, and has not been.

**Remedy:** the shared renderer from 4a. This is the one genuinely structural
engineering item here and can be deferred behind the token work.

### 6. The product names itself two things

The sidebar wordmark and the token gate both say **"Assistant"**; QuickView
says **"Bom"**; the empty chat says **"What are we working on?"**. No screen
agrees on the product's name.

**Remedy:** one name — **Bom** — everywhere. `components/NavRail.jsx` and
`components/TokenGate.jsx` are the two that say "Assistant".

### 7. Voice drifts by screen

Memory speaks warm first-person ("What I remember", "I worked it out").
Settings, Projects, and Skills are neutral-institutional ("This device",
"Folders for conversations"). QuickView is terse-imperative ("Ask me. Task
me."). Three personalities, none of them chosen against the others.

**Remedy:** pick a register per role and make it intentional. Proposed: warm
first-person for content the assistant owns (memory, empty states), neutral for
device/configuration screens. Do a copy pass so the split is deliberate rather
than accidental.

### 8. Heading weight is inconsistent at one size

`.h` (page heads) is `700`; the top-bar title and the gate `<h1>` are `400` —
both at `--t-xl`. A heading reads as a different product depending on which
screen it is on.

**Remedy:** state the rule and apply it. Proposed: display headings (page heads,
openers) `700`; in-context titles (top bar, thread) `400`. Both are defensible;
being unstated is not.

### 9. The four-tint palette is a fiction

`--violet`, `--blue`, `--send`, and `--accent` all resolve to the same
`#1f4fd8`. The names survive so downstream rules do not break, but the palette
the comments describe (ambient violet vs. actionable cobalt) does not exist in
the values.

**Remedy:** either restore a real second tint or reduce to `--accent` plus one
`--accent-ambient` and update the handful of consumers. The design's own note
says it "runs on one accent", so the reduction is the honest option.

---

## Already fixed on this branch

- **The transparent sidebar is gone.** The rail was a pane of glass: the window
  painted nothing so the desktop's native material showed through it, coloured
  only by a faint accent wash, with per-state glass gradients, `backdrop-filter`,
  and inset rim lights. It is now a single solid surface (`--sidebar`) in every
  state — unpinned overlay, pinned column, fullscreen — divided from the white
  sheet by one hairline. The accent tint remains, reverted from its glass-era
  `×2.6` strength to the normal subtle wash. See the "the sidebar, a solid
  surface" block in `client/src/styles.css`.

- **The mark is now "the agent's flower", drawn crisp.** The old brush-stroke
  `bom-mark.png` (a 161×512 raster that blurred when scaled) has been
  replaced across the app by `components/AgentFlower.jsx`: an eight-petal flower
  with a face, built from the accent tokens so it re-themes with the
  conversation, animated as a bud that blooms while a turn is streaming and
  folds back up after. Its static open form, `client/public/bom-flower.svg`,
  is the source for the app and platform icons. This is a real win against
  findings 1 and 9 — the mark is now vector and token-driven rather than a
  fixed raster.

  The flower was rendering **blurry** because `AgentFlower` was drawn at a 22px
  base and enlarged with `transform: scale()` (1.75× beside answers, up to 2.5×
  for the greeting logo); its perpetually-rotating petal ring is a composited
  layer, so the small raster was being stretched. It is now sized natively —
  the geometry is in `em` and the logo and per-answer instances raise
  `font-size` instead of scaling the box — so it is sharp at every size. This is
  *not* the naming fix in (6): the wordmark beside it still says "Assistant".

---

## Recommended order of work

The safe, mostly-mechanical items are independently shippable and change no
behaviour. The one real engineering decision (the shared renderer) sits at the
end and can wait.

| Phase | Work | Risk | Visible change |
|------|------|------|----------------|
| 0 | Decide the forks: canonical language, QuickView token strategy, radius scale | — | — |
| 1 | Collapse the `-base` alias layer; delete dead `--glass-*`; reduce the four-tint fiction (9); add the radius scale (2) | Low | none |
| 2 | One product name (6); heading-weight rule (8); voice pass (7) | Very low | small |
| 3 | Shadow / elevation policy (3) | Low | subtle |
| 4 | QuickView onto shared tokens (4b), then the shared renderer (4a / 5) | Med–High | moderate |
| 5 | Grep-audit for hard-coded hex, px radii, and font stacks that bypass tokens; delete `.ui-revert/`; write this doc's rules into a short `ui.md` the stylesheet header points at | Low | none |

Phases 1–3 and 5 are safe to do in one pass. Phase 4 is the only item that
needs a real decision and should not block the rest.

---

## The canonical rules, once decided

The point of the work above is to be able to state these in one place and have
the stylesheet obey them. A proposed starting set, for `:root` and a short
`ui.md`:

- **One accent.** `#1f4fd8`, driven by `lib/theme.js`. One ambient derivative,
  no parallel "four tints".
- **Two radii.** `--r-card: 3px` (structural), `--r-control: 10px` (inputs,
  composer).
- **One elevation.** Flat structural surfaces get a hairline and no shadow;
  floating transient surfaces get `--elevation-float`. Focus glow is
  `--glow-accent`, reused, not redrawn.
- **Type roles.** `.mi` / `.h` / `.p` as today. Display headings `700`,
  in-context titles `400`.
- **One typeface.** `--font-mono`, defined once and shared — including by
  QuickView, via a token scope rather than a duplicate.
- **One name.** Bom.
- **Voice.** Warm first-person for assistant-owned content; neutral for
  device/configuration screens.

Everything in the Findings section is a place where a value currently
contradicts one of these. Unifying the UI is making the values match the rules
and then keeping them matched.
