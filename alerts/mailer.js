// A small SMTP client for alert email, with no dependencies.
//
// How a send works (RFC 5321):
//   1. connect, and read the server's greeting
//   2. EHLO to learn what the server supports
//   3. STARTTLS to encrypt the connection (or connect with TLS from the start on port 465), then EHLO again
//   4. sign in with AUTH PLAIN or AUTH LOGIN
//   5. MAIL FROM, RCPT TO, DATA, the message, QUIT
// Certificates are always verified. Unencrypted SMTP is only allowed to a relay on this same machine.
const fs = require("fs");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { NETWORK_TIMEOUT_MS, SMTP_REPLY_TIMEOUT_MS, MAX_SMTP_REPLY_BYTES } = require("../lib/constants");
const { isValidEmail, isLocalHost } = require("../lib/http");

const DEFAULT_SUBMISSION_PORT = 587;   // STARTTLS
const IMPLICIT_TLS_PORT = 465;         // TLS from the first byte
const MINIMUM_TLS_VERSION = "TLSv1.2";
const BASE64_LINE_LENGTH = 76;         // MIME limit for encoded lines
const ENCODED_WORD_CHARACTERS = 20;    // characters per RFC 2047 encoded header word (keeps lines short)
const MESSAGE_ID_BYTES = 16;
const BOUNDARY_BYTES = 12;
const CLOSE_GRACE_MS = 2000;
const MAX_ERROR_TEXT = 300;

// SMTP reply codes we expect at each step.
const REPLY = { ready: 220, ok: 250, recipientForwarded: 251, authAccepted: 235, sendCredential: 334, startMessage: 354 };

const base64 = (text) => Buffer.from(String(text), "utf8").toString("base64");
const oneLine = (text) => String(text ?? "").replace(/[\r\n]+/g, " ").trim();

// "Name <address@example.com>" or "address@example.com" -> { address, name }
function parseFromSetting(setting) {
  const text = oneLine(setting);
  const withName = /^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>$/.exec(text);
  const address = withName ? withName[2] : text;
  const name = withName ? (withName[1] || "").replace(/["\\]/g, "").trim() : "";
  return isValidEmail(address) ? { address, name } : null;
}

// Header text: plain ASCII is used as-is; anything else is encoded (RFC 2047) in short pieces.
function encodeHeaderText(text) {
  text = oneLine(text);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const characters = [...text], words = [];
  for (let i = 0; i < characters.length; i += ENCODED_WORD_CHARACTERS) words.push(`=?UTF-8?B?${base64(characters.slice(i, i + ENCODED_WORD_CHARACTERS).join(""))}?=`);
  return words.join("\r\n ");
}

function buildMessage({ from, to, subject, text, html }) {
  const senderDomain = from.address.split("@")[1];
  const boundary = "lh-" + crypto.randomBytes(BOUNDARY_BYTES).toString("hex");
  const encodeBody = (content) => base64(content).replace(new RegExp(`.{${BASE64_LINE_LENGTH}}`, "g"), "$&\r\n");
  const fromHeader = from.name
    ? `${encodeHeaderText(from.name) === from.name ? `"${from.name}"` : encodeHeaderText(from.name)} <${from.address}>`
    : from.address;
  const headers = [
    `From: ${fromHeader}`,
    `To: <${to}>`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${crypto.randomBytes(MESSAGE_ID_BYTES).toString("hex")}@${senderDomain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",   // tells mail servers not to send out-of-office replies
    "X-Auto-Response-Suppress: All",
  ];
  let body;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", encodeBody(text),
      `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", encodeBody(html),
      `--${boundary}--`, "",
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    body = encodeBody(text) + "\r\n";
  }
  // "Dot-stuffing": a line starting with "." gets a second "." so the server doesn't read it as the end of the message.
  return (headers.join("\r\n") + "\r\n\r\n" + body).replace(/(^|\r\n)\./g, "$1..");
}

// Reads SMTP replies line by line. Can be moved onto a TLS socket after STARTTLS.
class SmtpConnection {
  constructor(socket) { this.pendingReplies = []; this.waiting = null; this.error = null; this.useSocket(socket); }

  useSocket(socket) {
    if (this.socket) for (const event of ["data", "error", "close", "timeout"]) this.socket.removeAllListeners(event);
    this.socket = socket;
    this.buffer = "";
    this.replyLines = [];
    socket.setTimeout(SMTP_REPLY_TIMEOUT_MS, () => { this.stop(new Error("Mail server stopped responding")); socket.destroy(); });
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => this.stop(error));
    socket.on("close", () => this.stop(new Error("Mail server closed the connection")));
  }

  receive(chunk) {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_SMTP_REPLY_BYTES) { this.stop(new Error("Mail server sent an oversized reply")); this.socket.destroy(); return; }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.replyLines.push(line);
      // "250-..." means more lines follow; "250 ..." (code then a space) is the last line of the reply.
      const isLastLine = /^\d{3}(?: |$)/.test(line);
      if (isLastLine) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.replyLines.map((l) => l.slice(4)) };
        this.replyLines = [];
        if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(reply); } else this.pendingReplies.push(reply);
      }
    }
  }

  stop(error) {
    if (!this.error) this.error = error;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(this.error); }
  }

  nextReply() {
    if (this.pendingReplies.length) return Promise.resolve(this.pendingReplies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  // Sends a line (or nothing, when `line` is null) and checks the reply code.
  // `description` names the step in error messages, so passwords and message text never appear in them.
  async send(line, expectedCodes, description) {
    if (line !== null) this.socket.write(line + "\r\n");
    const reply = await this.nextReply();
    if (!expectedCodes.includes(reply.code)) throw new Error(`Mail server rejected ${description}: ${reply.code} ${reply.lines.join(" ")}`.slice(0, MAX_ERROR_TEXT));
    return reply;
  }
}

function waitForEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Could not reach the mail server (timed out)")); }, NETWORK_TIMEOUT_MS);
    socket.once(eventName, () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function createMailer(settings) {
  const host = settings.host || "";
  const port = Number(settings.port) || DEFAULT_SUBMISSION_PORT;
  const encryption = (settings.encryption || (port === IMPLICIT_TLS_PORT ? "tls" : "starttls")).toLowerCase();
  const from = settings.from ? parseFromSetting(settings.from) : null;
  const greetingName = (settings.greetingName || "lighthouse.local").replace(/[^A-Za-z0-9.-]/g, "") || "lighthouse.local";

  // Work out whether the settings make sense before anything is sent.
  let problem = null;
  if (host) {
    if (!from) problem = "The From address is missing or not valid (SMTP_FROM). Example: Lighthouse <desk@example.com>";
    else if (!["starttls", "tls", "none"].includes(encryption)) problem = "Encryption (SMTP_SECURE) must be STARTTLS, TLS or none.";
    else if (encryption === "none" && !isLocalHost(host)) problem = "Encryption can only be turned off for a mail relay on this same machine (localhost).";
    else if (!!settings.username !== !!settings.password) problem = "Enter both the username and the password (SMTP_USER / SMTP_PASS), or neither.";
  }
  // An internal mail server signed by a private certificate authority can be trusted with SMTP_CA_FILE.
  let trustedCa;
  if (host && !problem && settings.trustedCaFile) {
    try { trustedCa = fs.readFileSync(settings.trustedCaFile, "utf8"); } catch { problem = `SMTP_CA_FILE could not be read: ${settings.trustedCaFile}`; }
  }
  const tlsOptions = { servername: host, minVersion: MINIMUM_TLS_VERSION, ...(trustedCa ? { ca: trustedCa } : {}) };
  const configured = !!host && !problem;
  if (problem) console.error(`Email alerts disabled: ${problem}`);

  function openConnection() {
    if (encryption === "tls") return waitForEvent(tls.connect({ host, port, ...tlsOptions }), "secureConnect");
    return waitForEvent(net.connect({ host, port }), "connect");
  }

  async function upgradeToTls(connection) {
    const plainSocket = connection.socket;
    for (const event of ["data", "error", "close", "timeout"]) plainSocket.removeAllListeners(event);
    const secureSocket = await waitForEvent(tls.connect({ socket: plainSocket, ...tlsOptions }), "secureConnect");
    connection.useSocket(secureSocket);
  }

  async function signIn(connection, ehloReply) {
    const authLine = ehloReply.lines.find((l) => /^AUTH[ =]/i.test(l)) || "";
    if (/\bPLAIN\b/i.test(authLine)) {
      await connection.send("AUTH PLAIN " + base64(`\0${settings.username}\0${settings.password}`), [REPLY.authAccepted], "the username or password");
    } else if (/\bLOGIN\b/i.test(authLine)) {
      await connection.send("AUTH LOGIN", [REPLY.sendCredential], "AUTH LOGIN");
      await connection.send(base64(settings.username), [REPLY.sendCredential], "the username");
      await connection.send(base64(settings.password), [REPLY.authAccepted], "the username or password");
    } else {
      throw new Error("Mail server offers no supported sign-in method (PLAIN or LOGIN).");
    }
  }

  async function send({ to, subject, text, html }) {
    if (!configured) throw new Error(problem || "Email is not set up on this server.");
    if (!isValidEmail(to)) throw new Error("Recipient address is not valid.");
    const message = buildMessage({ from, to, subject, text, html });
    const connection = new SmtpConnection(await openConnection());
    try {
      await connection.send(null, [REPLY.ready], "the connection");
      let capabilities = await connection.send(`EHLO ${greetingName}`, [REPLY.ok], "EHLO");
      if (encryption === "starttls") {
        const offersStartTls = capabilities.lines.some((l) => /^STARTTLS\b/i.test(l));
        if (!offersStartTls) throw new Error("Mail server does not offer STARTTLS, so the connection cannot be encrypted.");
        await connection.send("STARTTLS", [REPLY.ready], "STARTTLS");
        await upgradeToTls(connection);
        capabilities = await connection.send(`EHLO ${greetingName}`, [REPLY.ok], "EHLO");
      }
      if (settings.username) await signIn(connection, capabilities);
      await connection.send(`MAIL FROM:<${from.address}>`, [REPLY.ok], "the sender address");
      await connection.send(`RCPT TO:<${to}>`, [REPLY.ok, REPLY.recipientForwarded], "the recipient address");
      await connection.send("DATA", [REPLY.startMessage], "DATA");
      await connection.send(message + "\r\n.", [REPLY.ok], "the message");
      connection.socket.write("QUIT\r\n");
    } finally {
      connection.socket.end();
      setTimeout(() => connection.socket.destroy(), CLOSE_GRACE_MS).unref();
    }
  }

  const describe = () => configured
    ? { configured: true, server: `${host}:${port}`, encryption: encryption === "none" ? "none (local relay)" : encryption === "tls" ? "TLS" : "STARTTLS", from: from.address }
    : { configured: false, problem };

  return { configured, problem, describe, send };
}

module.exports = { createMailer };
