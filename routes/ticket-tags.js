// Tags on tickets, to make them easier to find.
//   PUT /api/tickets/:id/tags   { tags: ["psu", "vendor-rma"] }   replaces the ticket's tags   needs "Work tickets"
//   GET /api/tags                                                  tags in use, with how many tickets carry each
// (Whoever raises a ticket can also tag it as they create it: see POST /api/tickets.)
const { STATUS, fail } = require("../lib/http");
const { can } = require("../lib/access");
const { cleanTagList } = require("../lib/ticket-extras");

module.exports = function registerTicketTagRoutes(app) {
  const { route, all, run, db, ticketExtras, requireSignedIn, loadVisibleTicket, recordActivity } = app;

  route("PUT", "/api/tickets/:id/tags", (request) => {
    requireSignedIn(request);
    if (!can(request.user, "tickets.work")) fail(STATUS.forbidden, "Your access level doesn't allow changing tags.");
    const ticket = loadVisibleTicket(request.user, request.params.id);
    const before = ticketExtras.tagsOf(ticket.id);
    const after = cleanTagList(request.body.tags);
    if (before.join(",") === after.join(",")) return { tags: after };
    const now = Date.now();
    db.transaction(() => {
      run("DELETE FROM ticket_tags WHERE ticket_id = ?", ticket.id);
      for (const tag of after) run("INSERT INTO ticket_tags (ticket_id, tag) VALUES (?,?)", ticket.id, tag);
      recordActivity(ticket.id, request.user.id, "change", { field: "tags", from: before.join(", "), to: after.join(", ") }, now);
      run("UPDATE tickets SET updated_at = ? WHERE id = ?", now, ticket.id);
    })();
    return { tags: after };
  });

  // For suggestions while typing a tag. People who only see their own tickets only see those tickets' tags.
  route("GET", "/api/tags", (request) => {
    requireSignedIn(request);
    const rows = can(request.user, "tickets.view_all")
      ? all("SELECT tag, COUNT(*) AS n FROM ticket_tags GROUP BY tag ORDER BY n DESC, tag")
      : all("SELECT tg.tag, COUNT(*) AS n FROM ticket_tags tg JOIN tickets t ON t.id = tg.ticket_id WHERE t.requester_id = ? GROUP BY tg.tag ORDER BY n DESC, tg.tag", request.user.id);
    return { tags: rows.map((r) => ({ tag: r.tag, count: r.n })) };
  });
};
