# Email and text alerts

Lighthouse can email people and text their phones when something needs them: a ticket assigned to them, a P1 in their resolver group, an SLA about to run out or already breached, a reply on a ticket they raised, a project task assigned to them or coming due.

Setup has two parts:

1. **An Administrator connects Lighthouse** to an email service and (optionally) a text-message service, under **Settings → Alert setup**. Each card has a **Send test** button that tries the settings *before* you save them and shows the exact error if they're wrong. Passwords and tokens are encrypted when saved and never shown again. (You can put the same settings in the server's environment file instead, as described below for each service. Settings saved in the app take over from the env file. **Go back to the server's env file settings** on the card undoes that.)
2. **Each person chooses their own alerts** under **Settings → My alerts**: which events, email or text or both, and where alerts go.

People can add their own email and mobile number under **My alerts** at any time, even before delivery is set up. Until it is, they're saved as *Not confirmed*; once the channel is on, each person selects **Send confirmation code**. Nothing is ever sent to an unconfirmed address or number.

Email on an account is optional. If an admin entered one under **Settings → Users**, email alerts go there by default. Anyone can add (or change to) a different address from **My alerts**, confirmed with a one-time code. People only see the alert types their access level makes relevant: for example, "New ticket in my groups" needs *Can be assigned tickets*, and the project alerts need *Use projects*.

Alerts are optional. Without this setup, Lighthouse works exactly as before.

---

## What people can be alerted about

| Alert | Who can turn it on | Default |
|---|---|---|
| A ticket is assigned to me | Technicians, admins | Email |
| A new ticket lands in one of my resolver groups (choose: P1 only / P1–P2 / P1–P3 / all) | Technicians, admins | Email, P1–P2 |
| Any ticket anywhere is raised or escalated to P1 | Technicians, admins | Off |
| SLA about to run out (25% of the time left) on my tickets | Technicians, admins | Email |
| SLA breached on my tickets | Technicians, admins | Email **and text** |
| Someone posts an update on a ticket assigned to me | Technicians, admins | Email |
| The desk replies to, needs info on, or resolves a ticket I raised | Everyone, including requesters | Email |
| A project task is assigned to me | Technicians, admins | Email |
| My task is due tomorrow or is overdue | Technicians, admins | Email |
| Someone comments on a task assigned to me or that I created | Technicians, admins | Email |

How alerts are delivered:

- **"My tickets"** for SLA alerts means tickets assigned to you. If a ticket is unassigned, the alert goes to everyone in its resolver group. If it has no group either, it goes to the admins.
- **Texts are only sent to verified numbers.** The "SLA breached" default includes text, but nothing is texted until a person adds and verifies their number.
- **Nobody is alerted about their own changes.**
- **Requesters only hear about public updates.** Internal notes are never emailed or texted to them.
- **SLA and due-date alerts are sent once.** SLA breaches older than 6 hours aren't announced, so restarting or upgrading the server never floods anyone.
- **Task reminders go out once a day**, from `ALERT_DAILY_HOUR` (8 am by default) in the server's time zone.
- **Failed sends are retried 4 more times** (after 1, 5, 15 and 60 minutes) before being marked failed in the delivery log.

---

## Part 1: Email (any SMTP service)

Lighthouse sends email over SMTP, which nearly every email service supports. Connections are always encrypted, with STARTTLS on port 587 or TLS on port 465, and the server's certificate is always verified.

**In the app:** open **Settings → Alert setup → Email**. Choose your service under *Fill in server details for* (or type the server and port), then enter the username, password and *Send from* address. Enter your own address under *Send a test to*, select **Send test**, and once the test email arrives select **Save email settings**. The rest of this part explains where to find those values for each service.

**Or in the env file:** add these settings to `/etc/lighthouse/lighthouse.env`. With Docker, put them in `lighthouse-alerts.env` next to `docker-compose.yml` and run `chmod 600` on that file:

```ini
SMTP_HOST=smtp.example.com
SMTP_PORT=587
# starttls for port 587, tls for port 465
SMTP_SECURE=starttls
SMTP_USER=the-smtp-username
SMTP_PASS=the-smtp-password
SMTP_FROM="Lighthouse Service Desk <desk@yourcompany.com>"
```

Keep the double quotes around `SMTP_FROM`, because the value contains spaces and `<`. Put comments on their own lines starting with `#`. The environment file does not support comments at the end of a setting line.

Then restart Lighthouse. The startup log should say `Alerts: email on via smtp.example.com:587`:

```bash
sudo systemctl restart lighthouse
sudo journalctl -u lighthouse -n 20 --no-pager | grep Alerts
```

Below are step-by-step settings for the common services. Pick one.

### Amazon SES (good fit if you deployed on AWS)

1. Open the **Amazon SES** console in the same region as your server.
2. **Verify your sending domain.** Go to **Configuration → Identities → Create identity → Domain**, enter `yourcompany.com`, and add the DKIM CNAME records SES shows you to your DNS. If you use Route 53, SES can add them for you. Wait for the identity to show **Verified**.
3. **Request production access.** New SES accounts start in a *sandbox* that can only email addresses you have verified individually. Go to **Account dashboard → Request production access**, describe the use as "transactional alerts from an internal service desk to our own staff", and submit. Until it is approved, verify each staff address under **Identities → Create identity → Email address**.
4. **Create SMTP credentials.** Go to **SMTP settings → Create SMTP credentials**. This creates a dedicated IAM user. Copy the **SMTP user name** and **SMTP password** now, because the password is shown only once. These are not your AWS access keys.
5. Settings:

```ini
# Use your region; the SES console's "SMTP settings" page shows the exact endpoint
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=starttls
SMTP_USER=<SMTP user name from step 4>
SMTP_PASS=<SMTP password from step 4>
SMTP_FROM="Lighthouse Service Desk <desk@yourcompany.com>"
```

Use port **587**, not 25. EC2 throttles outbound port 25 by default.

### Azure Communication Services Email (good fit if you deployed on Azure)

1. In the Azure portal, create an **Email Communication Services** resource in `lighthouse-rg`, then add a domain. Either use the free Azure-managed `*.azurecomm.net` domain, or add your own custom domain and complete its DNS verification.
2. Create a **Communication Services** resource and connect the email domain to it: open the resource, go to **Email → Domains**, and choose **Connect domain**.
3. Create a **Microsoft Entra application**: **Microsoft Entra ID → App registrations → New registration**, named `lighthouse-smtp`. In the app, go to **Certificates & secrets → New client secret** and copy the secret value. That value is the SMTP password.
4. Give the app permission: in the **Communication Services** resource, go to **Access control (IAM) → Add role assignment**, choose role **Communication and Email Service Owner**, and select the `lighthouse-smtp` app.
5. In the Communication Services resource, open **SMTP Usernames → + Add SMTP Username**, pick the app, and enter a username such as `lighthouse`. Wait until it shows **Ready to use**.
6. Settings:

```ini
SMTP_HOST=smtp.azurecomm.net
SMTP_PORT=587
SMTP_SECURE=starttls
# The SMTP username from step 5
SMTP_USER=lighthouse
SMTP_PASS=<client secret value from step 3>
SMTP_FROM="Lighthouse Service Desk <DoNotReply@your-verified-domain>"
```

The `From` address must belong to the domain you connected in step 2. The Entra client secret expires, on the date you chose when you created it. Put a reminder in your calendar to rotate it.

### Google Workspace or Gmail

1. The sending account needs **2-Step Verification** turned on.
2. Go to **Google Account → Security → App passwords**, create one named "Lighthouse", and copy the 16-character password.
3. Settings:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=starttls
SMTP_USER=desk@yourcompany.com
SMTP_PASS=<16-character app password, no spaces>
SMTP_FROM="Lighthouse Service Desk <desk@yourcompany.com>"
```

Gmail limits how much one account can send each day. That is plenty for alerts, but use a dedicated account rather than a person's mailbox.

### Microsoft 365 / Exchange Online

Microsoft is retiring username-and-password (Basic) authentication for SMTP. It is scheduled to be **turned off by default for existing tenants in late December 2026**, and new tenants won't have it at all. Lighthouse signs in with a username and password, so for Microsoft 365 use one of these instead:

- **Azure Communication Services Email** (above). It works with your own domain, and the "password" is an Entra app secret, which stays supported.
- **An SMTP relay connector** in Exchange Online that accepts mail from your server's fixed public IP. Set `SMTP_HOST` to your tenant's MX endpoint (`yourdomain-com.mail.protection.outlook.com`), port 25, `SMTP_SECURE=starttls`, and leave `SMTP_USER`/`SMTP_PASS` empty. Note that EC2 and Azure VMs block or throttle outbound port 25 unless you request an exception.

### Other providers

Any service that offers SMTP with STARTTLS or TLS works. Examples include Postmark, Mailgun, SendGrid, Brevo, Fastmail and your company's own mail server. Use the host, port, username and password from their SMTP settings page.

### A relay on the same machine

If you already run Postfix on the server and it relays to your mail system, use:

```ini
SMTP_HOST=127.0.0.1
SMTP_PORT=25
SMTP_SECURE=none
```

`SMTP_SECURE=none` is accepted **only** for `localhost` / `127.0.0.1`. Lighthouse refuses to send unencrypted mail across a network.

### An internal mail server with a private certificate authority

Lighthouse always checks the mail server's certificate. If your relay's certificate comes from your company's own CA, give Lighthouse that CA certificate (PEM format) rather than turning checks off:

```ini
SMTP_CA_FILE=/etc/lighthouse/mail-ca.pem
```

Make the file readable by the `lighthouse` user (`sudo chown root:lighthouse /etc/lighthouse/mail-ca.pem && sudo chmod 640 /etc/lighthouse/mail-ca.pem`). The normal public CAs are still trusted too.

---

## Part 2: Text messages (Twilio)

### Why not email-to-text?

Texting a phone by emailing `number@carrier-domain` no longer works reliably. AT&T shut down its gateway in June 2025, T-Mobile's went offline at the end of 2024, and Verizon's is being phased out. Text alerts need a messaging provider. Lighthouse has built-in support for **Twilio**, plus a generic webhook for any other provider.

### Set up Twilio

1. **Create a Twilio account** at twilio.com and upgrade it from trial. Trial accounts can only text numbers you have verified one by one, and they add a "trial account" prefix to every message.
2. **Get a sending number.** In the Twilio Console go to **Phone Numbers → Manage → Buy a number**, and buy an SMS-capable number in your country.
3. **Register it for business texting (United States).** US carriers block or filter texts from unregistered numbers. Do **one** of the following:
   - **Toll-free number** (simplest for internal alerts): buy a toll-free number in step 2, then complete **Toll-Free Verification** in the Console. You describe the use case ("internal IT service desk alerts to employees who opted in") and give a sample message.
   - **Local 10-digit number**: complete **A2P 10DLC** registration under **Messaging → Regulatory Compliance**. This means registering a Brand (your company; sole proprietors can register without a tax ID, with lower volume limits) and a Campaign describing the alerts.

   Approval can take from a few days to a few weeks. Outside the US, check Twilio's rules for your country.
4. **Create an API key for Lighthouse.** In the Console go to **Account → API keys & tokens → Create API key**, name it `lighthouse`, and choose type **Standard**. Copy the key's **SID** (starts with `SK`) and **Secret**. The secret is shown only once. Also note your **Account SID** (starts with `AC`) from the Console dashboard. A dedicated key can be revoked on its own without touching your main Auth Token.
5. **In the app:** open **Settings → Alert setup → Text messages**, choose **Twilio**, and fill in the Account SID, API key SID, API key secret and your Twilio number. Enter your mobile number under *Send a test to*, select **Send test**, and once the text arrives select **Save text settings**.

   **Or in the env file:**

```ini
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SID=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY_SECRET=<API key secret>
# Your Twilio number, in + country-code form
TWILIO_FROM=+18885550100
# or, if you set up a Messaging Service, use this instead of TWILIO_FROM:
# TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

(`TWILIO_AUTH_TOKEN=<auth token>` also works in place of the two API key lines, but a dedicated key is safer.)

6. If you used the env file, restart Lighthouse and check the log says `texts on via twilio`.

Twilio's pricing page lists the per-message and per-number costs for your country. For a team getting a handful of urgent alerts a day, the monthly bill is small, and the limits below cap the worst case.

### Cost and abuse limits

| Setting | Default | Meaning |
|---|---|---|
| `SMS_MAX_PER_HOUR` | `60` | Most texts the whole desk may send in an hour. Further texts are skipped and logged. |
| `SMS_MAX_PER_USER_PER_HOUR` | `15` | Most texts one person may receive in an hour. |
| `SMS_INCLUDE_DETAILS` | `true` | Set to `false` to keep ticket and task titles out of texts. Messages then contain only the ticket number and a link. Use this if titles may contain sensitive information, because texts pass through carriers unencrypted. |
| `SMS_DEFAULT_COUNTRY` | `1` | Country code assumed when someone types a number without `+`. |

Every new phone number must be confirmed with a 6-digit code texted to it before Lighthouse will text it. Nobody can point alerts, or your Twilio bill, at someone else's phone.

### Other SMS providers (webhook)

For any other gateway (Amazon SNS, Azure Communication Services SMS, Vonage, a pager service, or your own script), point Lighthouse at a URL that accepts a JSON POST:

```ini
SMS_PROVIDER=webhook
SMS_WEBHOOK_URL=https://sms-bridge.internal.example.com/send
# Sent as "Authorization: Bearer <token>"
SMS_WEBHOOK_TOKEN=<long random string>
```

Lighthouse sends `{"to": "+13175550100", "body": "Lighthouse: ..."}` and treats any 2xx response as success. The URL must be `https://` unless it is on localhost.

---

## Part 3: Make links in alerts work

Every alert links straight to the ticket or task, for example `https://desk.example.com/#ticket-1042`. Those links are built from `PUBLIC_URL`, so make sure it is set to the address people use:

```ini
PUBLIC_URL=https://desk.example.com
```

Without it, alerts still go out, but they say "Open Lighthouse to see it" instead of including a link.

Set the server's time zone so daily task reminders arrive in the morning where your team is:

```ini
TZ=America/Chicago
ALERT_DAILY_HOUR=8
```

---

## Part 4: Check it works

1. If you changed the env file, restart Lighthouse.
2. Sign in as an Administrator and open **Settings → Alert setup**. Both channels should show **On**. If one shows **Off**, the reason is shown on the card.
3. Open **Settings → My alerts**:
   - Under **Email**, add your address if your account doesn't have one (a code is emailed to confirm it), then select **Send a test email**.
   - Under **Text messages**, enter your mobile number, select **Send code**, and enter the code you receive. Then select **Send a test text**.
4. Back on **Alert delivery**, both tests appear under **Recent deliveries** with status **sent**. Failures show the exact error from the mail server or Twilio, and failed alerts can be retried with one click.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| Log says `Email alerts disabled: SMTP_FROM is missing or not a valid address` | Quote the whole value: `SMTP_FROM="Name <addr@domain>"`. |
| `Mail server rejected the username or password: 535` | Wrong SMTP credentials. For SES, use the SMTP credentials, not AWS access keys. For Gmail, use an app password. |
| `Mail server does not offer STARTTLS` | Wrong port. For implicit TLS use `SMTP_PORT=465` and `SMTP_SECURE=tls`. |
| `Could not reach the mail server (timed out)` | Outbound port blocked. AWS throttles 25, so use 587. Check the security group or NSG outbound rules and any corporate firewall. |
| `self-signed certificate` or `unable to verify` | The mail server's certificate isn't trusted. Use the provider's public hostname, not an IP address. For an internal mail server with a private CA, start Lighthouse with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. |
| `Mail server rejected the sender address` | The `From` address or domain isn't verified with the provider (SES identity, ACS domain). |
| SES: `Email address is not verified` | Your SES account is still in the sandbox. Request production access or verify the recipient. |
| `Twilio refused the message: error 20003` | Wrong Account SID, API key or secret (or Auth Token). |
| `Twilio refused the message: error 21211` or `21614` | The number isn't valid or can't receive texts. |
| Texts show **sent** but never arrive (US) | The number isn't registered (toll-free verification or A2P 10DLC). Check **Monitor → Logs → Messaging** in the Twilio Console for carrier errors such as `30034`. |
| Status **skipped: Desk-wide limit… reached** | Raise `SMS_MAX_PER_HOUR` if this is expected. |
| Nobody gets task reminders | `ALERT_DAILY_HOUR` is later than now in the server's time zone, or `TZ` isn't set. |

## Privacy and security notes

- **Credentials** (SMTP password, Twilio API key secret) live only in the environment file, readable by root only. They are never stored in the database, shown in the UI, or written to logs or error messages.
- **Contact details are verified before use.** A new alert address or phone number needs a 6-digit code. Codes expire after 10 minutes, allow 5 attempts, are limited to 5 per person per hour, and are stored only as hashes.
- **Phone numbers are visible to their owner only.** Admins see a masked number (`+•••0101`) in the delivery log.
- **Deactivated or paused people get nothing**, including alerts already queued.
- **Requesters never receive internal notes**, by email or text.
- **The delivery log keeps 30 days** of history, then prunes it automatically. Verification codes are never written to the log.
