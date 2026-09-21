![alt text](https://github.com/noahhps/Courier/blob/main/image.png "dashboard UI Title Image")
# Courier

A harness designed to deliver a new paradigm of interactions with AI.


## Running it on the PC

The short way, once a model is pulled:

```bash
./run.sh
```

That checks the virtualenv and installs the server if it is missing, installs
and builds the client, reports whether Ollama is up and whether the configured
model is actually pulled, refuses to start if something already holds the port,
and then serves everything on :8080. `./run.sh --dev` additionally runs Vite on
:5173 with hot reload, and stops both on Ctrl+C. `--no-build`, `--port` and
`--model` are there too; `--help` lists them.

It deliberately does not start Ollama, which is a system service with its own
lifecycle -- guessing at that is how you end up running two of them.

The same steps by hand:


Do this on the machine with the GPU. Everything below assumes Windows with the
RTX 5070 Ti, but the commands are the same on macOS and Linux.

**1. Pull a model.**

```bash
ollama pull gpt-oss
```

**2. Build the client.** The UI is a React app; the server serves the build
output, not the source:

```bash
cd client && npm install && npm run build
```

**3. Install and start the server:**

```bash
python -m venv .venv && .venv/Scripts/pip install -e ./server
.venv/Scripts/python -m app
```

It prints the URL and the access token. The token is written to `data/token`
and reused across restarts, so you enter it on each device once.

If `client/dist` is missing the server still starts and says so — the API
works, there is just no UI at the root until you run the build.

**4. Keep Ollama private.** It must never be reachable from the network — the
API server is the only thing that talks to it. Confirm it is bound to loopback:

```bash
curl http://127.0.0.1:11434/api/tags   # works
```

Set `OLLAMA_HOST=127.0.0.1` if anything has changed it. Also set
`OLLAMA_KEEP_ALIVE=-1` so the model stays resident and you don't pay a cold
load on the first message of the day.

---

## Reaching it from the iPhone

Both devices have to be on the same network, and the server has to be listening
on an address the phone can dial.

**1. Find the PC's address on the LAN.** `ipconfig` on Windows, `ip addr` on
Linux — the `192.168.x.y` or `10.x.y.z` one. Give it a DHCP reservation in the
router if you don't want it moving.

**2. Bind to that address** rather than loopback:

```bash
BIND_HOST=192.168.1.50 .venv/Scripts/python -m app
```

`0.0.0.0` works too and listens on every interface, which is one fewer thing to
edit when the address changes and one more network you may not have meant to
serve — on a laptop that follows you around, it is whatever wifi you joined.

**3. Open it on the phone** at `http://192.168.1.50:8080` and enter the token
once.

**4. Install it to the home screen.** Safari → Share → *Add to Home Screen*. It
launches standalone, without browser chrome, and the service worker caches the
shell so it opens instantly. Conversation data is never cached — the server is
the source of truth, so a wiped phone loses nothing.

**5. Understand what is holding the door.** The bearer token is the only thing
in front of the API now: anything that can reach port 8080 gets as many guesses
as it likes. On a home LAN that is your own devices and whatever else is on the
wifi. Raise `TOKEN_LENGTH` if that set is larger than you'd like, and add a
firewall rule if only some machines should reach the port.

> **This is plain HTTP.** Requests cross the LAN in the clear, including the
> token. That is usually fine on a network you control and is not fine on one
> you don't — never expose this port to the internet as it stands. For a real
> certificate (and the padlock), put a reverse proxy such as
> Caddy in front of it and let that terminate TLS.

---

## Attachments

Files can be attached to a message. What happens to one depends on the only
thing that matters — what a model can do with it:

| | | |
|---|---|---|
| **Images** | PNG, JPEG, GIF, WebP | Sent as images, to a model that can see |
| **Documents** | PDF, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp` | Read for their text at upload |
| **Text and code** | `.txt`, `.md`, `.csv`, `.json`, `.py`, and the rest | Pasted into the prompt as-is |

Anything else is refused in the composer with a reason, rather than accepted
and quietly ignored later.

Files can be dropped anywhere on the window — the composer is what lights up,
since that is where they land — or picked with the paperclip.

Attached bytes live in SQLite beside the messages, so `VACUUM INTO` still
copies everything in one file and deleting a conversation takes its files with
it. Images are re-encoded to PNG on the way in when the local runner cannot
read the original — it rejects WebP — and transparency is flattened onto white,
without which a transparent screenshot arrives as a black rectangle. Documents
are extracted once, at upload, so a PDF with no text layer is refused while
you are still looking at the composer rather than two turns later.

Only the four most recent images travel with a request; older ones remain in
the transcript as `[earlier image: name]`. Resending every picture in a long
conversation is expensive, and a small vision model handed six of them answers
about the wrong one.

> **Vision needs a model that actually has it.** Some models advertise the
> `vision` capability without shipping a projector, accept the image, and then
> describe something that was never there. If answers about pictures are
> confidently wrong, check `ollama show <model>` for a projector before
> suspecting anything else.

## Canvas

Some answers are not a message. A draft you will keep editing, a script you are
building up over several turns, a page you want to see rendered — a fenced code
block in the thread is the wrong home for any of them, because the next edit
means the model reprinting the whole thing and you scrolling back to find it.

The **canvas** is a document that lives beside the conversation instead of
inside it, in a panel that splits the sheet on a laptop and takes the whole
screen on a phone. It opens itself the moment the model writes one, and the
button in the top bar shows and hides it after that.

Two skills reach it, and they are named for the choice the model is making:

| | |
|---|---|
| `write_canvas` | Create a canvas, or replace one by the same title |
| `read_canvas` | Read one back before revising, or list what a conversation has |

Named by title, not by id — like the calendar, and for the same reason: every
listing the model sees is prose, so an id is something it would have to be
handed and then copy back exactly. Writing to a title that already exists
replaces that canvas whole; a new title makes a new one. A conversation rarely
has more than a handful, and telling them apart by name is what a person does
too.

A canvas is **yours to edit as well**. Type into the panel and it saves itself a
beat after you stop; a markdown or HTML canvas flips between the editor and a
preview, opening on the rendered view so a page reads as a page rather than as
its source. Nothing here is retrieval-augmented magic — the model only sees a
canvas when it calls `read_canvas`, so it reads the version you left, edits and
all.

An **HTML canvas runs**. The preview is a sandboxed iframe with an opaque origin
— `allow-scripts`, never `allow-same-origin` — so a page's JavaScript executes
and an interactive layout or a script-driven slideshow renders, while the frame
stays walled off from Courier: it cannot read the app's DOM, cookies,
`localStorage` or bearer token, and any request it makes goes out cross-origin
without the app's credentials. The worst a hallucinated script can do is send
what is already on its own page somewhere; the two combined settings that would
let it drop the wall are never set together. A **Scripts** toggle turns
execution off for a locked, static look at a page you have not read yet, and the
content is stored as text either way — nothing runs until you are previewing it.

Canvases belong to the conversation the way messages and attachments do:
deleting the chat takes them with it, and they never leak into another one. The
bytes are columns in the same SQLite file as everything else, so `VACUUM INTO`
still copies the lot in one shot.

### Why the icons are not on the custom-property path

A file-backed glyph is a mask over `currentColor`, and the image used to reach
it as a custom property -- `style={{"--mask": url}}` against a
`mask: var(--mask)` rule. That quietly tied every icon in the app to every
custom property above it. Writing one on `:root` invalidates inherited custom
properties for the whole document, and the composer writes one as the pointer
moves, to publish how much of itself is on screen. So each icon had its mask
re-resolved on every mouse move, and a mask is a paint property holding an
image. That is what made the icons flicker whenever anything moved.

`mask-image` is set on the element directly now, with no `var()` in it, so a
custom property changing anywhere cannot reach it. Measured with 300 masked
icons and 300 root writes: about 1080ms of style work before, about 780ms
after -- a bit over a quarter of it was icon masks being resolved again for
nothing.

The composer also quantises what it publishes and skips the write when it has
not changed. A hand resting on a mouse never stops twitching; at three decimals
each twitch was a fresh value and a style write. Sixty small movements used to
cost sixty writes, and now cost none.

### When the model garbles a tool call

A local model writing a long argument -- an HTML document, a search objective
with quotes in it -- sometimes produces something that is *nearly* JSON. Ollama
parses tool calls before Courier ever sees them, so it rejects the call itself
and reports it in the stream with a 200 and its own wording, quoting the entire
unparsed payload.

That used to end the turn, and what reached the thread was pages of your own
document handed back to you as an error message. Now it costs a round instead:
the model is told its last call could not be read and why, and gets another go,
twice, before the turn gives up and says so in a sentence. The raw payload never
reaches the reader either way.

This is the model's mistake rather than Courier's, and it is worth knowing
which -- a bigger model makes it far less often.

### Pictures in a canvas

Images in a canvas are **drawn, not linked**: inline SVG, a CSS gradient, or a
`data:` URI. A model left to itself reaches for the placeholder services it
learned — `via.placeholder.com`, `source.unsplash.com`, a `picsum.photos` size,
an `images.unsplash.com` photo id it invented — and those are the least
dependable addresses on the web. Retired, down for weeks, or never real. The
page then renders as a finished layout with holes in it, which reads as Courier
losing the pictures rather than the model naming ones that were never there.
They also send your address to a stranger every time the panel opens, which is
the one thing this app exists to avoid.

So `write_canvas` says that in its description, and checks the page it was
handed: a canvas written with remote images comes back with a warning naming
the hosts, while the model is still in the turn and can redraw them. It is a
report and never a refusal — the canvas is saved either way, and a URL you
supplied yourself is a good reason to keep it.

## Asking before a skill runs

A skill that is switched on can read your folders, search the web and call
whatever an MCP server exposes. Until now the only say you had was that switch:
on meant "run whenever the model asks", off meant "never" — a decision made
once, in advance, about calls you had not seen yet.

**Skills → Ask before running a skill** is the setting in between. With it on,
the turn stops at the call and shows you which skill wants to run and with what
arguments, and waits:

```
WANTS TO RUN  list_directory
path          ~/Documents

[ Allow once ]  [ Allow in this chat ]  [ Always allow ]  [ Deny ]
```

The arguments are shown rather than summarised, deliberately. "list_directory
wants to run" is not a decision; `list_directory` on `~/Documents` is.

Three widths of yes, and only the widest is written down. **Once** is this call.
**In this chat** lives in memory on the server and dies with the process, because
a conversation is the unit of trust. **Always** is stored, and is the row that
turns into the *Always allowed* pill next to that skill on the Skills page —
which is also where you take it back.

Off by default. A harness that interrupts every call the first time you start it
teaches you to dismiss the prompt, which is the failure this exists to avoid.

Three things worth knowing about how it behaves:

* **the turn holds open.** The prompt is one more frame on the SSE stream the
  answer is already arriving on, so waiting costs a pending request and nothing
  else. It is not a second trip through the model, and answering does not
  restart the conversation;
* **a refusal is an answer.** Denying puts a sentence where the skill's result
  would have gone, so the model knows it was refused and says so rather than
  inventing one. The turn finishes normally;
* **silence is refusal.** A prompt nobody answers in five minutes is treated as
  a no. Running it anyway would teach you the prompt could be ignored.

### What it did, and what came back

A finished call is drawn as a **card** above the answer: the service that
answered, in one line what the call was for, and the head of the result — with
the full text one press away, so a turn that read four pages does not bury the
reply under them. A card still waiting says so, which is what tells a slow skill
apart from a hung turn, and a declined one stays on the card rather than
vanishing.

The summary is derived in the client from what the turn already recorded —
there is no second model call, because one would slow every turn that used a
tool and the arguments already carry the intent. A tool from an MCP server wears
that service's mark, the way the Skills page does.

## Agents

One assistant with one system prompt and the whole shelf of skills is the
default, and for most conversations it is the right one. An **agent** is a way
to keep several — a researcher who cites, a coder who writes tests first, a
planner who only talks — each with its own standing instructions and its own
subset of the skills, and to say which one a conversation is talking to. It is
the local, single-machine shape of the multi-agent idea GrokBot builds a team
of cloud bots around.

An agent is two things:

* **instructions** — persona, appended to the base system prompt for that
  agent's conversations. Additive, never a replacement: the preamble still
  carries what every answer needs, and the agent specialises on top of it. It
  sits in the stable, cacheable part of the prompt, so assigning one does not
  cost a fresh prefix every turn.
* **skills** — which tools it may call. The default is every enabled skill;
  narrow it and the model is only *offered* that subset, and a call to anything
  outside it is refused before it runs rather than quietly allowed. An agent
  given no skills at all is a pure conversationalist, and that is a different,
  deliberate thing from one given all of them.

Each agent carries its own **icon** and **accent**, so a team of them is legible
at a glance — in the list, and as the bead beside each conversation in the rail.
The accent is the agent's, not the chat's: a conversation run as an agent wears
that agent's colour (see **Accents**).

Make and edit them on the **Agents** page — from scratch, or from a **preset**:
a handful of ready-made roles (Researcher, Coder, Writer, Planner, Analyst,
Companion) that open prefilled in the editor so you can adjust the skills to
what this machine actually has before saving. A preset names its ideal skill
set whether or not you have all of it; a skill that is not registered (web
search with no key, the sandbox left off) is simply never offered, so a preset
degrades quietly rather than promising a tool that cannot run. Assign an agent
to the conversation you are in from the picker in the top bar, beside where you
file it into a project.
A conversation with no agent is the default assistant, and that is the common
case. Deleting an agent files its conversations back under the default rather
than taking them with it — the same way deleting a project does.

Per-agent *model* is the obvious next piece and is deliberately not here yet:
the provider holds one model at a time and a turn already streaming keeps the
one it started with, so choosing a model per agent is the same change as the
per-conversation model override in **Not built yet**, and lands with it.

## Design standards

Ask any model for a one-pager and it invents a look on the spot. Ask it eight
times and you get eight strangers — a different heading scale each time, a new
accent colour, a table that is bordered on Tuesday and ruled on Thursday. The
model is not being inconsistent; it was never told what consistent meant.

A **design.md** is that brief, as a short document: principles, type, colour,
layout, components, and the voice the words are written in. Whichever one you
pick is handed to the model whole, before it starts writing.

It is asked for rather than configured. When the model is about to make
something whose look matters — a document, a report, a web page, a canvas, a
deck, a diagram — it calls `ask_for_design`, and *the turn stops there*: the
chooser appears in the thread at the point the answer is waiting, the same way
a skill approval does, and the turn resumes the moment you pick. No second
round trip, no settings page you had to know about in advance, and the question
arrives when it is actually relevant rather than at the top of every chat.

If you name one yourself — *"use the brutalist web design.md"*, *"do it in the
Swiss style"*, *"use my house style"* — nothing is asked at all: the model
passes the name through and gets that document straight back. Matching is
forgiving about how you say it, `.md` and all, and a name that fits nothing
falls back to the list rather than to an apology — with a line saying what it
looked for, so an unfamiliar list does not read as your own standard having
gone missing.

These documents live inside Courier, not on disk. A design.md is never a file,
and the model is told so in as many words: left to infer it, a model asked for
"the brutalist web design.md" goes hunting through your Desktop for a file that
has never existed and comes back apologising.

Every answer is a real answer. **No standard** is one of the rows, and the
model is told to carry on with its own judgement and not to ask again that
turn — declining is not cancelling. If nobody answers within three minutes the
turn takes that same answer and continues, because a chooser nobody is looking
at must not be able to hang a conversation.

Eight presets ship with the server, written to be genuinely different from one
another rather than eight shades of the same restraint:

| | |
|---|---|
| **Swiss** | Grid, one grotesque, black and one red. Order before ornament. |
| **Academic paper** | Numbered sections, a text serif, black on white, survives printing. |
| **Business memo** | Answer first, skimmable headings, one page where possible. |
| **Editorial** | Magazine feature: serif body, big headline, pull quotes, one column. |
| **Soft product UI** | Rounded, calm, one brand ramp and a single soft shadow. |
| **Terminal** | Monospace on a character grid, six semantic colours, dense. |
| **Brutalist web** | Hard borders, no radius, enormous type, one alarming accent. |
| **Zine** | Riso duotone, mixed faces, rotated collage, handmade and loud. |

They take their cues from the design traditions they are named for; the
documents themselves are written for this repository rather than lifted from
anyone's brand book.

Your own sit beside them on the **Design** page, offered in the same list and
picked the same way — and marked **yours**, which is also the order they are
listed in. Write one in the editor, which keeps the source beside a live
preview, or press **Upload .md** and hand it a file you already have: the
markdown lands in the editor with its first `# heading` taken as the name, so
you can look it over before it is saved. A preset is read-only and can only be
**forked** — a copy you then own — because a preset that drifts per machine is
just an unlabelled custom standard.

Nothing points at a design once it has been used. The document is copied into
the window at the moment it is chosen, not referenced, so deleting one never
changes something already written under it.

## The sandbox

The most powerful thing Courier can be given, and the most dangerous: a local
computer. With it on, two skills appear —

| | |
|---|---|
| `run_shell` | Run a shell command and read its output |
| `run_python` | Run a Python snippet and read what it printed |

— so the model can do real work the answer depends on: calculate without
getting it wrong in its head, parse a file, run a build, drive a CLI. It is the
local, single-machine answer to the cloud "computer" a GrokBot or Manus agent
drives, and it makes the same trade — real capability for the cost of trusting
what you approve.

Three things are true of it by construction:

* **Off unless you turn it on.** `SANDBOX_ENABLED=1` and not otherwise. An
  unconfigured capability that could run code is a footgun, so an unset machine
  never offers it — the skill is listed on the Skills page as needing the flag,
  and never sent to the model until it has it.
* **Approved per run.** It goes through the same gate as every other skill, and
  the exact command is shown before it runs. "Run a shell command" is never the
  decision; `rm -rf ~` is. Keep **Ask before running a skill** on.
* **A scratch directory, not a jail.** Work lands in `SANDBOX_DIR`
  (`data/sandbox` by default) and relative paths resolve there — but be honest
  about the boundary: a command runs as the same user as the server, with that
  user's files and network, and `cd /` walks out like anywhere else. The
  confinement that matters is the switch being a deliberate choice and the
  approval prompt in front of each run. Enable it on a machine where you would
  run the command yourself.

The app's own secrets (`ANTHROPIC_API_KEY`, the bearer token, and the rest) are
stripped from the environment a command sees, so a snippet cannot print them
back out of `os.environ`. That is hygiene, not a boundary — a command that can
read the filesystem can read the key file too. A run that overruns
`SANDBOX_TIMEOUT` seconds is killed, and its output is capped before it reaches
the window. Give an agent only `run_python` and `run_shell` (see **Agents**)
and you have a coding assistant that cannot touch the web, or the reverse.

## Memory

Three kinds, and they fail differently.

**The window** is the recent turns, sent verbatim. It trims from the head when
it will not fit.

**Recall** is search over everything ever said, plus the text of every document
ever attached, exposed to the model as one skill it can call. Messages and
documents are cut into paragraph-sized chunks and indexed twice — BM25 over
the words, cosine over embeddings from a local encoder — and the two rankings
are fused. Nothing is sent anywhere: the vectors are generated by Ollama on
this machine and stored in the same SQLite file as the messages.

If the embedding model is not pulled, chunks stay unembedded and search runs on
keywords alone. That is a worse search, not a broken one.

```bash
ollama pull nomic-embed-text
```

**Facts** are the short curated list the model sees on every turn, without
having to look anything up. Say "remember that…" and it lands there; ask it to
forget and it goes. Anything the assistant works out for itself waits for your
confirmation first, unless you turn that off.

All of it is on the Memory page: what is remembered, where each fact came from
and how sure it is, what it has been used for, and a switch to stop the whole
mechanism. Deleting a fact takes effect on the next message — there is no save
step. Deleting a *conversation* removes it from search, but does not remove
what was learned from it; facts outlive the chat they came from, which is the
one place this schema deliberately does not cascade.

`docs/memory.md` has the details, including the one setting worth checking
against your own encoder.

## Accents

The whole client can be dressed in one colour, and so can a single project or
a single agent. Ten named accents, a hue slider, and an intensity — or
**From the chat**, which works the colour out from what is being talked about.

Three scopes, nearest wins: the **agent** a conversation is run as beats the
**project** it is filed under, which beats the **app-wide** one. The accent is a
property of the agent, not of the conversation — a chat run as an agent wears
that agent's colour, which is what makes a team of them legible. A scope that
has not chosen is not a scope that chose nothing — the decision falls through to
the next one up. That is why the picker distinguishes *inherit* (an open ring)
from *none* (a struck-through blank): the first declines to decide, the second
decides to wear no colour. Set it from the accent row in the **Agents** editor,
from a folder's **accent** row on Projects, and from **Settings → Accent** for
everything else.

**From the chat** is arithmetic, not a model call: a keyword pass over the
title and the recent turns, already in memory on the device, against a dozen
subject fields — engineering is cobalt, cooking is a bread-crust ochre, travel
is a sea blue. Nothing is sent anywhere and no model has to be running for the
UI to render. A conversation that matches two fields lands between them, and a
new subject has to clearly beat the standing one before the app is
redecorated, so the colour drifts rather than flickers.

Only the *intent* is stored — a mode, and a preset name or a hue. The palette
itself is derived in the client, in OKLCH: sixteen custom properties on one
lightness ladder read back off the hand-picked hexes in `styles.css`, so
`cobalt` at low intensity reproduces the palette this app shipped with, and
**none** restores it exactly. Every colour that carries text is contrast-checked
on the ground it will sit on as it is generated — 4.5:1 for the small greys,
5.5:1 for the accent — because the hue is now the reader's to choose and there
is no hand left to darken it afterwards. Green and ochre are deliberately left
alone: they mean pass and warning, and a warning that turns blue because
somebody likes blue is a bug.

The colour arrives as tints on the surfaces, lines and accents; the large soft
field behind the sheet — the part that looks like the reference — is a separate
layer, `--aura-*`, painted behind the thread and never between it and a word.

## Providers and models

Three places an answer can come from, chosen from the circle at the foot of the
rail or from **Settings → Connection**:

| | | |
|---|---|---|
| **Local** | Ollama on this machine | The default, and on a good day the only one |
| **Cloud** | Anthropic | Needs `ANTHROPIC_API_KEY` and the `cloud` extra |
| **OpenRouter** | several hundred models behind one key | Connected from the app |

**Auto** is the fourth choice and the one to leave it on: local first, and a
cloud backend only when the local runner cannot be reached. Which one answered
is never a guess — it is recorded on the message and shown in the top bar.

The same menu picks the *model*, one level in: **›** beside a backend lists
what it has — everything `ollama list` shows, every Claude model the API
reports, the whole OpenRouter catalogue with prices and context lengths, with a
filter, because that last one is several hundred long.

That choice is server state, not a per-device preference. The phone and the
laptop are looking at the same assistant, and the two passes that run off the
response path — titling a conversation, curating memory — have no request of
their own to carry a preference on. It survives a restart. *Which backend*
answers is the opposite case and stays in the browser: it is a per-message
field, and "answer this one locally" should not follow you to another device.

### Connecting OpenRouter

Two ways in, both ending at the same place — a key on this machine, in
`data/openrouter_key`, beside the bearer token:

**Sign in.** Settings → *Sign in with OpenRouter* opens openrouter.ai in a tab,
and OpenRouter mints a key for this app when you approve it. The flow is OAuth
PKCE, so nothing secret is baked into the app and the browser never carries
anything worth intercepting. The tab lands back on the server, which stores the
key and says so.

**Paste a key.** Settings → *Paste a key*, from openrouter.ai/keys. It is
checked against OpenRouter before it is written down, so a key that is wrong by
one character is refused on the page you are looking at rather than on a
message an hour later.

*Disconnect* deletes the file. There is no session to expire and nothing to
revoke from here — the key on disk is the whole of the connection, which is
also why you should revoke it at openrouter.ai if the machine is lost.

> **This is a bill.** Everything else in Courier runs on hardware you own.
> OpenRouter charges per token, on a key you connected, and every message sent
> to it costs money — the settings page shows what the key has spent so far.
> Models flagged **free** in the picker cost nothing and are rate limited
> accordingly.

Reasoning works across all of it: OpenRouter takes the composer's effort word
for any model and converts it upstream — into a token budget for Claude, into a
switch for the models that only have one — so the control does not change shape
when the model does. A model the catalogue says cannot reason is drawn without
the control at all rather than with one that does nothing.

## Configuration

All environment variables, all optional.

| Variable | Default | Notes |
|---|---|---|
| `BIND_HOST` | `127.0.0.1` | Used verbatim. A LAN address (or `0.0.0.0`) lets other devices in. |
| `BIND_PORT` | `8080` | |
| `AUTH_TOKEN` | generated | Written to `data/token` on first run. |
| `TOKEN_LENGTH` | `14` | Characters, from an alphabet with no `0/O/1/l/I`. |
| `DB_PATH` | `data/chat.db` | |
| `CLIENT_DIR` | `client/dist` | The built UI. Missing means API-only. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `OLLAMA_MODEL` | `gpt-oss` | |
| `OLLAMA_THINK` | `medium` | Default gpt-oss reasoning effort: `low`, `medium`, or `high`. |
| `CONTEXT_TOKENS` | `32768` | |
| `REPLY_TOKENS` | `2048` | Headroom reserved for the answer. |
| `MAX_TOOL_ROUNDS` | `16` | Skill rounds before a turn is cut off. The **Continue** button extends past it; raise `CONTEXT_TOKENS` too if you raise this. |
| `CARRY_WORKING` | `1` | Carry a compact recap of each turn's tool results + reasoning into later turns, so the model keeps context across turns and Continue. `0` replays the answer text alone. |
| `SANDBOX_ENABLED` | unset | `1` turns on `run_shell`/`run_python`. Off runs code nowhere. Read **The sandbox** first. |
| `SANDBOX_DIR` | `data/sandbox` | Scratch working directory for the sandbox. A workspace, not a jail. |
| `SANDBOX_TIMEOUT` | `30` | Seconds before a command is killed. |
| `SANDBOX_OUTPUT_CHARS` | `6000` | Cap on what one run puts back into the window. |
| `SYSTEM_PREAMBLE` | see `config.py` | Kept static — it is the cacheable prefix. |
| `EMBED_MODEL` | `nomic-embed-text` | Pull it separately. Changing it orphans existing vectors. |
| `MEMORY_MIN_SIMILARITY` | `0.35` | How close a passage must be to count as a match at all. |
| `MEMORY_MAX_FACTS` | `40` | Curated facts allowed in the system prompt. |
| `MEMORY_FACT_CHARS` | `200` | Longest a single fact may be. |
| `MEMORY_EXTRACT_EVERY` | `5` | User turns between curation passes; `0` disables them. |
| `ANTHROPIC_API_KEY` | unset | Enables the Anthropic fallback. `pip install -e "./server[cloud]"`. |
| `OPENROUTER_API_KEY` | unset | Enables OpenRouter. Usually set from the app instead — see below. |
| `OPENROUTER_MODEL` | `openrouter/auto` | Starting point only; the picker's choice is stored in the database. |
| `OPENROUTER_KEY_PATH` | `data/openrouter_key` | Where a key pasted or signed in from the app is kept. |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1` | |

### gpt-oss reasoning effort and `OLLAMA_THINK`

gpt-oss accepts `low`, `medium`, or `high` for its reasoning effort. The
composer's slider selects that level for each message; `OLLAMA_THINK` provides
the server default for API callers that do not send one. Higher levels take
longer and use more tokens. Reasoning arrives on Ollama's separate `thinking`
channel, so it can be shown live without being stored with the answer.

---

## Backups

Section 7's answer to SQLite corruption. `VACUUM INTO` produces a consistent
copy of a live database:

```python
from app.db import Database
from pathlib import Path
Database(Path("data/chat.db")).backup_to(Path("backups/chat-2026-08-13.db"))
```

Schedule it nightly with Task Scheduler. How that copy gets off the machine
without defeating the point of local-only is still an open decision (§10).

---

## Layout

```
server/app/
  config.py        env only; token persistence
  db.py            WAL, user_version migrations, VACUUM INTO
  store.py         sessions and messages
  orchestrator.py  §6 request lifecycle
  approvals.py     the prompts a turn waits on, and the standing grants
  choices.py       the same, for a question whose every answer is an answer
  design_presets.py  the eight design.md documents that ship with it
  api.py           HTTP surface
  providers/
    base.py        ModelProvider protocol — the seam, in place from day one
    ollama.py      default
    anthropic.py   cloud fallback, lazily imported
    openrouter.py  OpenAI-compatible; one encoder for every family it fronts
    openrouter_oauth.py  the PKCE sign-in; in memory, per process
    router.py      local first, cached health, explicit override
  memory/
    chunking.py    paragraph-sized pieces; pure
    embedding.py   float32, normalised on the way in
    search.py      cosine + reciprocal rank fusion; pure
    indexer.py     catch_up() and search() — the write and read halves
    facts.py       the curation pass, and a parser that never raises
  tests/           the pure parts of memory, and the approval gate
client/            React, built by Vite; no CDN, no runtime dependencies
  src/
    App.jsx        auth phases, drawer, wiring
    hooks/         useChat (the turn), useSessions (the list),
                   useTheme (the accent, resolved across three scopes)
    lib/api.js     bearer token, SSE-over-fetch
    lib/markdown.js  the renderer -- escapes before it emits a single tag
    lib/color.js     OKLCH <-> sRGB, WCAG contrast, gamut mapping
    lib/theme.js     one hue -> the whole palette; the ten named accents
    lib/autotheme.js what a conversation is about, as a hue
    components/    gate, top bar, drawer, message list, composer
  public/          copied verbatim: service worker, manifest, icons
  dist/            the build output; this is what the server serves
```

## Working on the UI

```bash
cd client && npm run dev
```

Vite serves the UI on :5173 and proxies `/api` to the server on :8080, so the
dev UI talks to the real thing — real token, real streaming, real history.
Run the Python server alongside it as usual. `npm run build` when you're done;
the server only ever reads `dist/`.

## Not built yet

Per-session model override — the picker sets one model per backend for the
whole app, and a conversation cannot yet keep its own. And compaction of the
middle of a long window: `build_window` still trims from the head.

Phases 4 and 5 are in: see **Memory** above and `docs/memory.md`.
