/* A host reached through the relay, behind the same `fetch` shape as HTTP.
 *
 * `RelayConnection.fetch(path, options)` returns a real `Response` -- status,
 * headers, and a body that streams as the host sends it -- so everything
 * above it (`createApi`, `readEvents`, `.json()`, `.blob()`) works unchanged
 * whether the server is across a desk or across the world.
 *
 * Underneath, it is one private Realtime channel in the user's own Supabase
 * project: requests are broadcast onto it, the host broadcasts replies back.
 * Every request carries this account's session token; the host asks the auth
 * server whose it is and serves only its owner. See relayFrames.js for the
 * wire format and server/app/remote/host.py for the other end.
 */

import { ResponseAssembler, splitBody } from "./relayFrames.js";

// For the first word of a reply. Generous: /status asks every backend whether
// it is up, and a cold Ollama can take a while to say.
const HEAD_TIMEOUT = 45_000;
// Between words of a reply. The host says it is still alive every 15 s.
const IDLE_TIMEOUT = 60_000;
const PING_TIMEOUT = 8_000;
const JOIN_TIMEOUT = 15_000;
// Between the parts of a large request body (a PDF, say). Sent all at once,
// a few dozen parts overrun the relay's messages-per-second limit, a part is
// dropped, and the host never sees the request. 25 a second, as the host
// paces its own.
const PART_GAP = 40;
// Statuses a Response may not have a body with.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** The host (or the relay in front of it) is not answering. */
export class HostUnreachable extends Error {
  constructor(message) {
    super(message);
    this.name = "HostUnreachable";
  }
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function jsonResponse(status, detail) {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class RelayConnection {
  /**
   * @param {() => Promise<import("@supabase/supabase-js").SupabaseClient>} getClient
   * @param {string} hostId
   */
  constructor(getClient, hostId) {
    this.getClient = getClient;
    this.hostId = hostId;
    this.client = null;
    this.channel = null;
    this.opening = null;
    this.pending = new Map();
    this.pings = new Map();
    // Bound, so it can be handed around as a bare function.
    this.fetch = this.fetch.bind(this);
  }

  /** Join the host's channel and check the host is there. Idempotent. */
  connect() {
    if (!this.opening) {
      this.opening = this._open().catch((error) => {
        this.opening = null;
        this._dropChannel();
        throw error;
      });
    }
    return this.opening;
  }

  async _open() {
    const client = await this.getClient();
    this.client = client;
    const { data } = await client.auth.getSession();
    if (!data?.session) throw new HostUnreachable("Sign in to reach your host.");
    // A private channel is checked against the relay's access rules, which
    // need to know who is asking.
    await client.realtime.setAuth(data.session.access_token);

    const channel = client.channel(`bom:host:${this.hostId}`, {
      config: { private: true, broadcast: { self: false, ack: false } },
    });
    const on = (event, handler) =>
      channel.on("broadcast", { event }, (message) => handler(message.payload || {}));
    on("res-head", (p) => this._onHead(p));
    on("res-body", (p) => this._onBody(p));
    on("res-alive", (p) => this._onAlive(p));
    on("res-end", (p) => this._onEnd(p));
    on("pong", (p) => this.pings.get(p.id)?.());
    this.channel = channel;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HostUnreachable("The relay didn't answer. Check your connection.")),
        JOIN_TIMEOUT,
      );
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          reject(
            new HostUnreachable(
              error?.message
                ? `The relay refused the connection: ${error.message}`
                : "The relay refused the connection. Is this device still linked to your account?",
            ),
          );
        }
      });
    });
    await this.ping();
  }

  /** Whether the host itself is on the other end, answering. */
  async ping(timeout = PING_TIMEOUT) {
    const id = newId();
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        reject(
          new HostUnreachable(
            "Your host isn't answering. Check it's switched on, with remote access turned on in its Settings.",
          ),
        );
      }, timeout);
      this.pings.set(id, () => {
        clearTimeout(timer);
        this.pings.delete(id);
        resolve();
      });
    });
    await this._send("ping", { id });
    return answered;
  }

  /** Leave the channel. Not final: the next request joins it again. */
  close() {
    for (const entry of [...this.pending.values()]) {
      this._fail(entry, new HostUnreachable("Disconnected from the host."), false);
    }
    this.opening = null;
    this._dropChannel();
  }

  _dropChannel() {
    const { channel, client } = this;
    this.channel = null;
    if (channel && client) client.removeChannel(channel).catch?.(() => {});
  }

  // -- requests --------------------------------------------------------------

  async fetch(path, options = {}) {
    const { method = "GET", body = null, headers = {}, signal } = options;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await this.connect();

    const { data } = await this.client.auth.getSession();
    const jwt = data?.session?.access_token;
    // Handed back as a 401, so the app treats it like any rejected sign-in.
    if (!jwt) return jsonResponse(401, "Signed out of your relay account.");

    const id = newId();
    const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const parts = splitBody(text);
    const contentType =
      headers["Content-Type"] || headers["content-type"] || (text ? "application/json" : null);

    const response = new Promise((resolve, reject) => {
      const entry = {
        id,
        resolve,
        reject,
        assembler: new ResponseAssembler(),
        controller: null,
        headed: false,
        early: [],
        timer: null,
        signal,
        onAbort: null,
      };
      entry.arm = (ms, message) => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this._fail(entry, new HostUnreachable(message)), ms);
      };
      entry.arm(HEAD_TIMEOUT, "Your host took too long to answer.");
      if (signal) {
        entry.onAbort = () => this._fail(entry, new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
    });

    try {
      await this._send("req", {
        id,
        jwt,
        method: method.toUpperCase(),
        path,
        content_type: contentType,
        parts: parts.length,
        body: parts[0],
      });
      for (let i = 1; i < parts.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, PART_GAP));
        // Stopped, or failed, while the body was still going out.
        if (!this.pending.has(id)) return response;
        await this._send("req-part", { id, i, body: parts[i] });
      }
      // The wait for the reply starts once the body is all sent: a large
      // upload shouldn't use up the time the host has to answer.
      if (parts.length > 1) this.pending.get(id)?.arm(HEAD_TIMEOUT, "Your host took too long to answer.");
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) this._fail(entry, error, false);
    }
    return response;
  }

  async _send(event, payload) {
    if (!this.channel) throw new HostUnreachable("Not connected to the relay.");
    const result = await this.channel.send({ type: "broadcast", event, payload });
    if (result && result !== "ok") {
      throw new HostUnreachable(
        result === "timed out" ? "The relay timed out." : "The relay didn't take the message.",
      );
    }
  }

  _onHead(p) {
    const entry = this.pending.get(p.id);
    if (!entry || entry.headed) return;
    entry.headed = true;
    entry.arm(IDLE_TIMEOUT, "Your host stopped answering.");
    const status = Number(p.status) >= 200 && Number(p.status) <= 599 ? Number(p.status) : 502;
    const headers = new Headers(p.headers || {});
    if (NULL_BODY.has(status)) {
      entry.resolve(new Response(null, { status, headers }));
      if (entry.assembler.done) this._finish(entry);
      return;
    }
    const stream = new ReadableStream({
      start: (controller) => {
        entry.controller = controller;
      },
      // The reader was dropped -- a stopped turn, say. Tell the host, which
      // closes its side and keeps whatever had been written.
      cancel: () => {
        this._send("abort", { id: entry.id }).catch(() => {});
        this._finish(entry);
      },
    });
    entry.resolve(new Response(stream, { status, headers }));
    this._deliver(entry, entry.early.splice(0));
  }

  _onBody(p) {
    const entry = this.pending.get(p.id);
    if (!entry) return;
    const ready = entry.assembler.push(p);
    if (entry.headed) {
      entry.arm(IDLE_TIMEOUT, "Your host stopped answering.");
      this._deliver(entry, ready);
    } else {
      // Ahead of the head, somehow: held until it comes.
      entry.early.push(...ready);
    }
  }

  _onAlive(p) {
    const entry = this.pending.get(p.id);
    if (entry) entry.arm(entry.headed ? IDLE_TIMEOUT : HEAD_TIMEOUT, "Your host stopped answering.");
  }

  _onEnd(p) {
    const entry = this.pending.get(p.id);
    if (!entry) return;
    entry.assembler.end(p.count);
    if (p.error) {
      this._fail(entry, new Error(p.error), false);
    } else if (!entry.headed) {
      this._fail(entry, new HostUnreachable("Your host ended the reply before it began."), false);
    } else if (entry.assembler.done) {
      this._finish(entry);
    }
  }

  _deliver(entry, chunks) {
    if (!entry.controller) return;
    for (const chunk of chunks) {
      try {
        entry.controller.enqueue(chunk);
      } catch {
        // The reader went away; cancel() already cleaned up.
      }
    }
    if (entry.assembler.done) this._finish(entry);
  }

  _finish(entry) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    this.pending.delete(entry.id);
    if (entry.controller) {
      try {
        entry.controller.close();
      } catch {
        // already closed or errored
      }
    }
  }

  _fail(entry, error, tellHost = true) {
    if (!this.pending.has(entry.id)) return;
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    this.pending.delete(entry.id);
    if (tellHost) this._send("abort", { id: entry.id }).catch(() => {});
    if (!entry.headed) entry.reject(error);
    else if (entry.controller) {
      try {
        entry.controller.error(error);
      } catch {
        // already closed
      }
    }
  }
}
