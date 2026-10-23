// Builds the whole Lighthouse application: database, services, routes and the HTTP server.
// It does not start listening; server.js does that (and the tests start their own copy).
const http = require("http");
const path = require("path");
const config = require("./config");
const { db, one, all, run, DATA_DIR } = require("./db");
const { audit } = require("./audit");
const { can, createAccessHelpers, PERMISSIONS, ADMINISTRATOR_ONLY_PERMISSIONS } = require("./access");
const { createSessions } = require("./sessions");
const { createPeople } = require("./people");
const { createRateLimiter } = require("./rate-limit");
const { RATE_LIMITS, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, EXPIRED_SESSION_CLEANUP_INTERVAL_MS } = require("./constants");
const { HttpError, STATUS, fail, createRouter, readJsonBody, sendJson, serveStaticFile, securityHeaders } = require("./http");
const { createNotifier } = require("../alerts/notify");
const { createSecrets } = require("./secrets");
const { createDeskSettings } = require("./desk-settings");
const { createPasswordReset } = require("./password-reset");
const { createTicketExtras } = require("./ticket-extras");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const permissionLabel = (key) => [...PERMISSIONS, ...ADMINISTRATOR_ONLY_PERMISSIONS].find((p) => p.key === key)?.label || key;

// ---------- shared services every route can use ----------
const { route, find } = createRouter();
const { loadUser, getUserById, activeUsersWith } = createAccessHelpers({ one, all });
const sessions = createSessions({ one, run, config, loadUser });
const people = createPeople({ one, all, run, db, getUserById });
const secrets = createSecrets(DATA_DIR);
const deskSettings = createDeskSettings({ one, run, config, secrets });
const notify = createNotifier({ db, one, all, run, audit, config, deskSettings, getUserById, activeUsersWith });
const passwordReset = createPasswordReset({ run, notify, sessions, config });
const ticketExtras = createTicketExtras({ one, all });

const requireSignedIn = (request) => { if (!request.user) fail(STATUS.unauthorized, "Sign in to continue."); };
const requirePermission = (request, permissionKey) => {
  requireSignedIn(request);
  if (!can(request.user, permissionKey)) fail(STATUS.forbidden, `Your access level doesn't allow this (it needs "${permissionLabel(permissionKey)}").`);
};

const app = { route, db, one, all, run, config, audit, sessions, people, notify, deskSettings, passwordReset, ticketExtras, getUserById, activeUsersWith, requireSignedIn, requirePermission };

// ---------- routes ----------
const auth = require("../routes/auth")(app);
require("../routes/me")(app);
require("../routes/users")(app);
require("../routes/access-levels")(app);
require("../routes/groups")(app);
const projects = require("../routes/projects")(app);
app.linkedTasksForTicket = projects.linkedTasksForTicket;
require("../routes/tickets")(app);   // also provides app.loadVisibleTicket and app.recordActivity for the next three
require("../routes/ticket-links")(app);
require("../routes/ticket-tags")(app);
require("../routes/attachments")(app);
require("../routes/announcements")(app);
require("../routes/alerts")(app);
require("../routes/desk-settings")(app);
require("../routes/photos")(app);

// ---------- request handling ----------
const changesPerUser = createRateLimiter(RATE_LIMITS.changesPerUser);
const headersForEveryResponse = securityHeaders(config);

// The client's real address. Behind a proxy, each proxy appends the address it saw to X-Forwarded-For,
// so we count back from the right by the number of proxies we trust; the left end can be faked by the client.
function clientAddress(request) {
  const socketAddress = request.socket.remoteAddress;
  if (!config.trustProxy) return socketAddress;
  if (config.clientIpHeader) {
    const fromHeader = String(request.headers[config.clientIpHeader] || "").trim();
    if (fromHeader) return fromHeader;
  }
  const forwardedChain = String(request.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwardedChain.length >= config.trustedProxyHops ? forwardedChain[forwardedChain.length - config.trustedProxyHops] : socketAddress;
}

// Cross-site request forgery check: a change must come from this site's own pages.
function comesFromThisSite(request) {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.origin;
  if (!origin) return true; // not a browser; the custom-header check below still applies
  if (config.publicUrl) return origin === config.publicUrl;
  const host = (config.trustProxy && request.headers["x-forwarded-host"]) || request.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}

async function handleApiRequest(request, response, pathname) {
  const isChange = CHANGE_METHODS.has(request.method);
  // Three layers against cross-site requests: a SameSite=Strict cookie, a custom header that other sites
  // cannot send, and the Origin / Sec-Fetch-Site check.
  if (isChange && (request.headers["x-lighthouse"] !== "1" || !comesFromThisSite(request))) {
    audit("csrf.block", request, { path: pathname, origin: request.headers.origin || null });
    fail(STATUS.forbidden, "Request blocked. Reload the page and try again.");
  }
  sessions.identify(request);
  if (isChange && request.user) {
    const key = String(request.user.id);
    if (changesPerUser.isBlocked(key)) fail(STATUS.tooMany, "You are making changes too quickly. Wait a minute and try again.");
    changesPerUser.record(key);
  }
  const { handler, params, options } = find(request.method, pathname);
  request.params = params;
  request.body = isChange && !options.rawBody ? await readJsonBody(request) : {};
  const result = await handler(request, response);
  if (response.headersSent) return; // the route sent (or is streaming) its own response, such as a photo or a file
  if (result && result.statusCode) return sendJson(response, result.statusCode, result.body);
  return sendJson(response, STATUS.ok, result ?? { ok: true });
}

const server = http.createServer(async (request, response) => {
  for (const [name, value] of Object.entries(headersForEveryResponse)) response.setHeader(name, value);
  let pathname;
  try {
    const url = new URL(request.url, "http://localhost");
    pathname = url.pathname;
    request.query = url.searchParams;
  } catch {
    response.writeHead(STATUS.badRequest);
    return response.end();
  }
  request.ip = clientAddress(request);

  if (pathname === "/healthz") { response.writeHead(STATUS.ok, { "Content-Type": "text/plain" }); return response.end("ok"); }
  if (!pathname.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(STATUS.methodNotAllowed); return response.end(); }
    return serveStaticFile(PUBLIC_DIR, request, response, pathname);
  }
  try {
    await handleApiRequest(request, response, pathname);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
    console.error(error);
    sendJson(response, STATUS.serverError, { error: "Something went wrong on the server. Check the server log." });
  }
});
// Cut off slow or stalled clients instead of letting them hold connections open.
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;


// On a brand-new install, make the one-time setup code (and print it to the log).
auth.prepareSetupCode();

// Starts the timers that clean up expired sessions, deliver alerts and run the SLA / due-date checks.
function startBackgroundWork() {
  setInterval(sessions.deleteExpiredSessions, EXPIRED_SESSION_CLEANUP_INTERVAL_MS).unref();
  notify.start();
}

module.exports = { server, config, db, notify, startBackgroundWork };
