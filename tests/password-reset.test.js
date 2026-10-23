// "Forgot password?" and "Email passphrase": a one-time passphrase emailed to the address on file.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startLighthouse, setUpDesk, addPerson, Person, readMail, settle } = require("./helpers");

let desk, admin, ada;
const mails = () => desk.mail.messages.map(readMail);
const passphraseIn = (text) => /passphrase:\s+([a-z]+(?:-[a-z]+){3}-\d{2})/.exec(text)?.[1];
const signInAs = async (username, password) => (await new Person(desk.baseUrl).post("/api/login", { username, password })).status;

before(async () => {
  desk = await startLighthouse({ withAlerts: true });
  admin = await setUpDesk(desk.baseUrl);
  await admin.patch("/api/users/1", { email: "nick@example.com" });
  ada = await addPerson(admin, { name: "Ada Tech", username: "ada", accessLevelName: "Technician", email: "ada@example.com" });
  await addPerson(admin, { name: "No Email", username: "noemail", accessLevelName: "Requester" });
});
after(() => desk.stop());

test("an admin who forgot their password gets a passphrase by email, and the old password still works until it's used", async () => {
  const visitor = new Person(desk.baseUrl);
  const asked = await visitor.post("/api/password-reset", { identifier: "nick" });
  assert.equal(asked.status, 200);
  await settle();
  const mail = mails().at(-1);
  assert.equal(mail.to, "nick@example.com");
  const passphrase = passphraseIn(mail.text);
  assert.ok(passphrase, "the email holds a word passphrase");
  assert.equal(await signInAs("nick", "admin-password-1"), 200, "old password still works (so nobody can be locked out)");

  // Signing in with the old password cancels the pending passphrase.
  assert.equal(await signInAs("nick", passphrase), 401);
});

test("signing in with the passphrase forces a new password, and the passphrase works only once", async () => {
  await new Person(desk.baseUrl).post("/api/password-reset", { identifier: "ada@example.com" });
  await settle();
  const passphrase = passphraseIn(mails().at(-1).text);
  const ada2 = new Person(desk.baseUrl);
  assert.equal((await ada2.post("/api/login", { username: "ada", password: passphrase })).status, 200);
  assert.equal((await ada2.get("/api/bootstrap")).body.me.mustChangePassword, true);
  assert.equal(await signInAs("ada", "ada-password-1"), 401, "the old password is replaced once the passphrase is used");
  assert.equal((await ada.get("/api/bootstrap")).status, 401, "other devices are signed out");
  assert.equal((await ada2.post("/api/me/password", { current: passphrase, next: "ada-new-password-2" })).status, 200);
  assert.equal(await signInAs("ada", passphrase), 401, "the passphrase is gone");
  assert.equal(await signInAs("ada", "ada-new-password-2"), 200);
});

test("the answer is the same whether or not the account exists, and nothing is sent when there's no email", async () => {
  const before = mails().length;
  const unknown = await new Person(desk.baseUrl).post("/api/password-reset", { identifier: "nobody-here" });
  const noEmail = await new Person(desk.baseUrl).post("/api/password-reset", { identifier: "noemail" });
  assert.equal(unknown.body.message, noEmail.body.message);
  await settle();
  assert.equal(mails().length, before);
});

test("an expired passphrase doesn't work", async () => {
  await new Person(desk.baseUrl).post("/api/password-reset", { identifier: "ada" });
  await settle();
  const passphrase = passphraseIn(mails().at(-1).text);
  desk.db.prepare("UPDATE users SET reset_expires_at = ? WHERE username = 'ada'").run(Date.now() - 1);
  assert.equal(await signInAs("ada", passphrase), 401);
});

test("an account gets at most a few reset emails an hour", async () => {
  const before = mails().length;
  for (let i = 0; i < 5; i++) await new Person(desk.baseUrl).post("/api/password-reset", { identifier: "ada" });
  await settle();
  // Two were already sent to Ada this hour (earlier tests); the limit is 3 per hour per account.
  assert.equal(mails().length - before, 1);
});

test("account managers can email someone a passphrase from Settings > Users", async () => {
  const noEmailId = (await admin.get("/api/bootstrap")).body.users.find((u) => u.username === "noemail").id;
  const refused = await admin.post(`/api/users/${noEmailId}/email-passphrase`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /no email address/i);
  const sent = await admin.post(`/api/users/${ada.id}/email-passphrase`);
  assert.equal(sent.body.sentTo, "ada@example.com");
  assert.match(mails().at(-1).text, /Nick Admin asked for a temporary passphrase/);
  const adaNow = await new Person(desk.baseUrl).signIn("ada", "ada-new-password-2");
  assert.equal((await adaNow.post(`/api/users/${noEmailId}/email-passphrase`)).status, 403, "needs Manage user accounts");
});

test("passphrases are never stored in the delivery log", async () => {
  const log = JSON.stringify((await admin.get("/api/alerts/admin")).body);
  assert.ok(!/passphrase:\s+[a-z]+-/.test(log));
  assert.ok(log.includes("password_reset"), "the send itself is logged");
});
