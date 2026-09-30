/* The relay's framing, with nothing else attached.
 *
 * A request or a reply crosses the relay as a run of broadcasts, each small
 * enough for Supabase's per-message limit. This file is the arithmetic of
 * that -- splitting a body up, putting a reply back together in order -- kept
 * apart from the connection so it can be tested without one.
 *
 * The other half is server/app/remote/host.py; the two agree on:
 *
 *   client -> host   req       {id, jwt, method, path, content_type, parts, body}
 *                    req-part  {id, i, body}            (parts 1..n-1)
 *                    abort     {id}
 *                    ping      {id}
 *   host -> client   res-head  {id, status, headers}
 *                    res-body  {id, seq, text | b64}
 *                    res-alive {id}                     (still working)
 *                    res-end   {id, count, error?}      (count = res-body frames)
 *                    pong      {id}
 */

// Characters of request body per broadcast. Matches the host's MAX_PART.
export const MAX_PART = 96 * 1024;

/**
 * A request body in parts of at most `max` UTF-16 units -- never splitting a
 * surrogate pair, which the host would otherwise receive as two halves of a
 * character that can no longer be put back together.
 */
export function splitBody(text, max = MAX_PART) {
  const body = text == null ? "" : String(text);
  if (body.length <= max) return [body];
  const parts = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + max, body.length);
    if (end < body.length) {
      const code = body.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    parts.push(body.slice(start, end));
    start = end;
  }
  return parts;
}

const encoder = new TextEncoder();

/** One res-body frame's bytes. */
export function frameBytes(frame) {
  if (typeof frame.text === "string") return encoder.encode(frame.text);
  if (typeof frame.b64 === "string") {
    const raw = atob(frame.b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(0);
}

/**
 * A reply put back in order. Broadcasts on one socket arrive in order in
 * practice, but nothing promises it -- so frames are held until the ones
 * before them are in, and the reply is done only when every frame the host
 * counted has been handed on.
 */
export class ResponseAssembler {
  constructor() {
    this.next = 0;
    this.held = new Map();
    this.count = null;
  }

  /** Take one res-body frame; return the chunks now ready, in order. */
  push(frame) {
    const seq = Number(frame.seq);
    if (!Number.isInteger(seq) || seq < this.next || this.held.has(seq)) return [];
    this.held.set(seq, frameBytes(frame));
    return this.drain();
  }

  /** Every chunk that can be handed on now. */
  drain() {
    const ready = [];
    while (this.held.has(this.next)) {
      ready.push(this.held.get(this.next));
      this.held.delete(this.next);
      this.next += 1;
    }
    return ready;
  }

  /** The host says it sent `count` frames in all. */
  end(count) {
    this.count = Number(count) || 0;
  }

  get done() {
    return this.count !== null && this.next >= this.count;
  }
}
