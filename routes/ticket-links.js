// Links from a ticket to other tickets and to projects.
//   POST   /api/tickets/:id/links               { ticket: "TKT-1042", relation: "related" | "duplicate-of" | "has-duplicate" | "blocks" | "blocked-by" }
//   DELETE /api/tickets/:id/links/:linkId
//   POST   /api/tickets/:id/projects            { projectId }
//   DELETE /api/tickets/:id/projects/:projectId
// Changing links needs "Work tickets"; project links also need "Use projects". Both tickets must be ones
// the person can see. Every change is written to the ticket's history (both tickets, for ticket links).
const { MAX_LINKS_PER_TICKET } = require("../lib/constants");
const { STATUS, fail, created, idFromPath, optionalId } = require("../lib/http");
const { can } = require("../lib/access");
const { ticketNumberFrom, STORED_AS } = require("../lib/ticket-extras");

// How a link is described in each ticket's history.
const HISTORY_WORDS = { "related": "related to", "duplicate-of": "duplicate of", "has-duplicate": "duplicated by", "blocks": "blocks", "blocked-by": "blocked by" };
const REVERSE = { "related": "related", "duplicate-of": "has-duplicate", "has-duplicate": "duplicate-of", "blocks": "blocked-by", "blocked-by": "blocks" };

module.exports = function registerTicketLinkRoutes(app) {
  const { route, one, run, db, ticketExtras, requireSignedIn, loadVisibleTicket, recordActivity } = app;
  const needs = (user, permission, what) => { if (!can(user, permission)) fail(STATUS.forbidden, `Your access level doesn't allow ${what}.`); };
  const touch = (ticketId, now) => run("UPDATE tickets SET updated_at = ? WHERE id = ?", now, ticketId);

  // ---------- ticket to ticket ----------
  route("POST", "/api/tickets/:id/links", (request) => {
    requireSignedIn(request);
    const user = request.user;
    needs(user, "tickets.work", "linking tickets");
    const ticket = loadVisibleTicket(user, request.params.id);
    const otherNumber = ticketNumberFrom(request.body.ticket);
    if (!otherNumber) fail(STATUS.badRequest, "Enter a ticket number, for example TKT-1042.");
    if (otherNumber === ticket.id) fail(STATUS.badRequest, "A ticket can't be linked to itself.");
    const other = one("SELECT * FROM tickets WHERE id = ?", otherNumber);
    if (!ticketExtras.personMaySeeTicket(user, other)) fail(STATUS.badRequest, `TKT-${otherNumber} doesn't exist or isn't one you can see.`);
    const relation = request.body.relation || "related";
    const storage = STORED_AS[relation] ?? fail(STATUS.badRequest, "Choose how the tickets are related.");
    if (ticketExtras.linkBetween(ticket.id, other.id)) fail(STATUS.conflict, `This ticket is already linked to TKT-${other.id}. Remove that link first to change it.`);
    if (ticketExtras.linkCount(ticket.id) >= MAX_LINKS_PER_TICKET) fail(STATUS.badRequest, `A ticket can have up to ${MAX_LINKS_PER_TICKET} links.`);

    const [fromId, toId] = storage.thisTicketIs === "from" ? [ticket.id, other.id] : [other.id, ticket.id];
    const now = Date.now();
    db.transaction(() => {
      run("INSERT INTO ticket_links (from_ticket_id, to_ticket_id, kind, created_by, created_at) VALUES (?,?,?,?,?)", fromId, toId, storage.kind, user.id, now);
      recordActivity(ticket.id, user.id, "change", { field: "links", from: "", to: `${HISTORY_WORDS[relation]} TKT-${other.id}` }, now);
      recordActivity(other.id, user.id, "change", { field: "links", from: "", to: `${HISTORY_WORDS[REVERSE[relation]]} TKT-${ticket.id}` }, now);
      touch(ticket.id, now); touch(other.id, now);
    })();
    return created({ linkedTickets: ticketExtras.linksOf(user, ticket.id) });
  });

  route("DELETE", "/api/tickets/:id/links/:linkId", (request) => {
    requireSignedIn(request);
    const user = request.user;
    needs(user, "tickets.work", "changing ticket links");
    const ticket = loadVisibleTicket(user, request.params.id);
    const link = one("SELECT * FROM ticket_links WHERE id = ? AND (from_ticket_id = ? OR to_ticket_id = ?)", idFromPath(request.params.linkId), ticket.id, ticket.id)
      ?? fail(STATUS.notFound, "Link not found.");
    const otherId = link.from_ticket_id === ticket.id ? link.to_ticket_id : link.from_ticket_id;
    const now = Date.now();
    db.transaction(() => {
      run("DELETE FROM ticket_links WHERE id = ?", link.id);
      recordActivity(ticket.id, user.id, "change", { field: "links", from: `TKT-${otherId}`, to: "" }, now);
      recordActivity(otherId, user.id, "change", { field: "links", from: `TKT-${ticket.id}`, to: "" }, now);
      touch(ticket.id, now); touch(otherId, now);
    })();
    return { linkedTickets: ticketExtras.linksOf(user, ticket.id) };
  });

  // ---------- ticket to project ----------
  function checkProjectLinking(request) {
    requireSignedIn(request);
    needs(request.user, "tickets.work", "linking tickets to projects");
    needs(request.user, "projects.access", "linking tickets to projects");
    return loadVisibleTicket(request.user, request.params.id);
  }

  route("POST", "/api/tickets/:id/projects", (request) => {
    const ticket = checkProjectLinking(request);
    const projectId = optionalId(request.body.projectId) ?? fail(STATUS.badRequest, "Choose a project.");
    const project = one("SELECT id, name FROM projects WHERE id = ?", projectId) ?? fail(STATUS.badRequest, "That project no longer exists.");
    if (one("SELECT 1 AS found FROM ticket_projects WHERE ticket_id = ? AND project_id = ?", ticket.id, project.id)) fail(STATUS.conflict, `This ticket is already linked to ${project.name}.`);
    const now = Date.now();
    db.transaction(() => {
      run("INSERT INTO ticket_projects (ticket_id, project_id, created_by, created_at) VALUES (?,?,?,?)", ticket.id, project.id, request.user.id, now);
      recordActivity(ticket.id, request.user.id, "change", { field: "projects", from: "", to: project.name }, now);
      touch(ticket.id, now);
    })();
    return created({ linkedProjects: ticketExtras.projectsOf(ticket.id) });
  });

  route("DELETE", "/api/tickets/:id/projects/:projectId", (request) => {
    const ticket = checkProjectLinking(request);
    const projectId = idFromPath(request.params.projectId);
    const project = one("SELECT name FROM projects WHERE id = ?", projectId);
    if (!run("DELETE FROM ticket_projects WHERE ticket_id = ? AND project_id = ?", ticket.id, projectId).changes) fail(STATUS.notFound, "That project isn't linked to this ticket.");
    recordActivity(ticket.id, request.user.id, "change", { field: "projects", from: project?.name || "a deleted project", to: "" });
    touch(ticket.id, Date.now());
    return { linkedProjects: ticketExtras.projectsOf(ticket.id) };
  });
};
