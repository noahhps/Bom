// bom-pair: linking a Bom host to an account, and unlinking it.
//
// The device-code flow, as TVs and `gh auth login` do it. The device has no
// account and no keyboard worth using, so:
//
//   POST /bom-pair/start    device   -> a code to show, and a secret to poll with
//   POST /bom-pair/lookup   owner    -> which device that code belongs to
//   POST /bom-pair/approve  owner    -> link it: the device gets its own sign-in
//   POST /bom-pair/poll     device   -> pending, or (once) its credentials
//   POST /bom-pair/revoke   owner or the device itself -> unlink
//
// Linking needs both halves: someone signed in to this project, and the code on
// the device's screen -- which only someone standing at the device (or who ran
// the command on it) can read. Neither alone links anything.
//
// Deployed with --no-verify-jwt because /start and /poll come from a device
// that has no account yet. The routes that need one check it themselves.

import { createClient, type User } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Optional: only these accounts may link devices. Comma-separated emails.
// Empty means any account that can sign in to this project -- so for a
// personal relay, either set this or turn off sign-ups once you have yours.
const ALLOWED = (Deno.env.get("BOM_ALLOWED_EMAILS") ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// The address each device's own account is created under. Never mailed; a
// reserved TLD so it can never belong to anyone.
const DEVICE_DOMAIN = Deno.env.get("BOM_DEVICE_EMAIL_DOMAIN") || "devices.bom.invalid";

const PAIRING_MINUTES = 10;
const POLL_SECONDS = 3;
// Wrong codes one account may type in ten minutes before it has to wait.
const MAX_FAILURES = 10;
const MAX_HOSTS_PER_OWNER = 20;
// No 0/O, 1/I/L: this is read off one screen and typed into another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Any origin: nothing here uses cookies, so there is no ambient credential for
// another site to borrow. Every call carries its own proof.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Refusal extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function randomCode(length: number): string {
  // Rejection sampling, so every character is equally likely: 256 is not a
  // multiple of 31, and a plain modulo would favour the first eight.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out;
}

function randomSecret(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a person typed, as it is stored: upper case, no dash or spaces. */
function normaliseCode(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A device's name, as it will be shown back to its owner. */
function cleanName(value: unknown, fallback: string, max = 80): string {
  // deno-lint-ignore no-control-regex
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (name || fallback).slice(0, max);
}

function isDevice(user: User): boolean {
  return Boolean(user.app_metadata?.bom_device);
}

/** The signed-in account behind the request, or a 401. */
async function caller(req: Request): Promise<User> {
  const header = req.headers.get("Authorization") ?? "";
  const jwt = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!jwt) throw new Refusal(401, "Sign in first.");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) throw new Refusal(401, "Your session has expired. Sign in again.");
  return data.user;
}

/** A person, not a device, and one this relay lets link devices. */
async function owner(req: Request): Promise<User> {
  const user = await caller(req);
  if (isDevice(user)) throw new Refusal(403, "A device can't link other devices.");
  const email = (user.email ?? "").toLowerCase();
  if (ALLOWED.length && !ALLOWED.includes(email)) {
    throw new Refusal(403, "This account isn't allowed to link devices on this relay.");
  }
  return user;
}

async function throttle(userId: string): Promise<void> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await admin
    .from("bom_pair_failures")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("at", since);
  if ((count ?? 0) >= MAX_FAILURES) {
    throw new Refusal(429, "Too many wrong codes. Wait a few minutes and try again.");
  }
}

/** The pending pairing a typed code names, or a 404 that counts against the typist. */
async function pendingPairing(userId: string, code: string) {
  await throttle(userId);
  const { data } = await admin
    .from("bom_pairings")
    .select("*")
    .eq("user_code", code)
    .is("approved_by", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!data) {
    await admin.from("bom_pair_failures").insert({ user_id: userId });
    throw new Refusal(404, "That code doesn't match a device waiting to be linked. Check it, or start again on the device.");
  }
  return data;
}

// -- routes -----------------------------------------------------------------

async function start(body: Record<string, unknown>) {
  // Housekeeping on the way in: nothing else runs on a schedule here.
  const now = new Date().toISOString();
  await admin.from("bom_pairings").delete().lt("expires_at", now);
  await admin.from("bom_pair_failures").delete().lt("at", new Date(Date.now() - 3600_000).toISOString());

  const deviceName = cleanName(body.name, "Bom host");
  const platform = cleanName(body.platform, "", 40) || null;
  const deviceCode = randomSecret();
  const expires = new Date(Date.now() + PAIRING_MINUTES * 60_000);

  // A clash on an 8-character code is about one in a trillion; retry anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = randomCode(8);
    const { error } = await admin.from("bom_pairings").insert({
      user_code: userCode,
      device_code_hash: await sha256(deviceCode),
      device_name: deviceName,
      platform,
      expires_at: expires.toISOString(),
    });
    if (!error) {
      return reply(200, {
        user_code: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
        device_code: deviceCode,
        expires_at: expires.toISOString(),
        interval: POLL_SECONDS,
      });
    }
    if (error.code !== "23505") throw new Refusal(500, `Couldn't start pairing: ${error.message}`);
  }
  throw new Refusal(500, "Couldn't start pairing. Try again.");
}

async function lookup(req: Request, body: Record<string, unknown>) {
  const user = await owner(req);
  const pairing = await pendingPairing(user.id, normaliseCode(body.user_code));
  return reply(200, {
    device_name: pairing.device_name,
    platform: pairing.platform,
    expires_at: pairing.expires_at,
  });
}

async function approve(req: Request, body: Record<string, unknown>) {
  const user = await owner(req);
  const pairing = await pendingPairing(user.id, normaliseCode(body.user_code));

  const { count } = await admin
    .from("bom_hosts")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", user.id);
  if ((count ?? 0) >= MAX_HOSTS_PER_OWNER) {
    throw new Refusal(409, `You already have ${MAX_HOSTS_PER_OWNER} devices linked. Remove one first.`);
  }

  // Claim the pairing before doing anything else, so two approvals racing on
  // the same code cannot both create a host.
  const { data: claimed } = await admin
    .from("bom_pairings")
    .update({ approved_by: user.id })
    .eq("id", pairing.id)
    .is("approved_by", null)
    .select("id")
    .maybeSingle();
  if (!claimed) throw new Refusal(409, "That code was just used.");

  const hostId = crypto.randomUUID();
  const { error: hostError } = await admin.from("bom_hosts").insert({
    id: hostId,
    owner_id: user.id,
    name: cleanName(body.name, pairing.device_name),
    platform: pairing.platform,
  });
  if (hostError) throw new Refusal(500, `Couldn't link the device: ${hostError.message}`);

  // The device's own account. Least privilege: it can read its own host row,
  // use its own channel, and nothing else -- it never sees the owner's session.
  const email = `${hostId}@${DEVICE_DOMAIN}`;
  const password = randomSecret(32);
  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { bom_device: true, bom_host_id: hostId, bom_owner_id: user.id },
    user_metadata: { name: pairing.device_name },
  });
  if (userError || !created?.user) {
    await admin.from("bom_hosts").delete().eq("id", hostId);
    await admin.from("bom_pairings").update({ approved_by: null }).eq("id", pairing.id);
    throw new Refusal(500, `Couldn't create the device's sign-in: ${userError?.message ?? "unknown error"}`);
  }

  await admin.from("bom_hosts").update({ device_user_id: created.user.id }).eq("id", hostId);
  await admin
    .from("bom_pairings")
    .update({ host_id: hostId, device_email: email, device_secret: password })
    .eq("id", pairing.id);

  return reply(200, { host_id: hostId, name: pairing.device_name });
}

async function poll(body: Record<string, unknown>) {
  const deviceCode = String(body.device_code ?? "");
  if (deviceCode.length < 32) throw new Refusal(400, "Missing device code.");
  const { data: pairing } = await admin
    .from("bom_pairings")
    .select("*")
    .eq("device_code_hash", await sha256(deviceCode))
    .maybeSingle();
  if (!pairing) throw new Refusal(404, "This pairing is unknown or already finished.");

  if (!pairing.host_id || !pairing.device_secret) {
    if (new Date(pairing.expires_at).getTime() < Date.now()) {
      await admin.from("bom_pairings").delete().eq("id", pairing.id);
      throw new Refusal(410, "The code expired before it was used. Start again.");
    }
    return reply(200, { status: "pending" });
  }

  // Handed over exactly once: the row, and the secret in it, go now.
  await admin.from("bom_pairings").delete().eq("id", pairing.id);
  const { data: ownerData } = await admin.auth.admin.getUserById(pairing.approved_by);
  const { data: host } = await admin
    .from("bom_hosts")
    .select("id, name")
    .eq("id", pairing.host_id)
    .maybeSingle();
  if (!host) throw new Refusal(410, "The device was removed before it finished linking.");

  return reply(200, {
    status: "approved",
    host_id: host.id,
    host_name: host.name,
    owner_id: pairing.approved_by,
    owner_email: ownerData?.user?.email ?? null,
    device_email: pairing.device_email,
    device_password: pairing.device_secret,
  });
}

async function revoke(req: Request, body: Record<string, unknown>) {
  const user = await caller(req);
  const hostId = String(body.host_id ?? "");
  const { data: host } = await admin
    .from("bom_hosts")
    .select("id, owner_id, device_user_id")
    .eq("id", hostId)
    .maybeSingle();
  // The same answer for "no such host" and "not yours", so ids can't be probed.
  if (!host || (host.owner_id !== user.id && host.device_user_id !== user.id)) {
    throw new Refusal(404, "No such device.");
  }
  // Deleting the device's account ends every session it holds; the host row
  // goes with it (on delete cascade), and with the row, its channel access.
  if (host.device_user_id) await admin.auth.admin.deleteUser(host.device_user_id);
  await admin.from("bom_hosts").delete().eq("id", host.id);
  return reply(200, { ok: true });
}

// -- entry ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only." });

  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.length > 4096) throw new Refusal(413, "Request too large.");
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof Refusal) return reply(error.status, { error: error.message });
    return reply(400, { error: "Body must be JSON." });
  }

  try {
    switch (route) {
      case "start":
        return await start(body);
      case "lookup":
        return await lookup(req, body);
      case "approve":
        return await approve(req, body);
      case "poll":
        return await poll(body);
      case "revoke":
        return await revoke(req, body);
      default:
        return reply(404, { error: "Unknown route." });
    }
  } catch (error) {
    if (error instanceof Refusal) return reply(error.status, { error: error.message });
    console.error(error);
    return reply(500, { error: "Something went wrong on the relay." });
  }
});
