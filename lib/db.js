// Opens the SQLite database (Node's built-in node:sqlite, Node 22.13+) and brings its schema up to date.
// The database is one file, DATA_DIR/lighthouse.db.
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { MIGRATIONS } = require("./migrations");

const OWNER_ONLY_FILE_PERMISSIONS = 0o600;  // read/write for the service account only
const OWNER_ONLY_FOLDER_PERMISSIONS = 0o700;
const OWNER_ONLY_UMASK = 0o077;              // new files get no access for group or others
const WAIT_FOR_LOCK_MS = 5000;               // how long a query waits if another write holds the database

process.umask(OWNER_ONLY_UMASK);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: OWNER_ONLY_FOLDER_PERMISSIONS });
const DB_FILE = path.join(DATA_DIR, "lighthouse.db");
const SQLITE_SIDE_FILES = ["", "-wal", "-shm"];

// One-time carry-over from the earliest build, which was called "Rackline".
const RACKLINE_FILE = path.join(DATA_DIR, "rackline.db");
if (!fs.existsSync(DB_FILE) && fs.existsSync(RACKLINE_FILE)) {
  for (const suffix of SQLITE_SIDE_FILES) if (fs.existsSync(RACKLINE_FILE + suffix)) fs.renameSync(RACKLINE_FILE + suffix, DB_FILE + suffix);
  console.log("Moved rackline.db to lighthouse.db");
}

const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${WAIT_FOR_LOCK_MS};`);
// Files left by older versions may have looser permissions; tighten them every start.
for (const suffix of SQLITE_SIDE_FILES) { try { fs.chmodSync(DB_FILE + suffix, OWNER_ONLY_FILE_PERMISSIONS); } catch { /* file may not exist yet */ } }
try { fs.chmodSync(DATA_DIR, OWNER_ONLY_FOLDER_PERMISSIONS); } catch { /* not the owner (e.g. a mounted volume) */ }

// db.transaction(work)(...args) runs `work` so that either all of its changes are saved or none are.
db.transaction = (work) => (...args) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work(...args);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

// Short helpers used everywhere: one row, all rows, or run a change.
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function applyMigrations() {
  const appliedVersion = one("PRAGMA user_version").user_version;
  if (appliedVersion >= MIGRATIONS.length) return;
  // Rebuilding a table means briefly breaking references to it, so reference checks are paused
  // while migrations run and the whole database is checked afterwards.
  db.exec("PRAGMA foreign_keys = OFF");
  for (let version = appliedVersion + 1; version <= MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version - 1];
    db.transaction(() => {
      if (typeof step === "function") step(db); else db.exec(step);
      db.exec(`PRAGMA user_version = ${version}`);
    })();
    console.log(`Database updated to version ${version}`);
  }
  const brokenReferences = all("PRAGMA foreign_key_check");
  if (brokenReferences.length) throw new Error(`Database update left ${brokenReferences.length} broken references; restore from backup.`);
}
applyMigrations();
db.exec("PRAGMA foreign_keys = ON");

module.exports = { db, one, all, run, DATA_DIR, DB_FILE };
