// Tickets and resolver groups, driven by access-level permissions; plus the web security basics.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson } = require("./helpers");

let desk, admin, ada, rex, groupId, levels;
const levelId = (name) => levels.find((l) => l.name === name).id;

before(async () => {
  desk = await startLighthouse();
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician" });
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
  groupId = (await admin.post("/api/groups", { name: "Hardware Break/Fix" })).body.id;
  levels = (await admin.get("/api/access-levels")).body.levels;
});
after(() => desk.stop());

test("a requester raises a ticket and sees only their own tickets", async () => {
  const raised = await rex.post("/api/tickets", { title: "PSU2 amber fault LED", priority: "P2", groupId, asset: "R12-A07-U22" });
  assert.equal(raised.status, 201);
  assert.equal(raised.body.ticket.id, 1001, "ticket numbers start at TKT-1001");
  await ada.post("/api/tickets", { title: "Staff-only ticket" });
  const rexList = (await rex.get("/api/tickets")).body.tickets.map((t) => t.title);
  assert.deepEqual(rexList, ["PSU2 amber fault LED"]);
  assert.equal((await rex.get("/api/tickets/1002")).status, 404, "other people's tickets look like they don't exist");
});

test("only people who can be assigned tickets can join resolver groups", async () => {
  assert.equal((await ada.post(`/api/groups/${groupId}/members`, { userId: ada.id })).status, 200);
  const rexJoins = await rex.post(`/api/groups/${groupId}/members`, { userId: rex.id });
  assert.equal(rexJoins.status, 403);
  const adminAddsRex = await admin.post(`/api/groups/${groupId}/members`, { userId: rex.id });
  assert.equal(adminAddsRex.status, 400, "even an admin can't add someone whose level can't take tickets");
});

test("permissions decide who may change what on a ticket", async () => {
  assert.equal((await rex.patch("/api/tickets/1001", { status: "Closed" })).status, 403, "requester can't work tickets");
  const take = await ada.patch("/api/tickets/1001", { assigneeId: ada.id });
  assert.equal(take.status, 200);
  assert.equal(take.body.ticket.status, "Assigned", "assigning a New ticket makes it Assigned");
  assert.equal((await ada.patch("/api/tickets/1001", { assigneeId: rex.id })).status, 400, "can't assign to someone who can't take tickets");
  assert.equal((await ada.patch("/api/tickets/1001", { status: "Resolved" })).status, 400, "resolving needs notes");
  assert.equal((await ada.delete("/api/tickets/1001")).status, 403, "Technicians can't delete tickets by default");
});

test("internal notes are hidden from people without the internal-notes permission", async () => {
  await ada.post("/api/tickets/1001/comments", { text: "Vendor case 4471", internal: true });
  await ada.post("/api/tickets/1001/comments", { text: "Replacement PSU on order", internal: false });
  const rexView = (await rex.get("/api/tickets/1001")).body.activity;
  assert.ok(rexView.some((a) => a.text === "Replacement PSU on order"));
  assert.ok(!rexView.some((a) => a.type === "internal"), "requester never receives internal notes");
  assert.equal((await rex.post("/api/tickets/1001/comments", { text: "sneaky", internal: true })).status, 403);
});

test("a requester replying to a Pending ticket hands it back to the desk", async () => {
  await ada.patch("/api/tickets/1001", { status: "Pending" });
  await rex.post("/api/tickets/1001/comments", { text: "Light is still amber" });
  assert.equal((await ada.get("/api/tickets/1001")).body.ticket.status, "In Progress");
});

test("custom access levels change what people can do, straight away", async () => {
  const nightShift = await admin.post("/api/access-levels", { name: "Night shift", permissions: ["tickets.view_all", "tickets.work", "tickets.assignable", "tickets.delete"] });
  const nora = await addPerson(admin, { name: "Nora Night", username: "nora", accessLevelName: "Night shift" });
  assert.equal((await nora.post("/api/tickets", { title: "x" })).status, 403, "no tickets.create in this level");
  assert.equal((await nora.get("/api/tickets/1002")).status, 200, "can see all tickets");
  assert.equal((await nora.patch("/api/tickets/1002", { assigneeId: nora.id })).status, 200, "can take a ticket herself");
  assert.equal((await nora.patch("/api/tickets/1002", { assigneeId: ada.id })).status, 403, "but can't assign others without tickets.assign");

  // The admin removes "Can be assigned tickets" from the level: Nora's ticket goes back to the queue.
  await admin.patch(`/api/access-levels/${nightShift.body.level.id}`, { permissions: ["tickets.view_all", "tickets.work", "tickets.delete"] });
  const ticket = (await admin.get("/api/tickets/1002")).body;
  assert.equal(ticket.ticket.assigneeId, null);
  assert.equal(ticket.ticket.status, "New");
  assert.ok(ticket.activity.some((a) => a.field === "assignee" && a.from === "Nora Night"), "the change is recorded in the ticket history");
});

test("moving someone to Requester releases their tickets and group memberships", async () => {
  await admin.patch(`/api/users/${ada.id}`, { accessLevelId: levelId("Requester") });
  const groups = (await admin.get("/api/bootstrap")).body.groups;
  assert.deepEqual(groups.find((g) => g.id === groupId).members, []);
  assert.equal((await admin.get("/api/tickets/1001")).body.ticket.assigneeId, null);
  await admin.patch(`/api/users/${ada.id}`, { accessLevelId: levelId("Technician") });
});

test("text input is stored as text, never run as SQL", async () => {
  const sneaky = await rex.post("/api/tickets", { title: "x'); DROP TABLE users;--" });
  assert.equal(sneaky.body.ticket.title, "x'); DROP TABLE users;--");
  assert.ok((await admin.get("/api/bootstrap")).body.users.length >= 3, "users table still there");
});

test("changes from other websites are refused (cross-site request forgery)", async () => {
  const withoutHeader = await fetch(desk.baseUrl + "/api/tickets", { method: "POST", headers: { "Content-Type": "application/json", Cookie: rex.cookie }, body: "{}" });
  assert.equal(withoutHeader.status, 403);
  const fromElsewhere = await fetch(desk.baseUrl + "/api/tickets", { method: "POST", headers: { "Content-Type": "application/json", "X-Lighthouse": "1", Origin: "https://evil.example", Cookie: rex.cookie }, body: "{}" });
  assert.equal(fromElsewhere.status, 403);
});

test("security headers are sent and files outside the app can't be read", async () => {
  const page = await fetch(desk.baseUrl + "/");
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const traversal = await fetch(desk.baseUrl + "/..%2fserver.js");
  assert.ok(!(await traversal.text()).includes("require("), "server code is never served");
});
