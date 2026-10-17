// Accounts, sign-in, access levels and the rules that stop anyone handing out more power than they hold.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson, Person, TEST_SETUP_CODE } = require("./helpers");

let desk, admin;
before(async () => { desk = await startLighthouse(); });
after(() => desk.stop());

test("first-run setup needs the setup code and creates an Administrator who signs in with a username", async () => {
  const stranger = new Person(desk.baseUrl);
  const withoutCode = await stranger.post("/api/setup", { name: "Mallory", username: "mallory", password: "not-the-admin-1" });
  assert.equal(withoutCode.status, 403);

  admin = await setUpDesk(desk.baseUrl);
  const me = (await admin.get("/api/bootstrap")).body.me;
  assert.equal(me.username, "nick");
  assert.equal(me.isAdministrator, true);
  assert.ok(me.permissions.includes("access.manage"), "Administrator has the admin-only permission");

  const again = await stranger.post("/api/setup", { setupCode: TEST_SETUP_CODE, name: "Mallory", username: "mallory", password: "not-the-admin-1" });
  assert.equal(again.status, 409, "setup can only happen once");
});

test("sign-in uses the username (any capitalisation) and a wrong password gives one generic message", async () => {
  await new Person(desk.baseUrl).signIn("NICK", "admin-password-1");
  const wrong = await new Person(desk.baseUrl).post("/api/login", { username: "nick", password: "wrong-password" });
  const unknown = await new Person(desk.baseUrl).post("/api/login", { username: "nobody", password: "wrong-password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, unknown.body.error, "unknown usernames and wrong passwords look the same");
});

test("new accounts get a server-generated temporary password and must change it", async () => {
  const levels = (await admin.get("/api/access-levels")).body.levels;
  const requester = levels.find((l) => l.name === "Requester");
  const created = await admin.post("/api/users", { name: "Rex Requester", username: "rex", accessLevelId: requester.id });
  assert.equal(created.status, 201);
  assert.ok(created.body.temporaryPassword.length >= 10);
  assert.equal(created.body.user.mustChangePassword, true);
  assert.equal(created.body.user.email, null, "email is optional");

  const rex = await new Person(desk.baseUrl).signIn("rex", created.body.temporaryPassword);
  assert.equal((await rex.get("/api/bootstrap")).body.me.mustChangePassword, true);
  assert.equal((await rex.post("/api/me/password", { current: created.body.temporaryPassword, next: "rex-password-1" })).status, 200);
});

test("usernames are checked: allowed characters, length, and no duplicates", async () => {
  const levelId = (await admin.get("/api/access-levels")).body.levels.find((l) => l.name === "Requester").id;
  assert.equal((await admin.post("/api/users", { name: "Bad", username: "has spaces", accessLevelId: levelId })).status, 400);
  assert.equal((await admin.post("/api/users", { name: "Short", username: "ab", accessLevelId: levelId })).status, 400);
  assert.equal((await admin.post("/api/users", { name: "Dup", username: "REX", accessLevelId: levelId })).status, 409);
});

test("admins create access levels from the permission list; unknown permissions are ignored", async () => {
  const created = await admin.post("/api/access-levels", { name: "Dispatcher", description: "Routes tickets", permissions: ["tickets.view_all", "tickets.assign", "users.manage", "made.up.permission", "access.manage"] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.level.permissions.sort(), ["tickets.assign", "tickets.view_all", "users.manage"], "admin-only and unknown permissions are dropped");
  const duplicate = await admin.post("/api/access-levels", { name: "dispatcher", permissions: [] });
  assert.equal(duplicate.status, 409);
});

test("the Administrator level cannot be edited or deleted", async () => {
  const adminLevel = (await admin.get("/api/access-levels")).body.levels.find((l) => l.isAdministrator);
  assert.equal((await admin.patch(`/api/access-levels/${adminLevel.id}`, { permissions: [] })).status, 400);
  assert.equal((await admin.delete(`/api/access-levels/${adminLevel.id}`)).status, 400);
});

test("someone who manages accounts cannot give out more than they have", async () => {
  const dispatcher = await addPerson(admin, { name: "Dana Dispatcher", username: "dana", accessLevelName: "Dispatcher" });
  const levels = (await dispatcher.get("/api/access-levels")).body.levels;
  const byName = (name) => levels.find((l) => l.name === name).id;

  assert.equal((await dispatcher.post("/api/access-levels", { name: "Sneaky", permissions: ["tickets.delete"] })).status, 403, "only Administrators edit access levels");
  assert.equal((await dispatcher.post("/api/users", { name: "Eve", username: "eve", accessLevelId: byName("Administrator") })).status, 403, "cannot create an Administrator");
  assert.equal((await dispatcher.post("/api/users", { name: "Eve", username: "eve", accessLevelId: byName("Technician") })).status, 403, "Technician has permissions Dana lacks");
  assert.equal((await dispatcher.post("/api/users", { name: "Rita", username: "rita", accessLevelId: byName("Requester") })).status, 403, "Requester has tickets.create, which Dana lacks");

  await admin.patch(`/api/access-levels/${byName("Dispatcher")}`, { permissions: ["tickets.view_all", "tickets.assign", "users.manage", "tickets.create"] });
  assert.equal((await dispatcher.post("/api/users", { name: "Rita", username: "rita", accessLevelId: byName("Requester") })).status, 201, "now Dana holds everything Requester has");

  const nick = (await admin.get("/api/bootstrap")).body.me;
  assert.equal((await dispatcher.post(`/api/users/${nick.id}/reset-password`)).status, 403, "cannot reset an Administrator's password");
  assert.equal((await dispatcher.patch(`/api/users/${dispatcher.id}`, { accessLevelId: byName("Administrator") })).status, 400, "cannot change own level");
});

test("Administrators can move another admin to a different level, but can never deactivate themselves", async () => {
  const levels = (await admin.get("/api/access-levels")).body.levels;
  const nickId = (await admin.get("/api/bootstrap")).body.me.id;
  const second = await addPerson(admin, { name: "Second Admin", username: "second", accessLevelName: "Administrator" });
  // Nick moves Second away from Administrator: fine, because Nick is still an Administrator.
  assert.equal((await admin.patch(`/api/users/${second.id}`, { accessLevelId: levels.find((l) => l.name === "Technician").id })).status, 200);
  // Nick can't deactivate himself. (The server also refuses to remove the last active Administrator by any route.)
  assert.equal((await admin.patch(`/api/users/${nickId}`, { active: false })).status, 400);
});

test("an access level in use cannot be deleted until its people are moved", async () => {
  const levels = (await admin.get("/api/access-levels")).body.levels;
  const requester = levels.find((l) => l.name === "Requester");
  const deleteAttempt = await admin.delete(`/api/access-levels/${requester.id}`);
  assert.equal(deleteAttempt.status, 409);
  assert.match(deleteAttempt.body.error, /Move them to another level/);
  const unused = await admin.post("/api/access-levels", { name: "Temporary", permissions: [] });
  assert.equal((await admin.delete(`/api/access-levels/${unused.body.level.id}`)).status, 200);
});

test("deactivating someone signs them out everywhere", async () => {
  const tess = await addPerson(admin, { name: "Tess Tech", username: "tess", accessLevelName: "Technician" });
  assert.equal((await tess.get("/api/bootstrap")).status, 200);
  await admin.patch(`/api/users/${tess.id}`, { active: false });
  assert.equal((await tess.get("/api/bootstrap")).status, 401);
  assert.equal((await new Person(desk.baseUrl).post("/api/login", { username: "tess", password: "tess-password-1" })).status, 401);
});

test("each person's theme choice is saved on their account", async () => {
  assert.equal((await admin.get("/api/bootstrap")).body.me.theme, "system", "default follows the device");
  assert.equal((await admin.put("/api/me/theme", { theme: "dark" })).status, 200);
  assert.equal((await admin.get("/api/bootstrap")).body.me.theme, "dark");
  assert.equal((await admin.put("/api/me/theme", { theme: "purple" })).status, 400);
});

test("people who only raise tickets do not get the staff directory", async () => {
  const rex = await new Person(desk.baseUrl).signIn("rex", "rex-password-1");
  const directory = (await rex.get("/api/bootstrap")).body.users;
  assert.deepEqual(directory.map((u) => u.name), ["Rex Requester"]);
  assert.equal(directory[0].username, undefined, "usernames are only shown to account managers");
});
