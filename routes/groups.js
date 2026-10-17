// Resolver groups: teams that tickets are routed to.
// Creating, editing and staffing groups needs "Manage resolver groups".
// Anyone who "Can be assigned tickets" may join or leave a group themselves.
const { MAX_LENGTH } = require("../lib/constants");
const { STATUS, fail, created, requiredTextField, textField, idFromPath, optionalId } = require("../lib/http");
const { can } = require("../lib/access");

module.exports = function registerGroupRoutes(app) {
  const { route, one, run, db, audit, getUserById, requireSignedIn, requirePermission } = app;

  const loadGroup = (id) => one("SELECT * FROM groups WHERE id = ?", idFromPath(id)) ?? fail(STATUS.notFound, "Group not found.");
  function uniqueName(input, exceptId = null) {
    const name = requiredTextField(input, MAX_LENGTH.groupName, "Group name");
    const existing = one("SELECT id FROM groups WHERE name = ?", name);
    if (existing && existing.id !== exceptId) fail(STATUS.conflict, "A group with that name already exists.");
    return name;
  }
  // Only the person themselves (if they can take tickets) or a group manager may change someone's membership.
  function assertMayChangeMembership(request, userId) {
    requireSignedIn(request);
    const changingSelf = userId === request.user.id;
    if (can(request.user, "groups.manage")) return;
    if (changingSelf && can(request.user, "tickets.assignable")) return;
    fail(STATUS.forbidden, changingSelf ? "Your access level doesn't let you take tickets, so you can't join resolver groups." : "Only people who can manage resolver groups can change other people's membership.");
  }

  route("POST", "/api/groups", (request) => {
    requirePermission(request, "groups.manage");
    const name = uniqueName(request.body.name);
    const id = run("INSERT INTO groups (name, description, created_at) VALUES (?,?,?)", name, textField(request.body.description, MAX_LENGTH.groupDescription, "Description"), Date.now()).lastInsertRowid;
    audit("group.create", request, { group: id });
    return created({ id });
  });

  route("PATCH", "/api/groups/:id", (request) => {
    requirePermission(request, "groups.manage");
    const group = loadGroup(request.params.id);
    const name = request.body.name !== undefined ? uniqueName(request.body.name, group.id) : group.name;
    const description = request.body.description !== undefined ? textField(request.body.description, MAX_LENGTH.groupDescription, "Description") : group.description;
    run("UPDATE groups SET name = ?, description = ? WHERE id = ?", name, description, group.id);
    return { ok: true };
  });

  // Tickets in a deleted group become unrouted (the database sets their group to NULL).
  route("DELETE", "/api/groups/:id", (request) => {
    requirePermission(request, "groups.manage");
    const group = loadGroup(request.params.id);
    run("DELETE FROM groups WHERE id = ?", group.id);
    audit("group.delete", request, { group: group.id, name: group.name });
    return { ok: true };
  });

  route("POST", "/api/groups/:id/members", (request) => {
    const group = loadGroup(request.params.id);
    const userId = optionalId(request.body.userId) ?? fail(STATUS.badRequest, "Choose a person.");
    assertMayChangeMembership(request, userId);
    const person = getUserById(userId);
    if (!person || !person.active) fail(STATUS.badRequest, "That person's account is not active.");
    if (!can(person, "tickets.assignable")) fail(STATUS.badRequest, `${person.name}'s access level (${person.level_name}) doesn't allow taking tickets, so they can't join a resolver group.`);
    run("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?,?)", group.id, person.id);
    return { ok: true };
  });

  route("DELETE", "/api/groups/:id/members/:userId", (request) => {
    const group = loadGroup(request.params.id);
    const userId = idFromPath(request.params.userId);
    assertMayChangeMembership(request, userId);
    run("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", group.id, userId);
    return { ok: true };
  });

  route("PUT", "/api/groups/:id/lead", (request) => {
    requirePermission(request, "groups.manage");
    const group = loadGroup(request.params.id);
    const leadId = optionalId(request.body.userId);
    db.transaction(() => {
      run("UPDATE group_members SET is_lead = 0 WHERE group_id = ?", group.id);
      if (leadId && !run("UPDATE group_members SET is_lead = 1 WHERE group_id = ? AND user_id = ?", group.id, leadId).changes) fail(STATUS.badRequest, "The lead must be a member of the group.");
    })();
    return { ok: true };
  });
};
