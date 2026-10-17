// Rules about people that several parts of the app share: how a person is shown to others,
// username checks, and what happens when someone loses a permission or is deactivated.
const { MAX_LENGTH, MIN_USERNAME_LENGTH, USERNAME_PATTERN, OPEN_TICKET_STATUSES } = require("./constants");
const { can, isAdministrator, permissionsForUser, USER_WITH_LEVEL_SQL } = require("./access");
const { fail, STATUS } = require("./http");

function createPeople({ one, all, run, db, getUserById }) {
  // What anyone allowed to see the staff list learns about a person.
  const forDirectory = (u) => ({
    id: u.id,
    name: u.name,
    active: !!u.active,
    accessLevelId: u.access_level_id,
    accessLevelName: u.level_name || "",
    canBeAssigned: !!u.active && can(u, "tickets.assignable"),
    usesProjects: !!u.active && can(u, "projects.access"),
    photoVersion: u.photo_updated_at || null, // the photo is at /api/users/<id>/photo?v=<photoVersion>
  });
  // Extra details for people who manage accounts.
  const forAccountManagers = (u) => ({
    ...forDirectory(u),
    username: u.username,
    email: u.email || null,
    isAdministrator: isAdministrator(u),
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
  });
  // What a person learns about themselves.
  const forSelf = (u) => ({ ...forAccountManagers(u), permissions: [...u.permissions], theme: u.theme });

  // ---------- who can see whom ----------
  // A person sees the whole staff list if their work involves other staff; otherwise only the
  // people on their own tickets (the technician working it, and anyone who posted a public update).
  const seesWholeDirectory = (user) => ["tickets.view_all", "projects.access", "users.manage", "groups.manage"].some((key) => can(user, key));
  function idsOnTheirTickets(user) {
    return all(`SELECT DISTINCT id FROM (
        SELECT ? AS id
        UNION SELECT assignee_id FROM tickets WHERE requester_id = ? AND assignee_id IS NOT NULL
        UNION SELECT a.user_id FROM activity a JOIN tickets t ON t.id = a.ticket_id WHERE t.requester_id = ? AND a.type != 'internal' AND a.user_id IS NOT NULL)`,
      user.id, user.id, user.id).map((r) => r.id);
  }
  function directoryFor(user) {
    if (seesWholeDirectory(user)) return allUsersWithPermissions();
    const visibleIds = idsOnTheirTickets(user);
    return allUsersWithPermissions().filter((u) => visibleIds.includes(u.id));
  }
  const canSeePerson = (viewer, personId) => seesWholeDirectory(viewer) || idsOnTheirTickets(viewer).includes(personId);

  const allUsersWithPermissions = () => all(`${USER_WITH_LEVEL_SQL} ORDER BY u.name COLLATE NOCASE`).map((row) => ({ ...row, permissions: permissionsForUser(row) }));

  // Checks a username and returns it in lower case. `exceptUserId` lets a person keep their own.
  function checkUsername(input, exceptUserId = null) {
    if (typeof input !== "string") fail(STATUS.badRequest, "Username is required.");
    const username = input.trim().toLowerCase();
    if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_LENGTH.username) fail(STATUS.badRequest, `Username must be ${MIN_USERNAME_LENGTH} to ${MAX_LENGTH.username} characters.`);
    if (!USERNAME_PATTERN.test(username)) fail(STATUS.badRequest, "Username can use letters, numbers, dots, dashes and underscores only.");
    const existing = one("SELECT id FROM users WHERE username = ?", username);
    if (existing && existing.id !== exceptUserId) fail(STATUS.conflict, "That username is already taken.");
    return username;
  }

  const countActiveAdministrators = () => one(`SELECT COUNT(*) AS n FROM users u JOIN access_levels l ON l.id = u.access_level_id WHERE u.active = 1 AND l.is_administrator = 1`).n;

  // After someone's access level, its permissions, or their active status changes, take away the work
  // they can no longer do, so nothing is left assigned to someone who cannot act on it.
  function releaseWorkTheyCanNoLongerDo(userId, actorId) {
    const person = getUserById(userId);
    if (!person) return;
    const now = Date.now();
    const canHoldTickets = person.active && can(person, "tickets.assignable");
    const canUseProjects = person.active && can(person, "projects.access");
    if (!canHoldTickets) {
      const openTickets = all(`SELECT id FROM tickets WHERE assignee_id = ? AND status IN (${OPEN_TICKET_STATUSES.map(() => "?").join(",")})`, person.id, ...OPEN_TICKET_STATUSES);
      for (const ticket of openTickets) {
        run("INSERT INTO activity (ticket_id, user_id, type, field, from_val, to_val, at) VALUES (?,?, 'change', 'assignee', ?, '', ?)", ticket.id, actorId, person.name, now);
        // A ticket that was only "Assigned" goes back to "New" so it shows up as needing an owner.
        run("UPDATE tickets SET assignee_id = NULL, status = CASE WHEN status = 'Assigned' THEN 'New' ELSE status END, updated_at = ? WHERE id = ?", now, ticket.id);
      }
      run("DELETE FROM group_members WHERE user_id = ?", person.id);
    }
    if (!canUseProjects) {
      for (const task of all("SELECT id FROM tasks WHERE assignee_id = ? AND completed = 0", person.id)) {
        run("INSERT INTO task_activity (task_id, user_id, type, field, from_val, to_val, at) VALUES (?,?, 'change', 'assignee', ?, '', ?)", task.id, actorId, person.name, now);
        run("UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE id = ?", now, task.id);
      }
      // Owners stay on their projects so ownership is never lost; an admin can hand the project over.
      run("DELETE FROM project_members WHERE user_id = ? AND project_id NOT IN (SELECT id FROM projects WHERE owner_id = ?)", person.id, person.id);
    }
  }

  return { forDirectory, forAccountManagers, forSelf, allUsersWithPermissions, seesWholeDirectory, directoryFor, canSeePerson, checkUsername, countActiveAdministrators, releaseWorkTheyCanNoLongerDo };
}

module.exports = { createPeople };
