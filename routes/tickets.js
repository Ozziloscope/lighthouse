// Tickets: raising, listing, working, commenting, reopening and deleting.
//
// Who can do what is decided by permissions (see lib/access.js):
//   tickets.create         raise tickets
//   tickets.view_all       see every ticket; without it, only tickets you raised
//   tickets.work           change status, priority and category; resolve and reopen
//   tickets.assign         assign to anyone, and move between resolver groups
//   tickets.assignable     can be the assignee (and, with tickets.work, can take a ticket yourself)
//   tickets.internal_notes read and write internal notes
//   tickets.delete         delete a ticket
const {
  MAX_LENGTH, TICKET_PRIORITIES, TICKET_STATUSES, OPEN_TICKET_STATUSES, TICKET_CATEGORIES,
  DEFAULT_TICKET_PRIORITY, DEFAULT_TICKET_CATEGORY, MAX_TICKETS_PER_LIST,
} = require("../lib/constants");
const { STATUS, fail, created, requiredTextField, textField, idFromPath, optionalId } = require("../lib/http");
const { can } = require("../lib/access");
const { cleanTagList } = require("../lib/ticket-extras");
const { removeFile } = require("../lib/attachment-files");

const isOpen = (status) => OPEN_TICKET_STATUSES.includes(status);

module.exports = function registerTicketRoutes(app) {
  const { route, one, all, run, db, audit, notify, ticketExtras, getUserById, requireSignedIn, requirePermission, linkedTasksForTicket } = app;

  // ---------- helpers ----------
  const toApi = (t) => ({
    id: t.id, title: t.title, description: t.description, priority: t.priority, category: t.category, status: t.status, asset: t.asset,
    groupId: t.group_id, assigneeId: t.assignee_id, requesterId: t.requester_id, resolution: t.resolution,
    createdAt: t.created_at, updatedAt: t.updated_at, resolvedAt: t.resolved_at,
  });

  // A ticket the person may see. "Doesn't exist" and "not yours" give the same answer, so ticket numbers can't be probed.
  function loadVisibleTicket(user, id) {
    const ticket = one("SELECT * FROM tickets WHERE id = ?", idFromPath(id));
    const mayView = ticket && (can(user, "tickets.view_all") || ticket.requester_id === user.id);
    if (!mayView) fail(STATUS.notFound, "Ticket not found.");
    return ticket;
  }

  const recordActivity = (ticketId, userId, type, { field = null, from = null, to = null, body = null } = {}, at = Date.now()) =>
    run("INSERT INTO activity (ticket_id, user_id, type, field, from_val, to_val, body, at) VALUES (?,?,?,?,?,?,?,?)", ticketId, userId, type, field, from, to, body, at);
  // Shared with the routes for links, tags and attachments.
  app.loadVisibleTicket = loadVisibleTicket;
  app.recordActivity = recordActivity;

  // How a value reads in the ticket history ("from Ada to Ben", not "from 2 to 3").
  function readableValue(field, value) {
    if (value === null || value === undefined || value === "") return "";
    if (field === "groupId") return one("SELECT name FROM groups WHERE id = ?", value)?.name || "deleted group";
    if (field === "assigneeId") return one("SELECT name FROM users WHERE id = ?", value)?.name || "former user";
    return String(value);
  }
  const groupExists = (groupId) => !!one("SELECT 1 AS found FROM groups WHERE id = ?", groupId);

  // ---------- list and read ----------
  route("GET", "/api/tickets", (request) => {
    requireSignedIn(request);
    const rows = can(request.user, "tickets.view_all")
      ? all("SELECT * FROM tickets ORDER BY id DESC LIMIT ?", MAX_TICKETS_PER_LIST)
      : all("SELECT * FROM tickets WHERE requester_id = ? ORDER BY id DESC LIMIT ?", request.user.id, MAX_TICKETS_PER_LIST);
    const tags = ticketExtras.tagsByTicket();
    return { tickets: rows.map((t) => ({ ...toApi(t), tags: tags.get(t.id) || [] })), serverTime: Date.now() };
  });

  route("GET", "/api/tickets/:id", (request) => {
    requireSignedIn(request);
    const ticket = loadVisibleTicket(request.user, request.params.id);
    const seesInternalNotes = can(request.user, "tickets.internal_notes");
    const activity = all("SELECT * FROM activity WHERE ticket_id = ? ORDER BY at, id", ticket.id)
      .filter((a) => a.type !== "internal" || seesInternalNotes)
      .map((a) => ({ id: a.id, type: a.type, by: a.user_id, field: a.field, from: a.from_val, to: a.to_val, text: a.body, at: a.at }));
    const usesProjects = can(request.user, "projects.access");
    return {
      ticket: { ...toApi(ticket), tags: ticketExtras.tagsOf(ticket.id) },
      activity,
      linkedTasks: usesProjects ? linkedTasksForTicket(ticket.id) : [],
      linkedTickets: ticketExtras.linksOf(request.user, ticket.id),
      linkedProjects: usesProjects ? ticketExtras.projectsOf(ticket.id) : [],
      attachments: ticketExtras.attachmentsOf(ticket.id),
    };
  });

  // ---------- raise ----------
  route("POST", "/api/tickets", (request) => {
    requirePermission(request, "tickets.create");
    const body = request.body;
    const title = requiredTextField(body.title, MAX_LENGTH.ticketTitle, "Title");
    const priority = TICKET_PRIORITIES.includes(body.priority) ? body.priority : DEFAULT_TICKET_PRIORITY;
    const category = TICKET_CATEGORIES.includes(body.category) ? body.category : DEFAULT_TICKET_CATEGORY;
    const groupId = optionalId(body.groupId);
    if (groupId && !groupExists(groupId)) fail(STATUS.badRequest, "That resolver group no longer exists.");
    const description = textField(body.description, MAX_LENGTH.ticketDescription, "Description");
    const asset = textField(body.asset, MAX_LENGTH.assetTag, "Asset");
    const tags = cleanTagList(body.tags);
    const now = Date.now();
    const ticketId = db.transaction(() => {
      const id = run(`INSERT INTO tickets (title, description, priority, category, status, asset, group_id, requester_id, created_at, updated_at)
        VALUES (?,?,?,?, 'New', ?,?,?,?,?)`, title, description, priority, category, asset, groupId, request.user.id, now, now).lastInsertRowid;
      for (const tag of tags) run("INSERT INTO ticket_tags (ticket_id, tag) VALUES (?,?)", id, tag);
      recordActivity(id, request.user.id, "created", {}, now);
      return id;
    })();
    notify.ticketCreated(ticketId, request.user.id);
    return created({ ticket: { ...toApi(one("SELECT * FROM tickets WHERE id = ?", ticketId)), tags } });
  });

  // ---------- change fields ----------
  const COLUMN_FOR_FIELD = { status: "status", priority: "priority", category: "category", groupId: "group_id", assigneeId: "assignee_id" };
  const HISTORY_NAME_FOR_FIELD = { status: "status", priority: "priority", category: "category", groupId: "group", assigneeId: "assignee" };

  // Reads the requested changes and checks the person is allowed to make each one.
  function readRequestedChanges(user, ticket, body) {
    const changes = {};
    const needs = (permission, what) => { if (!can(user, permission)) fail(STATUS.forbidden, `Your access level doesn't allow ${what}.`); };
    if (body.status !== undefined) { needs("tickets.work", "changing ticket status"); if (!TICKET_STATUSES.includes(body.status)) fail(STATUS.badRequest, "Unknown status."); changes.status = body.status; }
    if (body.priority !== undefined) { needs("tickets.work", "changing priority"); if (!TICKET_PRIORITIES.includes(body.priority)) fail(STATUS.badRequest, "Unknown priority."); changes.priority = body.priority; }
    if (body.category !== undefined) { needs("tickets.work", "changing category"); if (!TICKET_CATEGORIES.includes(body.category)) fail(STATUS.badRequest, "Unknown category."); changes.category = body.category; }
    if (body.groupId !== undefined) {
      needs("tickets.assign", "moving tickets between resolver groups");
      changes.groupId = optionalId(body.groupId);
      if (changes.groupId && !groupExists(changes.groupId)) fail(STATUS.badRequest, "That resolver group no longer exists.");
    }
    if (body.assigneeId !== undefined) {
      changes.assigneeId = optionalId(body.assigneeId);
      const takingItYourself = changes.assigneeId === user.id && can(user, "tickets.work") && can(user, "tickets.assignable");
      if (!takingItYourself) needs("tickets.assign", "assigning tickets to other people");
      if (changes.assigneeId) {
        const assignee = getUserById(changes.assigneeId);
        if (!assignee || !assignee.active || !can(assignee, "tickets.assignable")) fail(STATUS.badRequest, "That person can't be assigned tickets (check their access level).");
      }
    }
    return changes;
  }

  route("PATCH", "/api/tickets/:id", (request) => {
    requireSignedIn(request);
    const user = request.user;
    const before = loadVisibleTicket(user, request.params.id);
    const current = toApi(before);
    const changes = readRequestedChanges(user, before, request.body);
    let resolution;
    if (request.body.resolution !== undefined) {
      if (!can(user, "tickets.work")) fail(STATUS.forbidden, "Your access level doesn't allow resolving tickets.");
      resolution = textField(request.body.resolution, MAX_LENGTH.ticketDescription, "Resolution");
    }

    // The status follows assignment the way a desk works: assigning a New ticket makes it Assigned,
    // and unassigning an Assigned ticket puts it back to New.
    if ("assigneeId" in changes && changes.status === undefined) {
      if (changes.assigneeId && current.status === "New") changes.status = "Assigned";
      if (!changes.assigneeId && current.status === "Assigned") changes.status = "New";
    }
    const newStatus = changes.status ?? current.status;
    const isBeingClosed = isOpen(current.status) && !isOpen(newStatus);
    const isBeingReopened = !isOpen(current.status) && isOpen(newStatus);
    if (newStatus === "Resolved" && isBeingClosed && !(resolution || current.resolution)) fail(STATUS.badRequest, "Add resolution notes before resolving.");
    // Whoever closes an unassigned ticket becomes its owner, so every closed ticket has someone accountable.
    if (isBeingClosed && !current.assigneeId && !("assigneeId" in changes)) changes.assigneeId = user.id;

    const now = Date.now();
    db.transaction(() => {
      const columns = [], values = [];
      for (const [field, value] of Object.entries(changes)) {
        if (current[field] === value) continue;
        columns.push(COLUMN_FOR_FIELD[field]); values.push(value); // column names come from the fixed map above
        recordActivity(before.id, user.id, "change", { field: HISTORY_NAME_FOR_FIELD[field], from: readableValue(field, current[field]), to: readableValue(field, value) }, now);
      }
      if (isBeingClosed) { columns.push("resolved_at"); values.push(now); }
      if (isBeingReopened) { columns.push("resolved_at"); values.push(null); }
      if (resolution !== undefined && resolution !== current.resolution) {
        columns.push("resolution"); values.push(resolution);
        if (resolution) recordActivity(before.id, user.id, "comment", { body: "Resolution: " + resolution }, now);
      }
      if (!columns.length) return;
      columns.push("updated_at"); values.push(now);
      run(`UPDATE tickets SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...values, before.id);
    })();
    notify.ticketChanged(before, before.id, user.id);
    return { ticket: toApi(one("SELECT * FROM tickets WHERE id = ?", before.id)) };
  });

  // ---------- comments ----------
  route("POST", "/api/tickets/:id/comments", (request) => {
    requireSignedIn(request);
    const user = request.user;
    const ticket = loadVisibleTicket(user, request.params.id);
    const text = requiredTextField(request.body.text, MAX_LENGTH.ticketComment, "Update");
    const wantsInternal = !!request.body.internal;
    if (wantsInternal && !can(user, "tickets.internal_notes")) fail(STATUS.forbidden, "Your access level doesn't allow internal notes.");
    const now = Date.now();
    db.transaction(() => {
      recordActivity(ticket.id, user.id, wantsInternal ? "internal" : "comment", { body: text }, now);
      // When the person who raised a ticket answers a question (status Pending), hand the ticket back to the desk.
      const requesterIsReplying = ticket.requester_id === user.id && ticket.status === "Pending" && !can(user, "tickets.work");
      if (requesterIsReplying) {
        recordActivity(ticket.id, user.id, "change", { field: "status", from: "Pending", to: "In Progress" }, now);
        run("UPDATE tickets SET status = 'In Progress' WHERE id = ?", ticket.id);
      }
      run("UPDATE tickets SET updated_at = ? WHERE id = ?", now, ticket.id);
    })();
    notify.ticketComment(ticket.id, user.id, text, wantsInternal);
    return created({ ok: true });
  });

  // ---------- reopen and delete ----------
  route("POST", "/api/tickets/:id/reopen", (request) => {
    requireSignedIn(request);
    const user = request.user;
    const ticket = loadVisibleTicket(user, request.params.id);
    if (!can(user, "tickets.work") && ticket.requester_id !== user.id) fail(STATUS.forbidden, "Your access level doesn't allow reopening this ticket.");
    if (isOpen(ticket.status)) fail(STATUS.badRequest, "This ticket is already open.");
    const reopenedStatus = ticket.assignee_id ? "In Progress" : "New";
    const now = Date.now();
    db.transaction(() => {
      recordActivity(ticket.id, user.id, "change", { field: "status", from: ticket.status, to: reopenedStatus }, now);
      run("UPDATE tickets SET status = ?, resolved_at = NULL, updated_at = ? WHERE id = ?", reopenedStatus, now, ticket.id);
    })();
    notify.ticketChanged(ticket, ticket.id, user.id);
    return { ok: true };
  });

  route("DELETE", "/api/tickets/:id", (request) => {
    requirePermission(request, "tickets.delete");
    const id = idFromPath(request.params.id);
    const attachedFiles = all("SELECT storage_name FROM ticket_attachments WHERE ticket_id = ?", id).map((a) => a.storage_name);
    if (!run("DELETE FROM tickets WHERE id = ?", id).changes) fail(STATUS.notFound, "Ticket not found.");
    attachedFiles.forEach(removeFile); // their database rows went with the ticket
    audit("ticket.delete", request, { ticket: id, filesRemoved: attachedFiles.length });
    return { ok: true };
  });
};
