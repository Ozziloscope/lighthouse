// What hangs off a ticket besides its own fields: tags, links to other tickets, links to projects, and attached files.
// This file reads them and checks tag input; the routes that change them are in routes/ticket-links.js,
// routes/ticket-tags.js and routes/attachments.js.
const { MAX_TAG_LENGTH, MAX_TAGS_PER_TICKET, TAG_PATTERN } = require("./constants");
const { STATUS, fail } = require("./http");
const { can } = require("./access");

// How a link reads from each end. A row says "from <kind> to": ticket A duplicates ticket B, A blocks B.
const RELATION_FROM_EACH_END = {
  related: { fromEnd: "related", toEnd: "related" },
  duplicate: { fromEnd: "duplicate-of", toEnd: "has-duplicate" },
  blocks: { fromEnd: "blocks", toEnd: "blocked-by" },
};
// The reverse: what the person picked in the ticket panel -> how the row is stored.
const STORED_AS = {
  "related": { kind: "related", thisTicketIs: "from" },
  "duplicate-of": { kind: "duplicate", thisTicketIs: "from" },
  "has-duplicate": { kind: "duplicate", thisTicketIs: "to" },
  "blocks": { kind: "blocks", thisTicketIs: "from" },
  "blocked-by": { kind: "blocks", thisTicketIs: "to" },
};

// "Faulty PSU" -> "faulty-psu", "#Urgent" -> "urgent". Returns null for something that can't be a tag.
function normalizeTag(raw) {
  const tag = String(raw ?? "").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-");
  return tag && tag.length <= MAX_TAG_LENGTH && TAG_PATTERN.test(tag) ? tag : null;
}
function cleanTagList(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) fail(STATUS.badRequest, "Tags must be a list.");
  const tags = [];
  for (const raw of input) {
    const tag = normalizeTag(raw);
    if (!tag) fail(STATUS.badRequest, `"${String(raw).slice(0, MAX_TAG_LENGTH)}" can't be a tag. Use letters, numbers, dashes, dots or underscores, up to ${MAX_TAG_LENGTH} characters.`);
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS_PER_TICKET) fail(STATUS.badRequest, `A ticket can have up to ${MAX_TAGS_PER_TICKET} tags.`);
  return tags.sort();
}

// "TKT-1042", "tkt 1042", "#1042" or 1042 -> 1042
function ticketNumberFrom(input) {
  const match = /^\s*(?:tkt[-\s]?|#)?(\d+)\s*$/i.exec(String(input ?? ""));
  return match ? Number(match[1]) : null;
}

function createTicketExtras({ one, all }) {
  const personMaySeeTicket = (user, ticket) => !!ticket && (can(user, "tickets.view_all") || ticket.requester_id === user.id);

  // ---------- tags ----------
  const tagsOf = (ticketId) => all("SELECT tag FROM ticket_tags WHERE ticket_id = ? ORDER BY tag", ticketId).map((r) => r.tag);
  // Tags for many tickets at once (the queue list): Map of ticket id -> [tags].
  function tagsByTicket() {
    const byTicket = new Map();
    for (const { ticket_id: id, tag } of all("SELECT ticket_id, tag FROM ticket_tags ORDER BY tag")) {
      if (!byTicket.has(id)) byTicket.set(id, []);
      byTicket.get(id).push(tag);
    }
    return byTicket;
  }

  // ---------- links to other tickets ----------
  // Only tickets the viewer may see are listed, so a link never reveals a ticket someone couldn't open.
  function linksOf(user, ticketId) {
    const rows = all(`SELECT l.id AS link_id, l.kind, l.from_ticket_id, l.to_ticket_id, t.id, t.title, t.status, t.priority, t.requester_id
      FROM ticket_links l JOIN tickets t ON t.id = CASE WHEN l.from_ticket_id = ? THEN l.to_ticket_id ELSE l.from_ticket_id END
      WHERE l.from_ticket_id = ? OR l.to_ticket_id = ? ORDER BY l.created_at`, ticketId, ticketId, ticketId);
    return rows.filter((row) => personMaySeeTicket(user, row)).map((row) => ({
      linkId: row.link_id,
      relation: row.from_ticket_id === ticketId ? RELATION_FROM_EACH_END[row.kind].fromEnd : RELATION_FROM_EACH_END[row.kind].toEnd,
      ticket: { id: row.id, title: row.title, status: row.status, priority: row.priority },
    }));
  }
  const linkBetween = (a, b) => one("SELECT * FROM ticket_links WHERE (from_ticket_id = ? AND to_ticket_id = ?) OR (from_ticket_id = ? AND to_ticket_id = ?)", a, b, b, a);
  const linkCount = (ticketId) => one("SELECT COUNT(*) AS n FROM ticket_links WHERE from_ticket_id = ? OR to_ticket_id = ?", ticketId, ticketId).n;

  // ---------- links to projects ----------
  const projectsOf = (ticketId) => all(`SELECT p.id, p.name, p.color, p.archived FROM ticket_projects tp JOIN projects p ON p.id = tp.project_id
    WHERE tp.ticket_id = ? ORDER BY p.name COLLATE NOCASE`, ticketId).map((p) => ({ id: p.id, name: p.name, color: p.color, archived: !!p.archived }));
  // The project page's list of linked tickets, again only those the viewer may see.
  const ticketsLinkedToProject = (user, projectId) => all(`SELECT t.id, t.title, t.status, t.priority, t.requester_id FROM ticket_projects tp
    JOIN tickets t ON t.id = tp.ticket_id WHERE tp.project_id = ? ORDER BY t.id DESC`, projectId)
    .filter((t) => personMaySeeTicket(user, t)).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }));

  // ---------- attachments ----------
  const attachmentView = (a) => ({ id: a.id, fileName: a.file_name, contentType: a.content_type, sizeBytes: a.size_bytes, uploadedBy: a.uploaded_by, createdAt: a.created_at });
  const attachmentsOf = (ticketId) => all("SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at", ticketId).map(attachmentView);

  return { personMaySeeTicket, tagsOf, tagsByTicket, linksOf, linkBetween, linkCount, projectsOf, ticketsLinkedToProject, attachmentView, attachmentsOf };
}

module.exports = { createTicketExtras, normalizeTag, cleanTagList, ticketNumberFrom, STORED_AS };
