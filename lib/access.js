// Access control. Every person has one access level, and an access level is a named set of permissions.
// Admins create and edit access levels in Settings > Access levels. The built-in Administrator level
// always has every permission and cannot be changed or deleted.

// Every permission that can be granted, in the order the admin screen shows them.
const PERMISSIONS = [
  { key: "tickets.create",         area: "Tickets",  label: "Raise tickets", description: "Open new tickets and follow the tickets they raised." },
  { key: "tickets.view_all",       area: "Tickets",  label: "See every ticket", description: "Without this, a person only sees tickets they raised." },
  { key: "tickets.work",           area: "Tickets",  label: "Work tickets", description: "Change status, priority and category, resolve and reopen tickets they can see." },
  { key: "tickets.assignable",     area: "Tickets",  label: "Can be assigned tickets", description: "Appears in assignee lists, can take tickets and can join resolver groups." },
  { key: "tickets.assign",         area: "Tickets",  label: "Assign and route tickets", description: "Assign tickets to anyone who can be assigned, and move tickets between resolver groups." },
  { key: "tickets.internal_notes", area: "Tickets",  label: "Read and write internal notes", description: "Internal notes are hidden from everyone without this permission." },
  { key: "tickets.delete",         area: "Tickets",  label: "Delete tickets", description: "Permanently remove a ticket and its history." },
  { key: "sla.manage",             area: "Tickets",  label: "Change SLA targets", description: "Set how many hours each priority has to be resolved in. Applies to every ticket, open or closed." },
  { key: "groups.manage",          area: "Tickets",  label: "Manage resolver groups", description: "Create, rename and delete resolver groups, and choose their members and leads." },
  { key: "projects.access",        area: "Projects", label: "Use projects", description: "See projects, and add, edit and complete tasks." },
  { key: "projects.create",        area: "Projects", label: "Create projects", description: "Start new projects. The creator owns the project." },
  { key: "projects.manage_all",    area: "Projects", label: "Manage every project", description: "Archive, delete or change the owner of any project, not just their own." },
  { key: "users.manage",           area: "Admin",    label: "Manage user accounts", description: "Add people, reset passwords, deactivate accounts and choose access levels. Cannot give anyone more permissions than they have themselves." },
  { key: "alerts.view_log",        area: "Admin",    label: "See the alert delivery log", description: "See every email and text sent, and retry failed ones." },
];
const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Permissions only the built-in Administrator level holds. They can never be granted to another level,
// so only Administrators can change what access levels allow.
const ADMINISTRATOR_ONLY_PERMISSIONS = [
  { key: "access.manage", area: "Admin", label: "Manage access levels", description: "Create, edit and delete access levels. Only the Administrator level has this." },
  { key: "alerts.configure", area: "Admin", label: "Set up email and text delivery", description: "Enter mail server and Twilio settings, including passwords. Only the Administrator level has this." },
];
const ALL_PERMISSION_KEYS = [...PERMISSION_KEYS, ...ADMINISTRATOR_ONLY_PERMISSIONS.map((p) => p.key)];

// Starting access levels created on a new install (and for accounts upgraded from version 1.2).
// Admins can rename, change or delete everything except Administrator.
const STARTING_ACCESS_LEVELS = [
  { name: "Administrator", description: "Full access to everything, including access levels.", isAdministrator: true, permissions: ALL_PERMISSION_KEYS },
  {
    name: "Technician",
    description: "Works tickets and projects. Cannot manage users or resolver groups.",
    isAdministrator: false,
    permissions: ["tickets.create", "tickets.view_all", "tickets.work", "tickets.assignable", "tickets.assign", "tickets.internal_notes", "projects.access", "projects.create"],
  },
  { name: "Requester", description: "Raises tickets and follows only their own.", isAdministrator: false, permissions: ["tickets.create"] },
];

// Turn the stored list into a Set, dropping anything that is not a known, grantable permission.
function parseStoredPermissions(json) {
  let list = [];
  try { list = JSON.parse(json || "[]"); } catch { list = []; }
  return new Set((Array.isArray(list) ? list : []).filter((key) => PERMISSION_KEYS.includes(key)));
}

// The permissions a person actually has, given the access level row joined onto their user row.
function permissionsForUser(userRow) {
  if (!userRow) return new Set();
  if (userRow.level_is_administrator) return new Set(ALL_PERMISSION_KEYS);
  return parseStoredPermissions(userRow.level_permissions);
}

// SQL that loads users together with their access level. Use it wherever permissions matter.
const USER_WITH_LEVEL_SQL = `SELECT u.*, l.name AS level_name, l.permissions AS level_permissions, l.is_administrator AS level_is_administrator
  FROM users u LEFT JOIN access_levels l ON l.id = u.access_level_id`;

function createAccessHelpers({ one, all }) {
  function loadUser(whereSql, ...params) {
    const row = one(`${USER_WITH_LEVEL_SQL} WHERE ${whereSql}`, ...params);
    if (row) row.permissions = permissionsForUser(row);
    return row;
  }
  const getUserById = (id) => loadUser("u.id = ?", id);

  // Active people who hold a permission, e.g. everyone who should hear about any P1.
  function activeUsersWith(permissionKey) {
    return all(`${USER_WITH_LEVEL_SQL} WHERE u.active = 1`)
      .map((row) => ({ ...row, permissions: permissionsForUser(row) }))
      .filter((row) => row.permissions.has(permissionKey));
  }
  return { loadUser, getUserById, activeUsersWith };
}

const can = (user, permissionKey) => !!user && !!user.permissions && user.permissions.has(permissionKey);
const isAdministrator = (user) => !!user && !!user.level_is_administrator;

module.exports = {
  PERMISSIONS, PERMISSION_KEYS, ADMINISTRATOR_ONLY_PERMISSIONS, ALL_PERMISSION_KEYS, STARTING_ACCESS_LEVELS, USER_WITH_LEVEL_SQL,
  parseStoredPermissions, permissionsForUser, createAccessHelpers, can, isAdministrator,
};
