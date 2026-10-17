// Setting up email and texts from inside the app (no environment variables), testing settings before
// saving them, people saving their contact details before alerts are on, and SLA alerts following
// the SLA targets set in the app.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  startLighthouse, setUpDesk, addPerson, readMail, settle,
  TEST_SMTP_USER, TEST_SMTP_PASSWORD, TEST_TWILIO_SID, TEST_TWILIO_KEY_SID, TEST_TWILIO_KEY_SECRET,
} = require("./helpers");

let desk, admin, ada, shiftLead;
const mails = () => desk.mail.messages.map(readMail);
const texts = () => desk.twilio.texts;
const codeIn = (text) => /\b(\d{6})\b/.exec(text)[1];
const emailSettings = (overrides = {}) => ({
  host: "localhost", port: String(desk.mail.port), encryption: "starttls",
  username: TEST_SMTP_USER, password: TEST_SMTP_PASSWORD, from: "Lighthouse Test <desk@example.com>", ...overrides,
});
const smsSettings = {
  provider: "twilio", twilioAccountSid: TEST_TWILIO_SID, twilioApiKeySid: TEST_TWILIO_KEY_SID,
  twilioApiKeySecret: TEST_TWILIO_KEY_SECRET, twilioFromNumber: "+13175550000",
};

before(async () => {
  desk = await startLighthouse({ withFakeServers: true });
  admin = await setUpDesk(desk.baseUrl);
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician" });
  const levels = (await admin.get("/api/access-levels")).body;
  const allGrantable = levels.permissions.map((p) => p.key);
  await admin.post("/api/access-levels", { name: "Shift lead", permissions: [...allGrantable, "alerts.configure"] });
  shiftLead = await addPerson(admin, { name: "Sam Lead", username: "sam", accessLevelName: "Shift lead" });
});
after(() => desk.stop());

test("before anything is set up, people can still save their email and phone (marked unconfirmed)", async () => {
  assert.deepEqual((await ada.get("/api/alerts/me")).body.channels, { email: false, sms: false });
  const email = await ada.post("/api/alerts/me/verify/start", { channel: "email", target: "Ada@Example.com" });
  assert.equal(email.status, 200);
  assert.equal(email.body.saved, true);
  assert.equal(email.body.contact.alertEmail, "ada@example.com");
  assert.equal(email.body.contact.alertEmailVerified, false);
  assert.equal(email.body.contact.emailTo, null, "nothing is sent to an unconfirmed address");
  const phone = await ada.post("/api/alerts/me/verify/start", { channel: "sms", target: "(317) 555-0101" });
  assert.equal(phone.body.contact.phone, "+13175550101");
  assert.equal(phone.body.contact.phoneVerified, false);
  assert.equal((await ada.post("/api/alerts/me/test", { channel: "sms" })).status, 400, "nothing to test yet");
});

test("only Administrators can set up delivery; the permission can't be given to other levels", async () => {
  assert.equal((await ada.get("/api/settings/alert-setup")).status, 403);
  assert.equal((await shiftLead.get("/api/settings/alert-setup")).status, 403, "alerts.configure was dropped from the Shift lead level");
  assert.equal((await admin.get("/api/settings/alert-setup")).status, 200);
});

test("an admin can test email settings before saving them, and sees the real error when they're wrong", async () => {
  const wrongPassword = await admin.post("/api/settings/alert-setup/test", { channel: "email", target: "nick@example.com", settings: emailSettings({ password: "wrong" }) });
  assert.equal(wrongPassword.status, 502);
  assert.match(wrongPassword.body.error, /password/i);
  const before = mails().length;
  const right = await admin.post("/api/settings/alert-setup/test", { channel: "email", target: "nick@example.com", settings: emailSettings() });
  assert.equal(right.status, 200);
  await settle();
  assert.equal(mails().length, before + 1);
  assert.equal(mails().at(-1).to, "nick@example.com");
  assert.deepEqual((await ada.get("/api/alerts/me")).body.channels, { email: false, sms: false }, "testing doesn't save anything");
});

test("saved email settings take effect at once; the password is encrypted and never sent back", async () => {
  const saved = await admin.put("/api/settings/alert-setup/email", emailSettings());
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status.email.configured, true);
  assert.equal(saved.body.email.secrets.password.isSet, true);
  assert.ok(!JSON.stringify(saved.body).includes(TEST_SMTP_PASSWORD), "password not in the response");
  const storedRow = desk.db.prepare("SELECT value FROM settings WHERE key = 'email'").get().value;
  assert.ok(!storedRow.includes(TEST_SMTP_PASSWORD), "password not stored in plain text");
  assert.ok(fs.existsSync(path.join(desk.dataDir, "lighthouse.key")), "encryption key kept next to the database");
  assert.equal((await ada.get("/api/alerts/me")).body.channels.email, true);

  // Saving again with the password left blank keeps the saved one.
  const resaved = await admin.put("/api/settings/alert-setup/email", emailSettings({ password: "" }));
  assert.equal(resaved.body.status.email.configured, true);
});

test("a saved but unconfirmed address is confirmed with a code once email is on", async () => {
  await ada.post("/api/alerts/me/verify/start", { channel: "email", target: "ada@example.com" });
  await settle();
  const codeMail = mails().at(-1);
  assert.equal(codeMail.to, "ada@example.com");
  const confirmed = await ada.post("/api/alerts/me/verify/confirm", { channel: "email", code: codeIn(codeMail.text) });
  assert.equal(confirmed.body.contact.alertEmailVerified, true);
  assert.equal(confirmed.body.contact.emailTo, "ada@example.com");
  assert.equal((await ada.post("/api/alerts/me/test", { channel: "email" })).status, 200);
});

test("text settings saved in the app work end to end", async () => {
  const test = await admin.post("/api/settings/alert-setup/test", { channel: "sms", target: "+13175550111", settings: smsSettings });
  assert.equal(test.status, 200);
  assert.equal(texts().at(-1).to, "+13175550111");
  const saved = await admin.put("/api/settings/alert-setup/sms", smsSettings);
  assert.equal(saved.body.status.sms.configured, true);
  assert.ok(!JSON.stringify(saved.body).includes(TEST_TWILIO_KEY_SECRET));

  await ada.post("/api/alerts/me/verify/start", { channel: "sms", target: "+13175550101" });
  await ada.post("/api/alerts/me/verify/confirm", { channel: "sms", code: codeIn(texts().at(-1).body) });
  assert.equal((await ada.get("/api/alerts/me")).body.contact.phoneVerified, true);
});

test("alert options are checked and saved", async () => {
  const options = { includeDetailsInTexts: false, maxTextsPerHour: 30, maxTextsPerPersonPerHour: 5, dailyReminderHour: 0, defaultCountryCode: "44" };
  assert.equal((await admin.put("/api/settings/alert-setup/options", { ...options, dailyReminderHour: 24 })).status, 400);
  const saved = await admin.put("/api/settings/alert-setup/options", options);
  assert.equal(saved.body.options.maxTextsPerHour, 30);
  assert.equal(saved.body.status.includeDetailsInTexts, false);
  await admin.put("/api/settings/alert-setup/options", { ...options, includeDetailsInTexts: true, defaultCountryCode: "1" });
});

test("SLA warnings follow the SLA targets set in the app", async () => {
  // P2 with a 10-hour target, opened 9 hours ago: one hour left is under a quarter of the time.
  // With the default 24 hours this ticket wouldn't be close to its SLA yet.
  await admin.put("/api/settings/sla", { slaHours: { P1: 4, P2: 10, P3: 72, P4: 168 } });
  const ticketId = (await admin.post("/api/tickets", { title: "BMC unreachable on node-0412", priority: "P2" })).body.ticket.id;
  await admin.patch(`/api/tickets/${ticketId}`, { assigneeId: ada.id });
  desk.db.prepare("UPDATE tickets SET created_at = ? WHERE id = ?").run(Date.now() - 9 * 3600 * 1000, ticketId);
  await settle();
  const before = mails().length;
  desk.notify.runScheduledChecks();
  await settle();
  assert.ok(mails().slice(before).some((m) => m.to === "ada@example.com" && new RegExp(`SLA on TKT-${ticketId} runs out`).test(m.subject)));
});

test("going back to the env file turns a channel off again when the env file has nothing", async () => {
  const reset = await admin.delete("/api/settings/alert-setup/email");
  assert.equal(reset.body.status.email.configured, false);
  assert.equal(reset.body.email.source, "env");
  assert.equal((await ada.get("/api/alerts/me")).body.channels.email, false);
});
