// Projects, sections and tasks (Asana-style).
//
// Permissions:
//   projects.access      see projects; add, edit, move, complete and comment on tasks
//   projects.create      start new projects (the creator becomes the owner)
//   projects.manage_all  archive, delete or hand over any project (owners can always do this to their own)
// A task can be deleted by the person who created it, the project owner, or someone with projects.manage_all.
const {
  MAX_LENGTH, PROJECT_COLORS, DEFAULT_PROJECT_COLOR, PROJECT_STATUSES, TASK_PRIORITIES,
  MAX_SECTIONS_PER_PROJECT, MAX_MEMBERS_WHEN_CREATING_PROJECT, COMPLETED_TASKS_SHOWN_FOR_DAYS, DAY_MS,
} = require("../lib/constants");
const { STATUS, fail, created, requiredTextField, textField, idFromPath, optionalId } = require("../lib/http");
const { can } = require("../lib/access");
const { PROJECT_TEMPLATES, DEFAULT_TEMPLATE } = require("../lib/project-templates");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const twoDigits = (n) => String(n).padStart(2, "0");
const todayAsDate = () => { const d = new Date(); return `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`; };

module.exports = function registerProjectRoutes(app) {
  const { route, one, all, run, db, audit, notify, getUserById, requirePermission } = app;
  const requireProjects = (request) => requirePermission(request, "projects.access");

  // ---------- small helpers ----------
  // A date field: undefined = not being changed, null = cleared, otherwise "YYYY-MM-DD".
  function dateField(value, label) {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z"))) fail(STATUS.badRequest, `${label} must be a date.`);
    return value;
  }
  const nextPosition = (sql, ...params) => (one(sql, ...params)?.highest ?? 0) + 1;
  const loadProject = (id) => one("SELECT * FROM projects WHERE id = ?", idFromPath(id)) ?? fail(STATUS.notFound, "Project not found.");
  const canManageProject = (user, project) => can(user, "projects.manage_all") || project.owner_id === user.id;
  const assertNotArchived = (project) => { if (project.archived) fail(STATUS.badRequest, "This project is archived. Restore it to make changes."); };
  function assertCanWorkOnProjects(userId, label) {
    const person = getUserById(userId);
    if (!person || !person.active || !can(person, "projects.access")) fail(STATUS.badRequest, `${label} must be an active person whose access level includes projects.`);
    return person;
  }
  const addMember = (projectId, userId) => run("INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?,?)", projectId, userId);
  const touchProject = (projectId) => run("UPDATE projects SET updated_at = ? WHERE id = ?", Date.now(), projectId);
  const recordTaskActivity = (taskId, userId, type, { field = null, from = null, to = null, body = null } = {}, at = Date.now()) =>
    run("INSERT INTO task_activity (task_id, user_id, type, field, from_val, to_val, body, at) VALUES (?,?,?,?,?,?,?,?)", taskId, userId, type, field, from, to, body, at);

  const projectToApi = (p, counts = {}, members = []) => ({
    id: p.id, name: p.name, description: p.description, color: p.color, status: p.status, ownerId: p.owner_id,
    dueDate: p.due_date, archived: !!p.archived, createdAt: p.created_at, updatedAt: p.updated_at,
    taskCount: counts.total || 0, doneCount: counts.done || 0, overdueCount: counts.overdue || 0, members,
  });
  const taskToApi = (k) => ({
    id: k.id, projectId: k.project_id, sectionId: k.section_id, parentId: k.parent_id, title: k.title, description: k.description,
    assigneeId: k.assignee_id, dueDate: k.due_date, priority: k.priority, completed: !!k.completed, completedAt: k.completed_at,
    ticketId: k.ticket_id, position: k.position, createdBy: k.created_by, createdAt: k.created_at, updatedAt: k.updated_at,
  });

  // ---------- projects ----------
  route("GET", "/api/projects", (request) => {
    requireProjects(request);
    const showArchived = request.query.get("archived") === "1" ? 1 : 0;
    const countsByProject = new Map(all(`SELECT project_id, COUNT(*) AS total, SUM(completed) AS done,
        SUM(CASE WHEN completed = 0 AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END) AS overdue
      FROM tasks WHERE parent_id IS NULL GROUP BY project_id`, todayAsDate()).map((r) => [r.project_id, r]));
    const memberships = all("SELECT * FROM project_members");
    return {
      projects: all("SELECT * FROM projects WHERE archived = ? ORDER BY name COLLATE NOCASE", showArchived)
        .map((p) => projectToApi(p, countsByProject.get(p.id), memberships.filter((m) => m.project_id === p.id).map((m) => m.user_id))),
      templates: Object.entries(PROJECT_TEMPLATES).map(([key, t]) => ({ key, label: t.label, sections: t.sections.map((s) => s.name) })),
      colors: PROJECT_COLORS,
      canCreate: can(request.user, "projects.create"),
    };
  });

  route("POST", "/api/projects", (request) => {
    requirePermission(request, "projects.create");
    const body = request.body;
    const name = requiredTextField(body.name, MAX_LENGTH.projectName, "Project name");
    const description = textField(body.description, MAX_LENGTH.projectDescription, "Description");
    const color = PROJECT_COLORS.includes(body.color) ? body.color : DEFAULT_PROJECT_COLOR;
    const dueDate = dateField(body.dueDate, "Due date") ?? null;
    const template = PROJECT_TEMPLATES[body.template] || PROJECT_TEMPLATES[DEFAULT_TEMPLATE];
    const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(Number).filter(Number.isInteger))].slice(0, MAX_MEMBERS_WHEN_CREATING_PROJECT) : [];
    memberIds.forEach((id) => assertCanWorkOnProjects(id, "Every member"));

    const now = Date.now(), creatorId = request.user.id;
    const projectId = db.transaction(() => {
      const id = run("INSERT INTO projects (name, description, color, owner_id, due_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        name, description, color, creatorId, dueDate, now, now).lastInsertRowid;
      for (const userId of new Set([creatorId, ...memberIds])) addMember(id, userId);
      template.sections.forEach((section, sectionIndex) => {
        const sectionId = run("INSERT INTO sections (project_id, name, position) VALUES (?,?,?)", id, section.name, sectionIndex + 1).lastInsertRowid;
        section.tasks.forEach((taskTitle, taskIndex) => {
          const taskId = run("INSERT INTO tasks (project_id, section_id, title, position, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            id, sectionId, taskTitle, taskIndex + 1, creatorId, now, now).lastInsertRowid;
          recordTaskActivity(taskId, creatorId, "created", {}, now);
        });
      });
      return id;
    })();
    audit("project.create", request, { project: projectId });
    return created({ id: projectId });
  });

  route("GET", "/api/projects/:id", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id);
    const tasks = all("SELECT * FROM tasks WHERE project_id = ? AND parent_id IS NULL ORDER BY position, id", project.id);
    const subtaskCounts = new Map(all("SELECT parent_id, COUNT(*) AS total, SUM(completed) AS done FROM tasks WHERE project_id = ? AND parent_id IS NOT NULL GROUP BY parent_id", project.id).map((r) => [r.parent_id, r]));
    const commentCounts = new Map(all("SELECT a.task_id, COUNT(*) AS n FROM task_activity a JOIN tasks k ON k.id = a.task_id WHERE k.project_id = ? AND a.type = 'comment' GROUP BY a.task_id", project.id).map((r) => [r.task_id, r.n]));
    const today = todayAsDate();
    const counts = { total: tasks.length, done: tasks.filter((k) => k.completed).length, overdue: tasks.filter((k) => !k.completed && k.due_date && k.due_date < today).length };
    return {
      project: projectToApi(project, counts, all("SELECT user_id FROM project_members WHERE project_id = ?", project.id).map((r) => r.user_id)),
      canManage: canManageProject(request.user, project),
      sections: all("SELECT id, name, position FROM sections WHERE project_id = ? ORDER BY position, id", project.id),
      tasks: tasks.map((k) => ({ ...taskToApi(k), subtaskCount: subtaskCounts.get(k.id)?.total || 0, subtaskDone: subtaskCounts.get(k.id)?.done || 0, commentCount: commentCounts.get(k.id) || 0 })),
      linkedTickets: app.ticketExtras.ticketsLinkedToProject(request.user, project.id),
    };
  });

  route("PATCH", "/api/projects/:id", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id), body = request.body, changes = {};
    const managerOnly = (what) => { if (!canManageProject(request.user, project)) fail(STATUS.forbidden, `Only the project owner, or someone allowed to manage every project, can ${what}.`); };
    if (body.archived !== undefined) { managerOnly("archive or restore a project"); changes.archived = body.archived ? 1 : 0; }
    else assertNotArchived(project);
    if (body.name !== undefined) changes.name = requiredTextField(body.name, MAX_LENGTH.projectName, "Project name");
    if (body.description !== undefined) changes.description = textField(body.description, MAX_LENGTH.projectDescription, "Description");
    if (body.color !== undefined) { if (!PROJECT_COLORS.includes(body.color)) fail(STATUS.badRequest, "Unknown colour."); changes.color = body.color; }
    if (body.status !== undefined) { if (!PROJECT_STATUSES.includes(body.status)) fail(STATUS.badRequest, "Unknown status."); changes.status = body.status; }
    if (body.dueDate !== undefined) changes.due_date = dateField(body.dueDate, "Due date");
    if (body.ownerId !== undefined) {
      managerOnly("change the owner");
      changes.owner_id = assertCanWorkOnProjects(optionalId(body.ownerId), "The owner").id;
      addMember(project.id, changes.owner_id);
    }
    const columns = Object.keys(changes); // fixed keys above, never taken from the request
    if (!columns.length) return { ok: true };
    run(`UPDATE projects SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...columns.map((c) => changes[c]), Date.now(), project.id);
    if (body.archived !== undefined) audit(body.archived ? "project.archive" : "project.restore", request, { project: project.id });
    return { ok: true };
  });

  route("DELETE", "/api/projects/:id", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id);
    if (!canManageProject(request.user, project)) fail(STATUS.forbidden, "Only the project owner, or someone allowed to manage every project, can delete it.");
    run("DELETE FROM projects WHERE id = ?", project.id);
    audit("project.delete", request, { project: project.id, name: project.name });
    return { ok: true };
  });

  route("POST", "/api/projects/:id/members", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id);
    assertNotArchived(project);
    addMember(project.id, assertCanWorkOnProjects(optionalId(request.body.userId), "A member").id);
    return { ok: true };
  });

  route("DELETE", "/api/projects/:id/members/:userId", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id), userId = idFromPath(request.params.userId);
    if (userId === project.owner_id) fail(STATUS.badRequest, "The owner is always a member. Change the owner first.");
    if (userId !== request.user.id && !canManageProject(request.user, project)) fail(STATUS.forbidden, "Only the project owner, or someone allowed to manage every project, can remove other members.");
    run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", project.id, userId);
    return { ok: true };
  });

  // ---------- sections ----------
  function loadSection(id) {
    const section = one("SELECT * FROM sections WHERE id = ?", idFromPath(id)) ?? fail(STATUS.notFound, "Section not found.");
    return { section, project: loadProject(section.project_id) };
  }
  const sectionBelongsTo = (sectionId, projectId) => !!one("SELECT 1 AS found FROM sections WHERE id = ? AND project_id = ?", sectionId, projectId);

  route("POST", "/api/projects/:id/sections", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id);
    assertNotArchived(project);
    const name = requiredTextField(request.body.name, MAX_LENGTH.sectionName, "Section name");
    if (one("SELECT COUNT(*) AS n FROM sections WHERE project_id = ?", project.id).n >= MAX_SECTIONS_PER_PROJECT) fail(STATUS.badRequest, `A project can have at most ${MAX_SECTIONS_PER_PROJECT} sections.`);
    const id = run("INSERT INTO sections (project_id, name, position) VALUES (?,?,?)", project.id, name, nextPosition("SELECT MAX(position) AS highest FROM sections WHERE project_id = ?", project.id)).lastInsertRowid;
    touchProject(project.id);
    return created({ id });
  });

  // Rename, and/or move to a new place in the order (`index` counts from 0).
  route("PATCH", "/api/sections/:id", (request) => {
    requireProjects(request);
    const { section, project } = loadSection(request.params.id);
    assertNotArchived(project);
    db.transaction(() => {
      if (request.body.name !== undefined) run("UPDATE sections SET name = ? WHERE id = ?", requiredTextField(request.body.name, MAX_LENGTH.sectionName, "Section name"), section.id);
      if (request.body.index !== undefined) {
        const otherSectionIds = all("SELECT id FROM sections WHERE project_id = ? AND id != ? ORDER BY position, id", project.id, section.id).map((r) => r.id);
        const newIndex = Math.max(0, Math.min(otherSectionIds.length, Number(request.body.index) || 0));
        otherSectionIds.splice(newIndex, 0, section.id);
        otherSectionIds.forEach((id, i) => run("UPDATE sections SET position = ? WHERE id = ?", i + 1, id));
      }
    })();
    touchProject(project.id);
    return { ok: true };
  });

  // Deleting a section moves its tasks to the end of the first remaining section.
  route("DELETE", "/api/sections/:id", (request) => {
    requireProjects(request);
    const { section, project } = loadSection(request.params.id);
    assertNotArchived(project);
    const destination = one("SELECT id FROM sections WHERE project_id = ? AND id != ? ORDER BY position, id LIMIT 1", project.id, section.id);
    if (!destination) fail(STATUS.badRequest, "A project needs at least one section.");
    db.transaction(() => {
      let position = nextPosition("SELECT MAX(position) AS highest FROM tasks WHERE section_id = ?", destination.id);
      for (const task of all("SELECT id FROM tasks WHERE section_id = ? AND parent_id IS NULL ORDER BY position, id", section.id)) {
        run("UPDATE tasks SET section_id = ?, position = ? WHERE id = ?", destination.id, position++, task.id);
      }
      run("DELETE FROM sections WHERE id = ?", section.id);
    })();
    touchProject(project.id);
    return { ok: true, movedTo: destination.id };
  });

  // ---------- tasks ----------
  function loadTask(id) {
    const task = one("SELECT * FROM tasks WHERE id = ?", idFromPath(id)) ?? fail(STATUS.notFound, "Task not found.");
    return { task, project: loadProject(task.project_id) };
  }
  const canDeleteTask = (user, task, project) => task.created_by === user.id || canManageProject(user, project);
  // How a value reads in the task history.
  function readableValue(field, value) {
    if (value === null || value === undefined || value === "") return "";
    if (field === "assignee") return one("SELECT name FROM users WHERE id = ?", value)?.name || "former user";
    if (field === "section") return one("SELECT name FROM sections WHERE id = ?", value)?.name || "deleted section";
    if (field === "linked ticket") return "TKT-" + value;
    return String(value);
  }
  function ticketIdField(value) {
    const id = optionalId(typeof value === "string" ? value.replace(/^TKT-/i, "") : value);
    if (id && !one("SELECT 1 AS found FROM tickets WHERE id = ?", id)) fail(STATUS.badRequest, `Ticket TKT-${id} does not exist.`);
    return id;
  }

  route("POST", "/api/projects/:id/tasks", (request) => {
    requireProjects(request);
    const project = loadProject(request.params.id);
    assertNotArchived(project);
    const body = request.body;
    const title = requiredTextField(body.title, MAX_LENGTH.taskTitle, "Task name");
    const parentId = optionalId(body.parentId);
    let sectionId = null, position;
    if (parentId) {
      // A subtask lives inside its parent, not in a section. Only one level of subtasks is allowed.
      const parent = one("SELECT * FROM tasks WHERE id = ? AND project_id = ?", parentId, project.id) ?? fail(STATUS.badRequest, "Parent task not found in this project.");
      if (parent.parent_id) fail(STATUS.badRequest, "Subtasks cannot have their own subtasks.");
      position = nextPosition("SELECT MAX(position) AS highest FROM tasks WHERE parent_id = ?", parentId);
    } else {
      sectionId = optionalId(body.sectionId) ?? one("SELECT id FROM sections WHERE project_id = ? ORDER BY position, id LIMIT 1", project.id)?.id;
      if (!sectionId || !sectionBelongsTo(sectionId, project.id)) fail(STATUS.badRequest, "Section not found in this project.");
      position = nextPosition("SELECT MAX(position) AS highest FROM tasks WHERE section_id = ? AND parent_id IS NULL", sectionId);
    }
    const assigneeId = optionalId(body.assigneeId);
    if (assigneeId) assertCanWorkOnProjects(assigneeId, "The assignee");
    const priority = TASK_PRIORITIES.includes(body.priority) ? body.priority : "";
    const ticketId = ticketIdField(body.ticketId);
    const now = Date.now();
    const taskId = db.transaction(() => {
      const id = run(`INSERT INTO tasks (project_id, section_id, parent_id, title, description, assignee_id, due_date, priority, ticket_id, position, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, project.id, sectionId, parentId, title, textField(body.description, MAX_LENGTH.taskDescription, "Description"),
        assigneeId, dateField(body.dueDate, "Due date") ?? null, priority, ticketId, position, request.user.id, now, now).lastInsertRowid;
      recordTaskActivity(id, request.user.id, "created", {}, now);
      if (assigneeId) addMember(project.id, assigneeId);
      return id;
    })();
    touchProject(project.id);
    if (assigneeId) notify.taskAssigned(taskId, request.user.id);
    return created({ task: taskToApi(one("SELECT * FROM tasks WHERE id = ?", taskId)) });
  });

  route("GET", "/api/tasks/mine", (request) => {
    requireProjects(request);
    const showCompletedSince = Date.now() - COMPLETED_TASKS_SHOWN_FOR_DAYS * DAY_MS;
    const rows = all(`SELECT k.*, p.name AS project_name, p.color AS project_color, parent.title AS parent_title FROM tasks k
      JOIN projects p ON p.id = k.project_id LEFT JOIN tasks parent ON parent.id = k.parent_id
      WHERE k.assignee_id = ? AND p.archived = 0 AND (k.completed = 0 OR k.completed_at > ?)
      ORDER BY k.completed, CASE WHEN k.due_date IS NULL THEN 1 ELSE 0 END, k.due_date, k.id`, request.user.id, showCompletedSince);
    return { tasks: rows.map((k) => ({ ...taskToApi(k), projectName: k.project_name, projectColor: k.project_color, parentTitle: k.parent_title })), today: todayAsDate() };
  });

  route("GET", "/api/tasks/:id", (request) => {
    requireProjects(request);
    const { task, project } = loadTask(request.params.id);
    const parent = task.parent_id ? one("SELECT id, title FROM tasks WHERE id = ?", task.parent_id) : null;
    return {
      task: taskToApi(task),
      project: { id: project.id, name: project.name, color: project.color, archived: !!project.archived, ownerId: project.owner_id },
      parent: parent ? { id: parent.id, title: parent.title } : null,
      subtasks: all("SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, id", task.id).map(taskToApi),
      sections: all("SELECT id, name FROM sections WHERE project_id = ? ORDER BY position, id", project.id),
      ticket: task.ticket_id ? one("SELECT id, title, status, priority FROM tickets WHERE id = ?", task.ticket_id) : null,
      activity: all("SELECT * FROM task_activity WHERE task_id = ? ORDER BY at, id", task.id)
        .map((a) => ({ id: a.id, type: a.type, by: a.user_id, field: a.field, from: a.from_val, to: a.to_val, text: a.body, at: a.at })),
      canDelete: canDeleteTask(request.user, task, project),
    };
  });

  // Request fields -> { column, history name }.
  const TASK_FIELDS = {
    title: { column: "title", historyName: "name" },
    description: { column: "description", historyName: "description" },
    assigneeId: { column: "assignee_id", historyName: "assignee" },
    dueDate: { column: "due_date", historyName: "due date" },
    priority: { column: "priority", historyName: "priority" },
    completed: { column: "completed", historyName: "status" },
    sectionId: { column: "section_id", historyName: "section" },
    ticketId: { column: "ticket_id", historyName: "linked ticket" },
  };

  route("PATCH", "/api/tasks/:id", (request) => {
    requireProjects(request);
    const { task, project } = loadTask(request.params.id);
    assertNotArchived(project);
    const body = request.body, changes = {};
    if (body.title !== undefined) changes.title = requiredTextField(body.title, MAX_LENGTH.taskTitle, "Task name");
    if (body.description !== undefined) changes.description = textField(body.description, MAX_LENGTH.taskDescription, "Description");
    if (body.assigneeId !== undefined) { changes.assigneeId = optionalId(body.assigneeId); if (changes.assigneeId) assertCanWorkOnProjects(changes.assigneeId, "The assignee"); }
    if (body.dueDate !== undefined) changes.dueDate = dateField(body.dueDate, "Due date");
    if (body.priority !== undefined) { if (!TASK_PRIORITIES.includes(body.priority)) fail(STATUS.badRequest, "Unknown priority."); changes.priority = body.priority; }
    if (body.completed !== undefined) changes.completed = body.completed ? 1 : 0;
    if (body.sectionId !== undefined) {
      if (task.parent_id) fail(STATUS.badRequest, "Subtasks live inside their parent task, not in a section.");
      changes.sectionId = optionalId(body.sectionId);
      if (!changes.sectionId || !sectionBelongsTo(changes.sectionId, project.id)) fail(STATUS.badRequest, "Section not found in this project.");
    }
    if (body.ticketId !== undefined) changes.ticketId = ticketIdField(body.ticketId);

    const now = Date.now();
    const somethingChanged = db.transaction(() => {
      const columns = [], values = [];
      for (const [field, value] of Object.entries(changes)) {
        const { column, historyName } = TASK_FIELDS[field];
        if (task[column] === value) continue;
        columns.push(column); values.push(value);
        if (field === "description") recordTaskActivity(task.id, request.user.id, "change", { field: historyName }, now);
        else if (field === "completed") recordTaskActivity(task.id, request.user.id, "change", { field: historyName, from: task.completed ? "complete" : "incomplete", to: value ? "complete" : "incomplete" }, now);
        else recordTaskActivity(task.id, request.user.id, "change", { field: historyName, from: readableValue(historyName, task[column]), to: readableValue(historyName, value) }, now);
        if (field === "completed") { columns.push("completed_at"); values.push(value ? now : null); }
        // A task moved to another section goes to the bottom of that section.
        if (field === "sectionId") { columns.push("position"); values.push(nextPosition("SELECT MAX(position) AS highest FROM tasks WHERE section_id = ? AND parent_id IS NULL", value)); }
        if (field === "assigneeId" && value) addMember(project.id, value);
      }
      if (!columns.length) return false;
      columns.push("updated_at"); values.push(now);
      run(`UPDATE tasks SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...values, task.id);
      return true;
    })();
    if (somethingChanged) touchProject(project.id);
    if (changes.assigneeId && changes.assigneeId !== task.assignee_id) notify.taskAssigned(task.id, request.user.id);
    return { task: taskToApi(one("SELECT * FROM tasks WHERE id = ?", task.id)) };
  });

  // Drag and drop: put the task into `sectionId`, just before task `beforeId` (or at the end when beforeId is empty).
  route("POST", "/api/tasks/:id/move", (request) => {
    requireProjects(request);
    const { task, project } = loadTask(request.params.id);
    assertNotArchived(project);
    if (task.parent_id) fail(STATUS.badRequest, "Subtasks cannot be moved between sections.");
    const targetSectionId = optionalId(request.body.sectionId) ?? task.section_id;
    if (!sectionBelongsTo(targetSectionId, project.id)) fail(STATUS.badRequest, "Section not found in this project.");
    const beforeId = optionalId(request.body.beforeId);
    db.transaction(() => {
      const orderedIds = all("SELECT id FROM tasks WHERE section_id = ? AND parent_id IS NULL AND id != ? ORDER BY position, id", targetSectionId, task.id).map((r) => r.id);
      const insertAt = beforeId ? orderedIds.indexOf(beforeId) : -1;
      orderedIds.splice(insertAt < 0 ? orderedIds.length : insertAt, 0, task.id);
      orderedIds.forEach((id, i) => run("UPDATE tasks SET position = ? WHERE id = ?", i + 1, id));
      if (targetSectionId !== task.section_id) {
        run("UPDATE tasks SET section_id = ?, updated_at = ? WHERE id = ?", targetSectionId, Date.now(), task.id);
        recordTaskActivity(task.id, request.user.id, "change", { field: "section", from: readableValue("section", task.section_id), to: readableValue("section", targetSectionId) });
      }
    })();
    touchProject(project.id);
    return { ok: true };
  });

  route("POST", "/api/tasks/:id/comments", (request) => {
    requireProjects(request);
    const { task, project } = loadTask(request.params.id);
    assertNotArchived(project);
    const text = requiredTextField(request.body.text, MAX_LENGTH.ticketComment, "Comment");
    recordTaskActivity(task.id, request.user.id, "comment", { body: text });
    run("UPDATE tasks SET updated_at = ? WHERE id = ?", Date.now(), task.id);
    notify.taskComment(task.id, request.user.id, text);
    return created({ ok: true });
  });

  route("DELETE", "/api/tasks/:id", (request) => {
    requireProjects(request);
    const { task, project } = loadTask(request.params.id);
    assertNotArchived(project);
    if (!canDeleteTask(request.user, task, project)) fail(STATUS.forbidden, "Only the person who created the task, the project owner, or someone allowed to manage every project can delete it.");
    run("DELETE FROM tasks WHERE id = ?", task.id);
    touchProject(project.id);
    audit("task.delete", request, { task: task.id, project: project.id });
    return { ok: true };
  });

  // Used by the ticket page to list tasks linked to a ticket.
  return {
    linkedTasksForTicket: (ticketId) => all(`SELECT k.id, k.title, k.completed, p.id AS project_id, p.name AS project_name, p.color AS project_color
        FROM tasks k JOIN projects p ON p.id = k.project_id WHERE k.ticket_id = ? ORDER BY k.id`, ticketId)
      .map((r) => ({ id: r.id, title: r.title, completed: !!r.completed, projectId: r.project_id, projectName: r.project_name, projectColor: r.project_color })),
  };
};
