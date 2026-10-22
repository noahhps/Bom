// Brand marks for the services the MCP gallery offers, bundled with the app.
//
// The server can fetch a site's favicon, but that needs the internet at the
// moment the page opens, and what comes back is whatever the site happens to
// serve -- a 16px PNG here, a blurry ICO there. These are vectors, drawn the
// same way every time and with no request behind them. Sources and licences
// are in assets/logos/LICENSES.md.
//
// Keyed by the server's name, which is the preset id for anything installed
// from the gallery -- so a server keeps its logo after it is added.
import atlassian from "../assets/logos/atlassian.svg";
import exa from "../assets/logos/exa.svg";
import figma from "../assets/logos/figma.svg";
import firecrawl from "../assets/logos/firecrawl.svg";
import github from "../assets/logos/github.svg";
import google from "../assets/logos/google.svg";
import googleCalendar from "../assets/logos/google-calendar.svg";
import huggingface from "../assets/logos/huggingface.svg";
import jira from "../assets/logos/jira.svg";
import linear from "../assets/logos/linear.svg";
import notion from "../assets/logos/notion.svg";
import playwright from "../assets/logos/playwright.svg";
import sentry from "../assets/logos/sentry.svg";
import stripe from "../assets/logos/stripe.svg";
import supabase from "../assets/logos/supabase.svg";
import vercel from "../assets/logos/vercel.svg";

const LOGOS = {
  atlassian,
  jira_confluence: jira,
  jira,
  linear,
  notion,
  sentry,
  stripe,
  figma,
  figma_api: figma,
  google_workspace: google,
  google_calendar: googleCalendar,
  github,
  exa,
  huggingface,
  firecrawl,
  playwright,
  supabase,
  vercel,
};

export function logoFor(name) {
  const key = String(name || "").toLowerCase().replace(/[\s-]+/g, "_");
  return LOGOS[key] || null;
}
