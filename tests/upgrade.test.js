// Upgrading a database from version 1.2 (email sign-in, fixed roles) to usernames and access levels.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { MIGRATIONS } = require("../lib/migrations");

const VERSION_1_2_SCHEMA = 3; // the 1.2 release had applied the first three schema steps

test("1.2 accounts get usernames and matching access levels, and keep everything else", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-upgrade-"));
  const oldDb = new DatabaseSync(path.join(dataDir, "lighthouse.db"));
  for (const step of MIGRATIONS.slice(0, VERSION_1_2_SCHEMA)) oldDb.exec(step);
  oldDb.exec(`PRAGMA user_version = ${VERSION_1_2_SCHEMA}`);
  const addOldUser = oldDb.prepare("INSERT INTO users (email, name, password_hash, role, created_at, phone) VALUES (?,?,?,?,?,?)");
  addOldUser.run("nick@example.com", "Nick", "hash-1", "admin", 1, null);
  addOldUser.run("ada.lovelace@example.com", "Ada", "hash-2", "technician", 2, "+13175550101");
  addOldUser.run("ada.lovelace@other.org", "Ada Two", "hash-3", "technician", 3, null);
  addOldUser.run("r@example.com", "Rex", "hash-4", "requester", 4, null);
  oldDb.prepare("INSERT INTO tickets (title, created_at, updated_at, requester_id, assignee_id) VALUES ('Old ticket', 1, 1, 4, 2)").run();
  oldDb.close();

  process.env.DATA_DIR = dataDir;
  const originalLog = console.log;
  console.log = () => {};
  const { all, one } = require("../lib/db");
  console.log = originalLog;

  const people = all("SELECT u.id, u.username, u.email, u.phone, u.password_hash, l.name AS level FROM users u JOIN access_levels l ON l.id = u.access_level_id ORDER BY u.id");
  assert.deepEqual(people.map((p) => [p.username, p.level]), [
    ["nick", "Administrator"],
    ["ada.lovelace", "Technician"],
    ["ada.lovelace2", "Technician"], // same name before the @ gets a number
    ["ruser", "Requester"],          // too short on its own, so padded
  ]);
  assert.equal(people[1].phone, "+13175550101", "alert settings are kept");
  assert.equal(people[1].password_hash, "hash-2", "passwords are kept");
  assert.equal(one("SELECT assignee_id FROM tickets").assignee_id, 2, "ticket links still point at the same people");
  assert.equal(one("PRAGMA user_version").user_version, MIGRATIONS.length);
});
