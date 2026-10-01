/* Remote hosts: the relay, the account, and the devices linked to it.
 *
 * A host is a Bom server on someone's own machine that has been linked to
 * their account on a relay -- a Supabase project they own. This file is the
 * client's side of that: where the relay is, signing in to it, listing and
 * linking devices, and opening a connection to one (relay.js).
 *
 * Supabase's client is imported only when something here is actually used, so
 * a local-only install never downloads it.
 */

import { RelayConnection } from "./relay";

const CONFIG_KEY = "bom.relay";
const HOST_KEY = "bom.remote-host";
const AUTH_KEY = "bom.relay.auth";

const env = (typeof import.meta !== "undefined" && import.meta.env) || {};

/** Built for the hosted web app, where there is no local server to fall back to. */
export const REMOTE_ONLY = env.VITE_BOM_REMOTE_ONLY === "1";

/** Whether the relay's address came with this build, rather than being typed in. */
export function relayFromBuild() {
  return Boolean(env.VITE_BOM_RELAY_URL && env.VITE_BOM_RELAY_KEY);
}

/** `{url, key}` for the relay, or null if none is known. */
export function relayConfig() {
  if (relayFromBuild()) {
    return { url: String(env.VITE_BOM_RELAY_URL).replace(/\/+$/, ""), key: String(env.VITE_BOM_RELAY_KEY) };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    if (saved?.url && saved?.key) return saved;
  } catch {
    // unreadable or no storage
  }
  return null;
}

export function saveRelayConfig({ url, key }) {
  const value = { url: String(url || "").trim().replace(/\/+$/, ""), key: String(key || "").trim() };
  if (!/^https:\/\/[^\s/]+$/.test(value.url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(value.url)) {
    throw new Error("The relay address should look like https://<project>.supabase.co");
  }
  if (!value.key) throw new Error("Paste the project's anon or publishable key.");
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(value));
  } catch {
    // kept for this run only
  }
  client = null;
  return value;
}

// -- the host this device last used ----------------------------------------

/** `{id, name}` of the host to reconnect to on launch, or null. */
export function savedHost() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_KEY) || "null");
    return saved?.id ? saved : null;
  } catch {
    return null;
  }
}

export function saveHost(host) {
  try {
    localStorage.setItem(HOST_KEY, JSON.stringify({ id: host.id, name: host.name }));
  } catch {
    // reconnecting on the next launch is a convenience, not a need
  }
}

export function forgetHost() {
  try {
    localStorage.removeItem(HOST_KEY);
  } catch {
    // nothing to forget
  }
}

// -- the relay client -------------------------------------------------------

let client = null;

/** The Supabase client for the configured relay, made on first use. */
export async function relayClient() {
  const config = relayConfig();
  if (!config) throw new Error("No relay is set up on this device.");
  if (!client || client.key !== config.url + config.key) {
    const { createClient } = await import("@supabase/supabase-js");
    const made = createClient(config.url, config.key, {
      auth: {
        storageKey: AUTH_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // The sign-in link in the email lands back here with the session in
        // the address; this picks it up.
        detectSessionInUrl: true,
      },
    });
    client = { key: config.url + config.key, sb: made };
  }
  return client.sb;
}

/* A sign-in link that failed comes back with the reason in the address
 * (`#error_code=otp_expired&error_description=...`). Read once, when this
 * module loads -- before anything else can rewrite the address -- so the
 * sign-in screen can say what happened rather than show nothing. */
let ARRIVAL_ERROR = (() => {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(
    (window.location.hash || "").replace(/^#/, "") || window.location.search.replace(/^\?/, ""),
  );
  const code = params.get("error_code") || params.get("error") || "";
  const text = params.get("error_description") || "";
  if (!code && !text) return "";
  try {
    const url = new URL(window.location.href);
    url.hash = "";
    for (const key of ["error", "error_code", "error_description"]) url.searchParams.delete(key);
    window.history.replaceState(null, "", url.pathname + url.search);
  } catch {
    // the address stays as it is; nothing else depends on it
  }
  if (/expired|otp_expired|invalid/i.test(code + " " + text)) {
    return "That sign-in link had expired or was already used — some email apps open links to scan them. Use the code in the email instead, or send a new one.";
  }
  return text.replace(/\+/g, " ") || "The sign-in link didn't work. Use the code in the email instead.";
})();

/** Why the sign-in link this page was opened from failed, or "". Read as
 * often as needed (React may run an initializer twice); cleared once a new
 * code is on its way, when it has stopped being news. */
export function arrivalError() {
  return ARRIVAL_ERROR;
}

/** Supabase's wording, turned into what to do about it. */
function signInProblem(message) {
  const text = String(message || "");
  if (/expired|invalid/i.test(text) && /token|otp|code/i.test(text)) {
    return "That code didn't work. Codes work once, and only the newest one counts — use the code from the latest email, or send a new one.";
  }
  if (/rate limit|only request this after|too many/i.test(text)) {
    return `${text}. Supabase's built-in email sends only a few messages an hour — use the code from the last email you got, or wait a little.`;
  }
  if (/signups not allowed|signup is disabled/i.test(text)) {
    return "This relay doesn't allow new accounts. Sign in with the email you set it up with.";
  }
  return text;
}

/** Whether this page was opened from a sign-in email or a device's link. */
export function arrivedForRemote() {
  if (typeof window === "undefined") return false;
  const { hash, search } = window.location;
  return Boolean(ARRIVAL_ERROR) || /access_token=/.test(hash) || /[?&]link=/.test(search);
}

/** The pairing code in `?link=`, taken out of the address so a reload does not reuse it. */
export function takeLinkCode() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const code = url.searchParams.get("link") || "";
  if (code) {
    url.searchParams.delete("link");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Show a pairing code the way the device shows it: ABCD-EFGH. */
export function formatCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

// -- the account ------------------------------------------------------------

export async function currentAccount() {
  const sb = await relayClient();
  const { data } = await sb.auth.getSession();
  return data?.session?.user || null;
}

export async function onAccountChange(callback) {
  const sb = await relayClient();
  const { data } = sb.auth.onAuthStateChange((_event, session) => callback(session?.user || null));
  return () => data.subscription.unsubscribe();
}

/** Email a sign-in code (and link) to this address. */
export async function sendSignInCode(email) {
  ARRIVAL_ERROR = "";
  const sb = await relayClient();
  const overHttp = /^https?:$/.test(window.location.protocol);
  const { error } = await sb.auth.signInWithOtp({
    email: email.trim(),
    // The link can only come back to a page served over http(s); the desktop
    // app signs in with the code instead.
    options: overHttp ? { emailRedirectTo: window.location.origin + window.location.pathname } : {},
  });
  if (error) throw new Error(signInProblem(error.message));
}

export async function verifySignInCode(email, code) {
  const sb = await relayClient();
  const { data, error } = await sb.auth.verifyOtp({
    email: email.trim(),
    token: String(code).replace(/\s+/g, ""),
    type: "email",
  });
  if (error) throw new Error(signInProblem(error.message));
  return data.user;
}

export async function signOutAccount() {
  const sb = await relayClient();
  forgetHost();
  await sb.auth.signOut();
}

// -- devices ----------------------------------------------------------------

/** How recently a host must have checked in to count as up. */
const ONLINE_WINDOW = 150_000;

export async function listHosts() {
  const sb = await relayClient();
  const { data, error } = await sb
    .from("bom_hosts")
    .select("id, name, platform, created_at, last_seen_at")
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(
      /relation|does not exist|schema cache/i.test(error.message)
        ? "The relay isn't set up yet. Run relay/setup.sh (see docs/remote.md)."
        : error.message,
    );
  }
  const now = Date.now();
  return (data || []).map((host) => ({
    ...host,
    online: Boolean(host.last_seen_at) && now - new Date(host.last_seen_at).getTime() < ONLINE_WINDOW,
  }));
}

async function pairing(route, body) {
  const sb = await relayClient();
  const { data, error } = await sb.functions.invoke(`bom-pair/${route}`, { body });
  if (error) {
    let message = error.message;
    try {
      const detail = await error.context?.json?.();
      if (detail?.error) message = detail.error;
    } catch {
      // not JSON; the client's own message will do
    }
    throw new Error(message);
  }
  return data;
}

/** Which device a pairing code belongs to, before linking it. */
export const lookupDevice = (code) => pairing("lookup", { user_code: code });
/** Link it: the device, polling, picks up its own sign-in and comes online. */
export const linkDevice = (code) => pairing("approve", { user_code: code });
/** Unlink a device: its sign-in is deleted, and with it, its access. */
export const removeHost = (hostId) => pairing("revoke", { host_id: hostId });

/** A connection to one host. Nothing is sent until the first request. */
export function openRelay(hostId) {
  return new RelayConnection(relayClient, hostId);
}
