// New in 1.5: grouped categories, tags, links between tickets and to projects, and attached files.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startLighthouse, setUpDesk, addPerson } = require("./helpers");

let desk, admin, ada, rex, rita, rexTicket, adaTicket, ritaTicket;
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

async function upload(person, ticketId, bytes, { name = "file.bin", type = "application/octet-stream" } = {}) {
  const response = await fetch(`${desk.baseUrl}/api/tickets/${ticketId}/attachments`, {
    method: "POST", body: bytes,
    headers: { Cookie: person.cookie, "X-Lighthouse": "1", "X-File-Name": encodeURIComponent(name), "Content-Type": type },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
async function download(person, attachmentId, query = "") {
  const response = await fetch(`${desk.baseUrl}/api/attachments/${attachmentId}${query}`, { headers: { Cookie: person.cookie } });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

before(async () => {
  desk = await startLighthouse();
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician" });
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
  rita = await addPerson(admin, { name: "Rita Requester", username: "rita", accessLevelName: "Requester" });
  rexTicket = (await rex.post("/api/tickets", { title: "Leak under sink in break room", category: "Plumbing", tags: ["Break Room", "#Leak"] })).body.ticket;
  adaTicket = (await ada.post("/api/tickets", { title: "Water damage on floor tiles", category: "Facilities: Other" })).body.ticket;
  ritaTicket = (await rita.post("/api/tickets", { title: "Can't sign in to the wiki", category: "Login Issue" })).body.ticket;
});
after(() => desk.stop());

// ---------- categories ----------
test("the Tech and Facilities categories are offered, grouped, and accepted", async () => {
  const groups = (await rex.get("/api/bootstrap")).body.constants.CATEGORY_GROUPS;
  assert.deepEqual(groups.find((g) => g.group.startsWith("Tech")).categories, ["Login Issue", "Site Improvement", "Feature Request", "Software Issue"]);
  assert.deepEqual(groups.find((g) => g.group === "Facilities").categories,
    ["Plumbing", "Stock", "Electrical", "Carpentry", "Capital Expenditure", "Procurement", "Property Maintenance", "Facilities: Other"]);
  assert.equal(rexTicket.category, "Plumbing");
  assert.equal(adaTicket.category, "Facilities: Other");
  assert.equal(ritaTicket.category, "Login Issue");
  assert.equal((await ada.patch(`/api/tickets/${rexTicket.id}`, { category: "Capital Expenditure" })).status, 200);
});

// ---------- tags ----------
test("tags are cleaned up, listed with tickets, and only people who work tickets can change them later", async () => {
  assert.deepEqual(rexTicket.tags, ["break-room", "leak"], "lower case, spaces become dashes, # dropped");
  assert.equal((await rex.post("/api/tickets", { title: "x", tags: ["no/slashes"] })).status, 400);
  assert.equal((await rex.put(`/api/tickets/${rexTicket.id}/tags`, { tags: ["urgent"] })).status, 403);
  const saved = await ada.put(`/api/tickets/${rexTicket.id}/tags`, { tags: ["leak", "Plumbing", "leak"] });
  assert.deepEqual(saved.body.tags, ["leak", "plumbing"]);
  assert.deepEqual((await ada.get("/api/tickets")).body.tickets.find((t) => t.id === rexTicket.id).tags, ["leak", "plumbing"]);
  const history = (await ada.get(`/api/tickets/${rexTicket.id}`)).body.activity.find((a) => a.field === "tags");
  assert.equal(history.from, "break-room, leak");
});

test("tag suggestions only include tags on tickets the person can see", async () => {
  await ada.put(`/api/tickets/${ritaTicket.id}/tags`, { tags: ["sso"] });
  const forAda = (await ada.get("/api/tags")).body.tags.map((t) => t.tag);
  const forRex = (await rex.get("/api/tags")).body.tags.map((t) => t.tag);
  assert.ok(forAda.includes("sso") && forAda.includes("plumbing"));
  assert.ok(!forRex.includes("sso"), "Rex never sees tags from Rita's ticket");
});

// ---------- links between tickets ----------
test("tickets link to each other, and each side reads the right way round", async () => {
  const linked = await ada.post(`/api/tickets/${adaTicket.id}/links`, { ticket: `TKT-${rexTicket.id}`, relation: "blocked-by" });
  assert.equal(linked.status, 201);
  assert.equal(linked.body.linkedTickets[0].relation, "blocked-by");
  const fromOtherSide = (await ada.get(`/api/tickets/${rexTicket.id}`)).body.linkedTickets;
  assert.deepEqual(fromOtherSide.map((l) => [l.ticket.id, l.relation]), [[adaTicket.id, "blocks"]]);
  assert.equal((await ada.post(`/api/tickets/${rexTicket.id}/links`, { ticket: adaTicket.id, relation: "related" })).status, 409, "one link per pair");
  assert.equal((await ada.post(`/api/tickets/${rexTicket.id}/links`, { ticket: rexTicket.id })).status, 400, "not to itself");
  assert.equal((await ada.post(`/api/tickets/${rexTicket.id}/links`, { ticket: "TKT-99999" })).status, 400);
  assert.equal((await rex.post(`/api/tickets/${rexTicket.id}/links`, { ticket: ritaTicket.id })).status, 403, "requesters can't link");
});

test("a link never reveals a ticket the viewer can't see", async () => {
  await ada.post(`/api/tickets/${rexTicket.id}/links`, { ticket: ritaTicket.id, relation: "related" });
  const rexSees = (await rex.get(`/api/tickets/${rexTicket.id}`)).body.linkedTickets;
  assert.deepEqual(rexSees, [], "Rex can't see Ada's or Rita's tickets, so no links show");
  const adaSees = (await ada.get(`/api/tickets/${rexTicket.id}`)).body.linkedTickets;
  assert.equal(adaSees.length, 2);
  const removed = await ada.delete(`/api/tickets/${rexTicket.id}/links/${adaSees.find((l) => l.ticket.id === ritaTicket.id).linkId}`);
  assert.equal(removed.body.linkedTickets.length, 1);
});

// ---------- links to projects ----------
test("tickets link to projects, and the project lists them", async () => {
  const projectId = (await ada.post("/api/projects", { name: "Break room refit" })).body.id;
  assert.equal((await ada.post(`/api/tickets/${rexTicket.id}/projects`, { projectId })).status, 201);
  assert.equal((await ada.post(`/api/tickets/${rexTicket.id}/projects`, { projectId })).status, 409);
  assert.deepEqual((await ada.get(`/api/tickets/${rexTicket.id}`)).body.linkedProjects.map((p) => p.name), ["Break room refit"]);
  assert.deepEqual((await ada.get(`/api/projects/${projectId}`)).body.linkedTickets.map((t) => t.id), [rexTicket.id]);
  assert.deepEqual((await rex.get(`/api/tickets/${rexTicket.id}`)).body.linkedProjects, [], "requesters don't see projects");
  assert.equal((await rex.post(`/api/tickets/${rexTicket.id}/projects`, { projectId })).status, 403);
  assert.equal((await ada.delete(`/api/tickets/${rexTicket.id}/projects/${projectId}`)).status, 200);
});

// ---------- attached files ----------
test("the person who raised a ticket can attach a photo; pictures show in the page, other files download", async () => {
  const photo = await upload(rex, rexTicket.id, PNG_BYTES, { name: "leak photo.png", type: "image/png" });
  assert.equal(photo.status, 201);
  assert.equal(photo.body.attachment.fileName, "leak photo.png");
  const shown = await download(ada, photo.body.attachment.id);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.match(shown.headers.get("content-disposition"), /^inline/);
  assert.ok(shown.bytes.equals(PNG_BYTES));
  assert.match(shown.headers.get("content-security-policy"), /sandbox/);

  const disguised = await upload(rex, rexTicket.id, Buffer.from("<script>alert(1)</script>"), { name: "not-really.png", type: "image/png" });
  const served = await download(rex, disguised.body.attachment.id);
  assert.equal(served.headers.get("content-type"), "application/octet-stream", "type comes from the file's bytes, not the claim");
  assert.match(served.headers.get("content-disposition"), /^attachment/);
});

test("files are private to people who can see the ticket, and file names can't reach other folders", async () => {
  const sneaky = await upload(rex, rexTicket.id, Buffer.from("log line\n"), { name: "../../etc/passwd" });
  assert.equal(sneaky.body.attachment.fileName, "passwd");
  assert.equal((await download(rita, sneaky.body.attachment.id)).status, 404, "Rita can't see Rex's ticket");
  assert.equal((await upload(rita, rexTicket.id, Buffer.from("x"))).status, 404);
  assert.equal((await rita.delete(`/api/attachments/${sneaky.body.attachment.id}`)).status, 404);
});

test("files over the size limit are refused", async () => {
  const { MAX_ATTACHMENT_BYTES } = require("../lib/constants");
  assert.equal((await upload(rex, rexTicket.id, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).status, 413);
  assert.equal((await upload(rex, rexTicket.id, Buffer.alloc(0))).status, 400, "empty files too");
});

test("removing a file or deleting the ticket removes the file from disk", async () => {
  const filesOnDisk = () => fs.readdirSync(path.join(desk.dataDir, "attachments")).length;
  const before = filesOnDisk();
  const file = (await upload(ada, adaTicket.id, Buffer.from("quote.pdf contents"), { name: "quote.pdf" })).body.attachment;
  assert.equal(filesOnDisk(), before + 1);
  assert.equal((await rex.delete(`/api/attachments/${file.id}`)).status, 404, "Rex can't see Ada's ticket");
  assert.equal((await ada.delete(`/api/attachments/${file.id}`)).status, 200);
  assert.equal(filesOnDisk(), before);

  const doomed = (await rex.post("/api/tickets", { title: "Ticket to delete" })).body.ticket;
  await upload(rex, doomed.id, Buffer.from("temporary"));
  assert.equal(filesOnDisk(), before + 1);
  assert.equal((await admin.delete(`/api/tickets/${doomed.id}`)).status, 200);
  assert.equal(filesOnDisk(), before);
});
