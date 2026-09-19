/* Patterns: whole screens, assembled only from instances. They are the
 * reference screenshots rebuilt, so the components can be checked against
 * the app at a glance. */

function setProps(inst, name, props) {
  const r = REG[name];
  const set = {};
  for (const [k, v] of Object.entries(props)) set[r.props[k] || k] = v;
  inst.setProperties(set);
}

function sceneFrame(name, w, h) {
  const scene = figma.createFrame();
  scene.name = name;
  scene.resize(w, h);
  scene.clipsContent = true;
  scene.fills = [];
  const wp = use("Utility/Wallpaper");
  scene.appendChild(wp);
  wp.resize(w, h);
  return scene;
}

function userRow(text) {
  const row = al("turn-user", "HORIZONTAL", { justify: "MAX" });
  row.appendChild(use("Message/User", {}, { Content: text }));
  return row;
}

async function chatWindow(page, o) {
  const scene = sceneFrame(o.name, 1300, 940);
  page.appendChild(scene);

  const win = figma.createFrame();
  win.name = "Window";
  win.resize(1180, 820);
  win.cornerRadius = 10;
  win.clipsContent = true;
  win.fills = [];
  await win.setEffectStyleIdAsync(ES["Elevation/Window"].id);
  scene.appendChild(win);
  win.x = 60;
  win.y = 70;
  const lights = use("Utility/Traffic lights");
  scene.appendChild(lights);
  lights.x = 72;
  lights.y = 46;

  const rail = use("NavRail");
  win.appendChild(rail);
  setMode(rail, o.railMode || "iris");
  if (o.session != null) {
    for (let i = 0; i < 5; i++) {
      const row = rail.findOne((n) => n.name === "session-" + i);
      if (row) row.setProperties({ State: i === o.session ? "Current" : "Default" });
    }
  }
  if (o.firstTitle) setProps(rail.findOne((n) => n.name === "session-0"), "Session row", { Title: o.firstTitle });

  const W = 928;
  const H = 820;
  const sheet = figma.createFrame();
  sheet.name = "Sheet";
  sheet.resize(W, H);
  sheet.fills = [paint("surface/sheet")];
  sheet.clipsContent = true;
  win.appendChild(sheet);
  sheet.x = 252;
  sheet.y = 0;
  sheet.appendChild(use("Utility/Grid"));
  sheet.appendChild(use("Aura/Sheet"));

  const composer = use("Composer", { Control: o.control || "Effort", State: o.busy ? "Busy" : "Idle" });
  if (o.sessionChip === false) setProps(composer, "Composer", { "Session chip": false });
  const boxH = composer.height;

  if (o.empty) {
    const top = 64 + (H - 64 - boxH) / 2;
    const head = use("Starters header");
    sheet.appendChild(head);
    head.x = (W - 780) / 2;
    head.y = top - 26 - head.height;
    const grid = al("starters", "VERTICAL", { gap: 10 });
    fixW(grid, 780);
    const starters = [
      ["Ask what I can do", "What skills do you have available, and when would each one be useful?"],
      ["Check a time zone", "What time is it in Tokyo right now, and how far ahead of me is that?"],
      ["Explain some code", "Explain what this code does, step by step, and point out anything that looks wrong:"],
      ["Think through a decision", "Help me think through a decision. I will describe the options and the constraints, and I want the trade-offs laid out rather than a recommendation up front."],
    ];
    for (let i = 0; i < 4; i += 2) {
      const row = al("row", "HORIZONTAL", { gap: 10 });
      add(grid, row, { fill: true });
      for (const [t, b] of starters.slice(i, i + 2)) add(row, use("Starter", {}, { Title: t, Body: b }), { grow: true });
    }
    sheet.appendChild(grid);
    grid.x = (W - 780) / 2;
    grid.y = top + boxH + 26;
    sheet.appendChild(composer);
    composer.x = (W - 780) / 2;
    composer.y = top;
  } else {
    const tucked = o.withdrawn ? 0.8 * boxH : 0;
    const peek = 16 + boxH + 26 - tucked;
    const messages = figma.createFrame();
    messages.name = "messages";
    messages.fills = [];
    messages.clipsContent = true;
    messages.resize(W, H - 65);
    sheet.appendChild(messages);
    messages.x = 0;
    messages.y = 65;

    const thread = al("thread", "VERTICAL", { gap: 26 });
    fixW(thread, 780);
    messages.appendChild(thread);
    add(thread, userRow(o.user), { fill: true });
    const answer = use("Message/Answer", {}, o.answer || {});
    add(thread, answer, { fill: true });
    if (o.decorate) await o.decorate(answer);
    thread.x = (W - 780) / 2;
    thread.y = Math.min(28, H - 65 - peek - 12 - thread.height);

    sheet.appendChild(composer);
    composer.x = (W - 780) / 2;
    composer.y = H - 26 - boxH + tucked;
  }

  const bar = use("Top bar", {}, { Title: o.title, "Can file": o.canFile !== false });
  sheet.appendChild(bar);

  setMode(win, o.mode);
  setMode(rail, o.railMode || "iris");
  return scene;
}

async function quickViewScene(page, name, turns) {
  const scene = sceneFrame(name, 860, 860);
  page.appendChild(scene);
  const W = 580;
  const H = 690;
  const win = figma.createFrame();
  win.name = "QuickView window";
  win.resize(W, H);
  win.cornerRadius = 14;
  win.clipsContent = true;
  win.fills = [
    {
      type: "GRADIENT_LINEAR",
      gradientTransform: [
        [0, 1, 0],
        [-1, 0, 1],
      ],
      gradientStops: [
        { position: 0, color: rgba("#ffffff", 0.5) },
        { position: 1, color: rgba("#ebe9f7", 0.42) },
      ],
    },
  ];
  win.strokes = [paint("border/glass")];
  win.strokeAlign = "INSIDE";
  await win.setEffectStyleIdAsync(ES["Glass/QuickView"].id);
  scene.appendChild(win);
  win.x = (860 - W) / 2;
  win.y = (860 - H) / 2;
  const lights = use("Utility/Traffic lights");
  win.appendChild(lights);
  lights.x = 14;
  lights.y = 12;

  const composer = use("QuickView/Composer", { State: "Empty" });
  const qvW = W - 28;
  composer.resize(qvW, composer.height);
  const qv = figma.createFrame();
  qv.name = "qv";
  qv.fills = [];
  qv.clipsContent = true;
  qv.cornerRadius = 18;
  win.appendChild(qv);
  qv.x = 14;

  if (!turns) {
    qv.resize(qvW, composer.height);
    qv.y = H - 14 - composer.height;
    qv.appendChild(composer);
    return scene;
  }

  const qvH = H - 30 - 14;
  qv.resize(qvW, qvH);
  qv.y = 30;
  const thread = al("qv-thread", "VERTICAL", { gap: 14 });
  fixW(thread, qvW - 36);
  qv.appendChild(thread);
  thread.x = 18;
  thread.y = 16;
  for (const [role, content] of turns) {
    const t = use("QuickView/Turn", { Role: role });
    const text = t.findOne((n) => n.type === "TEXT");
    text.characters = content;
    add(thread, t, { fill: true });
  }
  // Withdrawn: only the 36px lip stays on screen, at 0.82.
  qv.appendChild(composer);
  composer.x = 0;
  composer.y = qvH - 36;
  composer.opacity = 0.82;
  return scene;
}

async function buildPatterns(page) {
  const place = (scene, x, y) => {
    scene.x = x;
    scene.y = y;
  };
  const sec = figma.createSection();
  sec.name = "Patterns";
  page.appendChild(sec);
  const top = 180;

  const header = await docFrame("Patterns", "The reference screens, rebuilt from instances. Each window's Color mode is the conversation's accent; the rail's is the app-wide one.", [
    "Chat — thread: Teal, composer raised.",
    "Chat — long answer: Iris, composer withdrawn while reading.",
    "Chat — new conversation: Default (no accent), openers under a centred composer.",
    "Chat — waiting on approval: Fern, a skill asking to run, composer busy (Stop).",
    "QuickView: empty, and a conversation with the composer withdrawn to its lip.",
  ]);
  sec.appendChild(header);
  header.x = 48;
  header.y = 48;

  const a = await chatWindow(sec, {
    name: "Chat — thread",
    mode: "teal",
    title: "New conversation",
    user: "hello",
    answer: { Body: "Hello! How can I help you today?" },
    session: 0,
  });
  place(a, 480, top - 132);

  const longBody = [
    "No — I can't write or edit files on your computer directly. Here's the honest breakdown of what I can and can't do:",
    "",
    "What I can do:",
    "•  Read files from your folders (list directories and read text files to see your code)",
    "•  Search for files by name, and your past conversation history",
    "•  Control a web browser, for web-based editors like GitHub or online IDEs",
    "",
    "What I can't do:",
    "•  Modify, save, or delete files on your local machine",
    "•  Run your code or tests for you",
    "",
    "So I could open a code file, read it, and tell you exactly what to change — but the editing you'd have to do yourself.",
  ].join("\n");
  const b = await chatWindow(sec, {
    name: "Chat — long answer",
    mode: "iris",
    title: "Cannot Edit Your Local Code",
    user: "can you edit code on my computer?",
    answer: { Body: longBody },
    withdrawn: true,
    session: 1,
    firstTitle: "User says hello",
    decorate: async (answer) => {
      const body = answer.findOne((n) => n.name === "body" && n.type === "TEXT");
      if (!body) return;
      for (const phrase of ["What I can do:", "What I can't do:"]) {
        const at = body.characters.indexOf(phrase);
        if (at >= 0) body.setRangeFontName(at, at + phrase.length, { family: "DM Mono", style: "Medium" });
      }
      const it = "tell you exactly what to change";
      const at = body.characters.indexOf(it);
      if (at >= 0) body.setRangeFontName(at, at + it.length, { family: "DM Mono", style: "Italic" });
    },
  });
  place(b, 1860, top - 132);

  const c = await chatWindow(sec, {
    name: "Chat — new conversation",
    mode: "default",
    title: "New conversation",
    canFile: false,
    empty: true,
    session: 0,
  });
  place(c, 480, top + 900);

  const d = await chatWindow(sec, {
    name: "Chat — waiting on approval",
    mode: "fern",
    title: "What's In Documents",
    user: "what's in my Documents folder?",
    answer: { Reasoning: true, Approval: true, "Skill trace": true, "Show body": false },
    busy: true,
    session: 0,
    firstTitle: "What's In Documents",
    decorate: async (answer) => {
      const trace = answer.findOne((n) => n.name === "skill-trace");
      if (trace) trace.setProperties({ State: "Running" });
    },
  });
  place(d, 1860, top + 900);

  const e = await quickViewScene(sec, "QuickView — empty", null);
  place(e, 480, top + 1960);
  const f = await quickViewScene(sec, "QuickView — conversation", [
    ["User", "what's on my calendar tomorrow?"],
    ["Assistant", "Two things: the dentist at 9:30, and the design review at 2:00. Nothing after 4."],
    ["User", "move the review to 3"],
    ["Assistant", "Done — the design review is now 3:00–4:00 tomorrow."],
  ]);
  place(f, 1420, top + 1960);

  sec.resizeWithoutConstraints(3260, top + 1960 + 860 + 80);
  sec.x = 0;
  sec.y = nextY(page, sec.height);
}
