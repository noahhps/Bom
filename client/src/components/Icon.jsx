// The glyphs the shell uses, as one component.
//
// Two kinds, deliberately. Most are inline stroked paths: stroke, width and
// cap are styled once in CSS for every `svg`, so a path is all any of them
// needs. The rest are file-backed silhouettes in public/, listed in FILES,
// which take precedence over an inline path of the same name.
//
// A file-backed glyph is drawn as a mask over `currentColor`, not as an image.
// The artwork is filled rather than stroked and carries its own fill colour --
// masking throws that colour away and keeps only the shape, so a file icon
// inherits the row's colour exactly like a stroked one does, in either theme.
const PATHS = {
  menu: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  send: "M5 12h14M13 6l6 6-6 6",
  // The square everything uses for stop. Stroked like its neighbours rather
  // than filled, so it sits at the same visual weight as the arrow it
  // replaces -- a solid block in the same circle reads as much heavier.
  stop: "M8 8h8v8H8z",
  // Sliders rather than a cog. A cog is the convention, but its teeth are a
  // dozen tiny strokes that turn to mush at the 18px these are drawn at --
  // and this set is hairlines and round caps, which a gear fights. Two rails
  // with a knob each says "the things you can set" at any size.
  //
  // The knobs are circles written as two half-arcs, which is how a closed
  // circle is expressed inside a single `d`. They sit on the rails rather
  // than breaking them: the stroke passes behind, which is what a real slider
  // looks like.
  settings:
    "M4 8h16M4 16h16" +
    "M10.5 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8" +
    "M15 13.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8",
  check: "M5 12.5l5 5 9-11",
  // A page with a turned corner and two lines of text: the canvas, the
  // document that lives beside the conversation. Stroked like its neighbours.
  document: "M7 3h8l4 4v14H7zM15 3v4h4M10 13h6M10 17h6",
  // Two figures, one behind the other: a team of agents rather than the single
  // person the `memory` file glyph draws. One full person, one half-seen past
  // its shoulder, so it reads as "more than one" at rail size.
  agents:
    "M9 11a3 3 0 100-6 3 3 0 000 6M3.5 19a5.5 5.5 0 0111 0" +
    "M16 5.3a3 3 0 010 5.4M17 13.2a5.5 5.5 0 013.5 5.1",
  // The glyphs an agent can wear, so a team of them reads at a glance. Stroked
  // hairlines like the rest of the set; the picker in the Agents editor offers
  // these by name.
  search: "M10 4a6 6 0 100 12 6 6 0 000-12M20 20l-4.3-4.3",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  pen: "M4 20l1-4L15 6l3 3L8 19l-4 1M13 8l3 3",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  chart: "M4 20V4M4 20h16M8 20v-6M13 20v-9M18 20v-4",
  spark: "M12 3c.6 3.9 2.1 5.4 6 6-3.9.6-5.4 2.1-6 6-.6-3.9-2.1-5.4-6-6 3.9-.6 5.4-2.1 6-6z",
  compass: "M12 3a9 9 0 100 18 9 9 0 000-18M15 9l-2 4-4 2 2-4z",
  bolt: "M13 3L5 13h6l-1 8 8-11h-6z",
  // A canvas with one trail of paint zig-zagging across it.
  //
  // Every run is exactly 45 degrees -- (4,-4), (3.5,3.5), (3.5,-3.5) -- and
  // each turn is a quadratic that eats 2px of the run either side of the
  // corner, which is what makes the trail read as painted rather than
  // plotted. The rounding is close to its limit: much past 2px the straight
  // runs disappear into each other and the whole thing flattens into a sine
  // wave, losing the 45 degrees that make it a zig-zag.
  //
  // Two other shapes were tried and are worse at 18px. A wave along a
  // diagonal axis is a letter S, whatever its amplitude. A sharp-cornered
  // zig-zag is a chart line. The swing is kept to y 10-14 so that, with a
  // 1.6px stroke, neither the peaks nor the ends touch the frame.
  canvas:
    "M5.5 4.5h13a2 2 0 012 2v11a2 2 0 01-2 2h-13a2 2 0 01-2-2v-11a2 2 0 012-2z" +
    "M6.5 14L9.09 11.41Q10.5 10 11.91 11.41" +
    "L12.59 12.09Q14 13.5 15.41 12.09L17.5 10",
  // A down chevron for a disclosure. Rotated in CSS to point right when its
  // section is folded shut.
  chevron: "M6 9l6 6 6-6",
  // A drawing pin, seen side on: head, shaft, point. `pinned` is the same
  // object driven home -- shorter shaft, so the state reads at 15px.
  pin: "M9 4h6M12 4v7M8.5 11h7l1.5 4H7l1.5-4M12 15v5",
  pinned: "M8.5 4h7M12 4v5M7.5 9h9l2 5H5.5l2-5M12 14v6",
  // Paperclip. Superseded by public/attachments.svg -- kept as the fallback
  // for a build where that file is missing.
  attachment:
    "M21 11.5l-8.6 8.6a5 5 0 01-7-7l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.3-2.3l7.9-7.9",
  // A head in profile with a thought inside it -- reasoning, not a lightbulb.
  thinking:
    "M15.5 20.5v-2.2a6.5 6.5 0 10-7-10.6M6 13.5H4l2-3.6M9 20.5v-3.2M5 17.5l-2 3M12 11.5h.01M15 11.5h.01M9 11.5h.01",
};

// Served from public/ at the site root, so these are absolute paths and not
// imports: Vite copies public/ verbatim and never fingerprints it, which is
// what lets the service worker cache them by a name that does not move.
const FILES = {
  attachment: "/attachments.svg",
  calendar: "/calendar.svg",
  // A real pair: solid against hollow, which still reads at 14px, so a fold
  // can say which way it is facing without needing a second colour.
  chat_bubble: "/chat_bubble.svg",
  chat_bubble_outline: "/chat_bubble_outline.svg",
  // Not a pair, despite the names -- both are closed folders differing only by
  // the tab line inside, which is invisible at the size the rail uses them.
  // `folder` is the one in use; `folder_open` is registered so it is there if
  // it ever gets drawn open.
  folder: "/folder.svg",
  folder_open: "/folder_open.svg",
  // Drawn to match the others: Material's filled 24x24 silhouettes, one
  // path, no stroke. The mask discards their fill colour anyway, so the
  // #323232 in the files is only there to keep them legible on their own.
  //
  // A person, not a memory chip. The first version of this was Material's
  // `memory` glyph -- a RAM module -- which names the wrong thing entirely:
  // this page is what the assistant remembers *about you*, not how much
  // silicon it has.
  memory: "/memory.svg",
  skills: "/skills.svg",
  // The rail's Tools destination has been asking for this by name since it was
  // added; the file was in public/ and never registered here, so `Icon` fell
  // through to the inline branch and drew a path of `undefined` -- an empty
  // 24x24 box, which reads as a missing icon rather than as a bug.
  tools: "/tools.svg",
  // Which MCP server a tool came from. These are the fallback now rather than
  // the rule: an MCP server wears its own logo where one can be fetched (see
  // ServiceIcon), because a list of fourteen services is read as brands and a
  // wall of identical silhouettes is the slowest way to find one. These stay
  // for the handful whose sites offer no icon, and for the small inline tags
  // where a Material glyph still sits better than a logo would.
  mail: "/mail.svg",
  design: "/design.svg",
  apps: "/apps.svg",
  device_hub: "/device_hub.svg",
};

export function Icon({ name, badge }) {
  const file = FILES[name];
  const glyph = file ? (
    // The image is set as `mask-image` itself rather than handed to the
    // stylesheet through a custom property.
    //
    // It used to be `style={{ "--mask": ... }}` against a `mask: var(--mask)`
    // rule, which quietly tied every icon in the app to every custom property
    // above it. Writing one on :root -- which the composer does as the pointer
    // moves, to publish how much of itself is on screen -- invalidates
    // inherited custom properties for the whole document, so each of these had
    // its mask re-resolved on every mouse move. A mask is a paint property
    // holding an image, and re-resolving a few dozen of them per frame is what
    // made the icons flicker whenever anything moved.
    //
    // Set directly it is an ordinary declared value with no var() in it, so a
    // custom property changing anywhere cannot touch it.
    <span
      className="icon-mask"
      style={{ WebkitMaskImage: `url("${file}")`, maskImage: `url("${file}")` }}
      aria-hidden="true"
    />
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );

  if (!badge) return glyph;

  // A second glyph tucked into the bottom-right corner, inside the icon's own
  // box rather than hanging off it. It sits on a patch of the page background
  // so it stays legible over whatever the artwork underneath is doing.
  return (
    <span className="icon-stack" aria-hidden="true">
      {glyph}
      <svg className="icon-badge" viewBox="0 0 24 24">
        <path d={PATHS[badge]} />
      </svg>
    </span>
  );
}
