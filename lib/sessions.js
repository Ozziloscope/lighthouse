// Sign-in sessions. The browser holds a random token in an HttpOnly cookie; the database holds only
// a SHA-256 hash of it, so a leaked database cannot be used to sign in as anyone.
const crypto = require("crypto");
const { SESSION_TOKEN_BYTES, SESSION_TOKEN_PATTERN, DAY_MS, SECOND_MS } = require("./constants");
const { parseCookies } = require("./http");

function createSessions({ one, run, config, loadUser }) {
  // Over HTTPS the "__Host-" prefix makes the browser refuse to let any other site or subdomain set this cookie.
  const COOKIE_NAME = config.servedOverHttps ? "__Host-lh_session" : "lh_session";
  const sessionLengthMs = config.sessionDays * DAY_MS;
  const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

  function cookieHeader(token, maxAgeMs) {
    const parts = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / SECOND_MS)}`];
    if (config.servedOverHttps) parts.push("Secure");
    return parts.join("; ");
  }

  function startSession(response, userId) {
    const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const now = Date.now();
    run("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?", userId, now);
    run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)", hashToken(token), userId, now, now + sessionLengthMs);
    response.setHeader("Set-Cookie", cookieHeader(token, sessionLengthMs));
  }

  function endSession(request, response) {
    if (request.sessionHash) run("DELETE FROM sessions WHERE token_hash = ?", request.sessionHash);
    response.setHeader("Set-Cookie", cookieHeader("", 0));
  }

  // Sets request.user (with request.user.permissions) when the cookie belongs to a live session of an active person.
  function identify(request) {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!token || !SESSION_TOKEN_PATTERN.test(token)) return;
    const tokenHash = hashToken(token);
    const session = one("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?", tokenHash, Date.now());
    if (!session) return;
    const user = loadUser("u.id = ? AND u.active = 1", session.user_id);
    if (user) { request.user = user; request.sessionHash = tokenHash; }
  }

  const endAllSessionsFor = (userId) => run("DELETE FROM sessions WHERE user_id = ?", userId);
  const endOtherSessionsFor = (userId, keepHash) => run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", userId, keepHash);
  const deleteExpiredSessions = () => run("DELETE FROM sessions WHERE expires_at < ?", Date.now());

  return { startSession, endSession, identify, endAllSessionsFor, endOtherSessionsFor, deleteExpiredSessions };
}

module.exports = { createSessions };
