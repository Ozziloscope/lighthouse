// Announcements: banners across the top of every page, posted by people with "Post announcements".
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson } = require("./helpers");

let desk, admin, ada, rex;
const HOUR = 3600 * 1000;
const showingFor = async (person) => (await person.get("/api/bootstrap")).body.announcements;

before(async () => {
  desk = await startLighthouse();
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician" });
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
});
after(() => desk.stop());

test("an admin's announcement reaches everyone, red ones first", async () => {
  const advisory = await admin.post("/api/announcements", { severity: "advisory", title: "Core switch maintenance tonight", message: "22:00 to 23:00. Expect a short blip." });
  assert.equal(advisory.status, 201);
  assert.equal(advisory.body.announcement.state, "live");
  await admin.post("/api/announcements", { severity: "action", title: "Evacuate row 14: coolant leak" });
  const forRex = await showingFor(rex);
  assert.deepEqual(forRex.map((a) => a.severity), ["action", "advisory"], "action required is listed first");
  assert.equal(forRex[1].message, "22:00 to 23:00. Expect a short blip.");
  assert.deepEqual((await ada.get("/api/announcements")).body.announcements.map((a) => a.title), forRex.map((a) => a.title));
});

test("only people with Post announcements can post, change or remove them", async () => {
  assert.equal((await ada.post("/api/announcements", { severity: "action", title: "Not allowed" })).status, 403);
  assert.equal((await rex.get("/api/announcements/manage")).status, 403);
  const technician = (await admin.get("/api/access-levels")).body.levels.find((l) => l.name === "Technician");
  await admin.patch(`/api/access-levels/${technician.id}`, { permissions: [...technician.permissions, "announcements.manage"] });
  assert.equal((await ada.post("/api/announcements", { severity: "advisory", title: "Shift lead can post" })).status, 201);
  await admin.patch(`/api/access-levels/${technician.id}`, { permissions: technician.permissions });
});

test("input is checked: a known kind, a title, and an end after the start", async () => {
  assert.equal((await admin.post("/api/announcements", { severity: "purple", title: "x" })).status, 400);
  assert.equal((await admin.post("/api/announcements", { severity: "advisory", title: "  " })).status, 400);
  const now = Date.now();
  assert.equal((await admin.post("/api/announcements", { severity: "advisory", title: "x", startsAt: now, endsAt: now - HOUR })).status, 400);
});

test("scheduled announcements wait for their start, and ended ones disappear", async () => {
  const later = await admin.post("/api/announcements", { severity: "advisory", title: "Generator test Saturday", startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR });
  assert.equal(later.body.announcement.state, "scheduled");
  assert.ok(!(await showingFor(rex)).some((a) => a.title === "Generator test Saturday"));

  const red = (await showingFor(rex)).find((a) => a.severity === "action");
  const ended = await admin.patch(`/api/announcements/${red.id}`, { end: true });
  assert.equal(ended.body.announcement.state, "ended");
  assert.ok(!(await showingFor(rex)).some((a) => a.id === red.id));
  const all = (await admin.get("/api/announcements/manage")).body.announcements;
  assert.ok(all.some((a) => a.id === red.id && a.state === "ended"), "ended ones stay listed for admins");
});

test("editing and deleting", async () => {
  const live = (await showingFor(rex)).find((a) => a.title === "Core switch maintenance tonight");
  const edited = await admin.patch(`/api/announcements/${live.id}`, { severity: "action", title: "Core switch maintenance NOW" });
  assert.equal(edited.body.announcement.severity, "action");
  assert.ok(edited.body.announcement.updatedAt >= live.updatedAt, "a change gets a new version, so a hidden advisory shows again");
  assert.equal((await admin.delete(`/api/announcements/${live.id}`)).status, 200);
  assert.ok(!(await showingFor(rex)).some((a) => a.id === live.id));
});

test("no more than five show at once", async () => {
  for (const current of await showingFor(admin)) await admin.patch(`/api/announcements/${current.id}`, { end: true });
  for (let i = 1; i <= 5; i++) assert.equal((await admin.post("/api/announcements", { severity: "advisory", title: `Notice ${i}` })).status, 201);
  const sixth = await admin.post("/api/announcements", { severity: "advisory", title: "Notice 6" });
  assert.equal(sixth.status, 400);
  assert.match(sixth.body.error, /Up to 5/);
});
