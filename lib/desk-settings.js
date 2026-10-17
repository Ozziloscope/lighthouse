// Desk-wide settings that admins change from inside the app, stored in the "settings" table:
//   - SLA targets (hours to resolve, per priority)              Settings > SLA targets
//   - email (SMTP) and text (Twilio / webhook) delivery setup    Settings > Alert setup
//   - alert options (text limits, daily reminder hour, ...)      Settings > Alert setup
//
// Email and text settings start out as whatever the server's environment file says (if anything).
// Once an admin saves them in the app, the saved copy is used instead. "Use the server env file"
// deletes the saved copy and goes back to the environment values.
//
// Passwords and API tokens are encrypted (lib/secrets.js) and are never sent back to the browser:
// the page only learns whether one is set.
const { TICKET_PRIORITIES, SLA_HOURS_BY_PRIORITY, MIN_SLA_HOURS, MAX_SLA_HOURS } = require("./constants");
const { STATUS, fail } = require("./http");

const SETTING_KEYS = { slaHours: "sla_hours", email: "email", sms: "sms", alertOptions: "alert_options" };

// Which fields of each group an admin can edit in the app, and which of those are secret.
const EDITABLE = {
  email: { fields: ["host", "port", "encryption", "username", "from"], secrets: ["password"] },
  sms: {
    fields: ["provider", "twilioAccountSid", "twilioApiKeySid", "twilioFromNumber", "twilioMessagingServiceSid", "webhookUrl"],
    secrets: ["twilioApiKeySecret", "twilioAuthToken", "webhookToken"],
  },
};
const MAX_SETTING_LENGTH = 300;
const ALERT_OPTION_LIMITS = {
  maxTextsPerHour: { min: 1, max: 10000 },
  maxTextsPerPersonPerHour: { min: 1, max: 1000 },
  dailyReminderHour: { min: 0, max: 23 },
};
const COUNTRY_CODE_PATTERN = /^\d{1,3}$/;

function createDeskSettings({ one, run, config, secrets }) {
  // ---------- storage ----------
  function read(key) {
    const row = one("SELECT value FROM settings WHERE key = ?", key);
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return undefined; }
  }
  function write(key, value, actorId) {
    run(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key, JSON.stringify(value), Date.now(), actorId);
  }
  const forget = (key) => run("DELETE FROM settings WHERE key = ?", key);

  // ---------- SLA targets ----------
  function slaHours() {
    const saved = read(SETTING_KEYS.slaHours) || {};
    return Object.fromEntries(TICKET_PRIORITIES.map((priority) => [priority, Number(saved[priority]) || SLA_HOURS_BY_PRIORITY[priority]]));
  }
  function saveSlaHours(input, actorId) {
    const hours = {};
    for (const priority of TICKET_PRIORITIES) {
      const value = Number(input?.[priority]);
      if (!Number.isInteger(value) || value < MIN_SLA_HOURS || value > MAX_SLA_HOURS) {
        fail(STATUS.badRequest, `${priority} SLA must be a whole number of hours from ${MIN_SLA_HOURS} to ${MAX_SLA_HOURS}.`);
      }
      hours[priority] = value;
    }
    write(SETTING_KEYS.slaHours, hours, actorId);
    return hours;
  }

  // ---------- email and text settings ----------
  // The settings actually in use for "email" or "sms": the saved copy if there is one, else the environment.
  function effective(group) {
    const fromEnvironment = config[group];
    const saved = read(SETTING_KEYS[group]);
    if (!saved) return { ...fromEnvironment };
    const merged = { ...fromEnvironment }; // keeps env-only values such as SMTP_CA_FILE and TWILIO_API_BASE
    for (const field of EDITABLE[group].fields) merged[field] = saved[field] ?? "";
    for (const secret of EDITABLE[group].secrets) merged[secret] = secrets.decrypt(saved[secret]) ?? "";
    return merged;
  }
  const emailSettings = () => effective("email");
  const smsSettings = () => effective("sms");

  // Combines what the admin typed with what is already set, without saving. A blank secret means "keep the current one".
  function combine(group, input = {}) {
    const current = effective(group);
    const combined = { ...current };
    for (const field of EDITABLE[group].fields) {
      if (input[field] !== undefined) combined[field] = String(input[field] ?? "").trim().slice(0, MAX_SETTING_LENGTH);
    }
    for (const secret of EDITABLE[group].secrets) {
      if (input.clear?.includes(secret)) combined[secret] = "";
      else if (typeof input[secret] === "string" && input[secret] !== "") combined[secret] = input[secret].slice(0, MAX_SETTING_LENGTH);
    }
    if (group === "sms") combined.provider = combined.provider.toLowerCase();
    if (group === "email") combined.encryption = combined.encryption.toLowerCase();
    return combined;
  }
  function saveChannel(group, input, actorId) {
    const combined = combine(group, input);
    const stored = {};
    for (const field of EDITABLE[group].fields) stored[field] = combined[field] ?? "";
    for (const secret of EDITABLE[group].secrets) stored[secret] = combined[secret] ? secrets.encrypt(combined[secret]) : "";
    write(SETTING_KEYS[group], stored, actorId);
  }
  const useEnvironmentFor = (group) => forget(SETTING_KEYS[group]);

  // What the settings page may see: plain values, plus only "is it set, and where from" for secrets.
  function channelView(group) {
    const saved = read(SETTING_KEYS[group]);
    const values = effective(group);
    const view = { source: saved ? "app" : "env", values: {}, secrets: {} };
    for (const field of EDITABLE[group].fields) view.values[field] = values[field] ?? "";
    for (const secret of EDITABLE[group].secrets) {
      const unreadable = !!saved?.[secret] && secrets.decrypt(saved[secret]) === null;
      view.secrets[secret] = { isSet: !!values[secret], unreadable };
    }
    return view;
  }

  // ---------- alert options ----------
  function alertOptions() {
    const saved = read(SETTING_KEYS.alertOptions) || {};
    return { ...config.alerts, ...saved };
  }
  function saveAlertOptions(input, actorId) {
    const options = { includeDetailsInTexts: !!input.includeDetailsInTexts };
    for (const [name, limits] of Object.entries(ALERT_OPTION_LIMITS)) {
      const value = Number(input[name]);
      if (!Number.isInteger(value) || value < limits.min || value > limits.max) fail(STATUS.badRequest, `${name} must be a whole number from ${limits.min} to ${limits.max}.`);
      options[name] = value;
    }
    const countryCode = String(input.defaultCountryCode ?? "").replace(/\D/g, "");
    if (!COUNTRY_CODE_PATTERN.test(countryCode)) fail(STATUS.badRequest, "Default country code must be 1 to 3 digits, for example 1 for the US.");
    options.defaultCountryCode = countryCode;
    write(SETTING_KEYS.alertOptions, options, actorId);
    return options;
  }

  return { slaHours, saveSlaHours, emailSettings, smsSettings, combine, saveChannel, useEnvironmentFor, channelView, alertOptions, saveAlertOptions };
}

module.exports = { createDeskSettings };
