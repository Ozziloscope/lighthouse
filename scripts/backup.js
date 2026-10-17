// Makes a consistent copy of the database while the server keeps running (SQLite's VACUUM INTO),
// then opens the copy and checks it is healthy.
//
//   npm run backup -- /path/to/copy.db
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const OWNER_ONLY_UMASK = 0o077;     // the backup is readable by the service account only
const WAIT_FOR_LOCK_MS = 10000;     // wait this long if the server is in the middle of writing

const outputFile = process.argv[2];
if (!outputFile) { console.error("Usage: npm run backup -- <output.db>"); process.exit(1); }
if (fs.existsSync(outputFile)) { console.error(`${outputFile} already exists.`); process.exit(1); }
process.umask(OWNER_ONLY_UMASK);

const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const databaseFile = path.join(dataDir, "lighthouse.db");
if (!fs.existsSync(databaseFile)) { console.error(`No database at ${databaseFile}. Set DATA_DIR.`); process.exit(1); }

const source = new DatabaseSync(databaseFile, { readOnly: true });
source.exec(`PRAGMA busy_timeout = ${WAIT_FOR_LOCK_MS}`);
source.prepare("VACUUM INTO ?").run(path.resolve(outputFile));
source.close();

const copy = new DatabaseSync(outputFile, { readOnly: true });
const integrity = Object.values(copy.prepare("PRAGMA integrity_check").get())[0];
const ticketCount = copy.prepare("SELECT COUNT(*) AS n FROM tickets").get().n;
copy.close();
if (integrity !== "ok") { console.error(`Integrity check failed for ${outputFile}`); process.exit(1); }
console.log(`Backup OK: ${outputFile} (${ticketCount} tickets)`);
