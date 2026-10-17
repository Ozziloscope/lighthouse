// Email and text alerts, end to end, against a fake mail server (real STARTTLS + password) and a fake Twilio.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson, readMail, settle, PHONE_TWILIO_REJECTS, EMAIL_SMTP_REJECTS } = require("./helpers");

const PUBLIC_URL = "https://desk.example.com";
let desk, admin, ada, ben, rex, groupId;
const mails = () => desk.mail.messages.map(readMail);
const texts = () => desk.twilio.texts;
const codeIn = (text) => /\b(\d{6})\b/.exec(text)[1];

before(async () => {
  desk = await startLighthouse({ withAlerts: true, publicUrl: PUBLIC_URL });
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician", email: "ada@example.com" });
  ben = await addPerson(admin, { name: "Ben Tech", username: "ben", accessLevelName: "Technician", email: "ben@example.com" });
  rex = await addPerson(admin, { name: "Rex Requester", username: "rex", accessLevelName: "Requester" });
  groupId = (await admin.post("/api/groups", { name: "Hardware Break/Fix" })).body.id;
  await ada.post(`/api/groups/${groupId}/members`, { userId: ada.id });
  await ben.post(`/api/groups/${groupId}/members`, { userId: ben.id });
});
after(() => desk.stop());

test("people only see alert options their access level allows", async () => {
  const technicianOptions = (await ada.get("/api/alerts/me")).body.events.map((e) => e.key);
  const requesterOptions = (await rex.get("/api/alerts/me")).body.events.map((e) => e.key);
  assert.equal(technicianOptions.length, 10);
  assert.deepEqual(requesterOptions, ["ticket_requester_update"]);
});

test("a phone number is only saved after the texted code is entered", async () => {
  const start = await ada.post("/api/alerts/me/verify/start", { channel: "sms", target: "(317) 555-0101" });
  assert.equal(start.status, 200);
  await settle();
  assert.equal(texts().at(-1).to, "+13175550101", "number is normalised to international form");
  const wrong = await ada.post("/api/alerts/me/verify/confirm", { channel: "sms", code: codeIn(texts().at(-1).body) === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /tries left/);
  const right = await ada.post("/api/alerts/me/verify/confirm", { channel: "sms", code: codeIn(texts().at(-1).body) });
  assert.equal(right.body.contact.phone, "+13175550101");
});

test("someone with no email on their account can add and confirm one", async () => {
  await rex.post("/api/alerts/me/verify/start", { channel: "email", target: "Rex.Alerts@example.com" });
  await settle();
  const codeMail = mails().at(-1);
  assert.equal(codeMail.to, "rex.alerts@example.com");
  assert.equal(codeMail.encrypted, true, "sent over STARTTLS");
  const confirmed = await rex.post("/api/alerts/me/verify/confirm", { channel: "email", code: codeIn(codeMail.text) });
  assert.equal(confirmed.body.contact.emailTo, "rex.alerts@example.com");
});

test("bad addresses and refusals from the mail server or Twilio come back as clear errors", async () => {
  assert.equal((await ada.post("/api/alerts/me/verify/start", { channel: "email", target: "a@b.com\r\nBcc: evil@x.io" })).status, 400, "header injection refused");
  const bounce = await admin.post("/api/alerts/me/verify/start", { channel: "email", target: EMAIL_SMTP_REJECTS });
  assert.equal(bounce.status, 502);
  assert.match(bounce.body.error, /rejected the recipient/);
  const badNumber = await ben.post("/api/alerts/me/verify/start", { channel: "sms", target: PHONE_TWILIO_REJECTS });
  assert.equal(badNumber.status, 502);
  assert.match(badNumber.body.error, /21211/);
});

test("a new P2 in a group emails the group and texts people who asked for texts", async () => {
  await ada.put("/api/alerts/me/prefs", { prefs: { ticket_new_group: { email: true, sms: true, minPriority: "P2" } } });
  const mailsBefore = mails().length, textsBefore = texts().length;
  await rex.post("/api/tickets", { title: "PSU2 amber fault LED", priority: "P2", groupId });
  await settle();
  const newMails = mails().slice(mailsBefore);
  assert.deepEqual(newMails.map((m) => m.to).sort(), ["ada@example.com", "ben@example.com"]);
  assert.match(newMails[0].subject, /^\[Lighthouse\] New P2 ticket TKT-1001/);
  assert.ok(newMails[0].text.includes(`${PUBLIC_URL}/#ticket-1001`), "email links straight to the ticket");
  assert.deepEqual(texts().slice(textsBefore).map((t) => t.to), ["+13175550101"]);
});

test("tickets below someone's priority filter don't alert them", async () => {
  const mailsBefore = mails().length;
  await rex.post("/api/tickets", { title: "Label printer out of tape", priority: "P4", groupId });
  await settle();
  assert.equal(mails().length, mailsBefore);
});

test("the requester hears public replies but never internal notes", async () => {
  await ada.patch("/api/tickets/1001", { assigneeId: ada.id });
  const mailsBefore = mails().length;
  await ada.post("/api/tickets/1001/comments", { text: "Replacement PSU ordered", internal: false });
  await ada.post("/api/tickets/1001/comments", { text: "Vendor case 4471", internal: true });
  await settle();
  const newMails = mails().slice(mailsBefore);
  assert.deepEqual(newMails.map((m) => m.to), ["rex.alerts@example.com"]);
  assert.ok(!newMails.some((m) => m.text.includes("4471")));
});

test("SLA warnings and breaches are announced once each", async () => {
  // Make TKT-1001 (P2, 24 hours) look 23 hours old: one hour left is under the 25% warning line.
  desk.db.prepare("UPDATE tickets SET created_at = ? WHERE id = 1001").run(Date.now() - 23 * 3600 * 1000);
  const mailsBefore = mails().length;
  desk.notify.runScheduledChecks();
  desk.notify.runScheduledChecks(); // second run must not repeat it
  await settle();
  const warnings = mails().slice(mailsBefore).filter((m) => /SLA on TKT-1001 runs out/.test(m.subject));
  assert.equal(warnings.length, 1);

  desk.db.prepare("UPDATE tickets SET created_at = ? WHERE id = 1001").run(Date.now() - 25 * 3600 * 1000);
  const textsBefore = texts().length;
  desk.notify.runScheduledChecks();
  await settle();
  assert.ok(texts().slice(textsBefore).some((t) => t.body.includes("SLA breached on TKT-1001")), "breaches text by default");
});

test("a task due tomorrow reminds its assignee", async () => {
  const projectId = (await ada.post("/api/projects", { name: "PDU firmware rollout", template: "maintenance" })).body.id;
  const taskId = (await ada.get(`/api/projects/${projectId}`)).body.tasks[0].id;
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  await ada.patch(`/api/tasks/${taskId}`, { assigneeId: ben.id, dueDate: tomorrow });
  await settle();
  const mailsBefore = mails().length;
  desk.notify.runScheduledChecks();
  await settle();
  assert.ok(mails().slice(mailsBefore).some((m) => m.to === "ben@example.com" && /due tomorrow/.test(m.subject)));
});

test("paused people get nothing", async () => {
  await ben.put("/api/alerts/me/paused", { paused: true });
  const mailsBefore = mails().length;
  await rex.post("/api/tickets", { title: "Another P2", priority: "P2", groupId });
  await settle();
  assert.deepEqual(mails().slice(mailsBefore).map((m) => m.to), ["ada@example.com"]);
});

test("the delivery log needs its permission, and never shows secrets or codes", async () => {
  assert.equal((await ada.get("/api/alerts/admin")).status, 403);
  const log = (await admin.get("/api/alerts/admin")).body;
  const asText = JSON.stringify(log);
  assert.ok(!asText.includes("smtp-test-password") && !asText.includes("twilio-test-secret"));
  assert.ok(!/code is \d{6}/.test(asText), "verification codes are never logged");
  assert.ok(log.recent.filter((r) => r.channel === "sms").every((r) => r.to.includes("•")), "phone numbers are masked");
});
