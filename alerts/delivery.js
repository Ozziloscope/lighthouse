// The outbox: alerts are written to a table first, then a background loop sends them.
// This means a slow or failing mail server never slows the app down, failed sends are retried,
// and admins can see every send (and its error) in Settings > Alert delivery.
const {
  HOUR_MS, DELIVERY_RETRY_DELAYS_MS, MAX_DELIVERY_ATTEMPTS, DELIVERY_BATCH_SIZE, MAX_LOGGED_ERROR_LENGTH, ALERT_HISTORY_KEPT_MS,
} = require("../lib/constants");
const { verifiedEmailOf, verifiedPhoneOf } = require("./contacts");

// A send that should never be picked up by the background loop (it is sent immediately instead).
const NEVER = Number.MAX_SAFE_INTEGER;

// `senders()` returns the current { mailer, smsSender } (they change when an admin saves new settings);
// `limits()` returns the current text limits.
function createDelivery({ db, one, all, run, audit, senders, limits }) {
  const insertAlert = db.prepare(`INSERT OR IGNORE INTO outbox (user_id, channel, target, event, subject, body, html, dedupe_key, status, next_attempt_at, created_at)
    VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`);

  // Adds an alert to the outbox. With a dedupeKey, the same alert is only ever queued once (returns false the second time).
  function queue({ userId, channel, target, event, subject = "", body, html = null, dedupeKey = null }) {
    const now = Date.now();
    return insertAlert.run(userId, channel, target, event, subject, body, html, dedupeKey, now, now).changes > 0;
  }

  const textsSentSince = (since) => one("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'sms' AND status = 'sent' AND sent_at > ?", since).n;
  const textsSentToPersonSince = (since, userId) => one("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'sms' AND status = 'sent' AND sent_at > ? AND user_id = ?", since, userId).n;

  async function deliver(channel, target, { subject, body, html }, via = senders()) {
    if (channel === "email") await via.mailer.send({ to: target, subject, text: body, html: html || undefined });
    else await via.smsSender.send(target, body);
  }

  // Why an alert should not be sent right now (or null if it should).
  function reasonToSkip(alert, person) {
    if (!person || !person.active) return "Person is deactivated";
    if (person.alerts_paused) return "Person paused their alerts";
    const currentTarget = alert.channel === "sms" ? verifiedPhoneOf(person) : verifiedEmailOf(person);
    if (!currentTarget) return alert.channel === "sms" ? "No verified mobile number" : "No verified email address";
    if (alert.channel === "sms") {
      const anHourAgo = Date.now() - HOUR_MS, { maxTextsPerHour, maxTextsPerPersonPerHour } = limits();
      if (textsSentSince(anHourAgo) >= maxTextsPerHour) { audit("alert.sms_cap", null, { scope: "desk" }); return `Desk-wide limit of ${maxTextsPerHour} texts per hour reached`; }
      if (textsSentToPersonSince(anHourAgo, alert.user_id) >= maxTextsPerPersonPerHour) return `Limit of ${maxTextsPerPersonPerHour} texts per person per hour reached`;
    }
    return null;
  }

  let sendingInProgress = false;
  async function sendQueuedAlerts() {
    if (sendingInProgress) return; // one loop at a time
    sendingInProgress = true;
    try {
      const due = all("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?", Date.now(), DELIVERY_BATCH_SIZE);
      for (const alert of due) {
        const person = one("SELECT active, alerts_paused, phone, phone_verified, email, alert_email, alert_email_verified FROM users WHERE id = ?", alert.user_id);
        const skipReason = reasonToSkip(alert, person);
        if (skipReason) { run("UPDATE outbox SET status = 'skipped', last_error = ? WHERE id = ?", skipReason, alert.id); continue; }
        // Always send to the person's current verified address or number, which may have changed since queueing.
        const target = alert.channel === "sms" ? verifiedPhoneOf(person) : verifiedEmailOf(person);
        try {
          await deliver(alert.channel, target, alert);
          run("UPDATE outbox SET status = 'sent', target = ?, sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?", target, Date.now(), alert.id);
        } catch (error) {
          recordFailedAttempt(alert, String(error.message || error).slice(0, MAX_LOGGED_ERROR_LENGTH));
        }
      }
    } catch (error) {
      console.error("Alert delivery loop failed:", error);
    } finally {
      sendingInProgress = false;
    }
  }

  function recordFailedAttempt(alert, errorText) {
    const attempts = alert.attempts + 1;
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      run("UPDATE outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?", attempts, errorText, alert.id);
      audit("alert.failed", null, { outbox: alert.id, channel: alert.channel, event: alert.event, error: errorText });
    } else {
      const retryAt = Date.now() + DELIVERY_RETRY_DELAYS_MS[attempts - 1];
      run("UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", attempts, errorText, retryAt, alert.id);
    }
  }

  // Sends right away (verification codes, test messages) and records the result in the outbox for the delivery log.
  // `loggedBody` replaces the real text in the log, so verification codes are never stored.
  // `via` sends with specific senders instead of the current ones (used to test unsaved settings).
  async function sendNow({ userId, channel, target, event, subject = "", body, html, loggedBody, via }) {
    const now = Date.now();
    const id = run(`INSERT INTO outbox (user_id, channel, target, event, subject, body, status, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`,
      userId, channel, target, event, subject, loggedBody || body, NEVER, now).lastInsertRowid;
    try {
      if (channel === "sms" && textsSentSince(now - HOUR_MS) >= limits().maxTextsPerHour) throw new Error("The desk-wide hourly text limit has been reached. Try again later.");
      await deliver(channel, target, { subject, body, html }, via ? { ...senders(), ...via } : senders());
      run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = 1 WHERE id = ?", Date.now(), id);
    } catch (error) {
      run("UPDATE outbox SET status = 'failed', attempts = 1, last_error = ? WHERE id = ?", String(error.message).slice(0, MAX_LOGGED_ERROR_LENGTH), id);
      throw error;
    }
  }

  function retryFailed(outboxId) {
    return run("UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'failed' AND event NOT IN ('verify','test','password_reset')", Date.now(), outboxId).changes > 0;
  }

  function deleteOldHistory() {
    run("DELETE FROM outbox WHERE created_at < ?", Date.now() - ALERT_HISTORY_KEPT_MS);
    run("DELETE FROM verify_codes WHERE expires_at < ?", Date.now());
  }

  return { queue, sendQueuedAlerts, sendNow, retryFailed, deleteOldHistory };
}

module.exports = { createDelivery };
