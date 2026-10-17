// Requesters keeping sight of their tickets, SLA targets edited in the app, and profile photos.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson } = require("./helpers");

let desk, admin, ada, ben, rex;
const levelNamed = async (name) => (await admin.get("/api/access-levels")).body.levels.find((l) => l.name === name);

before(async () => {
  desk = await startLighthouse();
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician" });
  ben = await addPerson(admin, { name: "Ben Tech", username: "ben", accessLevelName: "Technician" });
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
});
after(() => desk.stop());

// ---------- requesters ----------
test("people always see the tickets they raised, even after their level loses every permission", async () => {
  const ticketId = (await rex.post("/api/tickets", { title: "Monitor flickering" })).body.ticket.id;
  const requester = await levelNamed("Requester");
  await admin.patch(`/api/access-levels/${requester.id}`, { permissions: [] });
  try {
    assert.ok((await rex.get("/api/tickets")).body.tickets.some((t) => t.id === ticketId));
    assert.equal((await rex.get(`/api/tickets/${ticketId}`)).status, 200);
    assert.equal((await rex.post(`/api/tickets/${ticketId}/comments`, { text: "Still flickering" })).status, 201, "and can still reply");
  } finally {
    await admin.patch(`/api/access-levels/${requester.id}`, { permissions: ["tickets.create"] });
  }
});

// ---------- SLA targets ----------
test("SLA targets need their own permission, are checked, and show up for everyone straight away", async () => {
  const newTargets = { P1: 2, P2: 12, P3: 48, P4: 120 };
  assert.equal((await ada.put("/api/settings/sla", { slaHours: newTargets })).status, 403);
  assert.equal((await admin.put("/api/settings/sla", { slaHours: { ...newTargets, P1: 0 } })).status, 400, "zero hours refused");
  assert.equal((await admin.put("/api/settings/sla", { slaHours: { ...newTargets, P2: 1.5 } })).status, 400, "whole hours only");
  assert.equal((await admin.put("/api/settings/sla", { slaHours: newTargets })).status, 200);
  assert.deepEqual((await rex.get("/api/bootstrap")).body.constants.SLA_HOURS, newTargets);

  const technician = await levelNamed("Technician");
  await admin.patch(`/api/access-levels/${technician.id}`, { permissions: [...technician.permissions, "sla.manage"] });
  assert.equal((await ada.put("/api/settings/sla", { slaHours: { ...newTargets, P1: 3 } })).status, 200, "granted through the access level");
  await admin.patch(`/api/access-levels/${technician.id}`, { permissions: technician.permissions });
});

// ---------- photos ----------
// A tiny but well-formed JPEG carrying metadata that must not survive the upload.
function jpegWithMetadata() {
  const segment = (marker, payload) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.from("Exif\0\0GPS-SECRET-LOCATION", "latin1")),
    segment(0xfe, Buffer.from("comment-secret", "latin1")),
    segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])),
    segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}
const asDataUrl = (bytes, type = "image/jpeg") => `data:${type};base64,${bytes.toString("base64")}`;
async function fetchPhoto(person, userId) {
  const response = await fetch(`${desk.baseUrl}/api/users/${userId}/photo`, { headers: { Cookie: person.cookie } });
  return { status: response.status, type: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
}

test("a technician's photo is stored without its hidden metadata", async () => {
  const saved = await ada.put("/api/me/photo", { image: asDataUrl(jpegWithMetadata()) });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.photoVersion);
  const photo = await fetchPhoto(ben, ada.id);
  assert.equal(photo.status, 200);
  assert.equal(photo.type, "image/jpeg");
  assert.ok(!photo.bytes.includes("GPS-SECRET"), "EXIF / GPS removed");
  assert.ok(!photo.bytes.includes("comment-secret"), "comments removed");
  assert.ok(photo.bytes.includes(Buffer.from([0xff, 0xd9])), "image data kept");
  const adaInDirectory = (await ben.get("/api/bootstrap")).body.users.find((u) => u.id === ada.id);
  assert.equal(adaInDirectory.photoVersion, saved.body.photoVersion);
});

test("only real JPEG photos of a sensible size are accepted", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await ben.put("/api/me/photo", { image: asDataUrl(png, "image/png") })).status, 400);
  assert.equal((await ben.put("/api/me/photo", { image: "not base64 at all!" })).status, 400);
  assert.equal((await ben.put("/api/me/photo", { image: asDataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xd9])) })).status, 400, "a JPEG header with no picture in it");
});

test("the person who raised a ticket sees the photo of whoever is working it, and nobody else's", async () => {
  const ticketId = (await rex.post("/api/tickets", { title: "Keyboard missing keys" })).body.ticket.id;
  assert.equal((await fetchPhoto(rex, ada.id)).status, 404, "not before Ada is on the ticket");
  await ada.patch(`/api/tickets/${ticketId}`, { assigneeId: ada.id });
  assert.equal((await fetchPhoto(rex, ada.id)).status, 200);
  const rexSees = (await rex.get("/api/bootstrap")).body.users.find((u) => u.id === ada.id);
  assert.ok(rexSees.photoVersion, "the requester's directory carries the photo version");
});

test("photos of other people can only be changed by account managers, within their reach", async () => {
  const photo = asDataUrl(jpegWithMetadata());
  assert.equal((await ben.put(`/api/users/${ada.id}/photo`, { image: photo })).status, 403);
  assert.equal((await admin.put(`/api/users/${ben.id}/photo`, { image: photo })).status, 200);
  assert.equal((await admin.delete(`/api/users/${ada.id}/photo`)).status, 200);
  assert.equal((await fetchPhoto(ben, ada.id)).status, 404);
  assert.equal((await ben.delete("/api/me/photo")).status, 200);
});
