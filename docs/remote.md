# Remote access

Use the Bom on your own machine — its Ollama models, conversations, memory and
files — from anywhere: a phone on cellular data, a laptop at work, the desktop
app on another computer. Nothing on your machine listens on an open port and
nothing needs port forwarding. You run the relay yourself on free tiers.

```
  your machine (the host)                your relay (Supabase)           anywhere
 ┌──────────────────────────┐         ┌────────────────────────┐     ┌────────────────────┐
 │ Ollama ◄── Bom server ───┼─ wss ──►│ Realtime: one private  │◄────┤ web app (Vercel)   │
 │            (dials out)   │         │ channel per host       │     │ or the desktop app │
 └──────────────────────────┘         │ Auth: your account     │     └────────────────────┘
                                      │ bom-pair: linking      │
                                      └────────────────────────┘
```

The host connects **out** to your relay and joins one private channel. The web
app and desktop app join the same channel and send it requests. The host
forwards each request to its own API over loopback and streams the reply back,
so chat streaming, attachments, images, canvases and memory all work as they
do at home.

## Who can use it

There are four checks, and each one holds even if another fails:

1. **Consent at the device.** Remote access is off until someone turns it on
   **at the host**. That's either the switch in Settings → Remote access,
   which only answers requests made on that machine, or `./run.sh --remote`
   run on it. A request that comes through the relay can never turn hosting
   on or off, or re-link the device. A phone on your LAN that has the token
   can't do it either.
2. **Linking by you.** Turning it on shows a one-time code on the host, for
   example `K7QM-3XRP`. The host is linked only when someone **signed in to
   your relay account** types that code. The code works once, expires after
   10 minutes, and repeated wrong guesses are throttled. The host then gets
   its **own** sign-in and never holds yours. Optionally,
   `BOM_ALLOWED_EMAILS` limits linking to named accounts.
3. **The relay's access rules.** Realtime lets only the host's owner and the
   host itself onto `bom:host:<id>`. The id is random and only the owner can
   read it. Every join and every message is checked against these rules
   (`relay/supabase/migrations`).
4. **The host checks every request itself.** Each request carries the
   caller's session token. The host asks your relay's auth service whose it
   is, and serves only its owner. Anyone else gets a 401, even if the rules in
   step 3 were misconfigured.

Removing a device, from the web app or with **Unlink** on the host, deletes
the host's own sign-in on the relay, so its access ends immediately.

**What the relay sees:** requests and replies pass through Supabase Realtime
over TLS. They aren't stored (broadcast messages aren't persisted), but they
aren't end-to-end encrypted either. Treat your Supabase project like any other
service that carries your data in transit. Conversations are stored only on
the host.

## Set it up (about 10 minutes, once)

You need a free [Supabase](https://supabase.com) account, and a free
[Vercel](https://vercel.com) account if you want the web app.

### 1. The relay (Supabase)

Create a project in the Supabase dashboard. Then, from this repo:

```bash
./relay/setup.sh <project-ref> https://<your-app>.vercel.app
```

- `<project-ref>` is the id in your project's dashboard URL. Pasting the
  whole URL works too.
- The second argument is where the web app will live (step 2). Vercel shows
  the address when you create the project. If you don't have it yet, leave it
  out and run the script again once you do.

The script asks once for a Supabase **access token**. Create one at
<https://supabase.com/dashboard/account/tokens>. It's used only for this run
and isn't saved. Then it:

- creates the tables and access rules, and deploys the `bom-pair` function
- **sets up sign-in:** links in sign-in emails return to your web app, and
  every sign-in email, including the first one, carries a 6-digit code as
  well as the link (free-tier projects need their own SMTP for this; without
  it the emails carry just the link, which is all the web app needs)
- turns Realtime to **private channels only**
- prints `BOM_RELAY_URL` and `BOM_RELAY_KEY`

There's nothing to change by hand in the dashboard. It uses the Supabase CLI,
through `npx` if you haven't installed it. To let only your own account link
devices:

```bash
BOM_ALLOWED_EMAILS=you@example.com ./relay/setup.sh <project-ref> https://<your-app>.vercel.app
```

For a relay only you use: sign in once, then turn off **Allow new users to
sign up** (Authentication → Sign In / Providers).

### 2. The web app (Vercel)

Import this repository into Vercel. `vercel.json` already sets the build. Add
two environment variables:

| Name | Value |
|---|---|
| `VITE_BOM_RELAY_URL` | `BOM_RELAY_URL` from step 1 |
| `VITE_BOM_RELAY_KEY` | `BOM_RELAY_KEY` from step 1 |

Deploy. The web app is the regular Bom client built in relay-only mode: it
never looks for a local server. The key is Supabase's public (anon or
publishable) key, which is meant to ship in web pages. Your data is protected
by your sign-in and the access rules, not by keeping the key secret.

Skip this step if you only want the desktop app: its sign-in screen has
**Away from it? Connect through your relay**, where you paste the same two
values.

Changed the Vercel address, or added one later? Run `setup.sh` again with the
new one, so sign-in links go there.

### 3. The host (your machine)

Either in the app, at the host: **Settings → Remote access**. Paste the relay
address and key (and the web app's address, so the code screen can link to
it), then switch on **Allow remote access**.

Or headless, for a GPU box without a screen:

```bash
export BOM_RELAY_URL=https://<project-ref>.supabase.co
export BOM_RELAY_KEY=<key>
export BOM_RELAY_WEB_URL=https://<your-app>.vercel.app   # optional
./run.sh --remote
```

Either way, the host shows a code, both on screen and in its terminal:

```
  ┌ Remote access ─────────────────────────────────────
  │ Link this machine to your account:
  │   open   https://<your-app>.vercel.app/?link=K7QM3XRP
  │   enter  K7QM-3XRP
  │ The code works once, for 10 minutes.
  └────────────────────────────────────────────────────
```

### 4. Link and connect

Open the web app (or the desktop app's relay sign-in) and sign in with your
email. Open the email's link on the same device, or type the **6-digit code**
if the email has one. There's no password. Then the host's own code goes in the next screen. Under **Link a
device**, enter the host's code, check the device name, and choose **Link
device**. Within a few seconds the host shows **Online**. Choose **Connect**.

From then on the host reconnects by itself after restarts, and the web app
reopens your last host.

## Everyday use

- **Several hosts:** link as many as you like, up to 20 per account, and pick
  one from the list. Each row shows whether that host is online.
- **Turning it off:** switch off **Allow remote access** on the host. The
  link is kept, so switching it on again reconnects without a new code.
- **Removing a device:** use **Remove** in the web app's device list, or
  **Unlink** on the host.
- **Local use is unchanged.** The token sign-in, `./run.sh` and the desktop
  app work exactly as before. Remote access adds a way in and changes nothing
  about the local one.

## What doesn't go through the relay

The relay forwards requests, not raw connections, so a few things only work
on the host's own network:

- the **terminal** in the Code view (a live WebSocket)
- the Code view's **preview** frame (the project's files served as a site)
- **signing in** to OpenRouter or a hosted MCP server, whose sign-in pages
  redirect back to the host's own address

Each one says so when you try it through the relay.

## Configuration reference

| Variable | Where | What it does |
|---|---|---|
| `BOM_RELAY_URL` | host | The relay's address (`https://<ref>.supabase.co`). Overrides Settings. |
| `BOM_RELAY_KEY` | host | The relay's anon or publishable key. Overrides Settings. |
| `BOM_RELAY_WEB_URL` | host | The web app's address, used for the link on the code screen. |
| `BOM_REMOTE=1` | host | Same as `./run.sh --remote`: turn remote access on at boot. |
| `BOM_REMOTE_NAME` | host | The name shown in the device list. Defaults to the hostname. |
| `BOM_RELAY_PATH` | host | Where the link is kept. Default `data/relay.json`, created `0600`. |
| `VITE_BOM_RELAY_URL`, `VITE_BOM_RELAY_KEY` | web build | The relay, built into the web app. |
| `VITE_BOM_REMOTE_ONLY=1` | web build | Relay-only gate (set by `vercel.json`). |
| `BOM_ALLOWED_EMAILS` | relay function secret | Only these accounts may link devices. |
| `BOM_DEVICE_EMAIL_DOMAIN` | relay function secret | Domain for hosts' own sign-ins. Default `devices.bom.invalid`; never mailed. |

## Troubleshooting

**"The relay has no bom-pair function."** Step 1 didn't finish. Run
`./relay/setup.sh <project-ref>` again; it's safe to repeat.

**The host stays on "Connecting…".** Its status line gives the reason. "The
relay refused this device's channel" means the migration didn't apply (run
setup again) or the device was removed. "Can't reach the relay" is a network
problem; the host keeps retrying with backoff.

**"This device was removed from your account."** It was unlinked from
elsewhere. Switch remote access on again for a new code.

**"Your host isn't answering."** The host is off, asleep, or has remote
access switched off. The device list shows when it was last seen.

**The sign-in link opens a page that won't load (often `localhost:3000`).**
Supabase doesn't know your web app's address. Run
`./relay/setup.sh <project-ref> https://<your-app>.vercel.app`. Or type the
6-digit code from the email, if it has one; it works wherever you're signing in.

**"That code didn't work."** Each code works once, and requesting another
cancels the previous one. Use the code from the newest email. Supabase's
built-in email sends only a few messages an hour; for more, connect your own
SMTP under Authentication → Emails.

**The email has a link but no code.** On the free tier Supabase won't change
the email templates until the project sends mail through your own SMTP, and
`setup.sh` says so. The link is enough for the web app: open it on the device
you're signing in on. The desktop app needs the code, so add SMTP under
Authentication → Emails (Resend and others have free plans), then run
`setup.sh` again. Templates you wrote that already include `{{ .Token }}` are
left alone.

**Linking fails with "Couldn't create the device's sign-in".** Your project's
auth settings rejected the host's generated address. Set
`BOM_DEVICE_EMAIL_DOMAIN` to a domain you own (it is never mailed) with
`supabase secrets set`, then link again.

## How it works (for contributors)

- `relay/supabase/migrations/…_bom_relay.sql`: tables, access rules for
  `realtime.messages`, and the heartbeat function.
- `relay/supabase/functions/bom-pair`: the device-code flow (start, lookup,
  approve, poll, revoke).
- `server/app/remote/`: `realtime.py` (one private channel, Phoenix v1
  protocol), `host.py` (pairing, reconnecting, checking callers, forwarding,
  streaming), `api.py` (the host-only `/api/remote` routes).
- `client/src/lib/relay.js`: `RelayConnection.fetch`, which returns a real
  `Response`, so `createApi` works unchanged. `relayFrames.js` is the wire
  format; `remote.js` handles the account and the device list.

The wire format, one broadcast each:

```
client → host   req {id, jwt, method, path, content_type, parts, body} · req-part {id, i, body}
                abort {id} · ping {id}
host → client   res-head {id, status, headers} · res-body {id, seq, text|b64}
                res-alive {id} · res-end {id, count, error?} · pong {id}
```

Bodies travel in parts of up to 96 KB, under Supabase's per-message limit.
Streaming replies are sent in batches every 40 ms, so a fast model stays
within the project's message-rate limit.
