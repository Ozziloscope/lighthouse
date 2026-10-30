// Files attached to tickets.
//   POST   /api/tickets/:id/attachments   the file itself as the request body, its name in the X-File-Name header
//   GET    /api/attachments/:id           download (pictures can be shown in the page; add ?download=1 to save instead)
//   DELETE /api/attachments/:id           the person who uploaded it, or anyone with "Work tickets"
// Anyone who can see a ticket can attach files to it and download its files, including the person who
// raised it (screenshots of an error, a photo of a leak). Files are stored on disk (lib/attachment-files.js).
const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TICKET } = require("../lib/constants");
const { STATUS, fail, created, idFromPath } = require("../lib/http");
const { can } = require("../lib/access");
const { saveUpload, removeFile, openForReading, pictureTypeOf, cleanFileName, TooLargeError } = require("../lib/attachment-files");

const MEGABYTE = 1024 * 1024;
const LIMIT_TEXT = `${MAX_ATTACHMENT_BYTES / MEGABYTE} MB`;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ATTACHMENT_CACHE_SECONDS = 3600;
// Content-Disposition with both a plain fallback and the exact UTF-8 name (RFC 6266 / 5987).
const dispositionFor = (kind, fileName) => `${kind}; filename="${fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

module.exports = function registerAttachmentRoutes(app) {
  const { route, one, run, db, audit, ticketExtras, requireSignedIn, loadVisibleTicket, recordActivity } = app;

  route("POST", "/api/tickets/:id/attachments", async (request) => {
    requireSignedIn(request);
    const ticket = loadVisibleTicket(request.user, request.params.id);
    const declaredSize = Number(request.headers["content-length"]);
    if (!declaredSize) fail(STATUS.badRequest, "Choose a file to attach. Empty files can't be attached.");
    if (declaredSize > MAX_ATTACHMENT_BYTES) { request.resume(); fail(STATUS.tooLarge, `That file is too large. The limit is ${LIMIT_TEXT}.`); }
    if (one("SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?", ticket.id).n >= MAX_ATTACHMENTS_PER_TICKET) {
      request.resume();
      fail(STATUS.badRequest, `A ticket can have up to ${MAX_ATTACHMENTS_PER_TICKET} files.`);
    }
    const fileName = cleanFileName(request.headers["x-file-name"]);
    const claimedType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const contentType = CONTENT_TYPE_PATTERN.test(claimedType) ? claimedType : "application/octet-stream";

    let saved;
    try { saved = await saveUpload(request, MAX_ATTACHMENT_BYTES); }
    catch (error) {
      if (error instanceof TooLargeError) fail(STATUS.tooLarge, `That file is too large. The limit is ${LIMIT_TEXT}.`);
      fail(STATUS.badRequest, "The upload didn't finish. Try again.");
    }
    const now = Date.now();
    const id = db.transaction(() => {
      const newId = run(`INSERT INTO ticket_attachments (ticket_id, uploaded_by, file_name, content_type, size_bytes, storage_name, created_at)
        VALUES (?,?,?,?,?,?,?)`, ticket.id, request.user.id, fileName, contentType, saved.sizeBytes, saved.storageName, now).lastInsertRowid;
      recordActivity(ticket.id, request.user.id, "change", { field: "files", from: "", to: fileName }, now);
      run("UPDATE tickets SET updated_at = ? WHERE id = ?", now, ticket.id);
      return newId;
    })();
    audit("attachment.upload", request, { ticket: ticket.id, attachment: id, bytes: saved.sizeBytes });
    return created({ attachment: ticketExtras.attachmentView(one("SELECT * FROM ticket_attachments WHERE id = ?", id)) });
  }, { rawBody: true });

  // The attachment plus its ticket, if the person may see that ticket. "Not found" either way, so ids can't be probed.
  function loadVisibleAttachment(request) {
    requireSignedIn(request);
    const attachment = one("SELECT * FROM ticket_attachments WHERE id = ?", idFromPath(request.params.id));
    const ticket = attachment && one("SELECT * FROM tickets WHERE id = ?", attachment.ticket_id);
    if (!ticketExtras.personMaySeeTicket(request.user, ticket)) fail(STATUS.notFound, "File not found.");
    return { attachment, ticket };
  }

  route("GET", "/api/attachments/:id", (request, response) => {
    const { attachment } = loadVisibleAttachment(request);
    // Only real pictures (checked from the file's own bytes) are shown in the page; anything else is a download.
    const pictureType = request.query.get("download") ? null : pictureTypeOf(attachment.storage_name);
    response.writeHead(STATUS.ok, {
      "Content-Type": pictureType || "application/octet-stream",
      "Content-Length": attachment.size_bytes,
      "Content-Disposition": dispositionFor(pictureType ? "inline" : "attachment", attachment.file_name),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": `private, max-age=${ATTACHMENT_CACHE_SECONDS}`,
    });
    openForReading(attachment.storage_name).on("error", () => response.destroy()).pipe(response);
  });

  route("DELETE", "/api/attachments/:id", (request) => {
    const { attachment, ticket } = loadVisibleAttachment(request);
    const mayDelete = attachment.uploaded_by === request.user.id || can(request.user, "tickets.work");
    if (!mayDelete) fail(STATUS.forbidden, "Only the person who attached this file, or someone who works tickets, can remove it.");
    db.transaction(() => {
      run("DELETE FROM ticket_attachments WHERE id = ?", attachment.id);
      recordActivity(ticket.id, request.user.id, "change", { field: "files", from: attachment.file_name, to: "" });
    })();
    removeFile(attachment.storage_name);
    audit("attachment.delete", request, { ticket: ticket.id, attachment: attachment.id });
    return { ok: true };
  });
};
