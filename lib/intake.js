// Website intake: a second, private listener that lets the windpoint.net form handler raise tickets for
// people who have no Lighthouse account (3D print requests and IT jobs).
//
//   POST /intake/requests             JSON (see readRequest below)  ->  201 { ticketId, reference }
//   POST /intake/requests/:id/files   the file itself as the body, its name in X-File-Name  ->  201 { fileName, sizeBytes }
//   GET  /healthz                     "ok", no token needed
//
// Why a separate listener: the desk itself is reachable through the tunnel; this must not be.
//   - It starts only when INTAKE_TOKEN is set (at least 32 characters).
//   - It listens on INTAKE_HOST:INTAKE_PORT (default 127.0.0.1:3001), never on the desk's port, so the
//     tunnel (pointed at PORT) can't reach it. Set INTAKE_HOST to a LAN address only if the form handler
//     runs on another machine, and firewall that port to the handler's address.
//   - Every request must carry "Authorization: Bearer <INTAKE_TOKEN>".
//   - Requests are capped desk-wide per hour; files only attach to website tickets, within an hour of the request.
//
// The ticket has no requester account. Who asked and how to reach them is stored in intake_requests,
// written into the description, and shown to staff in the ticket panel. Nobody outside the desk is emailed.
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const {
  INTAKE_REQUEST_TYPES, INTAKE_TYPE_LABEL, INTAKE_TAG_FOR_TYPE, INTAKE_PRINT_MATERIALS, INTAKE_FILE_EXTENSIONS,
  MAX_INTAKE_FILE_BYTES, MAX_INTAKE_FILES_PER_REQUEST, INTAKE_UPLOAD_WINDOW_MS, MAX_INTAKE_QUANTITY, MIN_INTAKE_TOKEN_LENGTH,
  INTAKE_TEXT_LENGTH, MAX_LENGTH, RATE_LIMITS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, OPEN_TICKET_STATUSES,
} = require("./constants");
const { HttpError, STATUS, fail, created, textField, requiredTextField, idFromPath, isValidEmail, createRouter, readJsonBody, sendJson } = require("./http");
const { createRateLimiter } = require("./rate-limit");
const { saveUpload, removeFile, cleanFileName, TooLargeError } = require("./attachment-files");

const MEGABYTE = 1024 * 1024;
const FILE_LIMIT_TEXT = `${MAX_INTAKE_FILE_BYTES / MEGABYTE} MB`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DESK_WIDE = "all";
const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest();

// ---------- reading a request ----------
function optionalDate(value, label) {
  const text = textField(value, 10, label);
  if (!text) return "";
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!DATE_PATTERN.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(STATUS.badRequest, `${label} must be a date like 2026-11-20.`);
  return text;
}
function optionalLink(value) {
  const text = textField(value, INTAKE_TEXT_LENGTH.link, "Link");
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { fail(STATUS.badRequest, "Link must be a web address starting with http:// or https://."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(STATUS.badRequest, "Link must be a web address starting with http:// or https://.");
  return url.href;
}

// The JSON body the form handler sends:
//   type      "print" | "it"                         required
//   name      the person's name                      required
//   email     their email address                    required
//   details   what they need                         required
//   neededBy  "YYYY-MM-DD"                           optional
//   notes     anything else                          optional
//   print only: material "PLA" | "PETG" (required), quantity 1-100 (default 1), link to the model (optional)
//   it only:    location, where the job is (required)
function readRequest(body) {
  const type = body.type;
  if (!INTAKE_REQUEST_TYPES.includes(type)) fail(STATUS.badRequest, `Type must be one of: ${INTAKE_REQUEST_TYPES.join(", ")}.`);
  const name = requiredTextField(body.name, MAX_LENGTH.personName, "Name");
  const email = requiredTextField(body.email, MAX_LENGTH.email, "Email");
  if (!isValidEmail(email)) fail(STATUS.badRequest, "Email doesn't look like an email address.");
  const details = requiredTextField(body.details, INTAKE_TEXT_LENGTH.details, "Details");
  const fields = { neededBy: optionalDate(body.neededBy, "Needed by"), notes: textField(body.notes, INTAKE_TEXT_LENGTH.notes, "Notes") };
  if (type === "print") {
    if (!INTAKE_PRINT_MATERIALS.includes(body.material)) fail(STATUS.badRequest, `Material must be one of: ${INTAKE_PRINT_MATERIALS.join(", ")}.`);
    fields.material = body.material;
    const quantity = body.quantity === undefined || body.quantity === null || body.quantity === "" ? 1 : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_INTAKE_QUANTITY) fail(STATUS.badRequest, `Quantity must be a whole number from 1 to ${MAX_INTAKE_QUANTITY}.`);
    fields.quantity = quantity;
    fields.link = optionalLink(body.link);
  } else {
    fields.location = requiredTextField(body.location, INTAKE_TEXT_LENGTH.location, "Location");
  }
  return { type, name, email, details, fields };
}

// What staff read on the ticket. Plain text; the desk escapes it when showing it.
function describe({ type, name, email, details, fields }) {
  const lines = [`Website request from ${name} <${email}>`, `Type: ${INTAKE_TYPE_LABEL[type]}`];
  if (type === "print") lines.push(`Material: ${fields.material} · Quantity: ${fields.quantity}`);
  if (fields.link) lines.push(`Model link: ${fields.link}`);
  if (fields.location) lines.push(`Location: ${fields.location}`);
  if (fields.neededBy) lines.push(`Needed by: ${fields.neededBy}`);
  lines.push("", "Details:", details);
  if (fields.notes) lines.push("", "Notes:", fields.notes);
  return lines.join("\n");
}
function titleFor({ type, details }) {
  const prefix = `${INTAKE_TYPE_LABEL[type]}: `;
  const firstLine = details.split("\n")[0].trim();
  const room = MAX_LENGTH.ticketTitle - prefix.length;
  return prefix + (firstLine.length > room ? firstLine.slice(0, room - 1) + "…" : firstLine);
}

// ---------- the listener ----------
function createIntakeServer({ db, one, run, config, audit, notify }) {
  const { token, printGroup, itGroup } = config.intake;
  if (!token) return null;
  if (token.length < MIN_INTAKE_TOKEN_LENGTH) {
    console.log(`Website intake is OFF: INTAKE_TOKEN must be at least ${MIN_INTAKE_TOKEN_LENGTH} characters.`);
    return null;
  }
  const expectedTokenHash = sha256(token);
  const tokenMatches = (header) => {
    const match = /^Bearer (.+)$/.exec(String(header || ""));
    return !!match && crypto.timingSafeEqual(sha256(match[1].trim()), expectedTokenHash);
  };
  const requestsPerHour = createRateLimiter(RATE_LIMITS.intakeRequests);
  const badTokens = createRateLimiter(RATE_LIMITS.intakeBadTokens);
  const groupIdFor = (type) => {
    const name = type === "print" ? printGroup : itGroup;
    return name ? one("SELECT id FROM groups WHERE name = ?", name)?.id ?? null : null;
  };
  const recordActivity = (ticketId, type, details, at) =>
    run("INSERT INTO activity (ticket_id, user_id, type, field, from_val, to_val, body, at) VALUES (?,NULL,?,?,?,?,?,?)",
      ticketId, type, details.field ?? null, details.from ?? null, details.to ?? null, details.body ?? null, at);

  const { route, find } = createRouter();

  route("POST", "/intake/requests", (request) => {
    if (requestsPerHour.isBlocked(DESK_WIDE)) fail(STATUS.tooMany, "Too many website requests this hour. Try again later.");
    const submitted = readRequest(request.body);
    requestsPerHour.record(DESK_WIDE);
    const now = Date.now();
    const ticketId = db.transaction(() => {
      const id = run(`INSERT INTO tickets (title, description, priority, category, status, asset, group_id, requester_id, created_at, updated_at)
        VALUES (?,?, 'P3', 'Request', 'New', '', ?, NULL, ?,?)`, titleFor(submitted), describe(submitted), groupIdFor(submitted.type), now, now).lastInsertRowid;
      for (const tag of ["website", INTAKE_TAG_FOR_TYPE[submitted.type]]) run("INSERT INTO ticket_tags (ticket_id, tag) VALUES (?,?)", id, tag);
      run("INSERT INTO intake_requests (ticket_id, request_type, requester_name, requester_email, fields, created_at) VALUES (?,?,?,?,?,?)",
        id, submitted.type, submitted.name, submitted.email, JSON.stringify(submitted.fields), now);
      recordActivity(id, "created", {}, now);
      return Number(id);
    })();
    notify.ticketCreated(ticketId, null);
    audit("intake.request", request, { ticket: ticketId, type: submitted.type });
    return created({ ticketId, reference: `TKT-${ticketId}` });
  });

  route("POST", "/intake/requests/:id/files", async (request) => {
    const ticketId = idFromPath(request.params.id);
    const intake = one("SELECT * FROM intake_requests WHERE ticket_id = ?", ticketId);
    const ticket = intake && one("SELECT * FROM tickets WHERE id = ?", ticketId);
    const refuse = (status, message) => { request.resume(); fail(status, message); };
    if (!ticket) refuse(STATUS.notFound, "No website request with that number.");
    if (Date.now() - intake.created_at > INTAKE_UPLOAD_WINDOW_MS || !OPEN_TICKET_STATUSES.includes(ticket.status)) refuse(STATUS.forbidden, "Files can only be added to a new website request, within an hour of sending it.");
    if (one("SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?", ticketId).n >= MAX_INTAKE_FILES_PER_REQUEST) refuse(STATUS.badRequest, `A website request can have up to ${MAX_INTAKE_FILES_PER_REQUEST} files.`);
    const fileName = cleanFileName(request.headers["x-file-name"]);
    if (!INTAKE_FILE_EXTENSIONS.includes(path.extname(fileName).toLowerCase())) refuse(STATUS.badRequest, `Only these file types are accepted: ${INTAKE_FILE_EXTENSIONS.join(", ")}.`);
    const declaredSize = Number(request.headers["content-length"]);
    if (!declaredSize) refuse(STATUS.badRequest, "The file is empty.");
    if (declaredSize > MAX_INTAKE_FILE_BYTES) refuse(STATUS.tooLarge, `That file is too large. The limit is ${FILE_LIMIT_TEXT}.`);

    let saved;
    try { saved = await saveUpload(request, MAX_INTAKE_FILE_BYTES); }
    catch (error) {
      if (error instanceof TooLargeError) fail(STATUS.tooLarge, `That file is too large. The limit is ${FILE_LIMIT_TEXT}.`);
      fail(STATUS.badRequest, "The upload didn't finish. Try again.");
    }
    const now = Date.now();
    try {
      db.transaction(() => {
        run(`INSERT INTO ticket_attachments (ticket_id, uploaded_by, file_name, content_type, size_bytes, storage_name, created_at)
          VALUES (?,NULL,?, 'application/octet-stream', ?,?,?)`, ticketId, fileName, saved.sizeBytes, saved.storageName, now);
        recordActivity(ticketId, "change", { field: "files", from: "", to: fileName }, now);
        run("UPDATE tickets SET updated_at = ? WHERE id = ?", now, ticketId);
      })();
    } catch (error) { removeFile(saved.storageName); throw error; }
    audit("intake.file", request, { ticket: ticketId, bytes: saved.sizeBytes });
    return created({ fileName, sizeBytes: saved.sizeBytes });
  }, { rawBody: true });

  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    request.ip = request.socket.remoteAddress;
    try {
      let pathname;
      try { pathname = new URL(request.url, "http://localhost").pathname; } catch { fail(STATUS.badRequest, "Bad address."); }
      if (pathname === "/healthz") { response.writeHead(STATUS.ok, { "Content-Type": "text/plain" }); return response.end("ok"); }
      if (badTokens.isBlocked(request.ip)) { request.resume(); fail(STATUS.tooMany, "Too many wrong intake tokens. Wait 15 minutes."); }
      if (!tokenMatches(request.headers.authorization)) {
        badTokens.record(request.ip);
        audit("intake.bad_token", request, { path: pathname });
        request.resume();
        fail(STATUS.unauthorized, "Missing or wrong intake token.");
      }
      const { handler, params, options } = find(request.method, pathname);
      request.params = params;
      request.body = options.rawBody ? {} : await readJsonBody(request);
      const result = await handler(request, response);
      return sendJson(response, result.statusCode, result.body);
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      console.error(error);
      sendJson(response, STATUS.serverError, { error: "Something went wrong on the server. Check the server log." });
    }
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

module.exports = { createIntakeServer, readRequest, describe };
