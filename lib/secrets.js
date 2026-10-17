// Encrypts passwords and API tokens that admins enter in the app (for example the SMTP password)
// before they are stored in the database.
//
// The key lives in its own file next to the database (DATA_DIR/lighthouse.key, readable only by the
// service), or in the LIGHTHOUSE_SECRET_KEY environment variable. A copy of the database on its own
// (an off-site backup, say) therefore doesn't reveal the secrets. If the key is lost, the app keeps
// working and the admin simply re-enters the passwords under Settings > Alert setup.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const FORMAT_VERSION = "v1";
const KEY_FILE_NAME = "lighthouse.key";
const OWNER_READ_WRITE_ONLY = 0o600;

function loadOrCreateKey(dataDir) {
  const fromEnvironment = process.env.LIGHTHOUSE_SECRET_KEY;
  if (fromEnvironment) {
    const key = Buffer.from(fromEnvironment, /^[0-9a-f]+$/i.test(fromEnvironment) ? "hex" : "base64");
    if (key.length !== KEY_BYTES) throw new Error(`LIGHTHOUSE_SECRET_KEY must be ${KEY_BYTES} bytes (64 hex characters).`);
    return key;
  }
  const keyFile = path.join(dataDir, KEY_FILE_NAME);
  try {
    const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
    if (key.length === KEY_BYTES) return key;
  } catch { /* no key yet: make one below */ }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(keyFile, key.toString("hex") + "\n", { mode: OWNER_READ_WRITE_ONLY });
  return key;
}

function createSecrets(dataDir) {
  const key = loadOrCreateKey(dataDir);

  // Returns "v1:<nonce>:<tag>:<ciphertext>" (base64 parts).
  function encrypt(plainText) {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(CIPHER, key, nonce);
    const cipherText = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
    return [FORMAT_VERSION, nonce.toString("base64"), cipher.getAuthTag().toString("base64"), cipherText.toString("base64")].join(":");
  }

  // Returns the plain text, or null if the value can't be decrypted (for example, the key file was replaced).
  function decrypt(stored) {
    if (!stored) return null;
    const [version, nonce, tag, cipherText] = String(stored).split(":");
    if (version !== FORMAT_VERSION) return null;
    try {
      const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(nonce, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  return { encrypt, decrypt };
}

module.exports = { createSecrets, KEY_FILE_NAME };
