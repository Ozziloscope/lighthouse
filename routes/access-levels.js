// Access levels: named sets of permissions that admins create and edit in Settings > Access levels.
// Viewing the list needs "Manage user accounts" (to pick a level for someone) or "Manage access levels".
// Creating, editing and deleting needs "Manage access levels", which only the Administrator level has.
const { MAX_LENGTH } = require("../lib/constants");
const { STATUS, fail, created, requiredTextField, textField, idFromPath } = require("../lib/http");
const { PERMISSIONS, PERMISSION_KEYS, ADMINISTRATOR_ONLY_PERMISSIONS, parseStoredPermissions, can } = require("../lib/access");

module.exports = function registerAccessLevelRoutes(app) {
  const { route, one, all, run, db, audit, people, requireSignedIn, requirePermission } = app;

  const levelView = (level) => ({
    id: level.id,
    name: level.name,
    description: level.description,
    isAdministrator: !!level.is_administrator,
    permissions: level.is_administrator ? [...PERMISSION_KEYS, ...ADMINISTRATOR_ONLY_PERMISSIONS.map((p) => p.key)] : [...parseStoredPermissions(level.permissions)],
    memberCount: one("SELECT COUNT(*) AS n FROM users WHERE access_level_id = ? AND active = 1", level.id).n,
  });

  // Only known, grantable permission keys are kept; anything else in the request is ignored.
  function cleanPermissionList(input) {
    if (!Array.isArray(input)) fail(STATUS.badRequest, "Permissions must be a list.");
    return PERMISSION_KEYS.filter((key) => input.includes(key));
  }
  function uniqueName(input, exceptId = null) {
    const name = requiredTextField(input, MAX_LENGTH.accessLevelName, "Access level name");
    const existing = one("SELECT id FROM access_levels WHERE name = ?", name);
    if (existing && existing.id !== exceptId) fail(STATUS.conflict, "An access level with that name already exists.");
    return name;
  }
  function loadEditableLevel(id) {
    const level = one("SELECT * FROM access_levels WHERE id = ?", idFromPath(id)) ?? fail(STATUS.notFound, "Access level not found.");
    if (level.is_administrator) fail(STATUS.badRequest, "The Administrator level always has every permission and can't be changed or deleted.");
    return level;
  }

  route("GET", "/api/access-levels", (request) => {
    requireSignedIn(request);
    if (!can(request.user, "users.manage") && !can(request.user, "access.manage")) fail(STATUS.forbidden, "Your access level doesn't allow viewing access levels.");
    return {
      levels: all("SELECT * FROM access_levels ORDER BY is_administrator DESC, name COLLATE NOCASE").map(levelView),
      permissions: PERMISSIONS,
      administratorOnlyPermissions: ADMINISTRATOR_ONLY_PERMISSIONS,
    };
  });

  route("POST", "/api/access-levels", (request) => {
    requirePermission(request, "access.manage");
    const name = uniqueName(request.body.name);
    const description = textField(request.body.description, MAX_LENGTH.accessLevelDescription, "Description");
    const permissions = cleanPermissionList(request.body.permissions || []);
    const now = Date.now();
    const id = run("INSERT INTO access_levels (name, description, permissions, is_administrator, created_at, updated_at) VALUES (?,?,?,0,?,?)",
      name, description, JSON.stringify(permissions), now, now).lastInsertRowid;
    audit("access_level.create", request, { level: id, name, permissions });
    return created({ level: levelView(one("SELECT * FROM access_levels WHERE id = ?", id)) });
  });

  route("PATCH", "/api/access-levels/:id", (request) => {
    requirePermission(request, "access.manage");
    const level = loadEditableLevel(request.params.id);
    const name = request.body.name !== undefined ? uniqueName(request.body.name, level.id) : level.name;
    const description = request.body.description !== undefined ? textField(request.body.description, MAX_LENGTH.accessLevelDescription, "Description") : level.description;
    const permissions = request.body.permissions !== undefined ? cleanPermissionList(request.body.permissions) : [...parseStoredPermissions(level.permissions)];
    const before = [...parseStoredPermissions(level.permissions)];

    db.transaction(() => {
      run("UPDATE access_levels SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?", name, description, JSON.stringify(permissions), Date.now(), level.id);
      // Anyone on this level who lost a permission gives up the work that depended on it.
      for (const member of all("SELECT id FROM users WHERE access_level_id = ?", level.id)) people.releaseWorkTheyCanNoLongerDo(member.id, request.user.id);
    })();
    audit("access_level.update", request, {
      level: level.id, name,
      added: permissions.filter((p) => !before.includes(p)),
      removed: before.filter((p) => !permissions.includes(p)),
    });
    return { level: levelView(one("SELECT * FROM access_levels WHERE id = ?", level.id)) };
  });

  route("DELETE", "/api/access-levels/:id", (request) => {
    requirePermission(request, "access.manage");
    const level = loadEditableLevel(request.params.id);
    const everyoneOnLevel = one("SELECT COUNT(*) AS n FROM users WHERE access_level_id = ?", level.id).n;
    if (everyoneOnLevel) fail(STATUS.conflict, `${everyoneOnLevel} ${everyoneOnLevel === 1 ? "person uses" : "people use"} this access level (including deactivated accounts). Move them to another level first.`);
    run("DELETE FROM access_levels WHERE id = ?", level.id);
    audit("access_level.delete", request, { level: level.id, name: level.name });
    return { ok: true };
  });
};
