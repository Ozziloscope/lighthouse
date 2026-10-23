// Where attached files live on disk: DATA_DIR/attachments/<random name>, readable only by the service.
// The database keeps the original file name; the disk name is random, so nothing a person uploads
// can choose or guess a path on the server.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { DATA_DIR } = require("./db");

const ATTACHMENTS_DIR = path.join(DATA_DIR, "attachments");
const OWNER_ONLY_FOLDER = 0o700, OWNER_ONLY_FILE = 0o600;
const STORAGE_NAME_BYTES = 16;
const STORAGE_NAME_PATTERN = /^[0-9a-f]{32}$/;
const SNIFF_BYTES = 12; // enough to recognise the picture formats below

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: OWNER_ONLY_FOLDER });

const pathFor = (storageName) => {
  if (!STORAGE_NAME_PATTERN.test(storageName)) throw new Error("Bad attachment name");
  return path.join(ATTACHMENTS_DIR, storageName);
};

class TooLargeError extends Error {}

// Streams an upload to disk, stopping as soon as it passes maxBytes. Returns { storageName, sizeBytes }.
async function saveUpload(readable, maxBytes) {
  const storageName = crypto.randomBytes(STORAGE_NAME_BYTES).toString("hex");
  const filePath = pathFor(storageName);
  let sizeBytes = 0;
  const sizeGuard = new Transform({
    transform(chunk, _encoding, done) {
      sizeBytes += chunk.length;
      done(sizeBytes > maxBytes ? new TooLargeError("File too large") : null, chunk);
    },
  });
  try {
    await pipeline(readable, sizeGuard, fs.createWriteStream(filePath, { flags: "wx", mode: OWNER_ONLY_FILE }));
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }
  return { storageName, sizeBytes };
}

const removeFile = (storageName) => { try { fs.rmSync(pathFor(storageName), { force: true }); } catch { /* already gone */ } };
const openForReading = (storageName) => fs.createReadStream(pathFor(storageName));

// Pictures are shown in the page; everything else is only ever downloaded. The type is decided from the
// file's first bytes, never from what the uploader claimed, so a file can't pretend to be a picture.
const PICTURE_SIGNATURES = [
  { type: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", matches: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { type: "image/webp", matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
function pictureTypeOf(storageName) {
  const head = Buffer.alloc(SNIFF_BYTES);
  let file;
  try {
    file = fs.openSync(pathFor(storageName), "r");
    fs.readSync(file, head, 0, SNIFF_BYTES, 0);
  } catch { return null; } finally { if (file !== undefined) fs.closeSync(file); }
  return PICTURE_SIGNATURES.find((s) => s.matches(head))?.type || null;
}

module.exports = { ATTACHMENTS_DIR, saveUpload, removeFile, openForReading, pictureTypeOf, TooLargeError };
