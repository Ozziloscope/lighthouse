# Lighthouse Service Desk

A self-hosted service desk for an operations team, built around break/fix and build-out work in a data centre. It has three parts, each with its own tab at the top of the app:

- **Tickets:** queues, SLA timers, resolver groups, internal notes and a full activity history.
- **Projects:** Asana-style projects with sections, tasks, subtasks, owners, due dates, a list view, a drag-and-drop board, and a My tasks page.
- **Settings:** each person's alerts, theme and password, and, for admins, user accounts, access levels and the alert delivery log.

It has **no dependencies**. Lighthouse uses only what ships with Node.js 22.13+: the HTTP server, crypto, TLS, and the built-in SQLite database. There is nothing to `npm install` and nothing to compile. Even the email sender is built in.

## Contents

- [Features](#features)
- [Accounts and access levels](#accounts-and-access-levels)
- [Try it locally](#try-it-locally-5-minutes)
- [Deploying for real](#deploying-for-real)
- [Email and text alerts](#email-and-text-alerts)
- [Configuration](#configuration)
- [Security](#security)
- [Operations](#operations)
- [Customising](#customising)
- [Project layout](#project-layout)

## Features

### Tickets
- Tickets are numbered from TKT-1001, with a priority (P1–P4), category, asset or location (hostname, serial, or row-rack-U), resolver group, assignee and requester.
- **Workflow:** New → Assigned → In Progress → Pending → Resolved → Closed.
  - Assigning a new ticket moves it to Assigned.
  - Resolving requires resolution notes.
  - When a requester replies to a Pending ticket, it goes back to In Progress.
- **SLA timers** run from open to resolve. The targets start at P1 4 h, P2 24 h, P3 72 h and P4 7 days, and anyone with *Change SLA targets* adjusts them under **Settings → SLA targets**. Each timer shows the time until due or the time since breach. Resolved tickets show whether the SLA was met.
- **Requesters always keep sight of their tickets.** Everyone has a *Raised by me* queue with every ticket they opened, open or closed, whatever their access level.
- **Technician photos.** People add a photo under **Settings → My profile** (an account manager can also set one). The person who raised a ticket sees the photo and name of the technician working it.
- **Queues:** Assigned to me, My groups, Unassigned, All open, Raised by me, and Resolved. A summary strip shows open, P1, unassigned and breached counts.
- **Categories in groups:** *Data center* (server hardware, storage, network, power and cooling...), *Tech* for software and applications (Login Issue, Site Improvement, Feature Request, Software Issue), *Facilities* (Plumbing, Stock, Electrical, Carpentry, Capital Expenditure, Procurement, Property Maintenance, Other) and *General*.
- **Tags** such as `#psu` or `#vendor-rma`, added when raising a ticket or later by whoever works it. Search with `#tag`, or click a tag to see every ticket that has it.
- **File attachments:** screenshots, photos, logs, PDFs, up to 25 MB each. Anyone who can see a ticket can attach files, including the person who raised it. Pictures show as thumbnails.
- **Linked tickets:** related to, duplicate of / duplicated by, blocks / blocked by. Each ticket shows the link from its own side.
- **Linked projects:** a ticket can point at the projects it belongs to, and the project page lists its tickets.
- **Resolver groups** have members, a lead, and their own counts.
- **Project links.** A ticket can be turned into a project task ("Add to a project…"), and the ticket then lists its linked tasks.

### Projects
- **Projects** have an owner, members, a colour, a due date, a status (On track / At risk / Off track / On hold / Complete) and a progress bar.
- **Templates for common work**, each with starter sections and tasks:
  - Rack build-out
  - Hardware refresh
  - Planned maintenance
  - Blank
- **List view:** tasks grouped by section, with assignee, due date and priority columns, and inline "Add task".
- **Board view:** one column per section. Drag cards to reorder them or move them between columns. Dragging works in the list view too.
- **Tasks** have an assignee, due date, priority, description, subtasks, comments, a full history, and an optional linked ticket. A task can be opened directly from its alert link.
- **My tasks** gathers everything assigned to you across projects, grouped as Overdue / Today / Next 7 days / Later / No due date.
- **Archiving** makes a finished project read-only and removes it from My tasks.

### Alerts (email and text)
- Each person picks what they hear about and how (email, text, or both) under **Settings → My alerts**. Options include new tickets in their groups (with a priority threshold), assignments, SLA warnings and breaches, replies, task assignments, due dates and comments.
- **Set up from inside the app.** Administrators enter mail server and Twilio details under **Settings → Alert setup**, with a **Send test** button that tries the settings before saving them and shows the exact error if they're wrong. Passwords and tokens are stored encrypted. (The server's env file still works, and is used until settings are saved in the app.)
- Email goes out over any SMTP service, such as Amazon SES, Azure Communication Services, Google Workspace or Postmark. Texts go out via **Twilio**, or through a webhook for any other provider.
- People add their own email address and mobile number under **Settings → My alerts**, even before delivery is set up. Every address and number is confirmed with a one-time code before anything is sent to it, and each person can send themselves a test.
- People can pause all their alerts. Admins get a delivery log with the exact error for anything that failed, and a one-click retry.

### Everywhere
- **Announcements** (Settings → Announcements): a banner across the top of every page for everyone signed in. **Yellow** service advisories pulse gently and can be hidden; **red** action-required notices pulse and stay until they end. Post now or schedule a start and end time; they appear within about 15 seconds. Needs the *Post announcements* permission (Administrators have it).
- **Light, dark, or match the device**, chosen per person under **Settings → Appearance** and saved to their account. Every screen works on phones.
- Links such as `/#ticket-1042`, `/#task-88` and `/#project-3` open directly to the right item.

## Accounts and access levels

**Forgot password?** On the sign-in page, anyone (Administrators included) can ask for a **temporary passphrase**, such as `maple-otter-quartz-lantern-42`, to be emailed to the address on their account. It works once, for 30 minutes, and leads straight to choosing a new password. Their old password keeps working until then, so nobody can lock someone out by requesting resets. Account managers can also send one from **Settings → Users → Email passphrase**. Email must be set up (Settings → Alert setup); without an email address on the account, an admin resets the password instead.

**Accounts.** People sign in with a **username**, not an email address. An account manager adds each person under **Settings → Users** with a name, a username, an optional email (used only for alerts) and an **access level**. Lighthouse makes up a **temporary password** and shows it once, with a Copy button, so it can be handed over directly. At first sign-in the person must choose their own password. "Reset password" makes a new temporary password and signs the person out everywhere.

**Access levels** are named sets of permissions that Administrators create and edit under **Settings → Access levels**, by ticking boxes. Nothing about who can do what is fixed in code. A new desk starts with three levels:

| Level | Starts with | Editable? |
|---|---|---|
| **Administrator** | Every permission, including managing access levels and setting up email and text delivery. | No. It always has everything and can't be deleted, so there is always a way back in. |
| **Technician** | Raise, see, work, take and assign tickets; internal notes; use and create projects. | Yes: rename, change or delete. |
| **Requester** | Raise tickets and follow only their own. | Yes. |

The permissions you can tick:

| Area | Permission | What it allows |
|---|---|---|
| Tickets | Raise tickets | Open new tickets and follow the ones they raised. |
| | See every ticket | Without it, a person only sees tickets they raised. |
| | Work tickets | Change status, priority and category; resolve and reopen. |
| | Can be assigned tickets | Appear in assignee lists, take tickets, join resolver groups. |
| | Assign and route tickets | Assign to anyone assignable and move tickets between groups. |
| | Read and write internal notes | Internal notes are invisible without it. |
| | Delete tickets | Permanently remove a ticket and its history. |
| | Change SLA targets | Set the hours each priority has to be resolved in. |
| | Manage resolver groups | Create, rename and delete groups; choose members and leads. |
| Projects | Use projects | See the Projects tab; add, edit and complete tasks. |
| | Create projects | Start new projects (the creator owns them). |
| | Manage every project | Archive, delete or re-own any project, not just their own. |
| Admin | Manage user accounts | Add people, reset passwords, deactivate, choose access levels. |
| | Post announcements | Post, edit and end the banners at the top of every page. |
| | See the alert delivery log | Every email and text sent, with retry. |

**Safety rules**, enforced on the server:

- Someone who manages user accounts but isn't an Administrator can only give out levels whose permissions they hold themselves, and can't change anyone whose level goes beyond their own. Only Administrators can make someone an Administrator.
- Nobody can change their own level or deactivate themselves, and the last active Administrator can't be demoted or deactivated.
- When a person loses a permission (a new level, an edited level, or deactivation), the work that needed it is released: their tickets and tasks are unassigned and they leave groups and projects they can no longer be part of.
- A level can only be deleted when nobody is on it.
- Every change to accounts and levels is written to the audit log, including which permissions were added or removed.

## Try it locally (5 minutes)

You need Node.js 22.13 or newer (`node -v`).

```bash
unzip lighthouse.zip && cd lighthouse
npm start
```

The terminal prints a **setup code**. Open <http://localhost:3000>, enter the code, and create your Administrator account (name, username, password; email is optional). Then:

1. **Settings → Access levels:** look over Technician and Requester, and add your own (for example a *Shift lead* who can manage resolver groups).
2. **Settings → Users → Add user:** create a technician and a requester. Each gets a temporary password that is shown once.
3. **Tickets → Resolver groups → New group:** for example "Hardware Break/Fix". Add your technician.
4. **Tickets → New ticket:** raise one and work it through the queues.
5. **Projects → New project:** start from the *Rack build-out* template, then switch between **List** and **Board** and drag a task to another column.

Your data is in `./data/lighthouse.db`. Delete the `data` folder to start over.

**On Windows:** install Node.js (`winget install OpenJS.NodeJS.LTS`), extract the zip, and double-click `windows\start-lighthouse.cmd`. See [docs/WINDOWS.md](docs/WINDOWS.md).

The process shows as `lighthouse` in `ps`, `top` and journalctl on Linux, and as `lighthouse.exe` in Task Manager when started with the Windows script.

**With Docker** instead: run `docker compose up -d --build`, then `docker compose logs lighthouse | grep -A1 "No users yet"`. The `env_file` entry in `docker-compose.yml` needs Docker Compose 2.24 or newer.

## Deploying for real

Lighthouse is one Node process and one SQLite file, so it runs on **one Linux server with a real disk**.

That rules out:

- serverless platforms (Lambda, Workers),
- platforms whose only storage is a network file share (Azure App Service with Azure Files, ECS with EFS), because SQLite's locking is unreliable there,
- running several copies at once, since each would have its own database.

One small server comfortably handles hundreds of users.

| Guide | Best for |
|---|---|
| [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md) | A server you already have (in your rack, at home, or in any cloud) published through **Cloudflare Tunnel**. No open inbound ports, and optional **Cloudflare Access** adds SSO and MFA in front. This is the most secure option. |
| [docs/DEPLOY-AWS.md](docs/DEPLOY-AWS.md) | **AWS EC2** (or Lightsail): encrypted EBS, an Elastic IP, Caddy for HTTPS, backups to a write-only S3 bucket, EBS snapshots, and **Amazon SES** for alert email. |
| [docs/DEPLOY-AZURE.md](docs/DEPLOY-AZURE.md) | **An Azure VM**: a managed disk, a static IP, Caddy for HTTPS, backups to an immutable Blob container, Azure Backup, and **Azure Communication Services** for alert email. |
| [docs/LINUX-SERVER.md](docs/LINUX-SERVER.md) | The shared server setup all three guides use: Node, a sandboxed systemd service, Caddy, the firewall, backups, upgrades and troubleshooting. |
| [docs/WINDOWS.md](docs/WINDOWS.md) | **A Windows PC**, for trying it out or a small team on your network. Runs as `lighthouse.exe` and can start with Windows through Task Scheduler. |
| [docs/ALERTS.md](docs/ALERTS.md) | Turning on email and text alerts, with step-by-step settings for SES, Azure Communication Services, Google Workspace, Microsoft 365 and Twilio. |

Ready-made files for those guides live in `deploy/`: the systemd unit, the env file template (including every alert setting), the Caddyfile, and the backup script with its nightly timer.

## Email and text alerts

Alerts are optional. Without them Lighthouse works as normal, and people just check their queues. To turn them on:

1. As an Administrator, open **Settings → Alert setup**. Enter your mail service (there are quick-fill choices for Amazon SES, Microsoft 365, Google Workspace and Azure) and, for texts, your Twilio details. Where to find each value is in [docs/ALERTS.md](docs/ALERTS.md).
2. Use **Send test** on each card. When the test arrives, select **Save**. The card shows **On**.
3. Each person opens **Settings → My alerts**, adds and verifies their mobile number (and an email address, if their account doesn't have one), and picks their alerts. Sensible defaults are already on: email for assignments, P1/P2 tickets in your groups, SLA warnings, replies and task changes. Texts default to SLA breaches only.

Carrier "email-to-text" addresses (`number@vtext.com` and similar) are not supported. AT&T and T-Mobile have shut theirs down, and Verizon's is being retired.

## Configuration

Settings are environment variables. On a server they live in `/etc/lighthouse/lighthouse.env`; the template is `deploy/lighthouse.env.example`. Put comments on their own lines, and wrap values that contain spaces or `<` in double quotes.

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | *(unset)* | The exact address people use, such as `https://desk.example.com`. State-changing requests must come from this origin, and links in alerts use it. **Set it in production.** |
| `COOKIE_SECURE` | `false` | `true` when served over HTTPS. Makes the session cookie `__Host-` and Secure, and turns on HSTS. |
| `TRUST_PROXY` | `false` | `true` when Caddy, nginx, a load balancer or cloudflared sits in front. |
| `TRUST_PROXY_HOPS` | `1` | How many proxies append to `X-Forwarded-For`. |
| `CLIENT_IP_HEADER` | *(unset)* | Read the client IP from this header, e.g. `cf-connecting-ip` behind Cloudflare Tunnel. Only safe when the app is reachable solely through that proxy. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Where to listen. Use `HOST=127.0.0.1` behind a local proxy. |
| `DATA_DIR` | `./data` | Folder for `lighthouse.db`, created with mode 700. |
| `TZ` | system | Time zone for daily task reminders and times in alerts, e.g. `America/Chicago`. |
| `SETUP_TOKEN` | *(random)* | Choose the first-run setup code yourself. |
| `SESSION_DAYS` | `7` | How long a sign-in lasts. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | *(unset)* | Email alerts, if you'd rather keep them in the env file than enter them in the app. Settings saved in the app take over from these. |
| `SMTP_CA_FILE` | *(unset)* | Extra CA certificate (PEM) to trust for the mail server, for an internal relay with a private CA. |
| `LIGHTHOUSE_SECRET_KEY` | *(a key file)* | The key that encrypts passwords entered under Settings → Alert setup. By default it's generated into `DATA_DIR/lighthouse.key`. Set this (64 hex characters) only if you want to keep the key outside the data folder. |
| `SMS_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_FROM` | *(unset)* | Text alerts. See [ALERTS.md](docs/ALERTS.md#part-2-text-messages-twilio). |
| `SMS_MAX_PER_HOUR` / `SMS_MAX_PER_USER_PER_HOUR` | `60` / `15` | Caps on texts per hour, desk-wide and per person. |
| `SMS_INCLUDE_DETAILS` | `true` | `false` keeps ticket and task titles out of texts (ID and link only). |
| `ALERT_DAILY_HOUR` | `8` | Hour (server time) after which daily task due-date reminders go out. |

## Security

This version was reviewed for application security, and the new Projects and alert features were reviewed the same way. The full report is in [SECURITY-REVIEW.md](SECURITY-REVIEW.md). Highlights:

- **First-run setup** requires a one-time code from the server log.
- **Passwords** are hashed with scrypt off the main thread and throttled per account and per IP. Admin-issued passwords are temporary.
- **Sessions** use HttpOnly, `SameSite=Strict`, `__Host-` cookies holding hashed random tokens. Sessions are revoked on deactivation and on password reset.
- **CSRF** is blocked three ways: the SameSite cookie, a required custom header, and origin and fetch-metadata checks.
- **A strict Content Security Policy** allows no inline script or style. HSTS, COOP/CORP and frame blocking are also on.
- **Permission-based access.** Every API route checks a named permission from the person's access level. People without "See every ticket" only get their own tickets; internal notes and projects need their own permissions. Account managers can't grant more than they hold.
- **Alerts:**
  - Email always uses TLS with certificate verification.
  - Secrets live only in the env file and never appear in the database, UI, logs or error messages.
  - Every phone number and alert address is verified with a one-time code before use.
  - Texts are capped per hour.
  - Alert links are built from `PUBLIC_URL`, never from request headers.
- **Audit log:** sign-ins, failures, account and access-level changes, deletions, alert contact changes and blocked requests are written as JSON lines.
- **Hardened runtime:** the systemd unit is sandboxed, the container is read-only with no capabilities, and database files are mode 600.

For an internet-facing desk, the biggest additional step is putting **Cloudflare Access** (or another identity-aware proxy) in front for single sign-on and MFA.

## Operations

| Task | How |
|---|---|
| Back up now | `npm run backup -- /path/to/copy.db`. On a server: `sudo systemctl start lighthouse-backup`. |
| Restore | Stop the app, replace `lighthouse.db` (remove any `-wal`/`-shm` files), and start the app. See [LINUX-SERVER.md §10](docs/LINUX-SERVER.md#10-nightly-backups). |
| Attached files | Stored in `DATA_DIR/attachments`, next to the database. The nightly backup script saves them as `attachments-<date>.tar.gz` alongside the database copy. |
| Encryption key | `DATA_DIR/lighthouse.key` decrypts the mail and Twilio passwords saved in the app. Backups of the database don't include it, on purpose. Keep a copy somewhere safe (a password manager), or re-enter those passwords after restoring onto a new server. |
| Locked out of every admin | `npm run reset-password -- <username> "temporary-password" --admin` (moves that person to Administrator) |
| Run the tests | `npm test` (81 automated tests; no network needed) |
| Check alerts | **Settings → Alert delivery** shows channel status, 24-hour counts and every send with its error. |
| View security events | `journalctl -u lighthouse -o cat \| grep '^{"ts"'` |
| Health check | `GET /healthz` returns `ok`. |
| Upgrade | Back up, replace the code, and restart. Schema changes apply automatically. |

**Upgrading from 1.5 to 1.6:** `git pull` and restart. Administrators can post announcements straight away; tick *Post announcements* on any other level that should.

**Upgrading from 1.4 to 1.5:** pull or unpack the new version and restart (`cd /opt/lighthouse && git pull && systemctl restart lighthouse`). Existing tickets keep their categories; the new ones appear in the menu. Nothing to configure, but emailed resets need email set up under Settings → Alert setup.

**Upgrading from 1.3 to 1.4:** start 1.4 against the same `DATA_DIR`. Nothing to do: SLA targets start at the old fixed values, and email and text settings keep coming from the env file until you save them in the app. Confirmed phone numbers and alert addresses stay confirmed. Administrators automatically get the two new permissions; give *Change SLA targets* to other levels if you want.

**Upgrading from 1.2 to 1.3:** start 1.3 against the same `DATA_DIR`. Sign-in changes from email to **username**: every existing account gets a username made from the part of its email before the `@` (for example `ada.lovelace@example.com` becomes `ada.lovelace`; a clash gets a number added, like `ada.lovelace2`). Passwords, tickets, alerts and everything else are kept. Old roles become access levels: admin → Administrator, technician → Technician, requester → Requester. Tell your team their new usernames (they're listed under Settings → Users).

**Upgrading from 1.1:** start 1.2 against the same `DATA_DIR`. The database gains the projects and alert tables, and every existing ticket, user and group is kept. Existing users start with the default alert settings, and nothing is sent until an admin configures email or texts.

## Customising

Every number and fixed list lives in one place, with a name that says what it is:

- **SLA targets, email and text setup:** in the app (Settings → SLA targets, Settings → Alert setup). The starting SLA values are in `lib/constants.js`.
- **Categories (and their groups), statuses, length limits, file size limits, rate limits, timeouts:** `lib/constants.js` (`TICKET_CATEGORY_GROUPS` for categories).
- **Which permissions exist and the starting access levels:** `lib/access.js`. (Day to day, change access levels in the app, not here.)
- **Project templates** (sections and starter tasks): `lib/project-templates.js`.
- **Which alerts exist and their defaults:** `alerts/events.js`.
- **Priority hints on the new-ticket form:** `PRIORITY_INFO` at the top of `public/tickets.js`.
- **Colours and fonts:** the tokens at the top of `public/styles.css`.

## Project layout

```
server.js              starts the app (everything else is required from lib/app.js)
lib/
  app.js               builds the router, services and routes; request handling, CSRF checks, rate limits
  config.js            reads every environment variable into one frozen settings object
  constants.js         named limits, timings and fixed lists
  access.js            the permission catalogue, starting access levels, can()/isAdministrator()
  db.js, migrations.js SQLite file, schema and numbered migrations
  sessions.js          sign-in sessions (hashed tokens, cookies)
  people.js            what each viewer may see about a person; usernames; releasing work on permission loss
  passwords.js         scrypt hashing, password rules, temporary password generator
  desk-settings.js     SLA targets and email/text setup saved in the app
  secrets.js           encrypts passwords saved in the app (key in DATA_DIR/lighthouse.key)
  photos.js            checks uploaded photos and strips their hidden metadata
  password-reset.js    emailed one-time passphrases ("Forgot password?")
  ticket-extras.js     reads a ticket's tags, links and files; tag rules
  attachment-files.js  where attached files live on disk, and which ones are pictures
  http.js              JSON, cookies, static files, security headers, input checks
  rate-limit.js, audit.js, project-templates.js
routes/                one file per area: auth, me, users, access-levels, groups, tickets, projects, alerts,
                       desk-settings, photos, ticket-links, ticket-tags, attachments, announcements
alerts/                events.js (alert types), messages.js (wording), notify.js (who gets what),
                       delivery.js (outbox and retries), mailer.js (SMTP client), sms.js (Twilio / webhook)
public/                index.html, core.js (shell, tabs, theme, photos, forgot password), tickets.js,
                       ticket-extras.js (tags, files, links in the ticket panel), projects.js,
                       settings.js (My profile, My alerts, Appearance, Password), settings-admin.js, styles.css
scripts/               backup.js, reset-password.js
windows/               start-lighthouse.cmd / .ps1 (runs as lighthouse.exe)
tests/                 npm test: accounts, access levels, tickets, projects, alerts, alert setup,
                       SLA targets, photos, tags, links, attachments, password reset, upgrade from 1.2
deploy/                systemd unit, env template, Caddyfile, backup script and timer
docs/                  deployment guides and alert setup
SECURITY-REVIEW.md     application security review
```
