// First-run setup, signing in and signing out.
const crypto = require("crypto");
const { MAX_LENGTH, RATE_LIMITS } = require("../lib/constants");
const { STATUS, fail, requiredTextField, textField, isValidEmail } = require("../lib/http");
const { hashPassword, verifyPassword, getDecoyHash, passwordProblem } = require("../lib/passwords");
const { createRateLimiter } = require("../lib/rate-limit");

const SETUP_CODE_BYTES = 9; // prints as 12 easy-to-copy characters

module.exports = function registerAuthRoutes(app) {
  const { route, one, run, db, config, audit, sessions, people } = app;
  const failedLoginsPerAccount = createRateLimiter(RATE_LIMITS.failedLoginsPerAccount);
  const failedLoginsPerAddress = createRateLimiter(RATE_LIMITS.failedLoginsPerAddress);
  const wrongSetupCodes = createRateLimiter(RATE_LIMITS.wrongSetupCodes);

  const userCount = () => one("SELECT COUNT(*) AS n FROM users").n;
  const administratorLevelId = () => one("SELECT id FROM access_levels WHERE is_administrator = 1").id;

  // ---------- first-run setup ----------
  // Until the first admin exists, anyone who can reach the site could claim it. The setup code, printed in the
  // server log (or set with SETUP_TOKEN), proves the person creating the first admin controls the server.
  let setupCode = null;
  function prepareSetupCode() {
    if (userCount() > 0) return;
    setupCode = config.setupToken || crypto.randomBytes(SETUP_CODE_BYTES).toString("base64url");
    console.log("------------------------------------------------------------");
    console.log(" No users yet. Open the site and create the first admin account.");
    console.log(config.setupToken ? " Use the setup code from the SETUP_TOKEN environment variable." : ` Setup code: ${setupCode}`);
    console.log("------------------------------------------------------------");
  }
  const setupCodeMatches = (given) => {
    if (!setupCode) return false;
    const a = Buffer.from(String(given || "").trim()), b = Buffer.from(setupCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  route("GET", "/api/setup", () => ({ needsSetup: userCount() === 0 }));

  route("POST", "/api/setup", async (request, response) => {
    if (userCount() > 0) fail(STATUS.conflict, "Setup is already complete. Sign in instead.");
    if (wrongSetupCodes.isBlocked(request.ip)) fail(STATUS.tooMany, "Too many wrong setup codes. Wait 15 minutes and try again.");
    if (!setupCodeMatches(request.body.setupCode)) {
      wrongSetupCodes.record(request.ip);
      audit("setup.bad_code", request);
      fail(STATUS.forbidden, "Setup code is incorrect. Find it in the server log from when the app started.");
    }
    const name = requiredTextField(request.body.name, MAX_LENGTH.personName, "Your name");
    const username = people.checkUsername(request.body.username);
    const email = textField(request.body.email, MAX_LENGTH.email, "Email").toLowerCase() || null;
    if (email && !isValidEmail(email)) fail(STATUS.badRequest, "Enter a valid email address, or leave it empty.");
    const problem = passwordProblem(request.body.password);
    if (problem) fail(STATUS.badRequest, problem);

    const passwordHash = await hashPassword(request.body.password);
    const userId = db.transaction(() => {
      if (userCount() > 0) fail(STATUS.conflict, "Setup is already complete. Sign in instead."); // two people racing to set up
      return run("INSERT INTO users (username, name, email, password_hash, access_level_id, created_at) VALUES (?,?,?,?,?,?)",
        username, name, email, passwordHash, administratorLevelId(), Date.now()).lastInsertRowid;
    })();
    setupCode = null;
    sessions.startSession(response, userId);
    audit("setup.complete", request, { admin: userId });
    return { ok: true };
  });

  // ---------- sign in / sign out ----------
  route("POST", "/api/login", async (request, response) => {
    const username = textField(request.body.username, MAX_LENGTH.username, "Username").toLowerCase();
    const password = typeof request.body.password === "string" ? request.body.password : "";
    const accountKey = `${request.ip}|${username}`;
    if (failedLoginsPerAccount.isBlocked(accountKey) || failedLoginsPerAddress.isBlocked(request.ip)) {
      audit("login.throttled", request, { username });
      fail(STATUS.tooMany, "Too many failed sign-ins. Wait 15 minutes and try again.");
    }
    const user = one("SELECT * FROM users WHERE username = ?", username);
    // Always check a password hash, even for unknown usernames, so timing does not reveal which usernames exist.
    const passwordIsRight = await verifyPassword(password, user ? user.password_hash : await getDecoyHash());
    if (!user || !user.active || !passwordIsRight) {
      failedLoginsPerAccount.record(accountKey);
      failedLoginsPerAddress.record(request.ip);
      audit("login.failure", request, { username, reason: !user ? "unknown_username" : !user.active ? "deactivated" : "wrong_password" });
      fail(STATUS.unauthorized, "Username or password is incorrect.");
    }
    failedLoginsPerAccount.reset(accountKey);
    sessions.startSession(response, user.id);
    audit("login.success", { ip: request.ip, user });
    return { ok: true };
  });

  route("POST", "/api/logout", (request, response) => {
    if (request.user) audit("logout", request);
    sessions.endSession(request, response);
    return { ok: true };
  });

  return { prepareSetupCode };
};
