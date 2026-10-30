// Tickets tab: queues, the new-ticket form, resolver groups, and the ticket detail panel.
// What each person sees and can change follows their access level's permissions.
(() => {
"use strict";
const { S, $, esc, toast, formatDateTime, shortDuration, api, act, can, userName, avatar, personHTML, peopleWhoCanTakeTickets } = LH;
const extras = LH.ticketExtras; // tags, files, linked tickets and projects (ticket-extras.js)

// ---------- settings ----------
const PRIORITY_INFO = {
  P1: { label: "P1 Critical", hint: "Production down, multiple racks or a whole cluster affected" },
  P2: { label: "P2 High", hint: "Single node or link down, redundancy lost" },
  P3: { label: "P3 Normal", hint: "Degraded component, workaround in place" },
  P4: { label: "P4 Low", hint: "Request, planned work, cosmetic" },
};
const DEFAULT_PRIORITY = "P3";
const PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4 };
const SLA_WARNING_FRACTION_LEFT = 0.25; // same as the server: "running out" when a quarter of the time is left
const HOURS_PER_DAY = 24, MS_PER_HOUR = 3600000;

// Page-level state for this tab.
const T = { search: "", filterGroup: "", filterPriority: "", filterTag: "", detail: null, drafts: {}, editingGroupId: null, projectsForLinking: null };

const openStatuses = () => new Set(S.C.OPEN_STATUSES);
const isOpen = (ticket) => openStatuses().has(ticket.status);
const ticketRef = (ticket) => "TKT-" + ticket.id;
const myGroupIds = () => [...S.groups.values()].filter((g) => g.members.includes(S.me.id)).map((g) => g.id);
const setDraft = (ticketId, changes) => (T.drafts[ticketId] = { ...T.drafts[ticketId], ...changes });
const statusClass = (status) => "s-" + status.replace(/\s/g, "");

// Time left (or overdue) against the SLA for a ticket's priority.
function slaState(ticket) {
  const windowMs = (S.C.SLA_HOURS[ticket.priority] || S.C.SLA_HOURS[DEFAULT_PRIORITY]) * MS_PER_HOUR;
  const dueAt = ticket.createdAt + windowMs;
  if (!isOpen(ticket)) {
    const met = (ticket.resolvedAt || Date.now()) <= dueAt;
    return { cssClass: "done", text: met ? "Met" : "Missed", dueAt, breached: false };
  }
  const timeLeft = dueAt - Date.now();
  if (timeLeft < 0) return { cssClass: "breach", text: "Breached " + shortDuration(timeLeft), dueAt, breached: true };
  return { cssClass: timeLeft < windowMs * SLA_WARNING_FRACTION_LEFT ? "soon" : "", text: "Due " + shortDuration(timeLeft), dueAt, breached: false };
}

// The category menu, grouped (Data center, Tech, Facilities, General). "Facilities: Other" shows as "Other" in its group.
function categoryOptionsHTML(selected) {
  const shortLabel = (category, group) => (category.startsWith(group.split(" ")[0] + ": ") ? category.slice(category.indexOf(": ") + 2) : category);
  const known = S.C.CATEGORIES.includes(selected);
  return (known || !selected ? "" : `<option selected>${esc(selected)}</option>`) + S.C.CATEGORY_GROUPS.map((g) =>
    `<optgroup label="${esc(g.group)}">${g.categories.map((c) => `<option value="${esc(c)}" ${c === selected ? "selected" : ""}>${esc(shortLabel(c, g.group))}</option>`).join("")}</optgroup>`).join("");
}

// ---------- queues ----------
// Each queue, the permission needed to see it, and which tickets it holds.
const QUEUES = {
  mine:       { label: "Assigned to me",    needs: "tickets.assignable", includes: (t) => isOpen(t) && t.assigneeId === S.me.id },
  groups:     { label: "My groups",         needs: "tickets.assignable", includes: (t) => isOpen(t) && myGroupIds().includes(t.groupId) },
  unassigned: { label: "Unassigned",        needs: "tickets.view_all",   includes: (t) => isOpen(t) && !t.assigneeId },
  open:       { label: "All open",          needs: "tickets.view_all",   includes: (t) => isOpen(t) },
  // Everyone always keeps sight of the tickets they raised, whatever their access level allows today.
  raised:     { label: "Raised by me",      needs: null,                 includes: (t) => t.requesterId === S.me.id },
  closed:     { label: "Resolved & closed", needs: null,                 includes: (t) => !isOpen(t) },
};
const queueIsAllowed = (key) => !QUEUES[key].needs || can(QUEUES[key].needs);
const allowedQueues = () => Object.keys(QUEUES).filter(queueIsAllowed);

// Open tickets first; among those, highest priority then soonest SLA. Closed tickets by most recently updated.
function sortForQueue(tickets) {
  return tickets.sort((a, b) => {
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    if (!isOpen(a)) return b.updatedAt - a.updatedAt;
    return (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) || (slaState(a).dueAt - slaState(b).dueAt);
  });
}
// Search looks at the ID, title, description, category, asset, people and tags. "#psu" matches the tag exactly.
function matchesSearch(ticket, search) {
  if (!search) return true;
  if (search.startsWith("#")) return (ticket.tags || []).includes(search.slice(1));
  const haystack = [ticketRef(ticket), ticket.title, ticket.description, ticket.category, ticket.asset, userName(ticket.assigneeId), userName(ticket.requesterId), ...(ticket.tags || [])];
  return haystack.join(" ").toLowerCase().includes(search);
}
function ticketsInQueue(queueKey) {
  const queue = QUEUES[queueKey], search = T.search.trim().toLowerCase();
  return sortForQueue([...S.tickets.values()].filter((t) =>
    queue.includes(t)
    && (!T.filterGroup || t.groupId === Number(T.filterGroup))
    && (!T.filterPriority || t.priority === T.filterPriority)
    && (!T.filterTag || (t.tags || []).includes(T.filterTag))
    && matchesSearch(t, search)));
}
const groupOptions = (selectedId, emptyLabel) => `<option value="">${esc(emptyLabel)}</option>` +
  [...S.groups.values()].map((g) => `<option value="${g.id}" ${Number(selectedId) === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("");

// ---------- left rail ----------
function railHTML(view) {
  const tickets = [...S.tickets.values()];
  const queueButton = (key) => `<button data-view="${key}" aria-current="${view === key}"><span>${QUEUES[key].label}</span><span class="count">${tickets.filter(QUEUES[key].includes).length}</span></button>`;
  const showsGroups = can("groups.manage") || can("tickets.assignable");
  const manageLinks = [
    can("tickets.create") ? `<button data-view="new" aria-current="${view === "new"}"><span>New ticket</span><span class="count">+</span></button>` : "",
    showsGroups ? `<button data-view="groupsAdmin" aria-current="${view === "groupsAdmin"}"><span>Resolver groups</span><span class="count">${S.groups.size}</span></button>` : "",
  ].join("");
  return `<div><div class="navlabel">Queues</div><nav class="nav">${allowedQueues().map(queueButton).join("")}</nav></div>
    ${manageLinks ? `<div><div class="navlabel">Manage</div><nav class="nav">${manageLinks}</nav></div>` : ""}`;
}

// ---------- queue page ----------
function summaryStripHTML() {
  const open = [...S.tickets.values()].filter(isOpen);
  const p1Count = open.filter((t) => t.priority === "P1").length;
  const unassignedCount = open.filter((t) => !t.assigneeId).length;
  const breachedCount = open.filter((t) => slaState(t).breached).length;
  return `<div class="stats">
    <button class="stat" data-view="open" data-pri=""><span class="k">Open</span><span class="v">${open.length}</span></button>
    <button class="stat ${p1Count ? "alert" : ""}" data-view="open" data-pri="P1"><span class="k">P1 open</span><span class="v">${p1Count}</span></button>
    <button class="stat" data-view="unassigned" data-pri=""><span class="k">Unassigned</span><span class="v">${unassignedCount}</span></button>
    <div class="stat ${breachedCount ? "alert" : ""}"><span class="k">SLA breached</span><span class="v">${breachedCount}</span></div></div>`;
}
function ticketRowHTML(ticket) {
  const sla = slaState(ticket), group = S.groups.get(ticket.groupId);
  const isSelected = S.panel?.type === "ticket" && S.panel.id === ticket.id;
  return `<tr class="row" tabindex="0" data-open="${ticket.id}" aria-selected="${isSelected}">
    <td class="tid">${ticketRef(ticket)}</td>
    <td class="ttl">${esc(ticket.title)}<div class="sub">${esc(ticket.category)}${ticket.asset ? ` · <span class="mono">${esc(ticket.asset)}</span>` : ""}</div>${ticket.tags?.length ? `<div class="tagchips">${extras.tagChipsHTML(ticket.tags)}</div>` : ""}</td>
    <td><span class="pri ${ticket.priority}">${ticket.priority}</span></td>
    <td><span class="status ${statusClass(ticket.status)}">${esc(ticket.status)}</span></td>
    <td>${group ? esc(group.name) : '<span class="none">Unrouted</span>'}</td>
    <td>${personHTML(ticket.assigneeId)}</td>
    <td class="hide-sm"><span class="sla ${sla.cssClass}">${esc(sla.text)}</span></td>
    <td class="hide-sm sub">${esc(formatDateTime(ticket.updatedAt))}</td></tr>`;
}
function emptyQueueHTML(queueKey) {
  if (!S.tickets.size) {
    return `<div class="empty"><strong>No tickets yet</strong><span>Raise the first one for a failed component, a down link, or a planned swap.</span>
      ${can("tickets.create") ? '<button class="btn primary" data-view="new">New ticket</button>' : ""}</div>`;
  }
  const messages = {
    mine: "Nothing assigned to you right now.",
    groups: myGroupIds().length ? "Your groups have no open tickets." : "You are not in a resolver group yet. Join one under Resolver groups.",
    unassigned: "Every open ticket has an owner.",
    raised: "You have not raised any tickets.",
    closed: "No resolved tickets yet.",
  };
  return `<div class="empty"><strong>Queue clear</strong><span>${esc(messages[queueKey] || "No tickets match these filters.")}</span></div>`;
}
function queuePageHTML(queueKey) {
  const rows = ticketsInQueue(queueKey);
  const slaHours = S.C.SLA_HOURS;
  const table = !S.ticketsLoaded ? `<div class="empty">Loading tickets…</div>` : rows.length
    ? `<table><thead><tr><th>ID</th><th>Title</th><th>Pri</th><th>Status</th><th>Group</th><th>Assignee</th><th class="hide-sm">SLA</th><th class="hide-sm">Updated</th></tr></thead>
       <tbody>${rows.map(ticketRowHTML).join("")}</tbody></table>`
    : emptyQueueHTML(queueKey);
  return `<div class="topbar"><h1>${esc(QUEUES[queueKey].label)}</h1>${can("tickets.create") ? '<button class="btn primary" data-view="new">New ticket</button>' : ""}</div>
    ${can("tickets.view_all") ? summaryStripHTML() : ""}
    <div class="filters">
      <input type="search" id="q" placeholder="Search ID, title, asset, person, tag (#tag)…" value="${esc(T.search)}" aria-label="Search tickets">
      ${can("tickets.view_all") ? `<select id="fGroup" aria-label="Filter by resolver group">${groupOptions(T.filterGroup, "All groups")}</select>` : ""}
      <select id="fPri" aria-label="Filter by priority"><option value="">All priorities</option>${S.C.PRIORITIES.map((p) => `<option value="${p}" ${T.filterPriority === p ? "selected" : ""}>${PRIORITY_INFO[p].label}</option>`).join("")}</select>
      ${T.filterTag ? `<span class="tagchip active">#${esc(T.filterTag)}<button class="tagchip-x" data-cleartagfilter aria-label="Stop filtering by tag">×</button></span>` : ""}
    </div>
    <div class="tablewrap">${table}</div>
    <p class="note">SLA targets from open to resolve: P1 ${slaHours.P1} h · P2 ${slaHours.P2} h · P3 ${slaHours.P3} h · P4 ${slaHours.P4 / HOURS_PER_DAY} days. This page refreshes on its own.</p>`;
}

// ---------- new ticket ----------
function newTicketPageHTML() {
  if (!can("tickets.create")) return `<div class="topbar"><h1>New ticket</h1></div><div class="banner">Your access level doesn't include raising tickets.</div>`;
  const L = S.C.MAX_LENGTH;
  return `<div class="topbar"><h1>New ticket</h1></div>
  <form class="formcard" id="newForm">
    <label class="f">Title<input id="n_title" required maxlength="${L.ticketTitle}" placeholder="e.g. DIMM B3 correctable ECC errors on gpu-node-0417"></label>
    <div class="grid2">
      <label class="f">Priority<select id="n_pri">${S.C.PRIORITIES.map((p) => `<option value="${p}" ${p === DEFAULT_PRIORITY ? "selected" : ""}>${PRIORITY_INFO[p].label}</option>`).join("")}</select></label>
      <label class="f">Category<select id="n_cat">${categoryOptionsHTML("Other")}</select></label>
      <label class="f">Resolver group<select id="n_group">${groupOptions("", "Unrouted (the desk will route it)")}</select></label>
      <label class="f">Asset / location<input id="n_asset" maxlength="${L.assetTag}" placeholder="Hostname, serial, or row-rack-U (R12-A07-U22)"></label>
    </div>
    <p class="note" id="n_hint">${esc(PRIORITY_INFO[DEFAULT_PRIORITY].hint)}</p>
    <label class="f">Description<textarea id="n_desc" rows="7" maxlength="${L.ticketDescription}" placeholder="Symptoms, alerts, what you already checked, error codes, part numbers."></textarea></label>
    <label class="f">Tags (optional)<input id="n_tags" list="tag_suggestions" placeholder="Separate with commas, e.g. psu, vendor-rma"><span class="note">Tags make tickets easy to find later. You can attach files once the ticket is created.</span></label>
    ${extras.tagSuggestionsHTML()}
    <div class="row-actions"><span class="note">You are the requester. The ticket starts as New until someone picks it up.</span>
      <span class="btns"><button type="button" class="btn" data-view="${defaultQueue()}">Cancel</button><button class="btn primary" type="submit" id="n_submit">Create ticket</button></span></div>
  </form>`;
}

// ---------- resolver groups ----------
function groupFormHTML() {
  const editing = T.editingGroupId, group = editing && editing !== "new" ? S.groups.get(editing) : null;
  if (!editing) return "";
  const L = S.C.MAX_LENGTH;
  return `<form class="formcard" id="groupForm"><h2>${group ? "Edit group" : "New resolver group"}</h2>
    <label class="f">Name<input id="g_name" required maxlength="${L.groupName}" value="${esc(group?.name)}"></label>
    <label class="f">What this group handles<textarea id="g_desc" rows="2" maxlength="${L.groupDescription}">${esc(group?.description)}</textarea></label>
    <div class="row-actions">${group ? `<button type="button" class="btn danger" data-delgroup="${group.id}">Delete group</button>` : "<span></span>"}
      <span class="btns"><button type="button" class="btn" data-cancelgroup>Cancel</button><button class="btn primary" type="submit">Save group</button></span></div>
    <div id="g_confirm"></div></form>`;
}
function groupCardHTML(group) {
  const manages = can("groups.manage");
  const open = [...S.tickets.values()].filter((t) => t.groupId === group.id && isOpen(t));
  const unassigned = open.filter((t) => !t.assigneeId).length, breached = open.filter((t) => slaState(t).breached).length;
  const iAmMember = group.members.includes(S.me.id);
  const canBeAdded = peopleWhoCanTakeTickets().filter((u) => !group.members.includes(u.id));
  const memberChip = (id) => `<span class="chip">${avatar(id)}${esc(userName(id))}${group.leads.includes(id) ? ' <span class="sub">lead</span>' : ""}${manages ? `<button title="Remove from group" aria-label="Remove ${esc(userName(id))}" data-rmmember="${group.id}|${id}">×</button>` : ""}</span>`;
  return `<section class="gcard">
    <div class="hd"><h2>${esc(group.name)}</h2>${manages ? `<button class="btn sm" data-editgroup="${group.id}">Edit</button>` : ""}</div>
    ${group.description ? `<div class="sub">${esc(group.description)}</div>` : ""}
    <div class="gstats"><span><b>${open.length}</b> open</span><span><b>${unassigned}</b> unassigned</span><span><b class="${breached ? "bad" : ""}">${breached}</b> breached</span></div>
    <div class="chips">${group.members.length ? group.members.map(memberChip).join("") : '<span class="none">No members yet</span>'}</div>
    ${manages && canBeAdded.length ? `<div class="addrow"><select id="add_${group.id}" aria-label="Add someone to ${esc(group.name)}"><option value="">Add someone who can take tickets…</option>${canBeAdded.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select><button class="btn sm" data-addmember="${group.id}">Add</button></div>` : ""}
    ${manages && group.members.length ? `<label class="f">Group lead<select id="lead_${group.id}" data-lead="${group.id}"><option value="">No lead</option>${group.members.map((id) => `<option value="${id}" ${group.leads.includes(id) ? "selected" : ""}>${esc(userName(id))}</option>`).join("")}</select></label>` : ""}
    <div class="row-actions">
      ${can("tickets.assignable") ? `<button class="btn sm" data-joingroup="${group.id}" data-member="${iAmMember ? 1 : 0}">${iAmMember ? "Leave group" : "Join group"}</button>` : "<span></span>"}
      ${can("tickets.view_all") ? `<button class="btn sm" data-viewgroup="${group.id}">View queue</button>` : ""}</div>
  </section>`;
}
function groupsPageHTML() {
  const groups = [...S.groups.values()], manages = can("groups.manage");
  const emptyState = `<div class="tablewrap"><div class="empty"><strong>No resolver groups</strong><span>Groups own tickets, such as a hardware break/fix team or a network fabric team.</span>${manages ? '<button class="btn primary" data-newgroup>Create the first group</button>' : ""}</div></div>`;
  return `<div class="topbar"><h1>Resolver groups</h1>${manages && !T.editingGroupId ? '<button class="btn primary" data-newgroup>New group</button>' : ""}</div>
    ${!manages ? '<p class="note">People with "Manage resolver groups" create groups and set membership. You can join or leave a group yourself.</p>' : ""}
    ${groupFormHTML()}
    ${groups.length ? `<div class="groups">${groups.map(groupCardHTML).join("")}</div>` : emptyState}`;
}

// ---------- ticket detail panel ----------
// The person who raised a ticket sees who is working on it, with their photo.
function technicianCardHTML(ticket) {
  if (ticket.requesterId !== S.me.id || !ticket.assigneeId || ticket.assigneeId === S.me.id) return "";
  return `<div class="tech-card">${avatar(ticket.assigneeId, "xl")}
    <div class="tech-who"><span class="sub">${isOpen(ticket) ? "Working on your ticket" : "Handled your ticket"}</span><b>${esc(userName(ticket.assigneeId))}</b></div></div>`;
}
function activityHTML(entry) {
  const who = esc(userName(entry.by) || "System"), when = esc(formatDateTime(entry.at));
  if (entry.type === "comment" || entry.type === "internal") {
    return `<div class="ev ${entry.type}"><div class="meta">${entry.type === "internal" ? '<span class="tag">Internal</span> · ' : ""}${who} · ${when}</div><div class="txt">${esc(entry.text)}</div></div>`;
  }
  if (entry.type === "created") return `<div class="ev"><div class="meta">${who} raised this ticket · ${when}</div></div>`;
  const line = (words) => `<div class="ev"><div class="meta">${who} ${words} · ${when}</div></div>`;
  const added = esc(entry.to), removed = esc(entry.from), wasAdded = !!entry.to && !entry.from;
  // Things added to or removed from a ticket read as "attached ...", "linked ...", not "changed files from none to ...".
  if (entry.field === "files") return line(wasAdded ? `attached <b>${added}</b>` : `removed the file <b>${removed}</b>`);
  if (entry.field === "links") return line(wasAdded ? `linked this ticket: <b>${added}</b>` : `removed the link to <b>${removed}</b>`);
  if (entry.field === "projects") return line(wasAdded ? `linked the project <b>${added}</b>` : `unlinked the project <b>${removed}</b>`);
  if (entry.field === "tags") return line(entry.to ? `set the tags to <b>${added}</b>` : "removed all tags");
  return line(`changed ${esc(entry.field)} from <b>${esc(entry.from || "none")}</b> to <b>${esc(entry.to || "none")}</b>`);
}
function linkedTasksHTML(ticket, draft) {
  if (!can("projects.access")) return "";
  const tasks = T.detail.linkedTasks || [];
  const list = tasks.length
    ? `<ul class="linklist">${tasks.map((k) => `<li><button class="linkrow" data-task="${k.id}"><span class="pdot pc-${esc(k.projectColor)}"></span><span class="${k.completed ? "done-text" : ""}">${esc(k.title)}</span><span class="sub">${esc(k.projectName)}</span></button></li>`).join("")}</ul>`
    : '<p class="note">Not linked to any project task.</p>';
  const projectChoices = T.projectsForLinking ? `<option value="">Choose a project…</option>${T.projectsForLinking.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}` : "<option>Loading…</option>";
  const linker = draft.linking
    ? `<div class="addrow"><select id="d_linkproject" aria-label="Project">${projectChoices}</select><button class="btn sm primary" data-createtask>Create task</button><button class="btn sm" data-cancellink>Cancel</button></div>`
    : `<button class="btn sm self-start" data-linktask>Add to a project…</button>`;
  return `<div><div class="section-label">Project tasks</div>${list}${linker}</div>`;
}
// Someone without an account who asked through the website form: their name, and their email as a mailto link.
function websiteRequesterHTML(requester) {
  if (!requester) return "";
  return `<span>${esc(requester.name)} <span class="sub">· website</span><br><a href="mailto:${esc(encodeURIComponent(requester.email).replace(/%40/g, "@"))}">${esc(requester.email)}</a></span>`;
}
function panelHTML() {
  if (!T.detail) return "";
  const ticket = T.detail.ticket, draft = T.drafts[ticket.id] || {}, sla = slaState(ticket);
  const canWork = can("tickets.work"), canAssign = can("tickets.assign");
  const canComment = can("tickets.view_all") || ticket.requesterId === S.me.id;
  const disabledUnless = (allowed) => (allowed ? "" : "disabled");
  const groupMembers = S.groups.get(ticket.groupId)?.members || [];
  const assigneeChoices = [...new Set([...groupMembers, ...peopleWhoCanTakeTickets().map((u) => u.id), ...(ticket.assigneeId ? [ticket.assigneeId] : [])])];
  const canTakeIt = canWork && can("tickets.assignable") && isOpen(ticket) && ticket.assigneeId !== S.me.id;

  return `<aside class="panel" role="dialog" aria-label="${ticketRef(ticket)}">
    <header><div class="panel-head"><div class="tid">${ticketRef(ticket)} · opened ${esc(formatDateTime(ticket.createdAt))}</div><h2 class="wrap-any">${esc(ticket.title)}</h2>
      <div class="btns badges"><span class="pri ${ticket.priority}">${PRIORITY_INFO[ticket.priority].label}</span><span class="status ${statusClass(ticket.status)}">${esc(ticket.status)}</span><span class="sla ${sla.cssClass}">${esc(sla.text)}</span></div></div>
      <button class="btn sm" data-close aria-label="Close ticket">Close</button></header>
    <div class="body">
      ${technicianCardHTML(ticket)}
      <div class="fields">
        <label class="f">Status<select id="d_status" data-field="status" ${disabledUnless(canWork)}>${S.C.STATUSES.map((s) => `<option ${ticket.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        <label class="f">Priority<select id="d_pri" data-field="priority" ${disabledUnless(canWork)}>${S.C.PRIORITIES.map((p) => `<option value="${p}" ${ticket.priority === p ? "selected" : ""}>${PRIORITY_INFO[p].label}</option>`).join("")}</select></label>
        <label class="f">Resolver group<select id="d_group" data-field="groupId" ${disabledUnless(canAssign)}>${groupOptions(ticket.groupId, "Unrouted")}</select></label>
        <label class="f">Assignee<select id="d_assignee" data-field="assigneeId" ${disabledUnless(canAssign)}><option value="">Unassigned</option>${assigneeChoices.map((id) => `<option value="${id}" ${ticket.assigneeId === id ? "selected" : ""}>${esc(userName(id))}${ticket.groupId && !groupMembers.includes(id) ? " (not in group)" : ""}</option>`).join("")}</select></label>
        <label class="f">Category<select id="d_cat" data-field="category" ${disabledUnless(canWork)}>${categoryOptionsHTML(ticket.category)}</select></label>
        <div class="f readonly-field">Requester<div class="readonly-value">${websiteRequesterHTML(T.detail.websiteRequester) || personHTML(ticket.requesterId, "Unknown")}</div></div>
      </div>
      ${canTakeIt ? '<button class="btn self-start" data-takeit>Assign to me</button>' : ""}
      ${ticket.asset ? `<div><div class="section-label">Asset / location</div><div class="mono">${esc(ticket.asset)}</div></div>` : ""}
      <div><div class="section-label">Description</div><div class="desc">${ticket.description ? esc(ticket.description) : '<span class="none">No description</span>'}</div></div>
      ${ticket.resolution ? `<div><div class="section-label">Resolution</div><div class="desc">${esc(ticket.resolution)}</div></div>` : ""}
      ${draft.resolving ? `<div class="confirm"><label class="f">Resolution notes (required)<textarea id="d_resolution" rows="3" placeholder="What was replaced or changed, part numbers, RMA number, how you verified it.">${esc(draft.resolutionText || "")}</textarea></label>
        <div class="btns end"><button class="btn" data-cancelresolve>Cancel</button><button class="btn primary" data-confirmresolve>Mark resolved</button></div></div>` : ""}
      ${canWork && isOpen(ticket) && !draft.resolving ? '<button class="btn self-start" data-resolve>Resolve…</button>' : ""}
      ${!isOpen(ticket) && (canWork || ticket.requesterId === S.me.id) ? '<button class="btn self-start" data-reopen>Reopen</button>' : ""}
      ${extras.tagsSectionHTML(T.detail)}
      ${extras.attachmentsSectionHTML(T.detail)}
      ${extras.linkedTicketsSectionHTML(T.detail)}
      ${extras.linkedProjectsSectionHTML(T.detail)}
      ${linkedTasksHTML(ticket, draft)}
      <div><div class="section-label">Activity</div>
        <div class="timeline">${T.detail.activity.slice().reverse().map(activityHTML).join("") || '<div class="ev"><span class="none">No activity yet</span></div>'}</div></div>
      ${canComment ? `<div class="composer"><label class="f">Add an update<textarea id="d_comment" rows="3" placeholder="${canWork ? "Work notes, findings, questions for the requester" : "Add details or answer a question from the desk"}">${esc(draft.comment || "")}</textarea></label>
        <div class="row-actions">${can("tickets.internal_notes") ? `<label class="chk"><input type="checkbox" id="d_internal" ${draft.internal ? "checked" : ""}> Internal note (only people allowed to see internal notes)</label>` : "<span></span>"}<button class="btn primary" data-comment>Post update</button></div></div>` : ""}
      ${can("tickets.delete") ? (draft.confirmDelete
        ? `<div class="confirm"><span>Delete ${ticketRef(ticket)} permanently? This removes its history for everyone.</span><div class="btns end"><button class="btn" data-canceldelete>Keep ticket</button><button class="btn danger" data-confirmdelete>Delete ticket</button></div></div>`
        : '<button class="btn sm danger self-start" data-deleteticket>Delete ticket</button>') : ""}
    </div></aside>`;
}
async function loadPanel(panel) {
  try {
    [T.detail] = await Promise.all([api("GET", "/api/tickets/" + panel.id), extras.loadSuggestions()]);
    S.tickets.set(panel.id, T.detail.ticket);
    return true;
  }
  catch (error) { T.detail = null; toast(error.message, true); return false; }
}
async function refreshAfterChange(ticketId) {
  await Promise.all([LH.loadTickets(), loadPanel({ id: ticketId })]);
  LH.render();
}
const defaultQueue = () => ["mine", "open", "raised", "closed"].find(queueIsAllowed);

// ---------- actions ----------
async function createTicket() {
  const button = $("#n_submit");
  button.disabled = true; button.textContent = "Creating…";
  try {
    const result = await act(() => api("POST", "/api/tickets", {
      title: $("#n_title").value, priority: $("#n_pri").value, category: $("#n_cat").value,
      groupId: $("#n_group").value || null, asset: $("#n_asset").value, description: $("#n_desc").value,
      tags: extras.tagsFromText($("#n_tags").value),
    }));
    toast("Created " + ticketRef(result.ticket));
    S.views.tickets = queueIsAllowed("raised") ? "raised" : defaultQueue();
    $("#main").innerHTML = "";
    await LH.loadTickets();
    await LH.openPanel("ticket", result.ticket.id);
  } catch {
    button.disabled = false; button.textContent = "Create ticket";
  }
}
async function saveGroup() {
  const body = { name: $("#g_name").value, description: $("#g_desc").value };
  if (T.editingGroupId === "new") await act(() => api("POST", "/api/groups", body), "Group created");
  else await act(() => api("PATCH", "/api/groups/" + T.editingGroupId, body), "Group saved");
  T.editingGroupId = null;
  await LH.loadBootstrap();
  $("#main").innerHTML = "";
  LH.render();
}
const redrawMain = () => { $("#main").innerHTML = ""; LH.render(); };

// What ticket-extras.js needs to act on the open ticket.
const extrasContext = () => ({ detail: T.detail, refresh: () => refreshAfterChange(T.detail.ticket.id) });

async function handlePanelClick(data) {
  const ticket = T.detail.ticket;
  if (await extras.handleClick(data, extrasContext())) return;
  if (data.takeit !== undefined) {
    const changes = { assigneeId: S.me.id };
    const firstGroup = myGroupIds()[0];
    if (!ticket.groupId && firstGroup && can("tickets.assign")) changes.groupId = firstGroup;
    await act(() => api("PATCH", "/api/tickets/" + ticket.id, changes), "Assigned to you");
    return refreshAfterChange(ticket.id);
  }
  if (data.comment !== undefined) {
    const text = $("#d_comment").value.trim();
    if (!text) { $("#d_comment").focus(); return; }
    const internal = !!$("#d_internal")?.checked;
    await act(() => api("POST", `/api/tickets/${ticket.id}/comments`, { text, internal }), internal ? "Internal note added" : "Update posted");
    setDraft(ticket.id, { comment: "", internal: false });
    return refreshAfterChange(ticket.id);
  }
  if (data.resolve !== undefined) { setDraft(ticket.id, { resolving: true }); LH.renderPanel(); $("#d_resolution")?.focus(); return; }
  if (data.cancelresolve !== undefined) { setDraft(ticket.id, { resolving: false }); LH.renderPanel(); return; }
  if (data.confirmresolve !== undefined) {
    const resolution = $("#d_resolution").value.trim();
    if (!resolution) { $("#d_resolution").focus(); toast("Add resolution notes first", true); return; }
    await act(() => api("PATCH", "/api/tickets/" + ticket.id, { status: "Resolved", resolution }), "Resolved " + ticketRef(ticket));
    setDraft(ticket.id, { resolving: false, resolutionText: "" });
    return refreshAfterChange(ticket.id);
  }
  if (data.reopen !== undefined) { await act(() => api("POST", `/api/tickets/${ticket.id}/reopen`), "Reopened"); return refreshAfterChange(ticket.id); }
  if (data.deleteticket !== undefined) { setDraft(ticket.id, { confirmDelete: true }); LH.renderPanel(); return; }
  if (data.canceldelete !== undefined) { setDraft(ticket.id, { confirmDelete: false }); LH.renderPanel(); return; }
  if (data.confirmdelete !== undefined) {
    await act(() => api("DELETE", "/api/tickets/" + ticket.id), "Deleted " + ticketRef(ticket));
    LH.closePanel(false); await LH.loadTickets(); LH.render(); return;
  }
  if (data.linktask !== undefined) {
    setDraft(ticket.id, { linking: true }); LH.renderPanel();
    T.projectsForLinking = (await act(() => api("GET", "/api/projects"))).projects;
    LH.renderPanel(); $("#d_linkproject")?.focus(); return;
  }
  if (data.cancellink !== undefined) { setDraft(ticket.id, { linking: false }); LH.renderPanel(); return; }
  if (data.createtask !== undefined) {
    const projectId = $("#d_linkproject").value;
    if (!projectId) { toast("Choose a project first", true); return; }
    const result = await act(() => api("POST", `/api/projects/${projectId}/tasks`, { title: `${ticketRef(ticket)}: ${ticket.title}`.slice(0, S.C.MAX_LENGTH.taskTitle), ticketId: ticket.id }), "Task created in project");
    setDraft(ticket.id, { linking: false });
    await LH.openPanel("task", result.task.id);
  }
}

async function handleGroupClick(data) {
  if (data.newgroup !== undefined) { T.editingGroupId = "new"; redrawMain(); $("#g_name")?.focus(); return true; }
  if (data.editgroup !== undefined) { T.editingGroupId = Number(data.editgroup); redrawMain(); $("#g_name")?.focus(); return true; }
  if (data.cancelgroup !== undefined) { T.editingGroupId = null; redrawMain(); return true; }
  if (data.delgroup !== undefined) {
    const groupId = Number(data.delgroup), group = S.groups.get(groupId);
    const openCount = [...S.tickets.values()].filter((t) => t.groupId === groupId && isOpen(t)).length;
    const warning = openCount ? ` ${openCount} open ticket${openCount > 1 ? "s" : ""} will become unrouted.` : "";
    $("#g_confirm").innerHTML = `<div class="confirm"><span>Delete ${esc(group?.name)}?${warning}</span><div class="btns end"><button type="button" class="btn danger" data-confirmdelgroup="${groupId}">Delete group</button></div></div>`;
    return true;
  }
  if (data.confirmdelgroup !== undefined) {
    await act(() => api("DELETE", "/api/groups/" + data.confirmdelgroup), "Group deleted");
    T.editingGroupId = null;
    await Promise.all([LH.loadBootstrap(), LH.loadTickets()]);
    redrawMain(); return true;
  }
  if (data.joingroup !== undefined) {
    const joining = data.member !== "1";
    if (joining) await act(() => api("POST", `/api/groups/${data.joingroup}/members`, { userId: S.me.id }), "Joined group");
    else await act(() => api("DELETE", `/api/groups/${data.joingroup}/members/${S.me.id}`), "Left group");
    await LH.loadBootstrap(); LH.render(); return true;
  }
  if (data.addmember !== undefined) {
    const userId = $("#add_" + data.addmember).value;
    if (!userId) return true;
    await act(() => api("POST", `/api/groups/${data.addmember}/members`, { userId: Number(userId) }), `${userName(Number(userId))} added`);
    await LH.loadBootstrap(); LH.render(); return true;
  }
  if (data.rmmember !== undefined) {
    const [groupId, userId] = data.rmmember.split("|");
    await act(() => api("DELETE", `/api/groups/${groupId}/members/${userId}`), "Removed from group");
    await LH.loadBootstrap(); LH.render(); return true;
  }
  if (data.viewgroup !== undefined) { T.filterGroup = data.viewgroup; await LH.go("tickets", "open"); return true; }
  return false;
}

async function changeTicketField(select) {
  const ticket = T.detail.ticket, field = select.dataset.field;
  let value = select.value;
  if (field === "groupId" || field === "assigneeId") value = value ? Number(value) : null;
  // Choosing "Resolved" from the menu opens the resolution notes instead of saving straight away.
  if (field === "status" && value === "Resolved" && !ticket.resolution) {
    select.value = ticket.status;
    setDraft(ticket.id, { resolving: true }); LH.renderPanel(); $("#d_resolution")?.focus(); return;
  }
  try { await act(() => api("PATCH", "/api/tickets/" + ticket.id, { [field]: value })); }
  catch { select.value = ticket[field] ?? ""; return; }
  await refreshAfterChange(ticket.id);
}

// ---------- register the tab ----------
LH.register({
  tab: "tickets", label: "Tickets", panelType: "ticket",
  badgeHTML: () => {
    if (!can("tickets.assignable") || !S.ticketsLoaded) return "";
    const assignedToMe = [...S.tickets.values()].filter((t) => isOpen(t) && t.assigneeId === S.me.id).length;
    return assignedToMe ? `<span class="tabcount">${assignedToMe}</span>` : "";
  },
  defaultView: defaultQueue,
  load: (view) => Promise.all([LH.loadTickets(), view === "new" ? extras.loadSuggestions() : null]),
  loadPanel, railHTML, panelHTML,
  mainHTML: (view) => {
    if (view === "new") return newTicketPageHTML();
    if (view === "groupsAdmin") return groupsPageHTML();
    return queuePageHTML(QUEUES[view] && queueIsAllowed(view) ? view : defaultQueue());
  },
  keepMain: (view) => (view === "new" && !!$("#newForm")) || (view === "groupsAdmin" && !!T.editingGroupId && !!$("#groupForm")),
  onViewClick: (data) => { T.editingGroupId = null; if (data.pri !== undefined) T.filterPriority = data.pri; },
  onKeydown: (event, element) => (S.panel?.type === "ticket" && T.detail ? extras.handleKeydown(event, element) : false),

  async onSubmit(event, form) {
    if (form.id === "newForm") { await createTicket(); return true; }
    if (form.id === "groupForm") { await saveGroup(); return true; }
    return false;
  },
  async onClick(event, element) {
    const data = element.dataset;
    if (data.open !== undefined) { await LH.openPanel("ticket", Number(data.open)); return true; }
    if (data.task !== undefined || data.project !== undefined) return false; // a linked task or project: the Projects tab opens it
    if (data.filtertag !== undefined) {
      T.filterTag = data.filtertag; T.search = "";
      if (S.panel) LH.closePanel(false);
      await LH.go("tickets", QUEUES[LH.currentView()] ? LH.currentView() : defaultQueue()); return true;
    }
    if (data.cleartagfilter !== undefined) { T.filterTag = ""; LH.render(); return true; }
    if (S.panel?.type === "ticket" && T.detail && element.closest(".panel")) { await handlePanelClick(data); return true; }
    return handleGroupClick(data);
  },
  onInput(event, element) {
    if (element.id === "q") { T.search = element.value; LH.render(); return true; }
    if (element.id === "n_pri") { $("#n_hint").textContent = PRIORITY_INFO[element.value].hint; return true; }
    if (S.panel?.type === "ticket") {
      if (element.id === "d_comment") setDraft(S.panel.id, { comment: element.value });
      if (element.id === "d_resolution") setDraft(S.panel.id, { resolutionText: element.value });
      if (element.id === "d_internal") setDraft(S.panel.id, { internal: element.checked });
    }
    return false;
  },
  async onChange(event, element) {
    if (element.id === "fGroup") { T.filterGroup = element.value; LH.render(); return true; }
    if (element.id === "fPri") { T.filterPriority = element.value; LH.render(); return true; }
    if (element.dataset.field && S.panel?.type === "ticket" && T.detail) { await changeTicketField(element); return true; }
    if (S.panel?.type === "ticket" && T.detail && (await extras.handleChange(element, extrasContext()))) return true;
    if (element.dataset.lead) {
      await act(() => api("PUT", `/api/groups/${element.dataset.lead}/lead`, { userId: element.value ? Number(element.value) : null }), "Group lead updated");
      await LH.loadBootstrap(); LH.render(); return true;
    }
    return false;
  },
});
})();
