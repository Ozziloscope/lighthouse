// Managing user accounts: add people, change their details or access level, reset passwords, deactivate.
// Needs the "Manage user accounts" permission.
//
// Safety rules (so account managers cannot hand out more power than they have):
//   - You cannot give anyone an access level with permissions you do not have yourself.
//   - You cannot change, reset or deactivate someone whose access level has permissions you do not have.
//   - Only Administrators can make someone an Administrator.
//   - You cannot change your own access level or deactivate yourself.
//   - The last active Administrator cannot be deactivated or moved to another level.
const { MAX_LENGTH } = require("../lib/constants");
const { STATUS, fail, created, requiredTextField, textField, isValidEmail, idFromPath, optionalId } = require("../lib/http");
const { isAdministrator, permissionsForUser } = require("../lib/access");
const { hashPassword, generatePassword } = require("../lib/passwords");

module.exports = function registerUserRoutes(app) {
  const { route, one, run, db, audit, sessions, people, getUserById, requirePermission } = app;

  const holdsEveryPermissionOf = (actor, permissions) => [...permissions].every((key) => actor.permissions.has(key));

  function loadLevel(levelId) {
    const level = one("SELECT * FROM access_levels WHERE id = ?", levelId);
    if (!level) fail(STATUS.badRequest, "That access level no longer exists.");
    return level;
  }
  function assertCanGiveLevel(actor, level) {
    if (isAdministrator(actor)) return;
    const levelPermissions = permissionsForUser({ level_is_administrator: level.is_administrator, level_permissions: level.permissions });
    if (level.is_administrator || !holdsEveryPermissionOf(actor, levelPermissions)) {
      fail(STATUS.forbidden, `You can't give someone the "${level.name}" access level because it includes permissions you don't have.`);
    }
  }
  function assertCanManagePerson(actor, target) {
    if (isAdministrator(actor)) return;
    if (isAdministrator(target) || !holdsEveryPermissionOf(actor, target.permissions)) {
      fail(STATUS.forbidden, `You can't change ${target.name}'s account because their access level has permissions you don't have.`);
    }
  }
  app.assertCanManagePerson = assertCanManagePerson; // also used for photos (routes/photos.js)

  function optionalEmail(value, exceptUserId = null) {
    const email = textField(value, MAX_LENGTH.email, "Email").toLowerCase();
    if (!email) return null;
    if (!isValidEmail(email)) fail(STATUS.badRequest, "Enter a valid email address, or leave it empty.");
    const existing = one("SELECT id FROM users WHERE email = ?", email);
    if (existing && existing.id !== exceptUserId) fail(STATUS.conflict, "Someone else already uses that email address.");
    return email;
  }

  // Add a person. The server makes up the temporary password and returns it once, for the admin to hand over.
  route("POST", "/api/users", async (request) => {
    requirePermission(request, "users.manage");
    const name = requiredTextField(request.body.name, MAX_LENGTH.personName, "Name");
    const username = people.checkUsername(request.body.username);
    const email = optionalEmail(request.body.email);
    const level = loadLevel(optionalId(request.body.accessLevelId) ?? fail(STATUS.badRequest, "Choose an access level."));
    assertCanGiveLevel(request.user, level);

    const temporaryPassword = generatePassword();
    const id = run(`INSERT INTO users (username, name, email, password_hash, access_level_id, must_change_password, created_at) VALUES (?,?,?,?,?,1,?)`,
      username, name, email, await hashPassword(temporaryPassword), level.id, Date.now()).lastInsertRowid;
    audit("user.create", request, { target: id, username, accessLevel: level.name });
    return created({ user: people.forAccountManagers(getUserById(id)), temporaryPassword });
  });

  route("PATCH", "/api/users/:id", (request) => {
    requirePermission(request, "users.manage");
    const actor = request.user;
    const target = getUserById(idFromPath(request.params.id)) ?? fail(STATUS.notFound, "User not found.");
    const isSelf = target.id === actor.id;
    if (!isSelf) assertCanManagePerson(actor, target);
    const body = request.body, changes = {}, changeLog = [];

    if (body.name !== undefined) { changes.name = requiredTextField(body.name, MAX_LENGTH.personName, "Name"); changeLog.push("name"); }
    if (body.username !== undefined) { changes.username = people.checkUsername(body.username, target.id); changeLog.push("username"); }
    if (body.email !== undefined) { changes.email = optionalEmail(body.email, target.id); changeLog.push("email"); }

    const losesAdministrator = (newLevel) => isAdministrator(target) && !newLevel.is_administrator;
    if (body.accessLevelId !== undefined) {
      if (isSelf) fail(STATUS.badRequest, "You can't change your own access level. Ask another admin.");
      const level = loadLevel(optionalId(body.accessLevelId));
      assertCanGiveLevel(actor, level);
      if (losesAdministrator(level) && target.active && people.countActiveAdministrators() <= 1) fail(STATUS.badRequest, "This is the last active Administrator. Make someone else an Administrator first.");
      changes.access_level_id = level.id;
      changeLog.push(`access level: ${target.level_name} -> ${level.name}`);
    }
    if (body.active !== undefined) {
      if (isSelf) fail(STATUS.badRequest, "You can't deactivate your own account.");
      if (!body.active && isAdministrator(target) && target.active && people.countActiveAdministrators() <= 1) fail(STATUS.badRequest, "This is the last active Administrator and can't be deactivated.");
      changes.active = body.active ? 1 : 0;
      changeLog.push(body.active ? "reactivated" : "deactivated");
    }
    if (!changeLog.length) return { user: people.forAccountManagers(target) };

    db.transaction(() => {
      const columns = Object.keys(changes); // keys above are fixed column names, never taken from the request
      run(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...columns.map((c) => changes[c]), target.id);
      if (changes.active === 0) sessions.endAllSessionsFor(target.id);
      people.releaseWorkTheyCanNoLongerDo(target.id, actor.id);
    })();
    audit("user.update", request, { target: target.id, changed: changeLog });
    return { user: people.forAccountManagers(getUserById(target.id)) };
  });

  route("POST", "/api/users/:id/reset-password", async (request) => {
    requirePermission(request, "users.manage");
    const target = getUserById(idFromPath(request.params.id)) ?? fail(STATUS.notFound, "User not found.");
    if (target.id === request.user.id) fail(STATUS.badRequest, "Use Settings > Password to change your own password.");
    assertCanManagePerson(request.user, target);
    const temporaryPassword = generatePassword();
    run("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", await hashPassword(temporaryPassword), target.id);
    sessions.endAllSessionsFor(target.id);
    audit("user.password_reset", request, { target: target.id });
    return { username: target.username, temporaryPassword };
  });
};
