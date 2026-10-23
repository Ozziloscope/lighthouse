// Emailed password resets: a one-time passphrase sent to the email address on file.
//
// How it works:
//   1. Someone asks for a reset (on the sign-in page, or an account manager does it from Settings > Users).
//   2. Lighthouse makes a passphrase such as "maple-otter-quartz-lantern-42", stores only its hash with a
//      30-minute expiry, and emails it to the account's address.
//   3. The person signs in with the passphrase and must choose a new password straight away.
//
// The old password keeps working until the passphrase is used. So a stranger who types someone's
// username into "Forgot password?" can't lock them out; at most they cause an email.
const { RESET_PASSPHRASE_LIFETIME_MS, MINUTE_MS } = require("./constants");
const { hashPassword, verifyPassword, generatePassphrase } = require("./passwords");
const { verifiedEmailOf } = require("../alerts/contacts");

const LIFETIME_MINUTES = RESET_PASSPHRASE_LIFETIME_MS / MINUTE_MS;

function createPasswordReset({ run, notify, sessions, config }) {
  // Where a reset email would go, or null. Same rule as alerts: a confirmed alert address, else the account email.
  const resetAddressOf = (user) => (user && user.active ? verifiedEmailOf(user) : null);
  const emailIsSetUp = () => notify.channels().email;

  // Sends a fresh passphrase. Throws if the mail server refuses it. `requestedBy` is shown in the email.
  async function emailPassphrase(user, requestedBy) {
    const target = resetAddressOf(user);
    if (!target) throw new Error("This account has no email address on file.");
    if (!emailIsSetUp()) throw new Error("Email isn't set up on this server yet (Settings > Alert setup).");
    const passphrase = generatePassphrase();
    run("UPDATE users SET reset_hash = ?, reset_expires_at = ? WHERE id = ?", await hashPassword(passphrase), Date.now() + RESET_PASSPHRASE_LIFETIME_MS, user.id);
    const signInLink = config.publicUrl ? `\n\nSign in here: ${config.publicUrl}/` : "";
    const body = [
      `Hi ${user.name},`,
      "",
      `${requestedBy} asked for a temporary passphrase for your Lighthouse account (username: ${user.username}).`,
      "",
      `Temporary passphrase:  ${passphrase}`,
      "",
      `Sign in with it in place of your password within ${LIFETIME_MINUTES} minutes. You'll choose a new password straight after. It works once.`,
      "Your current password keeps working until then. If you didn't ask for this, ignore this email.",
    ].join("\n") + signInLink;
    await notify.sendNow({
      userId: user.id, channel: "email", target, event: "password_reset",
      subject: "[Lighthouse] Your temporary passphrase", body, loggedBody: "Temporary passphrase (hidden)",
    });
    return target;
  }

  const hasPendingPassphrase = (user) => !!user.reset_hash && user.reset_expires_at > Date.now();

  // Called at sign-in when the password didn't match: true if it's a valid emailed passphrase.
  // Using it makes the passphrase the current password, signs out every other device, and forces a new password.
  async function signInWithPassphrase(user, given) {
    if (!hasPendingPassphrase(user) || !(await verifyPassword(given, user.reset_hash))) return false;
    run("UPDATE users SET password_hash = reset_hash, reset_hash = NULL, reset_expires_at = NULL, must_change_password = 1 WHERE id = ?", user.id);
    sessions.endAllSessionsFor(user.id);
    return true;
  }

  // Signing in with the normal password cancels a pending reset: they remembered it.
  const cancelPendingPassphrase = (user) => { if (user.reset_hash) run("UPDATE users SET reset_hash = NULL, reset_expires_at = NULL WHERE id = ?", user.id); };

  return { resetAddressOf, emailIsSetUp, emailPassphrase, signInWithPassphrase, cancelPendingPassphrase };
}

module.exports = { createPasswordReset };
