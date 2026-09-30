// The relay's framing: a body split for the trip, a reply put back together.
//
// Run with `npm test` in client/. The other end is server/app/remote/host.py,
// whose tests check the same format from the host's side.

import assert from "node:assert/strict";

import { HostUnreachable, RelayConnection } from "../src/lib/relay.js";
import { MAX_PART, ResponseAssembler, frameBytes, splitBody } from "../src/lib/relayFrames.js";

const decode = (chunks) => new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));

// -- splitting ---------------------------------------------------------------

assert.deepEqual(splitBody(""), [""], "an empty body is one empty part");
assert.deepEqual(splitBody(null), [""]);
assert.deepEqual(splitBody("abc"), ["abc"]);

{
  const body = "x".repeat(MAX_PART * 2 + 5);
  const parts = splitBody(body);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), body);
  assert.ok(parts.every((p) => p.length <= MAX_PART));
}

{
  // A surrogate pair straddling the boundary stays whole, in the next part.
  const body = "a".repeat(9) + "😀" + "b".repeat(5);
  const parts = splitBody(body, 10);
  assert.equal(parts.join(""), body);
  for (const part of parts) {
    const last = part.charCodeAt(part.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no part ends on half a character");
  }
  assert.equal(parts[0], "a".repeat(9));
}

// -- frames ------------------------------------------------------------------

assert.equal(decode([frameBytes({ text: "héllo ☃" })]), "héllo ☃");
assert.deepEqual([...frameBytes({ b64: Buffer.from([0, 1, 254, 255]).toString("base64") })], [0, 1, 254, 255]);
assert.equal(frameBytes({}).length, 0);

// -- reassembly --------------------------------------------------------------

{
  const reply = new ResponseAssembler();
  assert.deepEqual(reply.push({ seq: 1, text: "b" }), [], "held until 0 arrives");
  assert.equal(decode(reply.push({ seq: 0, text: "a" })), "ab", "then both, in order");
  assert.deepEqual(reply.push({ seq: 0, text: "a" }), [], "a repeat is ignored");
  assert.equal(reply.done, false);
  reply.end(3);
  assert.equal(reply.done, false, "not done until every counted frame is in");
  assert.equal(decode(reply.push({ seq: 2, text: "c" })), "c");
  assert.equal(reply.done, true);
}

{
  const empty = new ResponseAssembler();
  empty.end(0);
  assert.equal(empty.done, true, "a reply with no body is done at once");
}

{
  // A character split across two frames by bytes (the host sends text only
  // on character boundaries, but binary may split anywhere).
  const bytes = Buffer.from("☃");
  const reply = new ResponseAssembler();
  const got = [
    ...reply.push({ seq: 0, b64: bytes.subarray(0, 1).toString("base64") }),
    ...reply.push({ seq: 1, b64: bytes.subarray(1).toString("base64") }),
  ];
  assert.equal(decode(got), "☃");
}

// -- the connection, against a stand-in channel ---------------------------------
//
// The host is played by `serve(event, payload, emit)`; what the client sends
// reaches it on the next tick, as it would over the relay.

function fakeRelay(serve, { session = { access_token: "jwt" } } = {}) {
  const handlers = {};
  const sent = [];
  const emit = (event, payload) => handlers[event]?.({ payload });
  const channel = {
    on(_type, { event }, handler) {
      handlers[event] = handler;
      return channel;
    },
    subscribe(callback) {
      setTimeout(() => callback("SUBSCRIBED"), 0);
      return channel;
    },
    async send({ event, payload }) {
      sent.push({ event, payload });
      setTimeout(() => serve(event, payload, emit), 0);
      return "ok";
    },
  };
  const client = {
    auth: { getSession: async () => ({ data: { session } }) },
    realtime: { setAuth: async () => {} },
    channel: (topic, options) => {
      client.topic = topic;
      client.options = options;
      return channel;
    },
    removeChannel: async () => {},
  };
  return { client, sent };
}

const host = (reply) => (event, payload, emit) => {
  if (event === "ping") emit("pong", { id: payload.id });
  if (event === "req") reply(payload, emit);
};

async function run() {
  {
    // A JSON reply, with its frames delivered out of order.
    const { client, sent } = fakeRelay(
      host((req, emit) => {
        emit("res-head", { id: req.id, status: 200, headers: { "content-type": "application/json" } });
        emit("res-body", { id: req.id, seq: 1, text: '"world"}' });
        emit("res-body", { id: req.id, seq: 0, text: '{"hello":' });
        emit("res-end", { id: req.id, count: 2 });
      }),
    );
    const relay = new RelayConnection(async () => client, "abc");
    const response = await relay.fetch("/status", { headers: { "Content-Type": "application/json" } });
    assert.equal(client.topic, "bom:host:abc");
    assert.equal(client.options.config.private, true, "the channel is private");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hello: "world" });
    const req = sent.find((m) => m.event === "req").payload;
    assert.equal(req.jwt, "jwt", "every request carries the account's session");
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/status");
    assert.equal(relay.pending.size, 0, "nothing left waiting");
  }

  {
    // A long body goes in parts, and a 204 has no body at all.
    const { client, sent } = fakeRelay(
      host((req, emit) => {
        emit("res-head", { id: req.id, status: 204, headers: {} });
        emit("res-end", { id: req.id, count: 0 });
      }),
    );
    const relay = new RelayConnection(async () => client, "abc");
    const body = JSON.stringify({ data: "z".repeat(MAX_PART * 2) });
    const response = await relay.fetch("/images", { method: "POST", body });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    const req = sent.find((m) => m.event === "req").payload;
    const rest = sent.filter((m) => m.event === "req-part").map((m) => m.payload);
    assert.equal(req.parts, 3);
    assert.equal(req.content_type, "application/json");
    assert.equal(req.body + rest.map((p) => p.body).join(""), body);
  }

  {
    // A stream: the body is readable before the reply is over.
    let finish;
    const { client } = fakeRelay(
      host((req, emit) => {
        emit("res-head", { id: req.id, status: 200, headers: { "content-type": "text/event-stream" } });
        emit("res-body", { id: req.id, seq: 0, text: "event: delta\ndata: {}\n\n" });
        finish = () => {
          emit("res-body", { id: req.id, seq: 1, text: "event: done\ndata: {}\n\n" });
          emit("res-end", { id: req.id, count: 2 });
        };
      }),
    );
    const relay = new RelayConnection(async () => client, "abc");
    const response = await relay.fetch("/chat", { method: "POST", body: "{}" });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: delta/);
    finish();
    const second = await reader.read();
    assert.match(new TextDecoder().decode(second.value), /event: done/);
    assert.equal((await reader.read()).done, true);
  }

  {
    // Stopping a turn aborts it at the host too.
    const { client, sent } = fakeRelay(
      host((req, emit) => {
        emit("res-head", { id: req.id, status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const relay = new RelayConnection(async () => client, "abc");
    const controller = new AbortController();
    const response = await relay.fetch("/chat", { method: "POST", body: "{}", signal: controller.signal });
    const reading = response.body.getReader().read();
    controller.abort();
    await assert.rejects(reading, { name: "AbortError" });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(sent.some((m) => m.event === "abort"), "the host is told");
  }

  {
    // A failure the host reports, before and after the reply began.
    const { client } = fakeRelay(
      host((req, emit) => {
        if (req.path === "/early") emit("res-end", { id: req.id, count: 0, error: "local server down" });
        else {
          emit("res-head", { id: req.id, status: 200, headers: {} });
          emit("res-end", { id: req.id, count: 0, error: "dropped mid-reply" });
        }
      }),
    );
    const relay = new RelayConnection(async () => client, "abc");
    await assert.rejects(relay.fetch("/early"), /local server down/);
    const late = await relay.fetch("/late");
    await assert.rejects(late.text(), /dropped mid-reply/);
  }

  {
    // Signed out of the relay account: a 401, so the app goes back to the gate.
    const { client } = fakeRelay(host(() => {}), { session: null });
    const relay = new RelayConnection(async () => client, "abc");
    await assert.rejects(relay.fetch("/status"), HostUnreachable);
  }

  {
    // A host that never answers the ping is reported as such, quickly.
    const { client } = fakeRelay(() => {});
    const relay = new RelayConnection(async () => client, "abc");
    relay.ping = RelayConnection.prototype.ping.bind(relay, 20);
    await assert.rejects(relay.fetch("/status"), /isn't answering/);
  }
}

await run();
console.log("relay framing and connection: ok");
