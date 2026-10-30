// Website intake (lib/intake.js): the private listener the windpoint.net form handler uses to raise tickets
// for people without an account. Checks it stays off the desk's port, needs its token, validates what it's
// given, routes by request type, takes print files, and is capped per hour.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson, TEST_INTAKE_TOKEN } = require("./helpers");
const { MAX_INTAKE_FILE_BYTES, MAX_INTAKE_FILES_PER_REQUEST, RATE_LIMITS } = require("../lib/constants");

let desk, admin, rex, printGroupId, itGroupId;

async function intake(urlPath, { json, body, headers = {}, token = TEST_INTAKE_TOKEN } = {}) {
  const response = await fetch(desk.intakeUrl + urlPath, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const sendRequest = (json) => intake("/intake/requests", { json });
const sendFile = (ticketId, fileName, bytes) => intake(`/intake/requests/${ticketId}/files`, { body: bytes, headers: { "X-File-Name": fileName, "Content-Type": "application/octet-stream" } });

const PRINT = { type: "print", name: "Ada Lovelace", email: "ada@example.com", details: "Bracket for a shelf\nTwo of them, please", material: "PETG", quantity: 2, link: "https://www.printables.com/model/123", neededBy: "2026-11-20" };
const IT_JOB = { type: "it", name: "Ben Ops", email: "ben@example.com", details: "Wi-Fi drops in the back office", location: "Valparaiso, IN" };

before(async () => {
  desk = await startLighthouse({ withIntake: true });
  admin = await setUpDesk(desk.baseUrl);
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
  printGroupId = (await admin.post("/api/groups", { name: "3D Printing" })).body.id;
  itGroupId = (await admin.post("/api/groups", { name: "IT Jobs" })).body.id;
});
after(() => desk.stop());

test("the intake listener is separate: the desk's own port doesn't answer intake requests", async () => {
  assert.ok(desk.intakeUrl && desk.intakeUrl !== desk.baseUrl);
  const onDeskPort = await fetch(desk.baseUrl + "/intake/requests", { method: "POST", headers: { Authorization: `Bearer ${TEST_INTAKE_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(PRINT) });
  assert.equal(onDeskPort.status, 405, "the desk serves only its web app outside /api, and never accepts a POST there");
  assert.equal((await admin.get("/api/tickets")).body.tickets.length, 0);
});

test("every intake request needs the token; only the health check doesn't", async () => {
  assert.equal((await intake("/intake/requests", { json: PRINT, token: null })).status, 401);
  assert.equal((await intake("/intake/requests", { json: PRINT, token: "wrong-token-wrong-token-wrong-token" })).status, 401);
  assert.equal((await fetch(desk.intakeUrl + "/healthz")).status, 200);
  assert.equal((await admin.get("/api/tickets")).body.tickets.length, 0, "nothing was created");
});

test("a 3D print request becomes a routed, tagged ticket with the person's details", async () => {
  const sent = await sendRequest(PRINT);
  assert.equal(sent.status, 201);
  assert.match(sent.body.reference, /^TKT-\d+$/);
  const { ticket, websiteRequester } = (await admin.get(`/api/tickets/${sent.body.ticketId}`)).body;
  assert.equal(ticket.title, "3D print: Bracket for a shelf");
  assert.equal(ticket.groupId, printGroupId);
  assert.equal(ticket.category, "Request");
  assert.equal(ticket.status, "New");
  assert.equal(ticket.requesterId, null, "no account is created for the person");
  assert.deepEqual([...ticket.tags].sort(), ["3d-print", "website"]);
  for (const part of ["Ada Lovelace <ada@example.com>", "Material: PETG · Quantity: 2", "https://www.printables.com/model/123", "Needed by: 2026-11-20", "Two of them, please"]) {
    assert.ok(ticket.description.includes(part), `description includes ${part}`);
  }
  assert.deepEqual(websiteRequester, { name: "Ada Lovelace", email: "ada@example.com", type: "print" });
  assert.equal((await rex.get(`/api/tickets/${sent.body.ticketId}`)).status, 404, "people who only see their own tickets can't see it");
});

test("an IT job needs a location and routes to the IT group", async () => {
  const { location, ...withoutLocation } = IT_JOB;
  assert.equal((await sendRequest(withoutLocation)).status, 400);
  const sent = await sendRequest(IT_JOB);
  assert.equal(sent.status, 201);
  const { ticket } = (await admin.get(`/api/tickets/${sent.body.ticketId}`)).body;
  assert.equal(ticket.groupId, itGroupId);
  assert.ok(ticket.description.includes(`Location: ${location}`));
  assert.ok(ticket.tags.includes("it-job"));
});

test("bad input is refused with a reason", async () => {
  const cases = [
    [{ ...PRINT, type: "laser" }, /Type/],
    [{ ...PRINT, name: "" }, /Name/],
    [{ ...PRINT, email: "not-an-email" }, /Email/],
    [{ ...PRINT, details: "   " }, /Details/],
    [{ ...PRINT, material: "ABS" }, /Material/],
    [{ ...PRINT, quantity: 0 }, /Quantity/],
    [{ ...PRINT, quantity: 2.5 }, /Quantity/],
    [{ ...PRINT, link: "javascript:alert(1)" }, /Link/],
    [{ ...PRINT, neededBy: "2026-02-30" }, /Needed by/],
  ];
  for (const [json, reason] of cases) {
    const result = await sendRequest(json);
    assert.equal(result.status, 400, JSON.stringify(json));
    assert.match(result.body.error, reason);
  }
});

test("print files attach to website requests only, with type, size and count limits", async () => {
  const ticketId = (await sendRequest(PRINT)).body.ticketId;
  const model = Buffer.from("solid bracket\nendsolid bracket\n");
  const added = await sendFile(ticketId, "bracket.STL", model);
  assert.equal(added.status, 201);
  assert.deepEqual(added.body, { fileName: "bracket.STL", sizeBytes: model.length });
  const files = (await admin.get(`/api/tickets/${ticketId}`)).body.attachments;
  assert.deepEqual(files.map((f) => f.fileName), ["bracket.STL"]);
  assert.equal(files[0].uploadedBy, null);

  assert.equal((await sendFile(ticketId, "setup.exe", model)).status, 400, "only model files");
  assert.equal((await sendFile(ticketId, "../../bracket.3mf", model)).body.fileName, "bracket.3mf", "folders are stripped from names");
  assert.equal((await sendFile(ticketId, "huge.stl", Buffer.alloc(MAX_INTAKE_FILE_BYTES + 1))).status, 413);
  for (let n = files.length + 1; n < MAX_INTAKE_FILES_PER_REQUEST; n++) assert.equal((await sendFile(ticketId, `part-${n}.step`, model)).status, 201);
  assert.equal((await sendFile(ticketId, "one-too-many.stl", model)).status, 400);

  const staffTicket = (await admin.post("/api/tickets", { title: "Not from the website" })).body.ticket.id;
  assert.equal((await sendFile(staffTicket, "bracket.stl", model)).status, 404, "desk tickets can't be reached through intake");
});

test("files can't be added once the request has been closed", async () => {
  const ticketId = (await sendRequest(PRINT)).body.ticketId;
  await admin.patch(`/api/tickets/${ticketId}`, { status: "Closed" });
  assert.equal((await sendFile(ticketId, "late.stl", Buffer.from("solid x"))).status, 403);
});

test("website requests are capped per hour, desk-wide", async () => {
  let status;
  for (let i = 0; i <= RATE_LIMITS.intakeRequests.max; i++) {
    status = (await sendRequest(IT_JOB)).status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
});
