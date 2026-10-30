# Lighthouse Service Desk: application security review

This report has five parts, plus a note on 1.7:

- **[Version 1.7](#version-17-website-intake)** adds the private website-intake port.
- **[Part 5](#part-5-version-15-password-reset-attachments-links-and-tags)** reviews version 1.5: emailed password resets, file attachments, links between tickets and projects, and tags.
- **[Part 4](#part-4-version-14-settings-in-the-app-and-photos)** reviews version 1.4: email/text setup and SLA targets edited in the app, contact details saved before confirmation, and profile photos.
- **[Part 3](#part-3-version-13-usernames-and-access-levels)** reviews version 1.3: username sign-in, server-issued temporary passwords, and admin-defined access levels.
- **[Part 2](#part-2-version-12-projects-and-alerts)** reviews what version 1.2 added: Projects and email/text alerts.
- **[Part 1](#part-1-original-review-version-11)** is the original review of the ticketing core, unchanged.

---

## Version 1.7: website intake

**Date:** 30 October 2026 · Setup and API: [docs/WEBSITE-INTAKE.md](docs/WEBSITE-INTAKE.md)

| # | Topic | Severity | Status |
|---|---|---|---|
| I-1 | **Exposing ticket creation to the internet.** The desk is published through the tunnel; an unauthenticated "create ticket" route on it would be reachable by anyone. | High | **Avoided by design.** Intake is a second listener on its own port (default 127.0.0.1:3001), off unless `INTAKE_TOKEN` is set. The desk's port has no intake routes (tested: a POST there gets 405). The docs say to keep the tunnel on `PORT` only and firewall the intake port to the form handler's address. |
| I-2 | **Callers other than the form handler.** | High | Every call needs `Authorization: Bearer <INTAKE_TOKEN>` (at least 32 characters; compared as SHA-256 digests with `timingSafeEqual`). 10 wrong tokens per address per 15 minutes, then refused. Wrong tokens are audited (`intake.bad_token`); the token is never logged. |
| I-3 | **Flooding the queue** if the website form is abused. | Medium | 30 website requests per hour desk-wide, on top of whatever the form handler enforces per visitor. All fields are length-capped and validated; links must be `http(s)`. |
| I-4 | **Malicious files.** | Medium | Same storage as ticket attachments (random names, mode 600, always served as downloads). Only `.stl`, `.3mf`, `.step`, `.stp`; 50 MB each, streamed and cut off at the limit; 5 per request; only onto open website tickets within an hour of the request, so the token can't touch desk tickets (tested: 404). |
| I-5 | **Requester contact details.** | Low | Name and email are stored in `intake_requests` and shown only to people with *See every ticket*. No account is created and Lighthouse sends the person nothing. Description text is escaped like every other ticket. |

---

## Part 5: Version 1.5 (password reset, attachments, links and tags)

**Date:** 23 October 2026

| # | Topic | Severity | Status |
|---|---|---|---|
| R-1 | **Account takeover through "Forgot password?"** An emailed reset is only as strong as the passphrase and the mailbox. | High | **Mitigated.** The passphrase is 4 random words from a 282-word list plus a two-digit number (about 39 bits), generated with `crypto.randomInt`. Only its scrypt hash is stored, it expires after 30 minutes, works once, and sign-in attempts with it count against the normal throttles (10 per account and 50 per address every 15 minutes). Using it signs out every other session and forces a new password. |
| R-2 | **Locking people out by requesting resets for them.** | Medium | **Fixed by design.** Requesting a reset changes nothing until the passphrase is used: the old password keeps working, and signing in with it cancels the pending passphrase. At most 3 reset emails per account and 10 requests per address are allowed each hour. |
| R-3 | **Finding out who has an account.** | Medium | **Fixed.** The reply is word-for-word the same for unknown usernames, accounts without email, and real accounts, and the email is sent in the background, so response time doesn't differ either. Only the audit log records what happened. |
| R-4 | **Passphrases leaking through logs.** | Medium | The delivery log stores "Temporary passphrase (hidden)" instead of the message, and failed reset emails can't be retried from the log (a retry would otherwise resend the placeholder). Tested. |
| R-5 | **Malicious uploads** (HTML or scripts disguised as pictures, SVG, oversized files, path tricks). | High | **Mitigated.** Files are stored under random names in `DATA_DIR/attachments` (mode 600), never under the uploaded name; names are cleaned of folders and control characters. Only PNG, JPEG, GIF and WebP are ever shown in the page, and only when the file's own first bytes say so (the uploader's claimed type is ignored; SVG is never shown). Everything else is served as `application/octet-stream` with `Content-Disposition: attachment`. Every file response carries `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Uploads are streamed to disk and cut off at 25 MB; at most 50 files per ticket. Tested, including a script file claiming to be a PNG. |
| R-6 | **Who can read and attach files.** | Medium | Exactly the people who can see the ticket. Attachment ids from other tickets return "not found". Removing a file needs the uploader or *Work tickets*. Deleting a ticket deletes its files from disk. |
| R-7 | **Links revealing tickets.** A link to a ticket someone can't open would leak its title and status. | Medium | **Fixed.** Linked tickets (on tickets and on project pages) are filtered by the viewer's own ticket visibility. Changing links needs *Work tickets* (plus *Use projects* for project links). |
| R-8 | **Longer request timeout.** Raised from 30 to 120 seconds so large files can upload over slow connections. | Low | Header timeout stays at 20 seconds, JSON bodies stay capped at 200 KB, and Cloudflare (when used) absorbs slow-client attacks before they reach the server. |
| R-9 | **Tags.** | Info | Restricted to lower-case letters, digits, dot, dash and underscore, 30 characters, 15 per ticket. Requesters can tag only while raising a ticket; later changes need *Work tickets*. Tag suggestions only include tags on tickets the person can see. |

**Announcements (1.6):** posting needs the grantable *Post announcements* permission and every post, edit, end and delete is audited. Banner text is shown as plain text (escaped, never HTML), and announcements are only sent to signed-in people, never shown on the public sign-in page.

**Backups:** attachments are not inside the database file. The backup script now archives `DATA_DIR/attachments` next to each database copy. On Windows, copy `data\attachments` yourself (docs/WINDOWS.md).

---

## Part 4: Version 1.4 (settings in the app, and photos)

**Date:** 16 October 2026

### What changed

- Administrators enter mail server and Twilio settings, including passwords, under **Settings → Alert setup**, and can send a test with unsaved settings. Until then the env file is used, as before.
- SLA targets are edited in the app (new grantable permission *Change SLA targets*).
- People can save an email address or phone number before delivery is set up; it stays *unconfirmed* until they confirm it with a code.
- Profile photos: uploaded by the person (or an account manager), shown to anyone who can see that person, including the requester whose ticket they work.

### Findings and decisions

| # | Topic | Severity | Status |
|---|---|---|---|
| S-1 | **Mail and Twilio secrets now live in the database** instead of only in a root-owned env file. Anyone holding a copy of the database could otherwise read them. | Medium | **Mitigated.** Secrets are encrypted with AES-256-GCM using a key kept in its own file (`DATA_DIR/lighthouse.key`, mode 600), or in `LIGHTHOUSE_SECRET_KEY`. Backups copy only the database, so an off-site backup alone reveals nothing. Secrets are never returned to the browser (only "is set"), never logged, and the audit log records *which* secret changed, never its value. The env file remains available for anyone who prefers it. |
| S-2 | **Who may change delivery settings.** Whoever controls the mail server setting could redirect every alert, including verification codes, through a server they own. | High | **Fixed by design.** The new permission `alerts.configure` is Administrator-only, like `access.manage`: it can't be ticked on any other level, and the server drops it from level updates. Tested in `tests/alert-setup.test.js`. |
| S-3 | **Test sends as a relay.** "Send test" lets an admin send mail or a text to any address. | Low | Administrator-only, rate limited (6 per hour per person), fixed message text, and every test is audited with its target. |
| S-4 | **Server-side request forgery through settings.** The SMTP host and SMS webhook address are now set from the browser. | Low | Only Administrators can set them, the webhook must be HTTPS (or localhost), redirects are refused, and unencrypted SMTP is still only allowed to localhost. The Twilio API address and CA file remain env-only. |
| S-5 | **Unconfirmed contact details.** Saving an address before delivery is set up could be used to point alerts at someone else. | Low | **Fixed by design.** Delivery code only ever uses confirmed addresses and numbers (`alerts/contacts.js`), and is checked again at send time. An unconfirmed entry receives nothing until its owner enters the code sent to it. Tested. |
| S-6 | **Photo uploads** (malicious files, hidden location data, privacy). | Medium | **Mitigated.** The browser shrinks every photo to 256×256. The server accepts only JPEG, at most 120 KB, parses its structure, and removes all metadata segments (EXIF, GPS, XMP, comments) before storing it. Photos are served with `nosniff`, a fixed `image/jpeg` type and a sandboxing CSP, and only to people who can see that person (requesters only see the staff on their own tickets; "no photo" and "not allowed" look the same). Only account managers within their reach can change someone else's photo. Tested in `tests/desk-settings.test.js`. |
| S-7 | **SLA target changes** silently move every ticket's due time. | Info | Needs its own permission, whole hours from 1 to 2,160 only, and every change is audited with before and after values. |
| S-8 | **Requesters without "Raise tickets"** lost sight of tickets they had raised in the page (the server still allowed it). | Low (bug) | **Fixed.** *Raised by me* now always shows. Tested. |

### Recommendations

- Keep a copy of `lighthouse.key` in your password manager, separate from backups.
- If your organisation requires secrets to stay out of the application entirely, keep using the env file and don't save delivery settings in the app.

---

## Part 3: Version 1.3 (usernames and access levels)

**Date:** 16 October 2026

### What changed

- People sign in with a username. Email is optional and used only for alerts.
- Fixed roles (requester / technician / admin) are replaced by **access levels**: named sets of permissions that Administrators edit in the app. Every server route now checks a named permission (`tickets.view_all`, `users.manage`, and so on) instead of a role.
- Temporary passwords are generated on the server and shown once.
- The code was reorganised into small modules (`lib/`, `routes/`, `alerts/`) with named constants, and an automated test suite (`npm test`, 43 tests) now covers the security rules below.

### Threats considered

Making permissions editable creates a new way to escalate: anyone who can change accounts or levels could try to hand themselves, or a friend, more power. The review focused on that, plus the sign-in change.

### Findings and fixes

| # | Finding | Severity | Status |
|---|---|---|---|
| A-1 | **Privilege escalation through account management.** A person allowed to manage users could, in a naive design, move themselves or anyone else to a stronger level. | High | **Fixed by design.** Non-administrators can only grant levels whose every permission they already hold, can't touch accounts whose level exceeds theirs, and can't change their own level. Only Administrators grant Administrator. Tested in `tests/accounts.test.js`. |
| A-2 | **Editing access levels is itself a privilege.** If "manage access levels" were grantable, anyone holding it could give every level every permission. | High | **Fixed by design.** `access.manage` exists only on the built-in Administrator level and can't be ticked on any other level; the server drops unknown or administrator-only keys from any level update. |
| A-3 | **Locking everyone out.** Deleting or editing the Administrator level, or demoting/deactivating the last Administrator, would leave no one able to manage the desk. | Medium | **Fixed.** The Administrator level is read-only and undeletable; the last active Administrator can't be demoted or deactivated; the `reset-password --admin` script remains as a server-side recovery path. |
| A-4 | **Stale access after a permission is removed.** Someone moved to a weaker level kept their assigned tickets, group memberships and project tasks, and so kept seeing that work through alerts and links. | Medium | **Fixed.** Any level change, level edit or deactivation runs `releaseWorkTheyCanNoLongerDo`, which unassigns tickets and tasks and removes group and project memberships the person no longer qualifies for, in the same database transaction. Permissions are read fresh from the database on every request, so a change takes effect on the person's next click without signing them out. |
| A-5 | **Deleting a level that people are on** would leave accounts with no permissions in an undefined state. | Low | **Fixed.** Deleting is refused (409) while anyone, including deactivated accounts, is on the level. |
| A-6 | **Temporary passwords chosen in the browser.** 1.2 generated the suggested password in the admin's browser, and an admin could type a weak one. | Low | **Fixed.** The server generates a 14-character password with `crypto.randomInt` from an unambiguous alphabet, returns it once, and forces a change at first sign-in. Reset signs the person out everywhere. |
| A-7 | **Username enumeration at sign-in.** | Low | **Mitigated.** Unknown usernames are checked against a decoy scrypt hash, so response time and message are the same as a wrong password; failures are throttled per account and per address. Usernames are not secret (they appear in the Users list for account managers), so this is defence in depth. |
| A-8 | **Disabling certificate checks for internal mail servers.** Admins with a private CA might be tempted to turn TLS verification off. | Low | **Addressed.** New `SMTP_CA_FILE` adds a trusted CA instead; there is still no way to turn verification off. |
| A-9 | **Theme preference stored per account.** | Info | Only `system`, `light` or `dark` are accepted, enforced by the API and a database CHECK constraint. The value is applied as a `data-theme` attribute, never as HTML or CSS text. |

### Upgrade from 1.2

The migration rebuilds the users table inside a transaction with foreign keys checked afterwards (`PRAGMA foreign_key_check`). Usernames come from the email local part and are deduplicated. Password hashes, sessions' owners, tickets, alerts and memberships keep their user IDs. Old roles map to the three starting levels, so nobody gains or loses access during the upgrade. Covered by `tests/upgrade.test.js`.

### Residual risks and recommendations

- Anyone with **Manage user accounts** can reset the password of people at or below their level and so sign in as them. Give that permission only to people you'd trust with those accounts, and watch `user.password_reset` events in the audit log.
- Permissions are coarse by design (no per-group or per-project scoping). If you need "can only work tickets in group X", that isn't modelled.
- For an internet-facing desk, single sign-on and MFA in front (Cloudflare Access or similar) remain the biggest single improvement.

---

## Part 2: Version 1.2 (Projects and alerts)

**Date:** 16 October 2026
**Scope:**
- `projects.js`, `notify.js`, `alerts.js`, `mailer.js` and `sms.js`
- The schema migration in `db.js`
- The rewritten front end (`public/core.js`, `tickets.js`, `projects.js`, `settings.js`)
- The ticket routes in `server.js` that now raise alerts

**Method:**
- Hand review against the same OWASP Top 10 and ASVS level 2 areas as Part 1, plus email and SMS abuse cases.
- 48 scripted API checks against a running server.
- A real SMTP test server that only accepts STARTTLS with a password, and a fake Twilio API that checks credentials.
- A full headless-browser pass under the production Content Security Policy.
- The original Part 1 regression suite, which still passes unchanged.

### Threats considered, and how the design answers them

| Threat | Control | Verified by |
|---|---|---|
| Using the desk to email or text people who never asked for it (harassment, cost) | A new alert address or phone number is only stored after a 6-digit code sent to it is entered. Codes expire in 10 minutes, allow 5 attempts, are limited to 5 per person per hour, are stored only as salted SHA-256 hashes, and are compared in constant time. | Wrong code rejected; correct code accepted; 6th request returns 429 |
| Runaway text bills (a ticket storm, a bug, a hostile insider) | Hard caps per hour, desk-wide (`SMS_MAX_PER_HOUR`, default 60) and per person (`SMS_MAX_PER_USER_PER_HOUR`, default 15). Over-cap texts are skipped and logged, never queued forever. Texts default to off except SLA breaches. | Cap logic exercised; skipped rows visible in delivery log |
| Alert floods after an upgrade or restart | SLA and due-date alerts are de-duplicated by a unique key per ticket or task, per priority, per person, per channel. Breaches older than 6 hours and tasks overdue by more than 7 days are never announced. | "Sent only once" check across two scan cycles |
| Email header injection (adding `Bcc:`, rewriting `Subject:`) | Recipient addresses are validated against a strict pattern that rejects CR/LF and angle brackets. Every header value has line breaks stripped, and non-ASCII text is RFC 2047-encoded. Bodies are base64-encoded and dot-stuffed. | `a@b.com\r\nBcc: evil@x.io` rejected with 400 |
| Credential exposure | SMTP passwords and Twilio secrets come only from the root-only environment file. They are never stored in the database, never returned by any API (the admin page shows only host, port and sender), and never included in error messages. SMTP errors name the step ("the username or password"), not the data sent. | Delivery-log JSON searched for both secrets; bad-password error inspected |
| Email sent unencrypted or to an impostor server | STARTTLS is required (the session aborts if the server doesn't offer it) or implicit TLS is used, with TLS 1.2 minimum and full certificate verification. Plain SMTP is refused for any host other than localhost. | Self-signed certificate refused; `SMTP_SECURE=none` to a remote host refused at startup |
| Host-header poisoning of links in alerts | Links are built only from `PUBLIC_URL`, never from request headers. | Code review |
| Server-side request forgery through the SMS webhook | The webhook URL and Twilio base URL come only from the admin's environment file, must be `https://` (http only for localhost), and redirects are refused (`redirect: "error"`). No user can supply a URL. | Config validation tests |
| Requesters learning internal information through alerts | Requesters can only enable the "my tickets" alert. Internal notes never trigger requester alerts. Requester emails omit group, SLA and asset details. Requesters are blocked from every project and task endpoint, and ticket responses omit linked project tasks for them. | Internal-note and 403 checks |
| Alerts reaching people who have left | Deactivated or paused people are re-checked at delivery time, so queued alerts are skipped. Deactivation also unassigns their open tasks and removes them from projects. The current verified address or number is used at send time, not the one at queue time. | Pause and deactivation checks |
| Phone numbers exposed to other staff | A number is visible only to its owner. Admins see it masked (`+•••0101`) in the delivery log. | Delivery-log check |
| Access control on projects (broken object-level authorisation) | Every route requires technician or admin. Owner-only actions (archive, delete, change owner, remove others) are checked on the server. Task deletion is limited to the creator, project owner or admin. Archived projects reject all writes. Assignees must be active staff. Linked tickets must exist. | 403/400 checks for each |
| SQL injection in the new dynamic updates | Column names in `PATCH /api/projects/:id` and `PATCH /api/tasks/:id` come from fixed keys in code. All values are bound parameters. | Code review |
| Cross-site scripting in project and task content | All user text is escaped before rendering. Project colours and statuses are server-side allow-lists before they are used in class names. The CSP still forbids inline script and style. Alert email HTML escapes every value. | Browser pass with no CSP violations |
| Denial of service through the outbox | Delivery runs in a single background loop with no overlapping runs, 25 messages per tick, and 15–20 second network timeouts. Failures back off over 1, 5, 15 and 60 minutes, up to 5 attempts. History is pruned after 30 days. | Code review |

### Issues found and fixed during the build

| ID | Finding | Severity | Status |
|---|---|---|---|
| N-1 | Environment-file values with a trailing `# comment` silently included the comment (systemd does not strip trailing comments). With the alert settings, this would have produced settings like `SMTP_SECURE="starttls # …"`. | Medium (misconfiguration) | Fixed. All examples now put comments on their own lines, and the guides call this out. |
| N-2 | An unquoted `SMTP_FROM=Name <addr>` breaks shell-sourced env files and disabled email. | Low | Fixed. The template and guides quote the value, and the startup log names the exact problem. |
| N-3 | Using the main Twilio Auth Token gives the server full account control. | Low | Fixed. Twilio API keys (`TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`) are supported and documented as the default. A key can be revoked on its own. |

### Residual risks (accepted, with mitigations)

| Risk | Mitigation |
|---|---|
| **Texts leave your control.** SMS travels through carriers unencrypted, and a phone's lock screen shows message previews. | Set `SMS_INCLUDE_DETAILS=false` to send only the ticket number and a link. |
| **Alert emails contain ticket text** (including internal notes, to staff). Email is only as private as the recipients' mailboxes. | Keep alert addresses on your company domain. Each person controls which alerts they receive. |
| **Six-digit codes can be guessed** in theory. | A code is valid for 10 minutes with 5 attempts, so a guess has a 1-in-200,000 chance per code. Every attempt is audited (`alerts.verify_failed`). |
| **Node's built-in `fetch` does not use `HTTPS_PROXY` by default.** On a network that reaches the internet only through a proxy, Twilio calls will fail. | Allow outbound TCP 443 to `api.twilio.com`, or use the webhook provider pointed at an internal relay. |
| **Any technician can edit any project's tasks.** | This is intentional for a small ops team. The owner and admin gates cover destructive actions, and every change is in the task history. |

---

## Part 1: Original review (version 1.1)

**Date:** 12 October 2026
**Version reviewed:** the first standalone build (named "Rackline" at the time)
**Fixes verified in:** Lighthouse 1.1

### Scope and method

All first-party code was reviewed by hand:

- `server.js`: HTTP handling, routing, authentication, sessions, authorisation, input validation, and every API route
- `db.js`: the schema, migrations, and file handling
- `passwords.js`, `scripts/*.js`
- `public/app.js`, `public/index.html`, and `public/styles.css`: output encoding, CSP compatibility, and client-side trust
- `Dockerfile` and `docker-compose.yml`

Lighthouse has no third-party packages, so there is no dependency supply chain to audit.

Each fix was verified against the running server with scripted requests:

- the CSRF, origin, and setup-code checks
- spoofed proxy headers
- access to tickets that belong to someone else (insecure direct object references)
- SQL metacharacters in input
- path traversal
- oversized bodies and overlong passwords
- password spraying
- file permissions
- HTTPS-mode cookies and headers

The UI was then exercised in a headless browser under the tightened content security policy.

The review followed the OWASP Top 10 (2021) and the OWASP ASVS level 2 areas that apply to a small multi-user web app: authentication, session management, access control, input handling, configuration, and logging.

### Summary

| ID | Finding | Severity | Status |
|---|---|---|---|
| H-1 | Anyone could create the first admin account on a fresh install | High | Fixed |
| H-2 | Spoofed `X-Forwarded-For` defeated sign-in throttling behind a proxy | High | Fixed |
| M-1 | Password spraying across many accounts was not throttled | Medium | Fixed |
| M-2 | Synchronous password hashing let a sign-in flood stall the whole server | Medium | Fixed |
| M-3 | Throttle table could grow without limit (memory exhaustion) | Medium | Fixed |
| M-4 | Database files were world-readable on the host (mode 644) | Medium | Fixed |
| M-5 | CSRF protection rested on a single control | Medium | Fixed |
| L-1 | Requesters could list every staff member's name and role | Low | Fixed |
| L-2 | CSP allowed inline styles (`'unsafe-inline'`) | Low | Fixed |
| L-3 | Missing HSTS, COOP/CORP, Permissions-Policy; cookie lacked `__Host-` prefix | Low | Fixed |
| L-4 | No security audit trail | Low | Fixed |
| L-5 | No explicit header and request timeouts (slow-client exhaustion) | Low | Fixed |
| L-6 | Current-password check on password change was not throttled | Low | Fixed |
| L-7 | No per-user write rate limit (ticket and comment flooding) | Low | Fixed |
| L-8 | A file read error while serving static files could crash the process | Low | Fixed |
| L-9 | Container ran with default capabilities and a writable filesystem | Low | Fixed |

Accepted residual risks are listed at the end. None is high severity.

---

### High

#### H-1: First-run admin takeover

**What:** Until the first account existed, `POST /api/setup` created an admin for whoever called it first. On a cloud deployment, the server is reachable on the internet from the moment DNS and the firewall are in place, often before the owner opens it. A scanner could claim the desk, and through DNS rebinding even a malicious web page visited by someone on the same network could.

**Impact:** Full control of the desk, including every account created afterwards.

**Fix:** Setup now requires a one-time code. The code is printed in the server log at startup, or can be set ahead of time with `SETUP_TOKEN`. It is compared in constant time, wrong attempts are throttled (10 per 15 minutes per IP) and logged as `setup.bad_code`, and the code is discarded once the admin exists. The "already set up" check is repeated inside the database transaction, so two simultaneous requests cannot both succeed.

**Verified:** Setup with no code and with a wrong code is rejected. The logged code and `SETUP_TOKEN` both work.

#### H-2: Client IP spoofing through X-Forwarded-For

**What:** With `TRUST_PROXY=true`, the server used the **leftmost** `X-Forwarded-For` entry as the client's address. Proxies append to the right, so the leftmost value is whatever the client sent.

**Impact:** An attacker could send a fresh fake IP with each sign-in attempt and never hit the throttle, turning it off for online password guessing. The fake addresses also polluted logs.

**Fix:** The client IP is now taken by counting `TRUST_PROXY_HOPS` entries from the **right**, which are the ones added by your own proxies. `CLIENT_IP_HEADER` (for example Cloudflare's `cf-connecting-ip`) can be used instead, and is only read when `TRUST_PROXY=true`. The deployment guides bind the app to `127.0.0.1`, so only the local proxy or tunnel can set these headers.

**Verified:** Eleven attempts, each with a different spoofed left-hand address, were throttled on the eleventh, and the log recorded the real (rightmost) address.

### Medium

#### M-1: Password spraying was not throttled

**What:** Failed sign-ins were counted per IP address and email pair only. One IP could try a common password against every account without ever being slowed.

**Fix:** A second limit counts failures per IP across all emails: 50 per 15 minutes. Both limits log `login.throttled`.

**Verified:** The 51st failure from one IP, spread across 51 different emails, returned 429.

#### M-2: Synchronous password hashing (denial of service)

**What:** `scrypt` ran synchronously on the main thread, at roughly 50 ms per hash. A modest flood of sign-in requests would block every other user's requests, and passwords of unlimited length added to the cost.

**Fix:** Hashing now runs asynchronously on Node's worker thread pool. Passwords are limited to 10–256 characters everywhere: setup, sign-in, password change, user creation, reset, and the command-line tool. Request bodies are capped at 200 KB, and an oversized `Content-Length` is rejected before the body is read.

#### M-3: Unbounded throttle table

**What:** The in-memory failure counter added an entry for every IP and email pair and never removed old ones. A long-running spray of random emails would grow memory until the process died.

**Fix:** All limiters share one bounded implementation. Expired entries are pruned once 20,000 keys are reached, and the table is cleared if it is still full after pruning.

#### M-4: World-readable database files

**What:** SQLite created `rackline.db`, its `-wal` and its `-shm` files with the default umask, giving mode 644. Any other local account on the host could read password hashes, session token hashes, and every ticket.

**Fix:** The process sets `umask 077` at startup, the data directory is created as 700, and existing database files are tightened to 600 on every start. The systemd unit also sets `UMask=0077`, and backups are written as 600.

**Verified:** On a fresh install the directory is 700 and all three files are 600. Files left over from an upgraded install are corrected to 600 at startup.

#### M-5: Single-layer CSRF protection

**What:** Cross-site request forgery was blocked only by requiring a custom `X-Rackline` header. That is sound in browsers today, but a single control with no backup.

**Fix:** There are now three independent controls:

1. The session cookie is `SameSite=Strict`.
2. A custom `X-Lighthouse` header is required on every state-changing request.
3. The `Origin` header must equal `PUBLIC_URL` (or the request's own host if `PUBLIC_URL` is unset), and requests the browser marks `Sec-Fetch-Site: cross-site` or `same-site` are rejected.

Blocked attempts are logged as `csrf.block`.

**Verified:** A foreign `Origin` and a `Sec-Fetch-Site: cross-site` header are both rejected. Same-origin requests succeed.

### Low

**L-1: Staff directory exposed to requesters.** Every user received the full list of names and roles. Requesters now receive only themselves and the people who appear on their own tickets (assignees and authors of public updates), with no group membership details. Technicians and admins still see everyone. *Verified:* before assignment a requester saw only themselves, and afterwards only the assigned technician was added.

**L-2: Inline styles allowed by the CSP.** `style-src 'unsafe-inline'` would have let injected markup restyle the page, for example to overlay fake prompts. All inline styles moved to the stylesheet and the directive was removed. `object-src 'none'` was also added. *Verified:* the full UI ran in a browser with no CSP violations.

**L-3: Missing hardening headers.** When `COOKIE_SECURE=true`, the server now sends `Strict-Transport-Security`, and the session cookie becomes `__Host-lh_session`. That prefix forces Secure, Path=/ and no Domain, so subdomains cannot plant or overwrite it. `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` and a restrictive `Permissions-Policy` were added for all responses.

**L-4: No audit trail.** Security-relevant events are now written to stdout as one JSON object per line, which suits journald, CloudWatch and Azure Monitor. Each line carries a timestamp, IP, user ID and event-specific fields, and no secrets are written. The events are:

- `setup.complete`, `setup.bad_code`
- `login.success`, `login.failure` (with a reason), `login.throttled`, `logout`
- `password.change`, `password.change_failed`
- `user.create`, `user.update` (with the fields changed, including role transitions)
- `group.create`, `group.delete`, `ticket.delete`
- `csrf.block`
- `cli.password_reset`

**L-5: Slow-client exhaustion.** Explicit `headersTimeout` (20 s) and `requestTimeout` (30 s) values are now set, so stalled connections are cut off.

**L-6: Password change brute force.** Anyone holding a stolen session could guess the current password without limit in order to set a new one. This is now limited to 10 wrong attempts per 15 minutes per user, and failures are logged.

**L-7: Write flooding.** Each signed-in user is limited to 120 state-changing requests per minute, which stops a script from filling the database with tickets or comments.

**L-8: Static file read errors.** An error while streaming a static file was not handled, and Node treats an unhandled stream error as fatal. The stream now has an error handler that closes only that response.

**L-9: Container hardening.** `docker-compose.yml` now drops all Linux capabilities, sets `no-new-privileges`, mounts the root filesystem read-only (with a tmpfs for `/tmp`), and publishes the port on `127.0.0.1` only. The image copies the code as root-owned, so the `node` user cannot modify it, and adds a health check.

### Verified as sound (no change needed)

- **SQL injection:** every query is parameterised. The two dynamic `UPDATE ... SET` statements build column names only from fixed allow-lists in code. *Tested* with `'); DROP TABLE users;--` in a title: it was stored literally and all tables survived.
- **Cross-site scripting:** every value from the server is HTML-escaped (`esc()`) before insertion. Toasts use `textContent`. Values used in class names come from server-side enums. Scripts are restricted to `'self'` by the CSP, so even a missed escape could not run injected script.
- **Authorisation:** checked on the server for every route. For example, ticket edits require a technician, user and group management requires an admin, and technicians may only add or remove themselves from groups.
- **Insecure direct object references:** tickets that don't exist and tickets that belong to someone else both return the same 404, so ticket IDs cannot be probed. Requesters can never write internal notes (the flag is ignored for them), and internal notes are filtered out on the server before the response is built.
- **Sessions:** tokens are 256 random bits, stored only as SHA-256 hashes, and validated against a strict format. Logout deletes the server-side session. Deactivating a user or resetting their password revokes all their sessions, and changing your own password signs out your other devices.
- **Account enumeration:** sign-in returns one message for unknown email, wrong password, and inactive account. When the email doesn't exist, a real hash is still checked, so response time doesn't reveal valid accounts. Passwords are compared in constant time.
- **Privilege safety:** admins cannot demote or deactivate themselves, so at least one active admin always remains. People who are demoted or deactivated are removed from groups and from open assignments, and the change is recorded in each affected ticket's history.
- **Path traversal:** static files are resolved and confined to `public/`. Encoded and raw `../` attempts return the app page, never files outside it.
- **Error handling:** server errors return a generic message, and stack traces only go to the server log.

### Residual risks and recommendations

These are accepted for a small internal desk. Each has a mitigation you can add.

| Risk | Recommendation |
|---|---|
| **No built-in multi-factor authentication or SSO.** A phished password is enough to sign in. | Put Cloudflare Access in front with your company identity provider (see `docs/DEPLOY-CLOUDFLARE.md`). This adds SSO and MFA without code changes, and keeps the login page off the open internet. This is the most valuable single addition. |
| **Rate limits live in memory.** They reset on restart and are per process. | Fine for one server. If you put a WAF in front (AWS WAF, Azure Application Gateway, Cloudflare), add a rate rule on `POST /api/login`. |
| **Any admin can reset any other admin's password.** | Keep the admin count small. Every reset is logged as `user.update` with `password_reset`, so alert on it. |
| **No self-service password reset by email.** An admin or the CLI must reset passwords. | This is a deliberate choice that avoids an email-based takeover path. Revisit only if you add SMTP. |
| **Google Fonts is loaded from Google's servers**, which shows Google your visitors' IP addresses. | If that matters, download the IBM Plex font files into `public/fonts/`, reference them from `styles.css`, and remove the two Google entries from the CSP in `server.js`. The page already falls back to system fonts if Google is unreachable. |
| **Sessions are not bound to IP or device**, and last up to 7 days. | Lower `SESSION_DAYS`. Cloudflare Access also adds its own shorter session on top. |
| **Single server and single database file.** | This is the design. Nightly verified backups, off-site copies and disk snapshots are covered in the deployment guides. Test a restore once. |
| **`node:sqlite` is marked experimental in Node 22 and 24.** Its API could change in a future Node release. | Pin the Node major version, and test upgrades on a copy of the database before upgrading production. |
| **No automated test suite ships in the repository.** | The checks used for this review can be turned into a test script if you plan to modify the code. |
