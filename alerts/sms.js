// Text message delivery.
//   SMS_PROVIDER=twilio   Twilio's Messages API
//   SMS_PROVIDER=webhook  POST {"to": "+1...", "body": "..."} as JSON to your own endpoint (any other gateway)
const { NETWORK_TIMEOUT_MS, MAX_TEXT_MESSAGE_LENGTH } = require("../lib/constants");
const { isLocalHost } = require("../lib/http");

// E.164: "+", a country code that does not start with 0, then the rest of the number; 8 to 15 digits in all.
const INTERNATIONAL_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;
const TWILIO_ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/i;
const TWILIO_API_KEY_SID_PATTERN = /^SK[0-9a-f]{32}$/i;
const NORTH_AMERICA_COUNTRY_CODE = "1";
const NORTH_AMERICA_NUMBER_WITH_COUNTRY_CODE_LENGTH = 11; // 1 + 10 digits
const INTERNATIONAL_DIALING_PREFIX = "00";
const DIGITS_SHOWN_WHEN_MASKED = 4;
const MAX_ERROR_TEXT = 200;

// Turns what a person typed ("(317) 555-0100", "+44 20 7946 0958") into +E.164 form, or null if it isn't a phone number.
function normalizePhoneNumber(input, defaultCountryCode = NORTH_AMERICA_COUNTRY_CODE) {
  let text = String(input || "").trim();
  if (!text) return null;
  const startsWithPlus = text.startsWith("+");
  text = text.replace(/[\s().-]/g, "");
  if (startsWithPlus) text = text.slice(1);
  if (!/^\d+$/.test(text)) return null;
  if (!startsWithPlus) {
    const alreadyHasNorthAmericanCode = defaultCountryCode === NORTH_AMERICA_COUNTRY_CODE && text.length === NORTH_AMERICA_NUMBER_WITH_COUNTRY_CODE_LENGTH && text.startsWith(NORTH_AMERICA_COUNTRY_CODE);
    if (text.startsWith(INTERNATIONAL_DIALING_PREFIX)) text = text.slice(INTERNATIONAL_DIALING_PREFIX.length);
    else if (!alreadyHasNorthAmericanCode) text = defaultCountryCode + text;
  }
  const number = "+" + text;
  return INTERNATIONAL_NUMBER_PATTERN.test(number) ? number : null;
}

// "+13175550101" -> "+•••0101": enough to recognise, not enough to reuse.
function maskPhoneNumber(number) {
  if (!number) return "";
  const hidden = number.slice(0, -DIGITS_SHOWN_WHEN_MASKED).replace(/\d/g, "•").replace(/•+/, "•••");
  return hidden + number.slice(-DIGITS_SHOWN_WHEN_MASKED);
}

function urlProblem(url, settingName) {
  let parsed;
  try { parsed = new URL(url); } catch { return `${settingName} is not a valid URL.`; }
  const allowed = parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalHost(parsed.hostname));
  return allowed ? null : `${settingName} must use https:// (http is allowed only for localhost).`;
}

function createSmsSender(settings) {
  const provider = settings.provider;
  const usesApiKey = !!settings.twilioApiKeySid;

  let problem = null;
  if (provider === "twilio") {
    if (!TWILIO_ACCOUNT_SID_PATTERN.test(settings.twilioAccountSid)) problem = "The Twilio Account SID is missing or not valid (it starts with AC).";
    else if (usesApiKey && !TWILIO_API_KEY_SID_PATTERN.test(settings.twilioApiKeySid)) problem = "The Twilio API key SID is not valid (it starts with SK).";
    else if (usesApiKey && !settings.twilioApiKeySecret) problem = "The Twilio API key secret is missing.";
    else if (!usesApiKey && !settings.twilioAuthToken) problem = "Enter a Twilio API key SID and secret (recommended), or the account Auth Token.";
    else if (!settings.twilioFromNumber && !settings.twilioMessagingServiceSid) problem = "Enter the Twilio number to send from, or a Messaging Service SID.";
    else if (settings.twilioFromNumber && !INTERNATIONAL_NUMBER_PATTERN.test(settings.twilioFromNumber)) problem = "The Twilio number to send from must be in +15555550100 form.";
    else problem = urlProblem(settings.twilioApiBase, "TWILIO_API_BASE");
  } else if (provider === "webhook") {
    problem = settings.webhookUrl ? urlProblem(settings.webhookUrl, "The webhook address (SMS_WEBHOOK_URL)") : "The webhook address is missing.";
  } else if (provider) {
    problem = `Unknown text provider "${provider}". Use Twilio or webhook.`;
  }
  const configured = !!provider && !problem;
  if (problem) console.error(`Text alerts disabled: ${problem}`);

  async function sendWithTwilio(to, body) {
    const form = new URLSearchParams({ To: to, Body: body });
    if (settings.twilioMessagingServiceSid) form.set("MessagingServiceSid", settings.twilioMessagingServiceSid);
    else form.set("From", settings.twilioFromNumber);
    const credentials = usesApiKey ? `${settings.twilioApiKeySid}:${settings.twilioApiKeySecret}` : `${settings.twilioAccountSid}:${settings.twilioAuthToken}`;
    const response = await fetch(`${settings.twilioApiBase.replace(/\/$/, "")}/2010-04-01/Accounts/${settings.twilioAccountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(credentials).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(`Twilio refused the message: ${details.code ? `error ${details.code}, ` : ""}${String(details.message || response.statusText).slice(0, MAX_ERROR_TEXT)}`);
    }
  }

  async function sendWithWebhook(to, body) {
    const headers = { "Content-Type": "application/json" };
    if (settings.webhookToken) headers.Authorization = "Bearer " + settings.webhookToken;
    const response = await fetch(settings.webhookUrl, { method: "POST", headers, body: JSON.stringify({ to, body }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), redirect: "error" });
    if (!response.ok) throw new Error(`SMS webhook returned HTTP ${response.status}`);
  }

  async function send(to, body) {
    if (!configured) throw new Error(problem || "Text messages are not set up on this server.");
    if (!INTERNATIONAL_NUMBER_PATTERN.test(to)) throw new Error("Phone number is not valid.");
    const trimmedBody = String(body).slice(0, MAX_TEXT_MESSAGE_LENGTH);
    if (provider === "twilio") await sendWithTwilio(to, trimmedBody);
    else await sendWithWebhook(to, trimmedBody);
  }

  function describe() {
    if (!configured) return { configured: false, problem };
    const sender = provider === "twilio"
      ? (settings.twilioMessagingServiceSid ? "Messaging Service " + settings.twilioMessagingServiceSid.slice(0, 6) + "…" : settings.twilioFromNumber)
      : new URL(settings.webhookUrl).host;
    return { configured: true, provider, sender };
  }

  return { configured, problem, describe, send };
}

module.exports = { createSmsSender, normalizePhoneNumber, maskPhoneNumber, INTERNATIONAL_NUMBER_PATTERN };
