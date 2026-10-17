// Turns an alert into an email (plain text + simple HTML) and a short text message.
const { ALERT_EVENTS } = require("./events");
const { ALERT_EXCERPT_LENGTH, MINUTE_MS } = require("../lib/constants");

const PRIORITY_LABEL = { P1: "P1 Critical", P2: "P2 High", P3: "P3 Normal", P4: "P4 Low" };
const MINUTES_PER_HOUR = 60;
const HOURS_BEFORE_SHOWING_DAYS = 48;
const HOURS_PER_DAY = 24;

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Shortens text to `maxLength` characters on one line, ending with "…" when cut.
const excerpt = (text, maxLength) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > maxLength ? flat.slice(0, maxLength - 1) + "…" : flat; };

const formatDateTime = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const formatDueDate = (isoDate) => new Date(isoDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
// 35 -> "35 min", 125 min -> "2 h", 3 days -> "3 days"
function describeDuration(ms) {
  const minutes = Math.round(Math.abs(ms) / MINUTE_MS);
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min`;
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_BEFORE_SHOWING_DAYS) return `${hours} h`;
  return `${Math.round(hours / HOURS_PER_DAY)} days`;
}

// Email colours match the app's light theme (email clients ignore page stylesheets, so they are inline here).
const EMAIL_COLORS = { page: "#f3f5f7", card: "#ffffff", border: "#d5dce3", text: "#15202b", muted: "#5b6876", accent: "#0c6c8a", accentText: "#ffffff" };

/**
 * headline   "TKT-1042 was assigned to you by Nick"
 * title      the ticket or task title
 * facts      short lines under the title (priority, status, due date…)
 * quote      optional longer text (a comment, a description)
 * url        link back into Lighthouse, or null
 * eventKey   which alert this is (used to explain why it was sent)
 * sms        { full, short } text-message wording; `short` is used when SMS_INCLUDE_DETAILS=false
 */
function composeAlert({ headline, title, facts = [], quote = null, url, eventKey, sms }, { includeDetailsInTexts }) {
  const reason = `You get this because "${ALERT_EVENTS[eventKey].label}" is on in your Lighthouse alert settings.`;
  const visibleFacts = facts.filter(Boolean);
  const quoteLines = quote ? ["", ...String(quote).split("\n").map((line) => "> " + line)] : [];

  const text = [
    headline, "", title, ...visibleFacts, ...quoteLines, "",
    url ? `Open: ${url}` : "Open Lighthouse to see it.", "", "--",
    reason, "Change alert settings: Lighthouse > Settings > My alerts.",
  ].join("\n");

  const c = EMAIL_COLORS;
  const row = (content, style) => `<tr><td style="${style}">${content}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:${c.page};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${c.text}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:${c.card};border:1px solid ${c.border};border-radius:8px">
${row("Lighthouse Service Desk", `padding:20px 24px 4px;font-size:13px;color:${c.muted}`)}
${row(escapeHtml(headline), "padding:4px 24px 0;font-size:15px")}
${row(escapeHtml(title), "padding:10px 24px 0;font-size:19px;font-weight:600")}
${visibleFacts.map((fact) => row(escapeHtml(fact), `padding:4px 24px 0;font-size:14px;color:${c.muted}`)).join("")}
${quote ? row(`<div style="border-left:3px solid ${c.accent};padding:6px 12px;background:${c.page};font-size:14px;white-space:pre-wrap">${escapeHtml(quote)}</div>`, "padding:14px 24px 0") : ""}
${url ? row(`<a href="${escapeHtml(url)}" style="display:inline-block;background:${c.accent};color:${c.accentText};text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open in Lighthouse</a>`, "padding:20px 24px 4px") : ""}
${row(escapeHtml(reason), `padding:18px 24px 22px;font-size:12px;color:${c.muted}`)}
</table></td></tr></table></body></html>`;

  const smsText = `Lighthouse: ${includeDetailsInTexts ? sms.full : sms.short}${url ? " " + url : ""}`;
  return { subject: `[Lighthouse] ${headline.replace(/\.$/, "")}: ${excerpt(title, ALERT_EXCERPT_LENGTH.title)}`, text, html, sms: smsText };
}

module.exports = { composeAlert, excerpt, formatDateTime, formatDueDate, describeDuration, PRIORITY_LABEL };
