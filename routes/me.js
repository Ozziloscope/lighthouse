// Things a signed-in person does for themselves: load the app, change their password, pick a theme.
const { RATE_LIMITS, TICKET_PRIORITIES, TICKET_STATUSES, OPEN_TICKET_STATUSES, TICKET_CATEGORIES, TICKET_CATEGORY_GROUPS, MAX_TAG_LENGTH, MAX_TAGS_PER_TICKET, MAX_ATTACHMENT_BYTES, MIN_SLA_HOURS, MAX_SLA_HOURS, PHOTO_SIZE_PX, MAX_PHOTO_BYTES, MAX_LENGTH, MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH } = require("../lib/constants");
const { STATUS, fail } = require("../lib/http");
const { can } = require("../lib/access");
const { hashPassword, verifyPassword, passwordProblem } = require("../lib/passwords");
const { createRateLimiter } = require("../lib/rate-limit");

const THEMES = ["system", "light", "dark"];

module.exports = function registerMeRoutes(app) {
  const { route, one, all, run, audit, sessions, people, notify, deskSettings, requireSignedIn } = app;
  const wrongCurrentPasswords = createRateLimiter(RATE_LIMITS.wrongCurrentPasswords);

  // Everything the app needs on load: who I am, the people and groups I can see, and fixed lists.
  route("GET", "/api/bootstrap", (request) => {
    requireSignedIn(request);
    const me = request.user;
    const managesAccounts = can(me, "users.manage");
    const showMembers = people.seesWholeDirectory(me);
    const memberships = showMembers ? all("SELECT * FROM group_members") : [];
    return {
      me: people.forSelf(me),
      users: people.directoryFor(me).map(managesAccounts ? people.forAccountManagers : people.forDirectory),
      groups: all("SELECT * FROM groups ORDER BY name COLLATE NOCASE").map((g) => ({
        id: g.id, name: g.name, description: g.description,
        members: memberships.filter((m) => m.group_id === g.id).map((m) => m.user_id),
        leads: memberships.filter((m) => m.group_id === g.id && m.is_lead).map((m) => m.user_id),
      })),
      constants: {
        PRIORITIES: TICKET_PRIORITIES, STATUSES: TICKET_STATUSES, OPEN_STATUSES: OPEN_TICKET_STATUSES, CATEGORIES: TICKET_CATEGORIES, CATEGORY_GROUPS: TICKET_CATEGORY_GROUPS, MAX_TAG_LENGTH, MAX_TAGS_PER_TICKET, MAX_ATTACHMENT_BYTES, SLA_HOURS: deskSettings.slaHours(), MIN_SLA_HOURS, MAX_SLA_HOURS, PHOTO_SIZE_PX, MAX_PHOTO_BYTES,
        MAX_LENGTH, MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH, THEMES,
      },
      alertChannels: notify.channels(),
    };
  });

  route("POST", "/api/me/password", async (request) => {
    requireSignedIn(request);
    const me = request.user, limiterKey = String(me.id);
    if (wrongCurrentPasswords.isBlocked(limiterKey)) fail(STATUS.tooMany, "Too many wrong passwords. Wait 15 minutes and try again.");
    const { current, next } = request.body;
    if (!(await verifyPassword(current, me.password_hash))) {
      wrongCurrentPasswords.record(limiterKey);
      audit("password.change_failed", request);
      fail(STATUS.badRequest, "Current password is incorrect.");
    }
    const problem = passwordProblem(next, "New password");
    if (problem) fail(STATUS.badRequest, problem);
    if (next === current) fail(STATUS.badRequest, "Choose a password different from the current one.");
    run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", await hashPassword(next), me.id);
    sessions.endOtherSessionsFor(me.id, request.sessionHash); // sign out other devices
    audit("password.change", request);
    return { ok: true };
  });

  route("PUT", "/api/me/theme", (request) => {
    requireSignedIn(request);
    const theme = request.body.theme;
    if (!THEMES.includes(theme)) fail(STATUS.badRequest, "Theme must be system, light or dark.");
    run("UPDATE users SET theme = ? WHERE id = ?", theme, request.user.id);
    return { theme };
  });
};
