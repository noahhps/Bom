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

import { RelayConnection } from "./relay.js";
import { isDesktop } from "./serverOrigin.js";

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
    if (ARRIVAL_SESSION) {
      const tokens = ARRIVAL_SESSION;
      ARRIVAL_SESSION = null;
      ARRIVAL = settleArrival(made, tokens);
    }
  }
  if (ARRIVAL) await ARRIVAL;
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

// -- the desktop app first, then this page -----------------------------------
//
// A sign-in link lands on the web app (Supabase sends it to the project's site
// address) with the new session in the address. On a computer, it is offered
// to the desktop app first, through its bom:// link type; only if no app
// takes it within a few seconds does this page sign in with it. Never both:
// two copies of one session refresh over each other and Supabase ends it.

const APP_SCHEME = "bom";
const NO_APP_KEY = "bom.no-app";
// Long enough for the browser's "Open Bom?" question to take focus.
const APP_WAIT = 3000;

/* The session a sign-in link brought, taken out of the address at once so
 * Supabase's client doesn't sign this page in before the app has been asked. */
let ARRIVAL_SESSION = (() => {
  if (typeof window === "undefined" || isDesktop()) return null;
  const params = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;
  try {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {
    // the address keeps the tokens; harmless, as they are used just once
  }
  return { access_token, refresh_token };
})();
let ARRIVAL = null;
// Handed to the app, and kept in case it didn't really open.
let HANDED_OFF = null;

function wantsApp() {
  if (typeof navigator === "undefined") return false;
  // No desktop app on a phone or tablet (an iPad says it is a Mac).
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return false;
  if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return false;
  try {
    return !localStorage.getItem(NO_APP_KEY);
  } catch {
    return true;
  }
}

/** Ask the system to open the desktop app; true if the page lost focus to it. */
function openApp(tokens) {
  const url = `${APP_SCHEME}://auth#${new URLSearchParams(tokens)}`;
  return new Promise((resolve) => {
    let left = false;
    const mark = () => {
      left = true;
    };
    const hidden = () => {
      if (document.hidden) left = true;
    };
    window.addEventListener("blur", mark);
    window.addEventListener("pagehide", mark);
    document.addEventListener("visibilitychange", hidden);
    // Firefox shows an error page when the whole page goes to a link type
    // nothing handles; from a hidden frame, nothing happens.
    let frame = null;
    if (/Firefox\//.test(navigator.userAgent)) {
      frame = document.createElement("iframe");
      frame.style.display = "none";
      frame.src = url;
      document.body.appendChild(frame);
    } else {
      window.location.href = url;
    }
    setTimeout(() => {
      window.removeEventListener("blur", mark);
      window.removeEventListener("pagehide", mark);
      document.removeEventListener("visibilitychange", hidden);
      frame?.remove();
      resolve(left);
    }, APP_WAIT);
  });
}

async function settleArrival(sb, tokens) {
  if (wantsApp()) {
    if (await openApp(tokens)) {
      HANDED_OFF = tokens;
      return;
    }
    // Nothing here answers bom:// -- don't make the next sign-in wait too.
    try {
      localStorage.setItem(NO_APP_KEY, "1");
    } catch {
      // asked again next time
    }
  }
  const { error } = await sb.auth.setSession(tokens);
  if (error) ARRIVAL_ERROR = signInProblem(error.message);
}

/** Whether this page's sign-in was passed to the desktop app. */
export function handedToApp() {
  return HANDED_OFF !== null;
}

/** The app didn't open after all: sign in on this page instead. */
export async function signInHereInstead() {
  const tokens = HANDED_OFF;
  if (!tokens) return;
  HANDED_OFF = null;
  try {
    localStorage.setItem(NO_APP_KEY, "1");
  } catch {
    // fine
  }
  const sb = await relayClient();
  const { error } = await sb.auth.setSession(tokens);
  if (error) throw new Error(signInProblem(error.message));
}

// -- the desktop app's end ---------------------------------------------------

const PENDING_KEY = "bom.relay.pending";
// A sign-in this app asked for is expected back for about as long as the
// link in the email lasts.
const PENDING_FOR = 60 * 60 * 1000;

function rememberPending(email) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email: email.toLowerCase(), at: Date.now() }));
  } catch {
    // then the link will be confirmed by hand
  }
}

function jwtClaims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return null;
  }
}

/** `{access_token, refresh_token}` from a bom://auth link, or null. */
export function appLinkSession(link) {
  let url;
  try {
    url = new URL(String(link));
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:`) return null;
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  return access_token && refresh_token ? { access_token, refresh_token } : null;
}

/**
 * Sign this app in with a session a sign-in link handed it (see openApp).
 * A link carries a whole session, so one could be crafted to sign this app
 * in to someone else's account -- where a device linked next would be
 * theirs. Taken without asking only when it answers a sign-in this app asked
 * for, for the same email; anything else needs `confirm(email)` to say yes.
 */
export async function acceptAppLink(link, confirm) {
  const tokens = appLinkSession(link);
  const config = relayConfig();
  if (!tokens || !config) return false;
  const claims = jwtClaims(tokens.access_token);
  // A session from another relay is no use here, whoever sent it.
  if (!claims?.email || claims.iss !== `${config.url}/auth/v1`) return false;
  const email = String(claims.email).toLowerCase();
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
  } catch {
    // none
  }
  const expected = pending?.email === email && Date.now() - pending.at < PENDING_FOR;
  if (!expected && !(await confirm(email))) return false;
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // fine
  }
  const sb = await relayClient();
  const { error } = await sb.auth.setSession(tokens);
  if (error) throw new Error(signInProblem(error.message));
  return true;
}

const SEEN_LINKS = new Set();

/** Hand every bom:// link the app is opened with to `handle`. Returns a stop function. */
export async function watchAppLinks(handle) {
  if (!isDesktop()) return () => {};
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const each = (urls) => {
    for (const url of urls || []) {
      // The link the app was launched with is reported to every watcher.
      if (SEEN_LINKS.has(url)) continue;
      SEEN_LINKS.add(url);
      handle(url);
    }
  };
  each(await getCurrent().catch(() => null));
  return onOpenUrl(each);
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
  return (
    Boolean(ARRIVAL_ERROR) ||
    Boolean(ARRIVAL_SESSION || ARRIVAL) ||
    /access_token=/.test(hash) ||
    /[?&]link=/.test(search)
  );
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
  const overHttp = /^https?:$/.test(window.location.protocol) && !isDesktop();
  const { error } = await sb.auth.signInWithOtp({
    email: email.trim(),
    // The link comes back to this page when it is a web page. From the
    // desktop app it goes to the web app, which hands it on (openApp).
    options: overHttp ? { emailRedirectTo: window.location.origin + window.location.pathname } : {},
  });
  if (error) throw new Error(signInProblem(error.message));
  if (isDesktop()) rememberPending(email.trim());
}

/* The one-time token inside an emailed sign-in link, pasted rather than
 * opened -- for when the link can't reach the desktop app by itself (an app
 * built before it handled bom:// links, say), and on Supabase's free tier
 * the emails carry no code. The link is
 * https://<ref>.supabase.co/auth/v1/verify?token=<hash>&type=magiclink&...,
 * and the hash is verified directly, so the link itself is never visited. */
const LINK_TYPES = new Set(["magiclink", "signup", "email"]);

export function signInLinkToken(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    return null;
  }
  const token = url.searchParams.get("token");
  const type = url.searchParams.get("type");
  if (!/\/auth\/v1\/verify$/.test(url.pathname) || !token || !LINK_TYPES.has(type)) return null;
  return { token_hash: token, type };
}

export async function verifySignInCode(email, code) {
  const sb = await relayClient();
  const link = signInLinkToken(code);
  const { data, error } = await sb.auth.verifyOtp(
    link || { email: email.trim(), token: String(code).replace(/\s+/g, ""), type: "email" },
  );
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
