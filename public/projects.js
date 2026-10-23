// Projects tab: My tasks, the project list, a project page (list and board views with drag and drop),
// and the task detail panel. Shown to people whose access level includes "projects.access".
(() => {
"use strict";
const { S, $, esc, toast, formatDateTime, isoDay, dueDateLabel, api, act, can, userName, avatar, personHTML, peopleWhoUseProjects, personOptions } = LH;

// ---------- settings ----------
const PROJECT_STATUS_LABELS = { on_track: "On track", at_risk: "At risk", off_track: "Off track", on_hold: "On hold", complete: "Complete" };
const TASK_PRIORITY_LABELS = { "": "None", low: "Low", medium: "Medium", high: "High" };
const DEFAULT_COLOR = "teal";
const MEMBER_AVATARS_ON_CARD = 4;      // more members than this show as "+N"
const UPCOMING_DAYS = 7;               // the "Next 7 days" group in My tasks
const COMPLETED_TASKS_SHOWN_FOR_DAYS = 7; // matches the server
const MAX_TICKET_REFERENCE_LENGTH = 20;
const MS_PER_DAY = 86400000;
const PERCENT = 100;
const STORAGE_KEYS = { viewMode: "lh.pmode", hideCompleted: "lh.hidedone" };

// Small wrapper so a blocked localStorage never breaks the page.
const savedSetting = {
  get: (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* not important */ } },
};

// Page-level state for this tab.
const P = {
  projects: [], templates: [], colors: [], canCreate: false,
  archivedProjects: null,       // loaded when the Archived page is opened
  project: null,                // the open project page: { project, sections, tasks, canManage }
  myTasks: null,
  task: null,                   // the open task panel
  viewMode: savedSetting.get(STORAGE_KEYS.viewMode, "list"),          // "list" or "board"
  hideCompleted: savedSetting.get(STORAGE_KEYS.hideCompleted, "0") === "1",
  listFilter: "all",            // "all" or "mine" on the project list
  showCompletedInMyTasks: false,
  editingProject: false, addingSection: false, renamingSectionId: null,
  pendingConfirm: null,         // { type: "deleteProject" | "deleteSection" | "deleteTask", id }
  taskDrafts: {},               // unsaved description/comment text, by task id
  draggedTaskId: null,
};

// Pages in this tab are named "mytasks", "all", "archived", "new", or "project:<id>".
const PROJECT_VIEW_PREFIX = "project:";
const projectIdFromView = (view) => (String(view).startsWith(PROJECT_VIEW_PREFIX) ? Number(String(view).slice(PROJECT_VIEW_PREFIX.length)) : null);
const projectInitial = (name) => esc((name || "?").trim().charAt(0).toUpperCase());
const priorityChipHTML = (priority) => (priority ? `<span class="tprio tp-${priority}">${TASK_PRIORITY_LABELS[priority]}</span>` : "");
function dueDateHTML(isoDate, isCompleted) {
  if (!isoDate) return "";
  const label = dueDateLabel(isoDate);
  return `<span class="due ${isCompleted ? "" : label.cssClass}">${esc(label.text)}</span>`;
}
const openProjectIsArchived = () => !!P.project?.project.archived;
const canCreateProjects = () => P.canCreate || can("projects.create");
const checkboxHTML = (task, disabled) => `<button class="check ${task.completed ? "on" : ""}" data-toggle="${task.id}" aria-label="${task.completed ? "Mark incomplete" : "Mark complete"}" aria-pressed="${task.completed}" ${disabled ? "disabled" : ""}></button>`;

// ---------- data ----------
async function loadProjectList() {
  const result = await api("GET", "/api/projects");
  P.projects = result.projects; P.templates = result.templates; P.colors = result.colors; P.canCreate = result.canCreate;
}
async function load(view) {
  const jobs = [loadProjectList()];
  if (view === "mytasks") jobs.push(api("GET", "/api/tasks/mine").then((r) => (P.myTasks = r.tasks)));
  if (view === "archived") jobs.push(api("GET", "/api/projects?archived=1").then((r) => (P.archivedProjects = r.projects)));
  const projectId = projectIdFromView(view);
  if (projectId) {
    jobs.push(api("GET", "/api/projects/" + projectId)
      .then((r) => (P.project = r))
      .catch((error) => { P.project = null; toast(error.message, true); setTimeout(() => LH.go("projects", "all"), 0); }));
  }
  await Promise.all(jobs);
}
async function loadPanel(panel) {
  try { P.task = await api("GET", "/api/tasks/" + panel.id); return true; }
  catch (error) { P.task = null; toast(error.message, true); return false; }
}
async function reload() {
  await load(LH.currentView());
  if (S.panel?.type === "task") await loadPanel(S.panel);
  LH.render();
}
const redrawMain = () => { $("#main").innerHTML = ""; LH.render(); };

// ---------- left rail ----------
function railHTML(view) {
  const iAmIn = (project) => project.members.includes(S.me.id);
  const mine = P.projects.filter(iAmIn), others = P.projects.filter((p) => !iAmIn(p));
  const projectLink = (p) => `<button data-view="${PROJECT_VIEW_PREFIX}${p.id}" aria-current="${projectIdFromView(view) === p.id}"><span class="pname"><span class="pdot pc-${esc(p.color)}"></span><span class="ellip">${esc(p.name)}</span></span><span class="count">${p.taskCount - p.doneCount}</span></button>`;
  const myOpenTaskCount = P.myTasks ? P.myTasks.filter((k) => !k.completed).length : "";
  return `<div><nav class="nav">
      <button data-view="mytasks" aria-current="${view === "mytasks"}"><span>My tasks</span><span class="count">${myOpenTaskCount}</span></button>
      <button data-view="all" aria-current="${view === "all"}"><span>All projects</span><span class="count">${P.projects.length}</span></button>
      <button data-view="archived" aria-current="${view === "archived"}"><span>Archived</span><span class="count"></span></button>
      ${canCreateProjects() ? `<button data-view="new" aria-current="${view === "new"}"><span>New project</span><span class="count">+</span></button>` : ""}</nav></div>
    ${mine.length ? `<div><div class="navlabel">My projects</div><nav class="nav projnav">${mine.map(projectLink).join("")}</nav></div>` : ""}
    ${others.length ? `<div><div class="navlabel">Other projects</div><nav class="nav projnav">${others.map(projectLink).join("")}</nav></div>` : ""}`;
}

// ---------- My tasks ----------
function myTaskRowHTML(task) {
  return `<div class="trow row" data-task="${task.id}" tabindex="0">
    ${checkboxHTML(task)}
    <div class="tmain"><span class="ttitle ${task.completed ? "done-text" : ""}">${esc(task.title)}</span>
      <span class="tmeta"><span class="pchip"><span class="pdot pc-${esc(task.projectColor)}"></span>${esc(task.projectName)}</span>${task.parentTitle ? `<span>in ${esc(task.parentTitle)}</span>` : ""}${priorityChipHTML(task.priority)}</span></div>
    ${dueDateHTML(task.dueDate, task.completed)}</div>`;
}
function myTasksHTML() {
  if (!P.myTasks) return `<div class="topbar"><h1>My tasks</h1></div><div class="tablewrap"><div class="empty">Loading tasks…</div></div>`;
  const today = isoDay(), endOfUpcoming = isoDay(new Date(Date.now() + UPCOMING_DAYS * MS_PER_DAY));
  const open = P.myTasks.filter((k) => !k.completed), completed = P.myTasks.filter((k) => k.completed);
  const dueGroups = [
    { label: "Overdue", cssClass: "overdue", tasks: open.filter((k) => k.dueDate && k.dueDate < today) },
    { label: "Today", tasks: open.filter((k) => k.dueDate === today) },
    { label: `Next ${UPCOMING_DAYS} days`, tasks: open.filter((k) => k.dueDate > today && k.dueDate <= endOfUpcoming) },
    { label: "Later", tasks: open.filter((k) => k.dueDate > endOfUpcoming) },
    { label: "No due date", tasks: open.filter((k) => !k.dueDate) },
  ].filter((group) => group.tasks.length);
  const groupHTML = (group) => `<section class="tgroup"><h2 class="tg-h ${group.cssClass || ""}">${group.label} <span class="count">${group.tasks.length}</span></h2><div class="tasklist">${group.tasks.map(myTaskRowHTML).join("")}</div></section>`;
  const nothingToDo = `<div class="tablewrap"><div class="empty"><strong>Nothing on your plate</strong><span>Tasks assigned to you in any project show up here.</span><button class="btn primary" data-view="all">Browse projects</button></div></div>`;
  const completedSection = completed.length
    ? `<section class="tgroup"><button class="linkbtn" data-showdone>${P.showCompletedInMyTasks ? "Hide" : "Show"} ${completed.length} completed in the last ${COMPLETED_TASKS_SHOWN_FOR_DAYS} days</button>${P.showCompletedInMyTasks ? `<div class="tasklist">${completed.map(myTaskRowHTML).join("")}</div>` : ""}</section>`
    : "";
  return `<div class="topbar"><h1>My tasks</h1></div>
    <p class="note">Every task assigned to you across active projects, soonest first.</p>
    ${dueGroups.length ? dueGroups.map(groupHTML).join("") : nothingToDo}
    ${completedSection}`;
}

// ---------- project list ----------
function projectCardHTML(project) {
  const hiddenMembers = project.members.length - MEMBER_AVATARS_ON_CARD;
  return `<article class="pcard" data-project="${project.id}" tabindex="0" aria-label="${esc(project.name)}">
    <div class="pc-top"><span class="picon pc-${esc(project.color)}">${projectInitial(project.name)}</span>
      <div class="pc-name"><h2>${esc(project.name)}</h2><div class="sub">${esc(userName(project.ownerId) || "No owner")}${project.dueDate ? ` · due ${esc(dueDateLabel(project.dueDate).text)}` : ""}</div></div>
      <span class="pstatus st-${project.status}">${PROJECT_STATUS_LABELS[project.status]}</span></div>
    <progress class="prog pc-${esc(project.color)}" max="${Math.max(1, project.taskCount)}" value="${project.doneCount}" aria-label="${project.doneCount} of ${project.taskCount} tasks done"></progress>
    <div class="pc-foot"><span class="sub">${project.doneCount} of ${project.taskCount} tasks done</span>${project.overdueCount ? `<span class="overdue">${project.overdueCount} overdue</span>` : ""}
      <span class="avs">${project.members.slice(0, MEMBER_AVATARS_ON_CARD).map((id) => avatar(id)).join("")}${hiddenMembers > 0 ? `<span class="av more">+${hiddenMembers}</span>` : ""}</span></div>
  </article>`;
}
function projectCardsHTML(projects, whenEmpty) {
  if (!projects) return `<div class="tablewrap"><div class="empty">Loading projects…</div></div>`;
  if (!projects.length) return whenEmpty;
  return `<div class="pgrid">${projects.map(projectCardHTML).join("")}</div>`;
}
function allProjectsHTML() {
  const showingMine = P.listFilter === "mine";
  const projects = showingMine ? P.projects.filter((p) => p.members.includes(S.me.id)) : P.projects;
  const createButton = (label) => (canCreateProjects() ? `<button class="btn primary" data-view="new">${label}</button>` : "");
  const whenEmpty = `<div class="tablewrap"><div class="empty"><strong>${showingMine ? "You are not in any project yet" : "No projects yet"}</strong><span>Track rack build-outs, hardware refreshes and planned maintenance as projects with tasks and owners.</span>${createButton("Create a project")}</div></div>`;
  return `<div class="topbar"><h1>Projects</h1>${createButton("New project")}</div>
    <div class="filters"><div class="seg" role="group" aria-label="Show"><button data-pfilter="all" aria-pressed="${!showingMine}">All active</button><button data-pfilter="mine" aria-pressed="${showingMine}">I'm a member</button></div></div>
    ${projectCardsHTML(projects, whenEmpty)}`;
}
function archivedHTML() {
  return `<div class="topbar"><h1>Archived projects</h1></div><p class="note">Archived projects are read-only and hidden from My tasks. Open one to restore it.</p>
    ${projectCardsHTML(P.archivedProjects, `<div class="tablewrap"><div class="empty"><strong>Nothing archived</strong><span>Archive a finished project from its page to tidy up the list.</span></div></div>`)}`;
}
function colorSwatchesHTML(inputName, selectedColor) {
  return `<div class="swatches" role="radiogroup" aria-label="Colour">${P.colors.map((color) => `<label class="swatch pc-${color}"><input type="radio" name="${inputName}" value="${color}" ${color === selectedColor ? "checked" : ""}><span class="sr">${color}</span></label>`).join("")}</div>`;
}
const templateSectionsText = (templateKey) => {
  const template = P.templates.find((t) => t.key === templateKey);
  return "Sections: " + (template ? template.sections.join(" → ") : "");
};
function newProjectHTML() {
  if (!canCreateProjects()) return `<div class="topbar"><h1>New project</h1></div><div class="banner">Your access level doesn't include creating projects.</div>`;
  const L = S.C.MAX_LENGTH;
  const memberChoice = (u) => {
    const isMe = u.id === S.me.id;
    return `<label class="chk"><input type="checkbox" name="pf_member" value="${u.id}" ${isMe ? "checked disabled" : ""}> ${esc(u.name)}${isMe ? " (you, owner)" : ""}</label>`;
  };
  return `<div class="topbar"><h1>New project</h1></div>
  <form class="formcard" id="projForm">
    <label class="f">Project name<input id="pf_name" required maxlength="${L.projectName}" placeholder="e.g. Row 14 GPU rack build-out"></label>
    <div class="grid2">
      <label class="f">Start from<select id="pf_tpl">${P.templates.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join("")}</select></label>
      <label class="f">Due date (optional)<input id="pf_due" type="date"></label>
    </div>
    <p class="note" id="pf_tplnote">${esc(templateSectionsText(P.templates[0]?.key))}</p>
    <label class="f">Description (optional)<textarea id="pf_desc" rows="3" maxlength="${L.projectDescription}" placeholder="Goal, scope, change numbers, site and rows involved."></textarea></label>
    <div class="f"><span>Colour</span>${colorSwatchesHTML("pf_color", DEFAULT_COLOR)}</div>
    <fieldset class="f members-pick"><legend>Members</legend>
      <div class="checkgrid">${peopleWhoUseProjects().map(memberChoice).join("")}</div></fieldset>
    <div class="btns end"><button type="button" class="btn" data-view="all">Cancel</button><button class="btn primary" type="submit" id="pf_submit">Create project</button></div>
  </form>`;
}

// ---------- project page ----------
function projectHeaderHTML(project, canManage, readOnly) {
  const manageButtons = canManage
    ? (readOnly ? `<button class="btn sm primary" data-prestore>Restore</button>` : `<button class="btn sm" data-parchive>Archive</button>`) + `<button class="btn sm danger" data-pdelete>Delete</button>`
    : "";
  return `<div class="phead">
    <span class="picon lg pc-${esc(project.color)}">${projectInitial(project.name)}</span>
    <div class="phead-main"><h1 class="wrap-any">${esc(project.name)}</h1>${project.description ? `<p class="pdesc">${esc(project.description)}</p>` : ""}</div>
    <div class="btns">
      <div class="seg" role="group" aria-label="View"><button data-pmode="list" aria-pressed="${P.viewMode === "list"}">List</button><button data-pmode="board" aria-pressed="${P.viewMode === "board"}">Board</button></div>
      ${readOnly ? "" : `<button class="btn sm" data-pedit>Edit</button>`}
      ${manageButtons}
    </div></div>`;
}
function projectEditFormHTML(project) {
  const L = S.C.MAX_LENGTH;
  return `<form class="formcard" id="projEditForm"><h2>Edit project</h2>
    <label class="f">Name<input id="pe_name" required maxlength="${L.projectName}" value="${esc(project.name)}"></label>
    <label class="f">Description<textarea id="pe_desc" rows="3" maxlength="${L.projectDescription}">${esc(project.description)}</textarea></label>
    <div class="f"><span>Colour</span>${colorSwatchesHTML("pe_color", project.color)}</div>
    <div class="btns end"><button type="button" class="btn" data-pcancel>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
}
function projectDetailsHTML(project, canManage, readOnly) {
  const percentDone = project.taskCount ? Math.round((project.doneCount / project.taskCount) * PERCENT) : 0;
  const canBeAdded = peopleWhoUseProjects().filter((u) => !project.members.includes(u.id));
  const ownerField = canManage && !readOnly
    ? `<select id="pm_owner">${peopleWhoUseProjects().map((u) => `<option value="${u.id}" ${project.ownerId === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`
    : `<span class="readonly-value">${personHTML(project.ownerId, "No owner")}</span>`;
  // Owners and managers can remove anyone but the owner; everyone else can only remove themselves.
  const canRemove = (id) => id !== project.ownerId && !readOnly && (canManage || id === S.me.id);
  const memberChip = (id) => `<span class="chip">${avatar(id)}${esc(userName(id))}${canRemove(id) ? `<button title="Remove from project" aria-label="Remove ${esc(userName(id))}" data-rmpmember="${id}">×</button>` : ""}</span>`;
  return `<div class="pmeta">
    <label class="f">Status<select id="pm_status" class="pstatus-select st-${project.status}" ${readOnly ? "disabled" : ""}>${Object.entries(PROJECT_STATUS_LABELS).map(([key, label]) => `<option value="${key}" ${project.status === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label class="f">Owner${ownerField}</label>
    <label class="f">Due date<input id="pm_due" type="date" value="${esc(project.dueDate || "")}" ${readOnly ? "disabled" : ""}></label>
    <div class="f"><span>Progress</span><span class="readonly-value prog-col"><progress class="prog pc-${esc(project.color)}" max="${Math.max(1, project.taskCount)}" value="${project.doneCount}"></progress><span class="sub">${percentDone}% done · ${project.doneCount} of ${project.taskCount}${project.overdueCount ? ` · <span class="overdue">${project.overdueCount} overdue</span>` : ""}</span></span></div>
    <div class="f members"><span>Members</span><div class="chips">${project.members.map(memberChip).join("")}
      ${!readOnly && canBeAdded.length ? `<select id="pm_addmember" class="addmember" aria-label="Add a member"><option value="">+ Add member</option>${canBeAdded.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>` : ""}</div></div>
  </div>`;
}
function projectHTML() {
  if (!P.project) return `<div class="tablewrap"><div class="empty">Loading project…</div></div>`;
  const { project, canManage } = P.project, readOnly = project.archived;
  const deleteConfirm = P.pendingConfirm?.type === "deleteProject"
    ? `<div class="confirm"><span>Delete <b>${esc(project.name)}</b> and its ${project.taskCount} tasks permanently? This cannot be undone. Archive it instead if you might need it again.</span><div class="btns end"><button class="btn" data-pcancelconfirm>Keep project</button><button class="btn danger" data-pconfirmdelete>Delete project</button></div></div>`
    : "";
  return `${projectHeaderHTML(project, canManage, readOnly)}
    ${readOnly ? `<div class="banner">This project is archived and read-only.${canManage ? " Restore it to make changes." : ""}</div>` : ""}
    ${deleteConfirm}
    ${P.editingProject ? projectEditFormHTML(project) : ""}
    ${projectDetailsHTML(project, canManage, readOnly)}
    ${linkedTicketsHTML(P.project.linkedTickets || [])}
    <div class="ptoolbar"><label class="chk"><input type="checkbox" id="pm_hidedone" ${P.hideCompleted ? "checked" : ""}> Hide completed tasks</label>
      <span class="note">${readOnly ? "" : "Drag tasks to reorder them or move them between sections."}</span></div>
    ${P.viewMode === "board" ? boardHTML() : listHTML()}`;
}

// Tickets linked to this project (from the ticket's panel: Projects > Link to a project).
function linkedTicketsHTML(tickets) {
  if (!tickets.length) return "";
  const chip = (t) => `<button class="linkrow ticket-chip" data-open="${t.id}"><span class="pri ${t.priority}">${t.priority}</span><span class="mono">TKT-${t.id}</span><span class="ellip">${esc(t.title)}</span><span class="status s-${t.status.replace(/\s/g, "")}">${esc(t.status)}</span></button>`;
  return `<div class="project-tickets"><div class="section-label">Linked tickets <span class="count">${tickets.length}</span></div><div class="ticket-chips">${tickets.map(chip).join("")}</div></div>`;
}

// ---------- sections, list and board ----------
const tasksInSection = (sectionId) => P.project.tasks.filter((k) => k.sectionId === sectionId && !(P.hideCompleted && k.completed));
function taskBadgesHTML(task) {
  const badges = [];
  if (task.subtaskCount) badges.push(`<span title="Subtasks done">☑ ${task.subtaskDone}/${task.subtaskCount}</span>`);
  if (task.commentCount) badges.push(`<span title="Comments">💬 ${task.commentCount}</span>`);
  if (task.ticketId) badges.push(`<span class="mono">TKT-${task.ticketId}</span>`);
  return badges.join("");
}
function sectionHeaderHTML(section, position, sectionCount, cssClass) {
  if (P.renamingSectionId === section.id) {
    return `<form class="${cssClass} secform" id="secRenameForm" data-sid="${section.id}"><input id="sec_name" value="${esc(section.name)}" maxlength="${S.C.MAX_LENGTH.sectionName}" aria-label="Section name" required><button class="btn sm primary">Save</button><button type="button" class="btn sm" data-seccancel>Cancel</button></form>`;
  }
  const openTaskCount = P.project.tasks.filter((k) => k.sectionId === section.id && !k.completed).length;
  const [earlierArrow, laterArrow] = P.viewMode === "board" ? ["←", "→"] : ["↑", "↓"];
  const isFirst = position === 0, isLast = position === sectionCount - 1;
  const actions = openProjectIsArchived() ? "" : `<span class="sec-actions">
    <button class="icon-btn" data-secrename="${section.id}" title="Rename section" aria-label="Rename ${esc(section.name)}">✎</button>
    ${isFirst ? "" : `<button class="icon-btn" data-secmove="${section.id}|${position - 1}" title="Move earlier" aria-label="Move ${esc(section.name)} earlier">${earlierArrow}</button>`}
    ${isLast ? "" : `<button class="icon-btn" data-secmove="${section.id}|${position + 1}" title="Move later" aria-label="Move ${esc(section.name)} later">${laterArrow}</button>`}
    ${sectionCount > 1 ? `<button class="icon-btn" data-secdel="${section.id}" title="Delete section" aria-label="Delete ${esc(section.name)}">🗑</button>` : ""}</span>`;
  const confirmingDelete = P.pendingConfirm?.type === "deleteSection" && P.pendingConfirm.id === section.id;
  const confirm = confirmingDelete ? `<div class="confirm inline"><span>Delete this section? Its tasks move to the first remaining section.</span><span class="btns"><button class="btn sm" data-pcancelconfirm>Cancel</button><button class="btn sm danger" data-secdelconfirm="${section.id}">Delete</button></span></div>` : "";
  return `<div class="${cssClass}"><h2>${esc(section.name)}</h2><span class="count">${openTaskCount}</span>${actions}${confirm}</div>`;
}
const addTaskInputHTML = (sectionId, idPrefix) => (openProjectIsArchived() ? ""
  : `<div class="addtask"><input id="${idPrefix}_${sectionId}" data-addtask="${sectionId}" maxlength="${S.C.MAX_LENGTH.taskTitle}" placeholder="+ Add task" aria-label="Add a task to this section"></div>`);
function addSectionHTML() {
  if (openProjectIsArchived()) return "";
  if (!P.addingSection) return `<button class="btn sm" data-addsection>+ Add section</button>`;
  return `<form class="secform" id="secAddForm"><input id="newsec" maxlength="${S.C.MAX_LENGTH.sectionName}" placeholder="Section name" aria-label="New section name" required><button class="btn sm primary">Add</button><button type="button" class="btn sm" data-seccancel>Cancel</button></form>`;
}
const dragAttributes = (task) => (openProjectIsArchived() ? "" : `data-dragtask="${task.id}" draggable="true"`);

function listHTML() {
  const sections = P.project.sections;
  const row = (task) => `<div class="lrow row ${task.completed ? "is-done" : ""}" data-task="${task.id}" ${dragAttributes(task)} tabindex="0">
    ${checkboxHTML(task, openProjectIsArchived())}
    <div class="tmain"><span class="ttitle ${task.completed ? "done-text" : ""}">${esc(task.title)}</span><span class="tmeta">${taskBadgesHTML(task)}</span></div>
    <span class="lcell">${task.assigneeId ? `<span class="person">${avatar(task.assigneeId)}<span class="hide-sm">${esc(userName(task.assigneeId))}</span></span>` : ""}</span>
    <span class="lcell">${dueDateHTML(task.dueDate, task.completed)}</span>
    <span class="lcell hide-sm">${priorityChipHTML(task.priority)}</span></div>`;
  const sectionHTML = (section, position) => `<section class="psec" data-dropsection="${section.id}">${sectionHeaderHTML(section, position, sections.length, "psec-h")}
    <div class="psec-rows">${tasksInSection(section.id).map(row).join("") || `<div class="dropzone-empty">No tasks${P.hideCompleted ? " to show" : ""}</div>`}</div>
    ${addTaskInputHTML(section.id, "addl")}</section>`;
  return `<div class="plist">
    <div class="lhead"><span></span><span>Task</span><span>Assignee</span><span>Due</span><span class="hide-sm">Priority</span></div>
    ${sections.map(sectionHTML).join("")}
    <div class="addsec">${addSectionHTML()}</div></div>`;
}
function boardHTML() {
  const sections = P.project.sections;
  const card = (task) => `<article class="card row ${task.completed ? "is-done" : ""}" data-task="${task.id}" ${dragAttributes(task)} tabindex="0">
    <div class="card-top">${checkboxHTML(task, openProjectIsArchived())}<span class="ttitle ${task.completed ? "done-text" : ""}">${esc(task.title)}</span></div>
    <div class="card-meta">${priorityChipHTML(task.priority)}${dueDateHTML(task.dueDate, task.completed)}<span class="tmeta">${taskBadgesHTML(task)}</span><span class="spacer"></span>${task.assigneeId ? avatar(task.assigneeId) : ""}</div></article>`;
  const columnHTML = (section, position) => `<section class="bcol" data-dropsection="${section.id}">${sectionHeaderHTML(section, position, sections.length, "bcol-h")}
    <div class="bcards">${tasksInSection(section.id).map(card).join("") || `<div class="dropzone-empty">Drop tasks here</div>`}</div>
    ${addTaskInputHTML(section.id, "addb")}</section>`;
  return `<div class="boardwrap"><div class="board">
    ${sections.map(columnHTML).join("")}
    <div class="bcol add">${addSectionHTML()}</div></div></div>`;
}

// ---------- task panel ----------
function linkedTicketHTML(ticket, readOnly) {
  if (ticket) {
    return `<div class="linkline"><button class="linkrow" data-open="${ticket.id}"><span class="pri ${ticket.priority}">${ticket.priority}</span><span class="mono">TKT-${ticket.id}</span><span class="ellip">${esc(ticket.title)}</span><span class="status s-${ticket.status.replace(/\s/g, "")}">${esc(ticket.status)}</span></button>${readOnly ? "" : `<button class="btn sm" data-unlinkticket>Unlink</button>`}</div>`;
  }
  if (readOnly) return '<p class="note">None</p>';
  return `<div class="addrow"><input id="k_ticket" placeholder="TKT-1234" maxlength="${MAX_TICKET_REFERENCE_LENGTH}" aria-label="Ticket number to link"><button class="btn sm" data-linkticket>Link ticket</button></div>`;
}
function subtasksHTML(subtasks, readOnly) {
  const doneCount = subtasks.filter((s) => s.completed).length;
  const row = (sub) => `<div class="trow row" data-task="${sub.id}" tabindex="0">${checkboxHTML(sub, readOnly)}<div class="tmain"><span class="ttitle ${sub.completed ? "done-text" : ""}">${esc(sub.title)}</span></div>${dueDateHTML(sub.dueDate, sub.completed)}${sub.assigneeId ? avatar(sub.assigneeId) : ""}</div>`;
  return `<div><div class="section-label">Subtasks ${subtasks.length ? `<span class="count">${doneCount}/${subtasks.length}</span>` : ""}</div>
    <div class="tasklist compact">${subtasks.map(row).join("")}</div>
    ${readOnly ? "" : `<div class="addtask"><input id="k_newsub" maxlength="${S.C.MAX_LENGTH.taskTitle}" placeholder="+ Add subtask" aria-label="Add a subtask"></div>`}</div>`;
}
function taskActivityHTML(entry) {
  const who = esc(userName(entry.by) || "Someone"), when = esc(formatDateTime(entry.at));
  if (entry.type === "comment") return `<div class="ev comment"><div class="meta">${who} · ${when}</div><div class="txt">${esc(entry.text)}</div></div>`;
  if (entry.type === "created") return `<div class="ev"><div class="meta">${who} created this task · ${when}</div></div>`;
  if (entry.field === "description") return `<div class="ev"><div class="meta">${who} edited the description · ${when}</div></div>`;
  if (entry.field === "status") return `<div class="ev"><div class="meta">${who} marked this ${esc(entry.to)} · ${when}</div></div>`;
  return `<div class="ev"><div class="meta">${who} changed ${esc(entry.field)} from <b>${esc(entry.from || "none")}</b> to <b>${esc(entry.to || "none")}</b> · ${when}</div></div>`;
}
function panelHTML() {
  if (!P.task) return "";
  const { task, project, parent, sections, subtasks, ticket, activity, canDelete } = P.task;
  const readOnly = project.archived, disabled = readOnly ? "disabled" : "", draft = P.taskDrafts[task.id] || {};
  const descriptionChanged = draft.description !== undefined && draft.description !== task.description;
  const confirmingDelete = P.pendingConfirm?.type === "deleteTask" && P.pendingConfirm.id === task.id;
  const deleteControls = !canDelete || readOnly ? "" : confirmingDelete
    ? `<div class="confirm"><span>Delete this task${subtasks.length ? ` and its ${subtasks.length} subtasks` : ""}? This cannot be undone.</span><div class="btns end"><button class="btn" data-pcancelconfirm>Keep task</button><button class="btn danger" data-kconfirmdelete>Delete task</button></div></div>`
    : `<button class="btn sm danger self-start" data-kdelete>Delete task</button>`;
  const placementField = task.parentId
    ? `<div class="f readonly-field">Subtask of<div class="readonly-value">${esc(parent?.title || "")}</div></div>`
    : `<label class="f">Section<select id="k_section" data-kfield="sectionId" ${disabled}>${sections.map((s) => `<option value="${s.id}" ${task.sectionId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>`;

  return `<aside class="panel" role="dialog" aria-label="Task: ${esc(task.title)}">
    <header><div class="panel-head">
        <div class="crumbs"><button class="crumb" data-project="${project.id}"><span class="pdot pc-${esc(project.color)}"></span>${esc(project.name)}</button>${parent ? `<span aria-hidden="true">›</span><button class="crumb" data-task="${parent.id}">${esc(parent.title)}</button>` : ""}</div>
        <button class="btn sm complete-btn ${task.completed ? "on" : ""}" data-complete ${disabled} aria-pressed="${task.completed}">${task.completed ? "✓ Completed" : "Mark complete"}</button>
      </div><button class="btn sm" data-close aria-label="Close task">Close</button></header>
    <div class="body">
      <input id="k_title" class="title-input ${task.completed ? "done-text" : ""}" value="${esc(task.title)}" maxlength="${S.C.MAX_LENGTH.taskTitle}" aria-label="Task name" ${disabled}>
      <div class="fields">
        <label class="f">Assignee<select id="k_assignee" data-kfield="assigneeId" ${disabled}>${personOptions(peopleWhoUseProjects(), task.assigneeId)}</select></label>
        <label class="f">Due date<input id="k_due" type="date" data-kfield="dueDate" value="${esc(task.dueDate || "")}" ${disabled}></label>
        <label class="f">Priority<select id="k_pri" data-kfield="priority" ${disabled}>${Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => `<option value="${value}" ${task.priority === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        ${placementField}
      </div>
      <div><div class="section-label">Linked ticket</div>${linkedTicketHTML(ticket, readOnly)}</div>
      <div><div class="section-label">Description</div>
        <textarea id="k_desc" rows="4" maxlength="${S.C.MAX_LENGTH.taskDescription}" placeholder="Steps, part numbers, change request, location…" ${disabled}>${esc(draft.description ?? task.description)}</textarea>
        ${!readOnly && descriptionChanged ? `<div class="btns end mt"><button class="btn sm" data-canceldesc>Discard</button><button class="btn sm primary" data-savedesc>Save description</button></div>` : ""}</div>
      ${task.parentId ? "" : subtasksHTML(subtasks, readOnly)}
      <div><div class="section-label">Activity</div>
        <div class="timeline">${activity.slice().reverse().map(taskActivityHTML).join("") || '<div class="ev"><span class="none">No activity yet</span></div>'}</div></div>
      ${readOnly ? "" : `<div class="composer"><label class="f">Comment<textarea id="k_comment" rows="3" placeholder="Updates, blockers, questions. People on this task are alerted.">${esc(draft.comment || "")}</textarea></label>
        <div class="btns end"><button class="btn primary" data-kcomment>Post comment</button></div></div>`}
      ${deleteControls}
      <p class="note">Created by ${esc(userName(task.createdBy) || "someone")} · ${esc(formatDateTime(task.createdAt))}</p>
    </div></aside>`;
}

// ---------- actions ----------
function findTask(taskId) {
  return P.project?.tasks.find((k) => k.id === taskId)
    || P.myTasks?.find((k) => k.id === taskId)
    || P.task?.subtasks.find((k) => k.id === taskId)
    || (P.task?.task.id === taskId ? P.task.task : null);
}
async function updateTask(taskId, changes, successMessage) {
  await act(() => api("PATCH", "/api/tasks/" + taskId, changes), successMessage);
  await reload();
}
async function toggleCompleted(taskId) {
  const task = findTask(taskId), wasCompleted = !!task?.completed;
  await updateTask(taskId, { completed: !wasCompleted }, wasCompleted ? "Marked incomplete" : "Completed");
}
async function addTaskFromInput(input) {
  const title = input.value.trim();
  if (!title) return;
  const sectionId = Number(input.dataset.addtask), inputId = input.id;
  input.disabled = true;
  try { await act(() => api("POST", `/api/projects/${P.project.project.id}/tasks`, { title, sectionId })); }
  finally { input.disabled = false; }
  await reload();
  // Keep the cursor in the same box so several tasks can be typed in a row.
  const again = document.getElementById(inputId);
  if (again) { again.value = ""; again.focus(); }
}
const updateProject = async (changes, successMessage) => {
  await act(() => api("PATCH", "/api/projects/" + P.project.project.id, changes), successMessage);
  await reload();
};
const checkedColor = (inputName) => document.querySelector(`input[name="${inputName}"]:checked`)?.value;

async function createProject() {
  const button = $("#pf_submit");
  button.disabled = true;
  try {
    const memberIds = [...document.querySelectorAll('input[name="pf_member"]:checked')].map((box) => Number(box.value));
    const result = await act(() => api("POST", "/api/projects", {
      name: $("#pf_name").value, description: $("#pf_desc").value, template: $("#pf_tpl").value,
      dueDate: $("#pf_due").value || null, color: checkedColor("pf_color"), memberIds,
    }), "Project created");
    await LH.go("projects", PROJECT_VIEW_PREFIX + result.id);
  } catch {
    button.disabled = false;
  }
}

async function handleTaskPanelClick(data) {
  const task = P.task.task;
  if (data.complete !== undefined) { await toggleCompleted(task.id); return; }
  if (data.savedesc !== undefined) {
    await updateTask(task.id, { description: $("#k_desc").value }, "Description saved");
    delete P.taskDrafts[task.id]?.description; LH.renderPanel(); return;
  }
  if (data.canceldesc !== undefined) { delete P.taskDrafts[task.id]?.description; LH.renderPanel(); return; }
  if (data.linkticket !== undefined) {
    const reference = $("#k_ticket").value.trim();
    if (!reference) { $("#k_ticket").focus(); return; }
    await updateTask(task.id, { ticketId: reference }, "Ticket linked"); return;
  }
  if (data.unlinkticket !== undefined) { await updateTask(task.id, { ticketId: null }, "Ticket unlinked"); return; }
  if (data.kcomment !== undefined) {
    const text = $("#k_comment").value.trim();
    if (!text) { $("#k_comment").focus(); return; }
    await act(() => api("POST", `/api/tasks/${task.id}/comments`, { text }), "Comment posted");
    P.taskDrafts[task.id] = { ...P.taskDrafts[task.id], comment: "" };
    await reload(); return;
  }
  if (data.kdelete !== undefined) { P.pendingConfirm = { type: "deleteTask", id: task.id }; LH.renderPanel(); return; }
  if (data.kconfirmdelete !== undefined) {
    await act(() => api("DELETE", "/api/tasks/" + task.id), "Task deleted");
    P.pendingConfirm = null;
    // A deleted subtask returns you to its parent; a deleted task closes the panel.
    if (P.task.parent) await LH.openPanel("task", P.task.parent.id);
    else LH.closePanel(false);
    await reload();
  }
}

async function handleProjectPageClick(data) {
  if (data.pfilter !== undefined) { P.listFilter = data.pfilter; LH.render(); return true; }
  if (data.pmode !== undefined) { P.viewMode = data.pmode; savedSetting.set(STORAGE_KEYS.viewMode, P.viewMode); LH.render(); return true; }
  if (data.pedit !== undefined) { P.editingProject = true; redrawMain(); $("#pe_name")?.focus(); return true; }
  if (data.pcancel !== undefined) { P.editingProject = false; redrawMain(); return true; }
  if (data.parchive !== undefined) { await updateProject({ archived: true }, "Project archived"); return true; }
  if (data.prestore !== undefined) { await updateProject({ archived: false }, "Project restored"); return true; }
  if (data.pdelete !== undefined) { P.pendingConfirm = { type: "deleteProject" }; LH.render(); return true; }
  if (data.pconfirmdelete !== undefined) {
    await act(() => api("DELETE", "/api/projects/" + P.project.project.id), "Project deleted");
    P.pendingConfirm = null; P.project = null;
    await LH.go("projects", "all"); return true;
  }
  if (data.pcancelconfirm !== undefined) { P.pendingConfirm = null; LH.render(); return true; }
  if (data.rmpmember !== undefined) {
    await act(() => api("DELETE", `/api/projects/${P.project.project.id}/members/${data.rmpmember}`), "Member removed");
    await reload(); return true;
  }
  if (data.addsection !== undefined) { P.addingSection = true; LH.render(); $("#newsec")?.focus(); return true; }
  if (data.seccancel !== undefined) { P.addingSection = false; P.renamingSectionId = null; redrawMain(); return true; }
  if (data.secrename !== undefined) { P.renamingSectionId = Number(data.secrename); redrawMain(); $("#sec_name")?.select(); return true; }
  if (data.secmove !== undefined) {
    const [sectionId, newPosition] = data.secmove.split("|").map(Number);
    await act(() => api("PATCH", "/api/sections/" + sectionId, { index: newPosition }));
    await reload(); return true;
  }
  if (data.secdel !== undefined) { P.pendingConfirm = { type: "deleteSection", id: Number(data.secdel) }; LH.render(); return true; }
  if (data.secdelconfirm !== undefined) {
    await act(() => api("DELETE", "/api/sections/" + data.secdelconfirm), "Section deleted");
    P.pendingConfirm = null; await reload(); return true;
  }
  return false;
}

// ---------- drag and drop ----------
// While dragging, the section under the pointer is highlighted and a line shows where the task will land.
const isInLowerHalf = (event, element) => { const box = element.getBoundingClientRect(); return event.clientY > box.top + box.height / 2; };
function clearDropMarks() {
  document.querySelectorAll(".drop-before,.drop-after,.drop-target").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-target"));
}
function endDrag() {
  P.draggedTaskId = null;
  clearDropMarks();
  document.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
  document.body.classList.remove("dragging-active");
}
// The task the dropped one should go in front of, or null for "at the end".
function taskToDropBefore(event, draggedId) {
  const target = event.target.closest("[data-dragtask]");
  if (!target || Number(target.dataset.dragtask) === draggedId) return null;
  if (!isInLowerHalf(event, target)) return Number(target.dataset.dragtask);
  let next = target.nextElementSibling;
  while (next && (!next.dataset.dragtask || Number(next.dataset.dragtask) === draggedId)) next = next.nextElementSibling;
  return next ? Number(next.dataset.dragtask) : null;
}
document.addEventListener("dragstart", (event) => {
  const element = event.target.closest?.("[data-dragtask]");
  if (!element) return;
  P.draggedTaskId = Number(element.dataset.dragtask);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(P.draggedTaskId));
  element.classList.add("dragging");
  document.body.classList.add("dragging-active");
});
document.addEventListener("dragover", (event) => {
  if (!P.draggedTaskId) return;
  const section = event.target.closest?.("[data-dropsection]");
  if (!section) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearDropMarks();
  section.classList.add("drop-target");
  const overTask = event.target.closest("[data-dragtask]");
  if (overTask && Number(overTask.dataset.dragtask) !== P.draggedTaskId) overTask.classList.add(isInLowerHalf(event, overTask) ? "drop-after" : "drop-before");
});
document.addEventListener("drop", async (event) => {
  if (!P.draggedTaskId) return;
  const section = event.target.closest?.("[data-dropsection]");
  if (!section) return;
  event.preventDefault();
  const taskId = P.draggedTaskId, sectionId = Number(section.dataset.dropsection);
  const beforeId = taskToDropBefore(event, taskId);
  endDrag();
  // Move it on screen straight away so the board doesn't jump, then tell the server.
  const tasks = P.project.tasks, task = tasks.find((k) => k.id === taskId);
  if (task) {
    tasks.splice(tasks.indexOf(task), 1);
    task.sectionId = sectionId;
    const insertAt = beforeId ? tasks.findIndex((k) => k.id === beforeId) : -1;
    if (insertAt >= 0) tasks.splice(insertAt, 0, task); else tasks.push(task);
    LH.render();
  }
  try { await act(() => api("POST", `/api/tasks/${taskId}/move`, { sectionId, beforeId })); }
  finally { await reload(); }
});
document.addEventListener("dragend", endDrag);

// ---------- register the tab ----------
LH.register({
  tab: "projects", label: "Projects", panelType: "task",
  isVisible: () => can("projects.access"),
  badgeHTML: () => {
    const dueOrOverdue = P.myTasks ? P.myTasks.filter((k) => !k.completed && k.dueDate && k.dueDate <= isoDay()).length : 0;
    return dueOrOverdue ? `<span class="tabcount warn" title="Tasks due today or overdue">${dueOrOverdue}</span>` : "";
  },
  defaultView: () => "mytasks",
  load, loadPanel, railHTML, panelHTML,
  mainHTML: (view) => {
    if (view === "mytasks") return myTasksHTML();
    if (view === "archived") return archivedHTML();
    if (view === "new") return newProjectHTML();
    if (projectIdFromView(view)) return projectHTML();
    return allProjectsHTML();
  },
  keepMain: (view) => (view === "new" && !!$("#projForm")) || (P.editingProject && !!$("#projEditForm")) || !!$("#secRenameForm") || !!$("#secAddForm"),
  onViewClick: () => { P.editingProject = false; P.addingSection = false; P.renamingSectionId = null; P.pendingConfirm = null; },

  async onSubmit(event, form) {
    if (form.id === "projForm") { await createProject(); return true; }
    if (form.id === "projEditForm") {
      await act(() => api("PATCH", "/api/projects/" + P.project.project.id, { name: $("#pe_name").value, description: $("#pe_desc").value, color: checkedColor("pe_color") }), "Project saved");
      P.editingProject = false; $("#main").innerHTML = ""; await reload(); return true;
    }
    if (form.id === "secRenameForm") {
      await act(() => api("PATCH", "/api/sections/" + form.dataset.sid, { name: $("#sec_name").value }));
      P.renamingSectionId = null; $("#main").innerHTML = ""; await reload(); return true;
    }
    if (form.id === "secAddForm") {
      await act(() => api("POST", `/api/projects/${P.project.project.id}/sections`, { name: $("#newsec").value }), "Section added");
      P.addingSection = false; $("#main").innerHTML = ""; await reload(); return true;
    }
    return false;
  },

  async onClick(event, element) {
    const data = element.dataset;
    if (data.project !== undefined) { await LH.go("projects", PROJECT_VIEW_PREFIX + data.project); return true; }
    if (data.toggle !== undefined) { await toggleCompleted(Number(data.toggle)); return true; }
    if (data.task !== undefined) { await LH.openPanel("task", Number(data.task)); return true; }
    if (data.showdone !== undefined) { P.showCompletedInMyTasks = !P.showCompletedInMyTasks; LH.render(); return true; }
    if (S.panel?.type === "task" && P.task && element.closest(".panel")) {
      if (data.pcancelconfirm !== undefined) { P.pendingConfirm = null; LH.renderPanel(); return true; }
      await handleTaskPanelClick(data); return true;
    }
    if (S.tab !== "projects") return false;
    return handleProjectPageClick(data);
  },

  async onKeydown(event, element) {
    if (event.key !== "Enter" || event.isComposing) return false;
    if (element.dataset?.addtask !== undefined) { event.preventDefault(); await addTaskFromInput(element); return true; }
    if (element.id === "k_newsub") {
      event.preventDefault();
      const title = element.value.trim();
      if (!title) return true;
      await act(() => api("POST", `/api/projects/${P.task.project.id}/tasks`, { title, parentId: P.task.task.id }));
      await reload(); $("#k_newsub")?.focus(); return true;
    }
    if (element.id === "k_title") { event.preventDefault(); element.blur(); return true; }
    if (element.id === "k_ticket") { event.preventDefault(); document.querySelector("[data-linkticket]")?.click(); return true; }
    return false;
  },

  onInput(event, element) {
    if (S.panel?.type === "task" && P.task) {
      const taskId = P.task.task.id;
      if (element.id === "k_desc") {
        const firstEdit = P.taskDrafts[taskId]?.description === undefined;
        P.taskDrafts[taskId] = { ...P.taskDrafts[taskId], description: element.value };
        if (firstEdit) LH.renderPanel(); // shows the Save / Discard buttons
        return true;
      }
      if (element.id === "k_comment") { P.taskDrafts[taskId] = { ...P.taskDrafts[taskId], comment: element.value }; return true; }
    }
    if (element.id === "pf_tpl") { $("#pf_tplnote").textContent = templateSectionsText(element.value); return true; }
    return false;
  },

  async onChange(event, element) {
    if (element.dataset.kfield && P.task) {
      const field = element.dataset.kfield;
      let value = element.value;
      if (field === "assigneeId" || field === "sectionId") value = value ? Number(value) : null;
      if (field === "dueDate") value = value || null;
      await updateTask(P.task.task.id, { [field]: value }); return true;
    }
    if (element.id === "k_title" && P.task) {
      const title = element.value.trim();
      if (title && title !== P.task.task.title) await updateTask(P.task.task.id, { title }, "Task renamed");
      return true;
    }
    if (element.id === "pm_hidedone") {
      P.hideCompleted = element.checked;
      savedSetting.set(STORAGE_KEYS.hideCompleted, P.hideCompleted ? "1" : "0");
      LH.render(); return true;
    }
    if (!P.project) return false;
    if (element.id === "pm_status") { await updateProject({ status: element.value }, "Status updated"); return true; }
    if (element.id === "pm_owner") { await updateProject({ ownerId: Number(element.value) }, "Owner changed"); return true; }
    if (element.id === "pm_due") { await updateProject({ dueDate: element.value || null }, "Due date updated"); return true; }
    if (element.id === "pm_addmember" && element.value) {
      const userId = Number(element.value);
      await act(() => api("POST", `/api/projects/${P.project.project.id}/members`, { userId }), `${userName(userId)} added`);
      await reload(); return true;
    }
    return false;
  },
});
})();
