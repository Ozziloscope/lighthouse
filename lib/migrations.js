// The database schema, as a list of numbered steps. Each step runs once, in order, and the database
// remembers (in PRAGMA user_version) which steps it has had. To change the schema, add a new step at the end;
// never edit a step that has already shipped, because existing databases have already run it.
const { FIRST_TICKET_NUMBER, MAX_LENGTH, MIN_USERNAME_LENGTH } = require("./constants");
const { STARTING_ACCESS_LEVELS } = require("./access");

// Version 4: people sign in with a username instead of an email address, and the fixed roles
// (admin / technician / requester) become access levels that admins can edit.
function switchToUsernamesAndAccessLevels(db) {
  const now = Date.now();
  db.exec(`CREATE TABLE access_levels (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description      TEXT NOT NULL DEFAULT '',
    permissions      TEXT NOT NULL DEFAULT '[]',       -- JSON list of permission keys (see lib/access.js)
    is_administrator INTEGER NOT NULL DEFAULT 0,        -- the built-in level that always has every permission
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  )`);
  const levelIdByName = {};
  for (const level of STARTING_ACCESS_LEVELS) {
    levelIdByName[level.name] = db.prepare("INSERT INTO access_levels (name, description, permissions, is_administrator, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(level.name, level.description, JSON.stringify(level.isAdministrator ? [] : level.permissions), level.isAdministrator ? 1 : 0, now, now).lastInsertRowid;
  }
  const levelForOldRole = { admin: levelIdByName.Administrator, technician: levelIdByName.Technician, requester: levelIdByName.Requester };

  db.exec(`CREATE TABLE users_new (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name                 TEXT NOT NULL,
    email                TEXT UNIQUE COLLATE NOCASE,        -- optional; used for email alerts
    password_hash        TEXT NOT NULL,
    access_level_id      INTEGER NOT NULL REFERENCES access_levels(id),
    active               INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    alert_email          TEXT,
    phone                TEXT,
    alert_prefs          TEXT NOT NULL DEFAULT '{}',
    alerts_paused        INTEGER NOT NULL DEFAULT 0,
    theme                TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
    created_at           INTEGER NOT NULL
  )`);

  // Existing accounts get a username made from the part of their email before the "@".
  // Leave room at the end for a number in case two people share the same name before the "@".
  const ROOM_FOR_SUFFIX = 4;
  const longestBase = MAX_LENGTH.username - ROOM_FOR_SUFFIX;
  const taken = new Set();
  const usernameFromEmail = (email) => {
    let base = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, longestBase);
    if (base.length < MIN_USERNAME_LENGTH) base = (base + "user").slice(0, longestBase);
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base}${suffix}`;
    taken.add(candidate);
    return candidate;
  };
  const insertUser = db.prepare(`INSERT INTO users_new (id, username, name, email, password_hash, access_level_id, active, must_change_password,
    alert_email, phone, alert_prefs, alerts_paused, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const u of db.prepare("SELECT * FROM users ORDER BY id").all()) {
    insertUser.run(u.id, usernameFromEmail(u.email), u.name, u.email, u.password_hash, levelForOldRole[u.role] ?? levelIdByName.Requester,
      u.active, u.must_change_password, u.alert_email, u.phone, u.alert_prefs, u.alerts_paused, u.created_at);
  }
  db.exec("DROP TABLE users; ALTER TABLE users_new RENAME TO users; CREATE INDEX idx_users_level ON users(access_level_id);");
}

const MIGRATIONS = [
  // Version 1: users, sessions, resolver groups, tickets and ticket history.
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'requester' CHECK (role IN ('admin','agent','requester')),
    active        INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE TABLE groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_lead  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE tickets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    priority     TEXT NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3','P4')),
    category     TEXT NOT NULL DEFAULT 'Other',
    status       TEXT NOT NULL DEFAULT 'New',
    asset        TEXT NOT NULL DEFAULT '',
    group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    requester_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolution   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    resolved_at  INTEGER
  );
  CREATE INDEX idx_tickets_status ON tickets(status);
  CREATE INDEX idx_tickets_group ON tickets(group_id);
  CREATE INDEX idx_tickets_assignee ON tickets(assignee_id);
  CREATE INDEX idx_tickets_requester ON tickets(requester_id);
  CREATE TABLE activity (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type      TEXT NOT NULL CHECK (type IN ('created','change','comment','internal')),
    field     TEXT,
    from_val  TEXT,
    to_val    TEXT,
    body      TEXT,
    at        INTEGER NOT NULL
  );
  CREATE INDEX idx_activity_ticket ON activity(ticket_id);
  -- Ticket numbers start at 1001
  INSERT INTO sqlite_sequence (name, seq) VALUES ('tickets', ${FIRST_TICKET_NUMBER - 1});
  `,
  // Version 2: the "agent" role was renamed "technician".
  `
  CREATE TABLE users_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'requester' CHECK (role IN ('admin','technician','requester')),
    active        INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  INSERT INTO users_new (id, email, name, password_hash, role, active, must_change_password, created_at)
    SELECT id, email, name, password_hash, CASE role WHEN 'agent' THEN 'technician' ELSE role END, active, must_change_password, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  `,
  // Version 3: projects and tasks, per-person alert settings, and the alert outbox.
  `
  ALTER TABLE users ADD COLUMN alert_email TEXT;                       -- verified alternate address; NULL = account email
  ALTER TABLE users ADD COLUMN phone TEXT;                             -- verified mobile number in E.164 form
  ALTER TABLE users ADD COLUMN alert_prefs TEXT NOT NULL DEFAULT '{}'; -- per-event channel choices (JSON)
  ALTER TABLE users ADD COLUMN alerts_paused INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE verify_codes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL CHECK (channel IN ('email','sms')),
    target     TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel)
  );

  CREATE TABLE outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
    target          TEXT NOT NULL,
    event           TEXT NOT NULL,
    subject         TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL,
    html            TEXT,
    dedupe_key      TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    sent_at         INTEGER
  );
  CREATE INDEX idx_outbox_queue ON outbox(status, next_attempt_at);
  CREATE INDEX idx_outbox_sent ON outbox(channel, sent_at);

  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT 'teal',
    status      TEXT NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track','at_risk','off_track','on_hold','complete')),
    owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_date    TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE sections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_sections_project ON sections(project_id);
  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    section_id   INTEGER REFERENCES sections(id) ON DELETE SET NULL,
    parent_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_date     TEXT,
    priority     TEXT NOT NULL DEFAULT '' CHECK (priority IN ('','low','medium','high')),
    completed    INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER,
    ticket_id    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id, section_id, position);
  CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, completed);
  CREATE INDEX idx_tasks_parent ON tasks(parent_id);
  CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);
  CREATE TABLE task_activity (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type     TEXT NOT NULL CHECK (type IN ('created','change','comment')),
    field    TEXT,
    from_val TEXT,
    to_val   TEXT,
    body     TEXT,
    at       INTEGER NOT NULL
  );
  CREATE INDEX idx_task_activity ON task_activity(task_id);
  `,
  switchToUsernamesAndAccessLevels,

  // Version 5 (1.4): desk settings edited in the app (SLA targets, email and text setup), contact details
  // people can save before they are verified, and profile photos.
  `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,                                   -- JSON; secrets inside it are encrypted
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  -- Numbers and addresses saved before 1.4 were always verified, hence the default of 1.
  ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN alert_email_verified INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN photo_updated_at INTEGER;          -- also used as the photo's version in its address
  CREATE TABLE user_photos (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    image      BLOB NOT NULL,                                  -- JPEG, already shrunk and stripped of metadata
    updated_at INTEGER NOT NULL
  );
  `,
];

module.exports = { MIGRATIONS };
