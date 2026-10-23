// HTTP building blocks: errors, input checks, a small router, JSON bodies, static files and security headers.
const path = require("path");
const fs = require("fs");
const { MAX_REQUEST_BODY_BYTES, STATIC_FILE_CACHE_SECONDS, HSTS_MAX_AGE_SECONDS } = require("./constants");

// ---------- errors ----------
// Throw an HttpError anywhere in a route; the server turns it into a JSON error response.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const STATUS = { badRequest: 400, unauthorized: 401, forbidden: 403, notFound: 404, methodNotAllowed: 405, conflict: 409, tooLarge: 413, tooMany: 429, serverError: 500, badGateway: 502, ok: 200, created: 201 };
const fail = (status, message) => { throw new HttpError(status, message); };
// Return created(body) from a route to answer "201 Created".
const created = (body) => ({ statusCode: STATUS.created, body });

// ---------- input checks ----------
// Optional text field: trimmed, and an error if it is not text or is too long. Missing becomes "".
function textField(value, maxLength, label) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(STATUS.badRequest, `${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) fail(STATUS.badRequest, `${label} must be ${maxLength} characters or fewer.`);
  return trimmed;
}
function requiredTextField(value, maxLength, label) {
  const text = textField(value, maxLength, label);
  if (!text) fail(STATUS.badRequest, `${label} is required.`);
  return text;
}
// A database id from the request (a positive whole number), or null when empty.
function optionalId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) fail(STATUS.badRequest, "Invalid id.");
  return id;
}
const idFromPath = (value) => optionalId(value) ?? fail(STATUS.notFound, "Not found.");
const EMAIL_PATTERN = /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]+$/;
const isValidEmail = (text) => typeof text === "string" && EMAIL_PATTERN.test(text);
const isLocalHost = (hostname) => ["localhost", "127.0.0.1", "::1"].includes(String(hostname).toLowerCase());

// ---------- router ----------
// route("PATCH", "/api/tickets/:id", handler) — ":id" becomes request.params.id.
function createRouter() {
  const routes = [];
  // options.rawBody: the route reads the request body itself (file uploads) instead of it being parsed as JSON.
  function route(method, pattern, handler, options = {}) {
    const paramNames = [];
    const regex = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, name) => { paramNames.push(name); return "([^/]+)"; }) + "/?$");
    routes.push({ method, regex, paramNames, handler, options });
  }
  // Returns { handler, params } for the request, or throws 404 / 405.
  function find(method, pathname) {
    let pathExists = false;
    for (const r of routes) {
      const match = r.regex.exec(pathname);
      if (!match) continue;
      pathExists = true;
      if (r.method !== method) continue;
      const params = {};
      r.paramNames.forEach((name, i) => { try { params[name] = decodeURIComponent(match[i + 1]); } catch { params[name] = ""; } });
      return { handler: r.handler, params, options: r.options };
    }
    return fail(pathExists ? STATUS.methodNotAllowed : STATUS.notFound, pathExists ? "Method not allowed." : "Not found.");
  }
  return { route, find };
}

// ---------- request and response ----------
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(STATUS.tooLarge, "That update is too large.");
    if (Number(request.headers["content-length"]) > MAX_REQUEST_BODY_BYTES) { request.resume(); return reject(tooLarge()); }
    let receivedBytes = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) { reject(tooLarge()); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new HttpError(STATUS.badRequest, "Request body was not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of (header || "").split(";")) {
    const equals = part.indexOf("=");
    if (equals <= 0) continue;
    try { cookies[part.slice(0, equals).trim()] = decodeURIComponent(part.slice(equals + 1).trim()); } catch { /* ignore a malformed cookie */ }
  }
  return cookies;
}

// ---------- static files (the web app in /public) ----------
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function serveStaticFile(publicDir, request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  let file = path.normalize(path.join(publicDir, requested));
  // Refuse anything that would resolve outside the public folder (e.g. "/../server.js").
  if (!file.startsWith(publicDir + path.sep)) { response.writeHead(STATUS.badRequest); return response.end(); }
  fs.stat(file, (error, stats) => {
    // Unknown paths get the app itself, which shows its own views.
    if (error || !stats.isFile()) file = path.join(publicDir, "index.html");
    const extension = path.extname(file);
    response.writeHead(STATUS.ok, {
      "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : `public, max-age=${STATIC_FILE_CACHE_SECONDS}`,
    });
    if (request.method === "HEAD") return response.end();
    fs.createReadStream(file).on("error", () => response.destroy()).pipe(response);
  });
}

// ---------- security headers ----------
function securityHeaders({ servedOverHttps }) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    // Only this site's own scripts and styles may run; fonts may come from Google Fonts.
    "Content-Security-Policy": [
      "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
      "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
    ].join("; "),
  };
  if (servedOverHttps) headers["Strict-Transport-Security"] = `max-age=${HSTS_MAX_AGE_SECONDS}`;
  return headers;
}

module.exports = {
  HttpError, STATUS, fail, created, textField, requiredTextField, optionalId, idFromPath, isValidEmail, isLocalHost,
  createRouter, readJsonBody, sendJson, parseCookies, serveStaticFile, securityHeaders,
};
