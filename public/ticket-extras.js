// The parts of the ticket panel that hang off a ticket: tags, attached files, linked tickets and linked projects.
// tickets.js draws them with LH.ticketExtras.*HTML(detail) and passes clicks and changes to handleClick / handleChange.
//
// Who can do what (the server checks the same rules):
//   tags, links      change with "Work tickets"; everyone who can see the ticket sees them
//   files            anyone who can see the ticket can attach and download; the uploader or a worker can remove
//   project links    "Work tickets" and "Use projects"
(() => {
"use strict";
const { S, $, esc, toast, formatDateTime, api, act, can, userName } = LH;

// ---------- settings ----------
const RELATION_LABELS = {
  "related": "Related to", "duplicate-of": "Duplicate of", "has-duplicate": "Duplicated by", "blocks": "Blocks", "blocked-by": "Blocked by",
};
const BYTES_PER_KB = 1024, BYTES_PER_MB = 1024 * 1024;
const statusClass = (status) => "s-" + status.replace(/\s/g, "");
const ticketRef = (id) => "TKT-" + id;

// Remembered between panel openings: the tags in use (for suggestions) and the project list (for linking).
const X = { tagSuggestions: [], projects: null, uploading: "" };

// "1.4 MB", "820 KB", "512 bytes"
function readableSize(bytes) {
  if (bytes >= BYTES_PER_MB) return (bytes / BYTES_PER_MB).toFixed(1) + " MB";
  if (bytes >= BYTES_PER_KB) return Math.round(bytes / BYTES_PER_KB) + " KB";
  return bytes + " bytes";
}
// Same rule as the server, so people see the tag they'll get as they type: lower case, spaces become dashes.
const normalizeTag = (raw) => String(raw || "").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-");
const tagsFromText = (text) => String(text || "").split(",").map(normalizeTag).filter(Boolean);

// Tag chips for queue rows and the panel. Clicking one filters the queue by that tag.
function tagChipsHTML(tags, { removable = false } = {}) {
  return tags.map((tag) => `<span class="tagchip"><button class="tagchip-name" data-filtertag="${esc(tag)}" title="Show tickets tagged ${esc(tag)}">#${esc(tag)}</button>${removable ? `<button class="tagchip-x" data-removetag="${esc(tag)}" aria-label="Remove tag ${esc(tag)}">×</button>` : ""}</span>`).join("");
}
const tagSuggestionsHTML = () => `<datalist id="tag_suggestions">${X.tagSuggestions.map((t) => `<option value="${esc(t.tag)}">`).join("")}</datalist>`;

// ---------- tags ----------
function tagsSectionHTML(detail) {
  const tags = detail.ticket.tags || [], canEdit = can("tickets.work");
  if (!tags.length && !canEdit) return "";
  const editor = canEdit
    ? `<div class="addrow"><input id="d_newtag" list="tag_suggestions" maxlength="${S.C.MAX_TAG_LENGTH}" placeholder="Add a tag, e.g. psu or vendor-rma" aria-label="Add a tag"><button class="btn sm" data-addtag>Add</button></div>${tagSuggestionsHTML()}`
    : "";
  return `<div><div class="section-label">Tags</div><div class="tagchips">${tags.length ? tagChipsHTML(tags, { removable: canEdit }) : '<span class="none">No tags yet</span>'}</div>${editor}</div>`;
}

// ---------- attached files ----------
function attachmentHTML(file) {
  const url = `/api/attachments/${file.id}`;
  const isPicture = /^image\/(png|jpeg|gif|webp)$/.test(file.contentType);
  const mayRemove = file.uploadedBy === S.me.id || can("tickets.work");
  const preview = isPicture
    ? `<a class="file-thumb" href="${url}" target="_blank" rel="noopener" title="Open ${esc(file.fileName)}"><img src="${url}" alt="" loading="lazy"></a>`
    : `<span class="file-icon" aria-hidden="true">${esc((file.fileName.split(".").pop() || "file").slice(0, 4).toUpperCase())}</span>`;
  return `<li class="file-row">${preview}
    <div class="file-main"><a href="${url}?download=1" class="file-name">${esc(file.fileName)}</a>
      <span class="sub">${readableSize(file.sizeBytes)} · ${esc(userName(file.uploadedBy) || "Someone")} · ${esc(formatDateTime(file.createdAt))}</span></div>
    ${mayRemove ? `<button class="icon-btn" data-removefile="${file.id}" title="Remove file" aria-label="Remove ${esc(file.fileName)}">×</button>` : ""}</li>`;
}
function attachmentsSectionHTML(detail) {
  const files = detail.attachments || [];
  const limitMb = S.C.MAX_ATTACHMENT_BYTES / BYTES_PER_MB;
  return `<div><div class="section-label">Files ${files.length ? `<span class="count">${files.length}</span>` : ""}</div>
    ${files.length ? `<ul class="filelist">${files.map(attachmentHTML).join("")}</ul>` : '<p class="note">No files attached.</p>'}
    <div class="btns"><label class="btn sm file-btn">Attach files<input type="file" id="d_files" multiple></label>
      <span class="sub" id="d_upload_status" role="status">${esc(X.uploading)}</span></div>
    <p class="note">Up to ${limitMb} MB each. Screenshots, photos, logs, PDFs, quotes.</p></div>`;
}

// ---------- linked tickets ----------
function linkedTicketsSectionHTML(detail) {
  const links = detail.linkedTickets || [], canEdit = can("tickets.work");
  if (!links.length && !canEdit) return "";
  const row = (link) => `<li class="ticket-link"><span class="sub relation">${RELATION_LABELS[link.relation]}</span>
    <button class="linkrow" data-open="${link.ticket.id}"><span class="mono">${ticketRef(link.ticket.id)}</span><span class="ellip">${esc(link.ticket.title)}</span><span class="status ${statusClass(link.ticket.status)}">${esc(link.ticket.status)}</span></button>
    ${canEdit ? `<button class="icon-btn" data-unlinkticket="${link.linkId}" title="Remove link" aria-label="Remove link to ${ticketRef(link.ticket.id)}">×</button>` : ""}</li>`;
  const adder = canEdit
    ? `<div class="addrow"><select id="d_linkrelation" aria-label="How they're related">${Object.entries(RELATION_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
        <input id="d_linkticket" placeholder="TKT-1042" maxlength="20" aria-label="Ticket number to link"><button class="btn sm" data-linkticket>Link</button></div>`
    : "";
  return `<div><div class="section-label">Linked tickets</div>${links.length ? `<ul class="linklist">${links.map(row).join("")}</ul>` : '<p class="note">Not linked to other tickets.</p>'}${adder}</div>`;
}

// ---------- linked projects ----------
function linkedProjectsSectionHTML(detail) {
  if (!can("projects.access")) return "";
  const projects = detail.linkedProjects || [], canEdit = can("tickets.work");
  const row = (p) => `<li class="ticket-link"><button class="linkrow" data-project="${p.id}"><span class="pdot pc-${esc(p.color)}"></span><span class="ellip">${esc(p.name)}</span>${p.archived ? '<span class="sub">archived</span>' : ""}</button>
    ${canEdit ? `<button class="icon-btn" data-unlinkproject="${p.id}" title="Remove link" aria-label="Unlink ${esc(p.name)}">×</button>` : ""}</li>`;
  const available = (X.projects || []).filter((p) => !projects.some((linked) => linked.id === p.id));
  const adder = !canEdit ? "" : X.projects
    ? (available.length ? `<div class="addrow"><select id="d_linkprojectid" aria-label="Project to link"><option value="">Choose a project…</option>${available.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select><button class="btn sm" data-linkproject>Link</button></div>` : "")
    : `<button class="btn sm self-start" data-loadprojects>Link to a project…</button>`;
  return `<div><div class="section-label">Projects</div>${projects.length ? `<ul class="linklist">${projects.map(row).join("")}</ul>` : '<p class="note">Not linked to a project.</p>'}${adder}</div>`;
}

// ---------- actions ----------
// `context` = { detail, refresh } from tickets.js; refresh() reloads the ticket and redraws.
async function uploadFiles(input, { detail, refresh }) {
  const files = [...input.files];
  input.value = "";
  for (const [index, file] of files.entries()) {
    if (file.size > S.C.MAX_ATTACHMENT_BYTES) { toast(`${file.name} is larger than ${S.C.MAX_ATTACHMENT_BYTES / BYTES_PER_MB} MB`, true); continue; }
    X.uploading = `Uploading ${file.name}${files.length > 1 ? ` (${index + 1} of ${files.length})` : ""}…`;
    LH.renderPanel();
    // Sent as the raw file (not JSON); the server streams it to disk.
    const response = await fetch(`/api/tickets/${detail.ticket.id}/attachments`, {
      method: "POST", credentials: "same-origin", body: file,
      headers: { "X-Lighthouse": "1", "X-File-Name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" },
    }).catch(() => null);
    const result = response ? await response.json().catch(() => ({})) : {};
    if (!response || !response.ok) toast(result.error || `${file.name} didn't upload. Try again.`, true);
  }
  X.uploading = "";
  await refresh();
}
async function saveTags(detail, tags, refresh, message) {
  await act(() => api("PUT", `/api/tickets/${detail.ticket.id}/tags`, { tags }), message);
  await refresh();
}

async function handleClick(data, context) {
  const { detail, refresh } = context, ticketId = detail.ticket.id, tags = detail.ticket.tags || [];
  if (data.addtag !== undefined) {
    const added = tagsFromText($("#d_newtag").value);
    if (!added.length) { $("#d_newtag").focus(); return true; }
    await saveTags(detail, [...new Set([...tags, ...added])], refresh, "Tag added");
    $("#d_newtag")?.focus();
    return true;
  }
  if (data.removetag !== undefined) { await saveTags(detail, tags.filter((t) => t !== data.removetag), refresh, "Tag removed"); return true; }
  if (data.linkticket !== undefined) {
    const ticket = $("#d_linkticket").value.trim();
    if (!ticket) { $("#d_linkticket").focus(); return true; }
    await act(() => api("POST", `/api/tickets/${ticketId}/links`, { ticket, relation: $("#d_linkrelation").value }), "Tickets linked");
    await refresh(); return true;
  }
  if (data.unlinkticket !== undefined) { await act(() => api("DELETE", `/api/tickets/${ticketId}/links/${data.unlinkticket}`), "Link removed"); await refresh(); return true; }
  if (data.loadprojects !== undefined) {
    X.projects = (await act(() => api("GET", "/api/projects"))).projects;
    LH.renderPanel(); $("#d_linkprojectid")?.focus(); return true;
  }
  if (data.linkproject !== undefined) {
    const projectId = Number($("#d_linkprojectid").value);
    if (!projectId) { toast("Choose a project first", true); return true; }
    await act(() => api("POST", `/api/tickets/${ticketId}/projects`, { projectId }), "Linked to project");
    await refresh(); return true;
  }
  if (data.unlinkproject !== undefined) { await act(() => api("DELETE", `/api/tickets/${ticketId}/projects/${data.unlinkproject}`), "Project link removed"); await refresh(); return true; }
  if (data.removefile !== undefined) { await act(() => api("DELETE", `/api/attachments/${data.removefile}`), "File removed"); await refresh(); return true; }
  return false;
}
async function handleChange(element, context) {
  if (element.id === "d_files") { await uploadFiles(element, context); return true; }
  return false;
}
function handleKeydown(event, element) {
  if (event.key !== "Enter") return false;
  const buttonFor = { d_newtag: "[data-addtag]", d_linkticket: "[data-linkticket]" }[element.id];
  if (!buttonFor) return false;
  event.preventDefault();
  document.querySelector(buttonFor)?.click();
  return true;
}
// Called when a ticket panel opens, for tag suggestions.
async function loadSuggestions() {
  try { X.tagSuggestions = (await api("GET", "/api/tags")).tags; } catch { X.tagSuggestions = []; }
}

LH.ticketExtras = {
  tagChipsHTML, tagSuggestionsHTML, tagsFromText, loadSuggestions,
  tagsSectionHTML, attachmentsSectionHTML, linkedTicketsSectionHTML, linkedProjectsSectionHTML,
  handleClick, handleChange, handleKeydown,
};
})();
