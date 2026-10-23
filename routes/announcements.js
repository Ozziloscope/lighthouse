// Announcements: banners across the top of every page, for everyone who is signed in.
//   severity "advisory"  yellow, pulsing slowly   service advisories (planned maintenance, a known issue)
//   severity "action"    red, pulsing slowly      immediate action required
//
//   GET    /api/announcements          the ones showing right now        anyone signed in (also sent in /api/bootstrap)
//   GET    /api/announcements/manage   all of them, newest first         needs "Post announcements"
//   POST   /api/announcements          { severity, title, message, startsAt?, endsAt? }
//   PATCH  /api/announcements/:id      change any of those, or { end: true } to take it down now
//   DELETE /api/announcements/:id
const { ANNOUNCEMENT_SEVERITIES, MAX_ANNOUNCEMENT_TITLE, MAX_ANNOUNCEMENT_MESSAGE, MAX_ACTIVE_ANNOUNCEMENTS } = require("../lib/constants");
const { STATUS, fail, created, requiredTextField, textField, idFromPath } = require("../lib/http");

const RECENT_ANNOUNCEMENTS_LISTED = 100;

module.exports = function registerAnnouncementRoutes(app) {
  const { route, one, all, run, audit, requireSignedIn, requirePermission } = app;

  const stateOf = (row, now = Date.now()) => (row.starts_at > now ? "scheduled" : row.ends_at && row.ends_at <= now ? "ended" : "live");
  const view = (row) => ({
    id: row.id, severity: row.severity, title: row.title, message: row.message,
    startsAt: row.starts_at, endsAt: row.ends_at, createdBy: row.created_by, updatedAt: row.updated_at, state: stateOf(row),
  });

  // Showing now: started, and not ended. Red (action required) first, then the newest.
  function currentAnnouncements(now = Date.now()) {
    return all(`SELECT * FROM announcements WHERE starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY CASE severity WHEN 'action' THEN 0 ELSE 1 END, starts_at DESC`, now, now).map(view);
  }
  app.currentAnnouncements = currentAnnouncements; // for /api/bootstrap

  // Reads and checks the fields that were sent; anything left out keeps its current value.
  function readFields(body, current = {}) {
    const fields = {
      severity: body.severity ?? current.severity,
      title: body.title !== undefined ? requiredTextField(body.title, MAX_ANNOUNCEMENT_TITLE, "Title") : current.title,
      message: body.message !== undefined ? textField(body.message, MAX_ANNOUNCEMENT_MESSAGE, "Message") : current.message ?? "",
      startsAt: body.startsAt !== undefined ? Number(body.startsAt) || Date.now() : current.starts_at ?? Date.now(),
      endsAt: body.endsAt !== undefined ? (body.endsAt === null || body.endsAt === "" ? null : Number(body.endsAt)) : current.ends_at ?? null,
    };
    if (!ANNOUNCEMENT_SEVERITIES.includes(fields.severity)) fail(STATUS.badRequest, "Choose Service advisory or Action required.");
    if (!fields.title) fail(STATUS.badRequest, "Title is required.");
    if (fields.endsAt !== null && (!Number.isFinite(fields.endsAt) || fields.endsAt <= fields.startsAt)) fail(STATUS.badRequest, "The end time must be after the start time.");
    return fields;
  }
  function assertRoomFor(fields, exceptId = 0) {
    const now = Date.now();
    const goesLiveNow = fields.startsAt <= now && (fields.endsAt === null || fields.endsAt > now);
    const liveOthers = currentAnnouncements(now).filter((a) => a.id !== exceptId).length;
    if (goesLiveNow && liveOthers >= MAX_ACTIVE_ANNOUNCEMENTS) fail(STATUS.badRequest, `Up to ${MAX_ACTIVE_ANNOUNCEMENTS} announcements can show at once. End one first.`);
  }
  const load = (id) => one("SELECT * FROM announcements WHERE id = ?", idFromPath(id)) ?? fail(STATUS.notFound, "Announcement not found.");

  route("GET", "/api/announcements", (request) => {
    requireSignedIn(request);
    return { announcements: currentAnnouncements() };
  });

  route("GET", "/api/announcements/manage", (request) => {
    requirePermission(request, "announcements.manage");
    return { announcements: all("SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?", RECENT_ANNOUNCEMENTS_LISTED).map(view) };
  });

  route("POST", "/api/announcements", (request) => {
    requirePermission(request, "announcements.manage");
    const fields = readFields(request.body);
    assertRoomFor(fields);
    const now = Date.now();
    const id = run(`INSERT INTO announcements (severity, title, message, starts_at, ends_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      fields.severity, fields.title, fields.message, fields.startsAt, fields.endsAt, request.user.id, now, now).lastInsertRowid;
    audit("announcement.create", request, { announcement: id, severity: fields.severity, title: fields.title });
    return created({ announcement: view(load(id)) });
  });

  route("PATCH", "/api/announcements/:id", (request) => {
    requirePermission(request, "announcements.manage");
    const current = load(request.params.id);
    const now = Date.now();
    if (request.body.end) {
      run("UPDATE announcements SET ends_at = ?, updated_at = ? WHERE id = ?", Math.max(now, current.starts_at + 1), now, current.id);
      audit("announcement.end", request, { announcement: current.id });
      return { announcement: view(load(current.id)) };
    }
    const fields = readFields(request.body, current);
    assertRoomFor(fields, current.id);
    run("UPDATE announcements SET severity = ?, title = ?, message = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?",
      fields.severity, fields.title, fields.message, fields.startsAt, fields.endsAt, now, current.id);
    audit("announcement.update", request, { announcement: current.id });
    return { announcement: view(load(current.id)) };
  });

  route("DELETE", "/api/announcements/:id", (request) => {
    requirePermission(request, "announcements.manage");
    const current = load(request.params.id);
    run("DELETE FROM announcements WHERE id = ?", current.id);
    audit("announcement.delete", request, { announcement: current.id, title: current.title });
    return { ok: true };
  });
};
