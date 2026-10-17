// Each person's alert settings (Settings > My alerts), confirming a new email address or phone number
// with a one-time code, test messages, and the admin delivery log (Settings > Alert delivery).
const crypto = require("crypto");
const { MAX_LENGTH, RATE_LIMITS, VERIFICATION_CODE_LIFETIME_MS, VERIFICATION_CODE_MAX_TRIES, VERIFICATION_CODE_DIGITS, DAY_MS, MINUTE_MS } = require("../lib/constants");
const { STATUS, fail, textField, isValidEmail, idFromPath } = require("../lib/http");
const { normalizePhoneNumber, maskPhoneNumber } = require("../alerts/sms");
const { ALERT_EVENTS } = require("../alerts/events");
const { createRateLimiter } = require("../lib/rate-limit");
const { verifiedEmailOf, verifiedPhoneOf } = require("../alerts/contacts");

const RECENT_DELIVERIES_SHOWN = 150;
const LOG_PREVIEW_LENGTH = 80;
const CODE_LIFETIME_MINUTES = VERIFICATION_CODE_LIFETIME_MS / MINUTE_MS;

module.exports = function registerAlertRoutes(app) {
  const { route, one, all, run, audit, notify, config, deskSettings, requireSignedIn, requirePermission, getUserById } = app;
  const codeRequests = createRateLimiter(RATE_LIMITS.verificationCodesPerUser);
  const testMessages = createRateLimiter(RATE_LIMITS.testAlertsPerUser);
  const CHANNELS = ["email", "sms"];
  const assertChannel = (channel) => { if (!CHANNELS.includes(channel)) fail(STATUS.badRequest, "Choose email or sms."); };

  // The code itself is never stored, only a hash tied to the person, channel and address.
  const hashCode = (userId, channel, target, code) => crypto.createHash("sha256").update(`${userId}:${channel}:${target}:${code}`).digest("hex");

  // What Settings > My alerts shows.
  function settingsView(person) {
    const preferences = notify.preferencesFor(person);
    const events = Object.entries(ALERT_EVENTS)
      .filter(([key]) => notify.personMaySee(person, key))
      .map(([key, event]) => ({ key, group: event.group, label: event.label, hint: event.hint || null, hasPriorityFilter: !!event.hasPriorityFilter, ...preferences[key] }));
    const pendingCodes = Object.fromEntries(all("SELECT channel, target FROM verify_codes WHERE user_id = ? AND expires_at > ?", person.id, Date.now())
      .map((row) => [row.channel, row.channel === "sms" ? maskPhoneNumber(row.target) : row.target]));
    return {
      channels: notify.channels(),
      paused: !!person.alerts_paused,
      events,
      contact: {
        accountEmail: person.email || null,
        alertEmail: person.alert_email || null,
        alertEmailVerified: !!person.alert_email && !!person.alert_email_verified,
        emailTo: verifiedEmailOf(person),                    // where email alerts go right now (null = nowhere yet)
        phone: person.phone || null,
        phoneVerified: !!verifiedPhoneOf(person),
        pending: pendingCodes,
      },
    };
  }
  const freshView = (request) => settingsView(getUserById(request.user.id));

  route("GET", "/api/alerts/me", (request) => { requireSignedIn(request); return settingsView(request.user); });

  route("PUT", "/api/alerts/me/prefs", (request) => {
    requireSignedIn(request);
    let saved = {};
    try { saved = JSON.parse(request.user.alert_prefs || "{}"); } catch { saved = {}; }
    const merged = { ...saved, ...notify.cleanPreferences(request.body.prefs) };
    run("UPDATE users SET alert_prefs = ? WHERE id = ?", JSON.stringify(merged), request.user.id);
    return freshView(request);
  });

  route("PUT", "/api/alerts/me/paused", (request) => {
    requireSignedIn(request);
    run("UPDATE users SET alerts_paused = ? WHERE id = ?", request.body.paused ? 1 : 0, request.user.id);
    audit(request.body.paused ? "alerts.paused" : "alerts.resumed", request);
    return freshView(request);
  });

  // Step 1 of adding an address or number: send a code to it. Nothing is saved until the code comes back,
  // so nobody can point alerts (or text-message costs) at someone else's inbox or phone.
  route("POST", "/api/alerts/me/verify/start", async (request) => {
    requireSignedIn(request);
    const person = request.user, channel = request.body.channel;
    assertChannel(channel);
    let target;
    if (channel === "email") {
      target = textField(request.body.target, MAX_LENGTH.email, "Email").toLowerCase();
      if (!isValidEmail(target)) fail(STATUS.badRequest, "Enter a valid email address.");
      // Going back to the account's own email needs no code: an admin already set it.
      if (person.email && target === person.email.toLowerCase()) {
        run("UPDATE users SET alert_email = NULL WHERE id = ?", person.id);
        return { verified: true, ...freshView(request) };
      }
    } else {
      target = normalizePhoneNumber(request.body.target, deskSettings.alertOptions().defaultCountryCode);
      if (!target) fail(STATUS.badRequest, "Enter a mobile number with country code, for example +1 317 555 0100.");
    }

    // If this channel isn't set up on the server yet, save the address or number now, marked unconfirmed.
    // Nothing is ever sent to it until the person confirms it with a code once the channel is turned on.
    if (!notify.channels()[channel]) {
      run(channel === "email" ? "UPDATE users SET alert_email = ?, alert_email_verified = 0 WHERE id = ?" : "UPDATE users SET phone = ?, phone_verified = 0 WHERE id = ?", target, person.id);
      audit("alerts.contact_saved_unverified", request, { channel, target: channel === "sms" ? maskPhoneNumber(target) : target });
      return { saved: true, verified: false, ...freshView(request) };
    }

    const limiterKey = String(person.id);
    if (codeRequests.isBlocked(limiterKey)) fail(STATUS.tooMany, "Too many codes requested. Wait an hour and try again.");
    codeRequests.record(limiterKey);
    const code = notify.newVerificationCode();
    run(`INSERT INTO verify_codes (user_id, channel, target, code_hash, expires_at, attempts) VALUES (?,?,?,?,?,0)
      ON CONFLICT(user_id, channel) DO UPDATE SET target = excluded.target, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      person.id, channel, target, hashCode(person.id, channel, target, code), Date.now() + VERIFICATION_CODE_LIFETIME_MS);
    const text = `Your Lighthouse verification code is ${code}. It expires in ${CODE_LIFETIME_MINUTES} minutes. If you did not ask for this, ignore it.`;
    try {
      await notify.sendNow({ userId: person.id, channel, target, event: "verify", subject: "[Lighthouse] Your verification code", body: text, loggedBody: "Verification code (hidden)" });
    } catch (error) {
      run("DELETE FROM verify_codes WHERE user_id = ? AND channel = ?", person.id, channel);
      fail(STATUS.badGateway, `The code could not be sent: ${error.message}`);
    }
    audit("alerts.verify_sent", request, { channel, target: channel === "sms" ? maskPhoneNumber(target) : target });
    return { sent: true, ...freshView(request) };
  });

  // Step 2: check the code and save the address or number.
  route("POST", "/api/alerts/me/verify/confirm", (request) => {
    requireSignedIn(request);
    const person = request.user, channel = request.body.channel;
    assertChannel(channel);
    const code = String(request.body.code || "").replace(/\D/g, "");
    const pending = one("SELECT * FROM verify_codes WHERE user_id = ? AND channel = ?", person.id, channel);
    const forgetCode = () => run("DELETE FROM verify_codes WHERE user_id = ? AND channel = ?", person.id, channel);
    if (!pending || pending.expires_at < Date.now()) fail(STATUS.badRequest, "That code has expired. Send a new one.");
    if (pending.attempts >= VERIFICATION_CODE_MAX_TRIES) { forgetCode(); fail(STATUS.badRequest, "Too many wrong codes. Send a new one."); }

    const codeMatches = code.length === VERIFICATION_CODE_DIGITS
      && crypto.timingSafeEqual(Buffer.from(hashCode(person.id, channel, pending.target, code)), Buffer.from(pending.code_hash));
    if (!codeMatches) {
      run("UPDATE verify_codes SET attempts = attempts + 1 WHERE user_id = ? AND channel = ?", person.id, channel);
      audit("alerts.verify_failed", request, { channel });
      fail(STATUS.badRequest, `That code is not right. ${VERIFICATION_CODE_MAX_TRIES - pending.attempts - 1} tries left.`);
    }
    run(channel === "email" ? "UPDATE users SET alert_email = ?, alert_email_verified = 1 WHERE id = ?" : "UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?", pending.target, person.id);
    forgetCode();
    audit("alerts.contact_verified", request, { channel, target: channel === "sms" ? maskPhoneNumber(pending.target) : pending.target });
    return freshView(request);
  });

  route("DELETE", "/api/alerts/me/contact/:channel", (request) => {
    requireSignedIn(request);
    const channel = request.params.channel;
    assertChannel(channel);
    run(channel === "email" ? "UPDATE users SET alert_email = NULL, alert_email_verified = 1 WHERE id = ?" : "UPDATE users SET phone = NULL, phone_verified = 1 WHERE id = ?", request.user.id);
    run("DELETE FROM verify_codes WHERE user_id = ? AND channel = ?", request.user.id, channel);
    audit("alerts.contact_removed", request, { channel });
    return freshView(request);
  });

  route("POST", "/api/alerts/me/test", async (request) => {
    requireSignedIn(request);
    const person = request.user, channel = request.body.channel;
    assertChannel(channel);
    if (!notify.channels()[channel]) fail(STATUS.badRequest, "That channel is not set up on this server.");
    const target = channel === "email" ? verifiedEmailOf(person) : verifiedPhoneOf(person);
    if (!target) fail(STATUS.badRequest, channel === "email" ? "Add and confirm an email address first." : "Add and confirm a mobile number first.");
    if (testMessages.isBlocked(String(person.id))) fail(STATUS.tooMany, "Too many test messages. Wait an hour and try again.");
    testMessages.record(String(person.id));
    const link = config.publicUrl ? `\n\n${config.publicUrl}/` : "";
    try {
      await notify.sendNow(channel === "email"
        ? { userId: person.id, channel, target, event: "test", subject: "[Lighthouse] Test alert", body: `This is a test alert from Lighthouse for ${person.name}.\n\nEmail alerts are working.${link}` }
        : { userId: person.id, channel, target, event: "test", body: `Lighthouse: test alert for ${person.name}. Text alerts are working.` });
    } catch (error) {
      fail(STATUS.badGateway, `Sending failed: ${error.message}`);
    }
    return { ok: true, to: channel === "sms" ? maskPhoneNumber(target) : target };
  });

  // ---------- admin: delivery log ----------
  route("GET", "/api/alerts/admin", (request) => {
    requirePermission(request, "alerts.view_log");
    const since = Date.now() - DAY_MS;
    return {
      config: notify.describe(),
      lastDayCounts: all("SELECT channel, status, COUNT(*) AS n FROM outbox WHERE created_at > ? GROUP BY channel, status", since),
      people: {
        withPhone: one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND phone IS NOT NULL AND phone_verified = 1").n,
        paused: one("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND alerts_paused = 1").n,
        active: one("SELECT COUNT(*) AS n FROM users WHERE active = 1").n,
      },
      recent: all("SELECT o.*, u.name AS user_name FROM outbox o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT ?", RECENT_DELIVERIES_SHOWN).map((o) => ({
        id: o.id, at: o.sent_at || o.created_at, userName: o.user_name || "Former user", channel: o.channel,
        to: o.channel === "sms" ? maskPhoneNumber(o.target) : o.target, event: o.event, subject: o.subject || o.body.slice(0, LOG_PREVIEW_LENGTH),
        status: o.status, attempts: o.attempts, error: o.last_error,
      })),
    };
  });

  route("POST", "/api/alerts/admin/retry/:id", (request) => {
    requirePermission(request, "alerts.view_log");
    const outboxId = idFromPath(request.params.id);
    if (!notify.retryFailed(outboxId)) fail(STATUS.badRequest, "Only failed alerts can be retried.");
    audit("alert.retry", request, { outbox: outboxId });
    setImmediate(notify.sendQueuedAlerts);
    return { ok: true };
  });
};
