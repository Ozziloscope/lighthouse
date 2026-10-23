// Password hashing with scrypt (built into Node). A stored hash looks like: scrypt$N$r$p$salt$hash
// Hashing runs on Node's worker thread pool, so a burst of sign-ins never freezes other requests.
const crypto = require("crypto");
const { promisify } = require("util");
const { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, GENERATED_PASSWORD_LENGTH, RESET_PASSPHRASE_WORDS } = require("./constants");
const PASSPHRASE_WORDS = require("./passphrase-words");
const PASSPHRASE_NUMBER = { min: 10, max: 100 }; // a two-digit number on the end (max is exclusive)
const scrypt = promisify(crypto.scrypt);

// scrypt cost settings (OWASP-recommended minimums): CPU/memory cost, block size, parallelism.
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const HASH_BYTES = 64;
const SALT_BYTES = 16;
// Letters and digits that are hard to confuse when read aloud or copied by hand (no 0/O, 1/l/I).
const READABLE_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

// Returns an error message if the password is not allowed, or null if it is fine.
function passwordProblem(password, label = "Password") {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `${label} must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, HASH_BYTES, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM });
  return ["scrypt", SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELISM, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function verifyPassword(password, storedHash) {
  try {
    if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
    const [algorithm, cost, blockSize, parallelism, saltBase64, hashBase64] = String(storedHash).split("$");
    if (algorithm !== "scrypt") return false;
    const expected = Buffer.from(hashBase64, "base64");
    const actual = await scrypt(password, Buffer.from(saltBase64, "base64"), expected.length, { N: Number(cost), r: Number(blockSize), p: Number(parallelism) });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// When someone signs in with a username that does not exist, we still check a real hash, so the
// response takes the same time and does not reveal which usernames exist.
let decoyHash = null;
const decoyHashReady = hashPassword(crypto.randomBytes(SALT_BYTES).toString("hex")).then((hash) => (decoyHash = hash));
const getDecoyHash = async () => decoyHash || decoyHashReady;

// A random temporary password for new accounts and resets.
function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i++) out += READABLE_PASSWORD_ALPHABET[crypto.randomInt(READABLE_PASSWORD_ALPHABET.length)];
  return out;
}

// An easy-to-type one-time passphrase for emailed resets, such as "maple-otter-quartz-lantern-42".
function generatePassphrase(wordCount = RESET_PASSPHRASE_WORDS) {
  const words = Array.from({ length: wordCount }, () => PASSPHRASE_WORDS[crypto.randomInt(PASSPHRASE_WORDS.length)]);
  return [...words, crypto.randomInt(PASSPHRASE_NUMBER.min, PASSPHRASE_NUMBER.max)].join("-");
}

module.exports = { hashPassword, verifyPassword, getDecoyHash, passwordProblem, generatePassword, generatePassphrase };
