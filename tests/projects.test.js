// Projects, sections and tasks, and who may do what with them.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson } = require("./helpers");

let desk, admin, ada, ben, rex, projectId, sections, firstTaskId;

before(async () => {
  desk = await startLighthouse();
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician" });
  ben = await addPerson(admin, { name: "Ben Tech", username: "ben", accessLevelName: "Technician" });
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
});
after(() => desk.stop());

test("people without project access can't see projects at all", async () => {
  assert.equal((await rex.get("/api/projects")).status, 403);
  assert.equal((await rex.get("/api/tasks/mine")).status, 403);
});

test("a template creates its sections and starter tasks; the creator owns the project", async () => {
  const created = await ada.post("/api/projects", { name: "Row 14 GPU rack build-out", template: "rack", memberIds: [ben.id], color: "violet" });
  assert.equal(created.status, 201);
  projectId = created.body.id;
  const project = (await ada.get(`/api/projects/${projectId}`)).body;
  sections = project.sections;
  firstTaskId = project.tasks[0].id;
  assert.deepEqual(sections.map((s) => s.name), ["Planning", "Procurement", "Install & rack", "Cabling", "Burn-in & validation", "Handover"]);
  assert.equal(project.tasks.length, 14, "3 + 2 + 1 + 3 + 3 + 2 starter tasks");
  assert.equal(project.project.ownerId, ada.id);
  assert.deepEqual(project.project.members.sort(), [ada.id, ben.id].sort());
});

test("creating projects needs its own permission", async () => {
  const levels = (await admin.get("/api/access-levels")).body.levels;
  const technician = levels.find((l) => l.name === "Technician");
  await admin.patch(`/api/access-levels/${technician.id}`, { permissions: technician.permissions.filter((p) => p !== "projects.create") });
  assert.equal((await ben.post("/api/projects", { name: "Not allowed" })).status, 403);
  await admin.patch(`/api/access-levels/${technician.id}`, { permissions: technician.permissions });
});

test("drag and drop moves a task to another section, at the chosen position", async () => {
  const [planning, procurement] = sections;
  const before = (await ada.get(`/api/projects/${projectId}`)).body.tasks.filter((k) => k.sectionId === procurement.id).map((k) => k.id);
  assert.equal((await ben.post(`/api/tasks/${firstTaskId}/move`, { sectionId: procurement.id, beforeId: before[1] })).status, 200);
  const after = (await ada.get(`/api/projects/${projectId}`)).body.tasks.filter((k) => k.sectionId === procurement.id).map((k) => k.id);
  assert.deepEqual(after, [before[0], firstTaskId, before[1]]);
  assert.ok(planning);
});

test("subtasks are one level deep", async () => {
  const sub = await ben.post(`/api/projects/${projectId}/tasks`, { title: "Photograph breaker labels", parentId: firstTaskId });
  assert.equal(sub.status, 201);
  const subSub = await ben.post(`/api/projects/${projectId}/tasks`, { title: "Too deep", parentId: sub.body.task.id });
  assert.equal(subSub.status, 400);
});

test("tasks can only be assigned to people whose level includes projects", async () => {
  assert.equal((await ada.patch(`/api/tasks/${firstTaskId}`, { assigneeId: rex.id })).status, 400);
  assert.equal((await ada.patch(`/api/tasks/${firstTaskId}`, { assigneeId: ben.id, dueDate: "2026-12-01", priority: "high" })).status, 200);
  const mine = (await ben.get("/api/tasks/mine")).body.tasks;
  assert.ok(mine.some((k) => k.id === firstTaskId));
});

test("a task links to a ticket, and the ticket lists the task for staff only", async () => {
  await rex.post("/api/tickets", { title: "Breaker trips on PDU A" });
  assert.equal((await ben.patch(`/api/tasks/${firstTaskId}`, { ticketId: "TKT-1001" })).status, 200);
  assert.equal((await ben.patch(`/api/tasks/${firstTaskId}`, { ticketId: 99999 })).status, 400);
  assert.ok((await ada.get("/api/tickets/1001")).body.linkedTasks.some((k) => k.id === firstTaskId));
  assert.deepEqual((await rex.get("/api/tickets/1001")).body.linkedTasks, []);
});

test("only the owner (or someone who manages every project) can archive or delete", async () => {
  assert.equal((await ben.patch(`/api/projects/${projectId}`, { archived: true })).status, 403);
  assert.equal((await ben.delete(`/api/tasks/${firstTaskId}`)).status, 403, "Ben didn't create the task and doesn't own the project");
  assert.equal((await admin.patch(`/api/projects/${projectId}`, { archived: true })).status, 200, "Administrators can manage every project");
  assert.equal((await ben.patch(`/api/tasks/${firstTaskId}`, { title: "x" })).status, 400, "archived projects are read-only");
  assert.ok(!(await ben.get("/api/tasks/mine")).body.tasks.some((k) => k.projectId === projectId), "archived work leaves My tasks");
  await ada.patch(`/api/projects/${projectId}`, { archived: false });
});

test("losing project access releases a person's tasks", async () => {
  const levels = (await admin.get("/api/access-levels")).body.levels;
  await admin.patch(`/api/users/${ben.id}`, { accessLevelId: levels.find((l) => l.name === "Requester").id });
  const project = (await ada.get(`/api/projects/${projectId}`)).body;
  assert.equal(project.tasks.find((k) => k.id === firstTaskId).assigneeId, null);
  assert.ok(!project.project.members.includes(ben.id));
});
