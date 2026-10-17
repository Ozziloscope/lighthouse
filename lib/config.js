// Reads the server's settings from environment variables, once, at startup.
// Every setting is described in README.md ("Configuration") and docs/ALERTS.md.
const { DEFAULT_SESSION_DAYS } = require("./constants");

const env = process.env;
const DEFAULT_PORT = 3000;
const DEFAULT_SMS_MAX_PER_HOUR = 60;
const DEFAULT_SMS_MAX_PER_PERSON_PER_HOUR = 15;
const DEFAULT_DAILY_REMINDER_HOUR = 8;
const LAST_HOUR_OF_DAY = 23;

const isTrue = (value, fallback = false) => (value === undefined || value === "" ? fallback : String(value).toLowerCase() === "true");
const positiveNumber = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; };

// The address people type in the browser, without a trailing slash, e.g. https://desk.example.com
const publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null;
const servedOverHttps = isTrue(env.COOKIE_SECURE);

const config = Object.freeze({
  port: positiveNumber(env.PORT, DEFAULT_PORT),
  host: env.HOST || "0.0.0.0",
  publicUrl,
  servedOverHttps,
  sessionDays: positiveNumber(env.SESSION_DAYS, DEFAULT_SESSION_DAYS),
  setupToken: env.SETUP_TOKEN || null,

  // Reverse proxy / tunnel in front of the app
  trustProxy: isTrue(env.TRUST_PROXY),
  trustedProxyHops: Math.max(1, Math.floor(positiveNumber(env.TRUST_PROXY_HOPS, 1))),
  clientIpHeader: (env.CLIENT_IP_HEADER || "").toLowerCase() || null,

  email: {
    host: env.SMTP_HOST || "",
    port: env.SMTP_PORT,
    encryption: env.SMTP_SECURE,
    username: env.SMTP_USER || "",
    password: env.SMTP_PASS || "",
    from: env.SMTP_FROM || "",
    // Optional: a PEM file with the certificate authority that signed an internal mail server's certificate.
    trustedCaFile: env.SMTP_CA_FILE || "",
    greetingName: publicUrl ? new URL(publicUrl).hostname : env.SMTP_HELO,
  },
  sms: {
    provider: (env.SMS_PROVIDER || "").toLowerCase(),
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || "",
    twilioApiKeySid: env.TWILIO_API_KEY_SID || "",
    twilioApiKeySecret: env.TWILIO_API_KEY_SECRET || "",
    twilioFromNumber: env.TWILIO_FROM || "",
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || "",
    twilioApiBase: env.TWILIO_API_BASE || "https://api.twilio.com",
    webhookUrl: env.SMS_WEBHOOK_URL || "",
    webhookToken: env.SMS_WEBHOOK_TOKEN || "",
  },
  alerts: {
    includeDetailsInTexts: isTrue(env.SMS_INCLUDE_DETAILS, true),
    maxTextsPerHour: positiveNumber(env.SMS_MAX_PER_HOUR, DEFAULT_SMS_MAX_PER_HOUR),
    maxTextsPerPersonPerHour: positiveNumber(env.SMS_MAX_PER_USER_PER_HOUR, DEFAULT_SMS_MAX_PER_PERSON_PER_HOUR),
    dailyReminderHour: Math.min(LAST_HOUR_OF_DAY, Math.max(0, Math.floor(Number(env.ALERT_DAILY_HOUR ?? DEFAULT_DAILY_REMINDER_HOUR)) || 0)),
    defaultCountryCode: String(env.SMS_DEFAULT_COUNTRY || "1").replace(/\D/g, "") || "1",
  },
});

module.exports = config;
