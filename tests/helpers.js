// Shared tools for the automated tests (run them with `npm test`).
//
// Each test file starts its own copy of Lighthouse, in-process, with a brand-new database in a temporary folder,
// plus a fake mail server (real STARTTLS, real password check) and a fake Twilio API, so email and text alerts
// are tested end to end without sending anything to the outside world.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const http = require("http");

const FIXTURES = path.join(__dirname, "fixtures");
const TEST_SMTP_USER = "lighthouse-test";
const TEST_SMTP_PASSWORD = "smtp-test-password";
const TEST_TWILIO_SID = "AC0123456789abcdef0123456789abcdef";
const TEST_TWILIO_KEY_SID = "SK0123456789abcdef0123456789abcdef";
const TEST_TWILIO_KEY_SECRET = "twilio-test-secret";
const TEST_SETUP_CODE = "test-setup-code";
const TEST_INTAKE_TOKEN = "test-intake-token-0123456789abcdef0123456789";
const PHONE_TWILIO_REJECTS = "+15555550199";   // the fake Twilio answers "not a valid number" for this one
const EMAIL_SMTP_REJECTS = "bounce@example.com"; // the fake mail server rejects this recipient
const SMTP_LINE_END = "\r\n";

// ---------- fake mail server ----------
// Requires STARTTLS before sign-in, accepts one username/password, and records every message.
function startFakeMailServer() {
  const secureContext = tls.createSecureContext({ key: fs.readFileSync(path.join(FIXTURES, "test-smtp-key.pem")), cert: fs.readFileSync(path.join(FIXTURES, "test-smtp-cert.pem")) });
  const messages = [];
  const server = net.createServer((plainSocket) => {
    let socket = plainSocket, encrypted = false, signedIn = false, buffer = "", readingMessage = false, messageLines = [], envelope = {};
    const reply = (line) => socket.write(line + SMTP_LINE_END);
    function handleLine(line) {
      if (readingMessage) {
        if (line === ".") { readingMessage = false; messages.push({ ...envelope, encrypted, raw: messageLines.join(SMTP_LINE_END) }); messageLines = []; return reply("250 Queued"); }
        messageLines.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      const command = line.split(" ")[0].toUpperCase();
      if (command === "EHLO") { reply("250-fake.mail.test"); reply(encrypted ? "250-AUTH PLAIN LOGIN" : "250-STARTTLS"); return reply("250 OK"); }
      if (command === "STARTTLS") {
        reply("220 Ready to start TLS");
        plainSocket.removeAllListeners("data");
        socket = new tls.TLSSocket(plainSocket, { isServer: true, secureContext });
        socket.on("data", receive);
        encrypted = true;
        return;
      }
      if (command === "AUTH") {
        if (!encrypted) return reply("530 Must issue STARTTLS first");
        const [, user, password] = Buffer.from(line.split(" ")[2] || "", "base64").toString().split("\0");
        signedIn = user === TEST_SMTP_USER && password === TEST_SMTP_PASSWORD;
        return reply(signedIn ? "235 Authenticated" : "535 Bad credentials");
      }
      if (command === "MAIL") return signedIn ? reply("250 OK") : reply("530 Authentication required");
      if (command === "RCPT") { envelope.to = (line.match(/<(.*)>/) || [])[1]; return reply(envelope.to === EMAIL_SMTP_REJECTS ? "550 No such user" : "250 OK"); }
      if (command === "DATA") { readingMessage = true; return reply("354 Send the message"); }
      if (command === "QUIT") { reply("221 Bye"); return socket.end(); }
      reply("502 Unknown command");
    }
    function receive(chunk) {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf(SMTP_LINE_END)) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + SMTP_LINE_END.length); handleLine(line); }
    }
    plainSocket.on("data", receive);
    plainSocket.on("error", () => {});
    reply("220 fake.mail.test ready");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, messages, close: () => server.close() })));
}

// Decodes a recorded message into { to, subject, text, encrypted }.
function readMail(message) {
  const decodeBase64Part = (raw, type) => {
    const match = raw.match(new RegExp(`Content-Type: ${type}[^]*?\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`));
    return match ? Buffer.from(match[1].replace(/\s/g, ""), "base64").toString("utf8") : "";
  };
  const subjectLine = (message.raw.match(/^Subject: (.*(?:\r\n .*)*)/m) || [])[1] || "";
  const subject = subjectLine.split(/\r\n /).map((part) => {
    const encoded = /^=\?UTF-8\?B\?(.*)\?=$/.exec(part.trim());
    return encoded ? Buffer.from(encoded[1], "base64").toString("utf8") : part;
  }).join("");
  return { to: message.to, subject, text: decodeBase64Part(message.raw, "text/plain"), encrypted: message.encrypted, hasHtml: message.raw.includes("text/html") };
}

// ---------- fake Twilio ----------
function startFakeTwilio() {
  const texts = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const credentials = Buffer.from((request.headers.authorization || "").replace("Basic ", ""), "base64").toString();
      const form = new URLSearchParams(body);
      const answer = (status, json) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(json)); };
      if (request.url !== `/2010-04-01/Accounts/${TEST_TWILIO_SID}/Messages.json` || credentials !== `${TEST_TWILIO_KEY_SID}:${TEST_TWILIO_KEY_SECRET}`) return answer(401, { code: 20003, message: "Authenticate" });
      if (form.get("To") === PHONE_TWILIO_REJECTS) return answer(400, { code: 21211, message: `The 'To' number ${PHONE_TWILIO_REJECTS} is not a valid phone number.` });
      texts.push({ to: form.get("To"), from: form.get("From"), body: form.get("Body") });
      answer(201, { sid: "SM" + texts.length, status: "queued" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, texts, close: () => server.close() })));
}

// ---------- Lighthouse under test ----------
// Starts Lighthouse with a fresh database.
//   withAlerts       connects it to the fake mail server and fake Twilio through environment variables.
//   withFakeServers  starts the fakes but leaves email and texts off, so a test can set them up in the app.
//                    (Only the env-only settings are filled in: the test certificate authority and the Twilio address.)
//   withIntake       turns on the private website-intake listener (lib/intake.js) with TEST_INTAKE_TOKEN;
//                    3D print requests route to a group called "3D Printing", IT jobs to "IT Jobs".
async function startLighthouse({ withAlerts = false, withFakeServers = false, withIntake = false, publicUrl = "" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lighthouse-test-"));
  const needsFakes = withAlerts || withFakeServers;
  const mail = needsFakes ? await startFakeMailServer() : null;
  const twilio = needsFakes ? await startFakeTwilio() : null;
  Object.assign(process.env, {
    DATA_DIR: dataDir, PUBLIC_URL: publicUrl, SETUP_TOKEN: TEST_SETUP_CODE, ALERT_DAILY_HOUR: "0", TZ: process.env.TZ || "UTC",
    ...(withIntake ? { INTAKE_TOKEN: TEST_INTAKE_TOKEN, INTAKE_PRINT_GROUP: "3D Printing", INTAKE_IT_GROUP: "IT Jobs" } : {}),
    ...(withFakeServers ? { SMTP_CA_FILE: path.join(FIXTURES, "test-smtp-cert.pem"), TWILIO_API_BASE: `http://127.0.0.1:${twilio.port}` } : {}),
    ...(withAlerts ? {
      SMTP_HOST: "localhost", SMTP_PORT: String(mail.port), SMTP_SECURE: "starttls", SMTP_USER: TEST_SMTP_USER, SMTP_PASS: TEST_SMTP_PASSWORD,
      SMTP_FROM: "Lighthouse Test <desk@example.com>", SMTP_CA_FILE: path.join(FIXTURES, "test-smtp-cert.pem"),
      SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: TEST_TWILIO_SID, TWILIO_API_KEY_SID: TEST_TWILIO_KEY_SID, TWILIO_API_KEY_SECRET: TEST_TWILIO_KEY_SECRET,
      TWILIO_FROM: "+13175550000", TWILIO_API_BASE: `http://127.0.0.1:${twilio.port}`,
    } : {}),
  });
  const originalLog = console.log;
  console.log = () => {}; // keep audit lines out of the test output
  const lighthouse = require("../lib/app");
  await new Promise((resolve) => lighthouse.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${lighthouse.server.address().port}`;
  let intakeUrl = null;
  if (lighthouse.intakeServer) {
    await new Promise((resolve) => lighthouse.intakeServer.listen(0, "127.0.0.1", resolve));
    intakeUrl = `http://127.0.0.1:${lighthouse.intakeServer.address().port}`;
  }
  return {
    baseUrl, intakeUrl, mail, twilio, dataDir, notify: lighthouse.notify, db: lighthouse.db,
    stop() { lighthouse.server.close(); lighthouse.intakeServer?.close(); mail?.close(); twilio?.close(); console.log = originalLog; },
  };
}

// ---------- a signed-in person ----------
class Person {
  constructor(baseUrl) { this.baseUrl = baseUrl; this.cookie = ""; }
  async call(method, urlPath, body) {
    const response = await fetch(this.baseUrl + urlPath, {
      method,
      headers: { "Content-Type": "application/json", "X-Lighthouse": "1", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const json = await response.json().catch(() => ({}));
    return { status: response.status, body: json };
  }
  get(urlPath) { return this.call("GET", urlPath); }
  post(urlPath, body = {}) { return this.call("POST", urlPath, body); }
  patch(urlPath, body = {}) { return this.call("PATCH", urlPath, body); }
  put(urlPath, body = {}) { return this.call("PUT", urlPath, body); }
  delete(urlPath) { return this.call("DELETE", urlPath); }
  async signIn(username, password) {
    const result = await this.post("/api/login", { username, password });
    if (result.status !== 200) throw new Error(`Sign-in failed for ${username}: ${JSON.stringify(result.body)}`);
    return this;
  }
}

// Creates the first admin, then signs in. Returns the admin.
async function setUpDesk(baseUrl) {
  const admin = new Person(baseUrl);
  const result = await admin.post("/api/setup", { setupCode: TEST_SETUP_CODE, name: "Nick Admin", username: "nick", password: "admin-password-1" });
  if (result.status !== 200) throw new Error("Setup failed: " + JSON.stringify(result.body));
  return admin;
}

// An admin creates an account; the new person signs in and replaces the temporary password.
async function addPerson(admin, { name, username, accessLevelName, email }) {
  const levels = (await admin.get("/api/access-levels")).body.levels;
  const level = levels.find((l) => l.name === accessLevelName);
  if (!level) throw new Error(`No access level called ${accessLevelName}`);
  const created = await admin.post("/api/users", { name, username, email, accessLevelId: level.id });
  if (created.status !== 201) throw new Error("Could not add user: " + JSON.stringify(created.body));
  const person = new Person(admin.baseUrl);
  await person.signIn(username, created.body.temporaryPassword);
  await person.post("/api/me/password", { current: created.body.temporaryPassword, next: `${username}-password-1` });
  person.id = created.body.user.id;
  person.username = username;
  return person;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400)); // lets queued alerts go out

module.exports = {
  startLighthouse, setUpDesk, addPerson, Person, readMail, settle, startFakeMailServer, startFakeTwilio,
  TEST_SETUP_CODE, TEST_INTAKE_TOKEN, PHONE_TWILIO_REJECTS, EMAIL_SMTP_REJECTS,
  TEST_SMTP_USER, TEST_SMTP_PASSWORD, TEST_TWILIO_SID, TEST_TWILIO_KEY_SID, TEST_TWILIO_KEY_SECRET,
};
