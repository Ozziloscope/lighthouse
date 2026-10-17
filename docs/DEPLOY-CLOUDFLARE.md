# Deploying Lighthouse with Cloudflare

## Which Cloudflare setup this is

Lighthouse is a Node.js server that keeps its data in a SQLite file on local disk. That shapes how it can run on Cloudflare:

- **Cloudflare Workers and Pages can't run it.** They don't run a long-lived Node HTTP server or keep a local database file.
- **Cloudflare Containers** have disks that are wiped when the container stops, so your tickets would vanish.

The setup that works, and the one Cloudflare designs for self-hosted apps, is **Cloudflare Tunnel**:

```
Browser ──HTTPS──▶ Cloudflare edge ──(outbound-only tunnel)──▶ cloudflared on your server ──▶ Lighthouse 127.0.0.1:3000
```

- **Lighthouse runs on any Linux machine you control**: a server in your rack, a small VM at AWS or Azure, or a mini PC at home.
- **`cloudflared` dials out to Cloudflare.** Your server needs **no open inbound ports, no public IP, and no certificate**. Cloudflare serves HTTPS on your hostname.
- **Optionally, Cloudflare Access** (part of Cloudflare Zero Trust) puts a sign-in gate in front of the whole site. Only people you allow can even reach the Lighthouse login page. For a desk exposed to the internet, this is the single biggest security upgrade available. It's free for up to 50 users.

> **Dashboard labels change.** Cloudflare renames menus fairly often. The paths below match Cloudflare's documentation as of October 2026. If a label differs, search the Cloudflare docs for "Create a tunnel (dashboard)" or "Publish a self-hosted application".

## What you need

- A Cloudflare account (the free plan is fine).
- A domain whose DNS is managed by Cloudflare (**Websites → Add a domain**, then change your registrar's nameservers to the two Cloudflare gives you). Wait until the domain shows **Active**.
- A Linux server with outbound internet access and SSH access for you.

Throughout this guide the hostname is `desk.example.com`. Use your own.

---

## Step 1: Install Lighthouse on the server

Follow [LINUX-SERVER.md](LINUX-SERVER.md) **steps 1 to 6**. In step 5, set these values in `/etc/lighthouse/lighthouse.env`:

```ini
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://desk.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
CLIENT_IP_HEADER=cf-connecting-ip
```

`CLIENT_IP_HEADER=cf-connecting-ip` tells Lighthouse to take the visitor's real IP from Cloudflare, so login throttling and the audit log see real addresses. This is only safe because `HOST=127.0.0.1` means nothing but the local `cloudflared` can reach the app. **Do not** combine `CLIENT_IP_HEADER` with a publicly reachable port.

Restart and check:

```bash
sudo systemctl restart lighthouse
curl -s http://127.0.0.1:3000/healthz    # ok
```

## Step 2: Create the tunnel in the Cloudflare dashboard

1. Log in to the Cloudflare dashboard and go to **Networking → Tunnels**.
2. Select **Create a tunnel**.
3. Name it, for example `lighthouse`, then select **Create Tunnel**.
4. Under the operating system choices, pick **Debian** (it also covers Ubuntu) and your architecture (64-bit, or arm64 for ARM servers).
5. The dashboard shows two command blocks: one installs `cloudflared`, and one ends in `sudo cloudflared service install <long token>`. **Copy both and run them on the server.**

   The token is a credential. Don't paste it into chat, tickets, or screenshots.

   If you'd rather install the package yourself, these commands set up Cloudflare's official repository:

   ```bash
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   ```

   Then run only the `sudo cloudflared service install <token>` line from the dashboard.
6. Back in the dashboard, wait until the connector shows **Connected**, then select **Continue**.

On the server, confirm the service is running and set to start at boot:

```bash
systemctl status cloudflared --no-pager
systemctl is-enabled cloudflared     # enabled
```

## Step 3: Publish Lighthouse on your hostname

1. Go to **Networking → Tunnels** and select the `lighthouse` tunnel.
2. On the **Routes** tab, select **Add route → Published application**.
3. **Subdomain:** `desk`. **Domain:** `example.com`. Leave **Path** empty.
4. **Service URL:** `http://localhost:3000`
5. Select **Add route**.

Cloudflare creates the DNS record for `desk.example.com` automatically. Use a single-level subdomain such as `desk.example.com`. Deeper names like `desk.ops.example.com` need a paid Advanced Certificate.

Open `https://desk.example.com`. You should see the **Set up your desk** page. Don't create the admin yet if you plan to add Cloudflare Access in step 4. Doing that first means nobody else can reach the setup page in the meantime.

## Step 4 (strongly recommended): Lock the site to your team with Cloudflare Access

Without this step, anyone on the internet can reach your login page. With it, Cloudflare checks identity before any request reaches your server.

1. In the dashboard, go to **Zero Trust**. The first time, Zero Trust asks you to pick a team name and plan. The **Free** plan covers 50 users.
2. Go to **Zero Trust → Access controls → Applications** and select **Create new application**.
3. Choose **Self-hosted and private**, then **Add public hostname**.
4. **Subdomain:** `desk`. **Domain:** `example.com`.
5. Under **Access policies**, create a policy:
   - **Name:** `Ops team`
   - **Action:** Allow
   - **Include:** *Emails ending in* `@yourcompany.com`, or list individual *Emails*.
6. **Identity providers:** the built-in **One-time PIN** emails a code to the address entered. If your company uses Microsoft Entra ID, Google Workspace, or Okta, add it under **Zero Trust → Integrations → Identity providers** first and choose it here. That gives you single sign-on and the multi-factor authentication your company already enforces.
7. **Session Duration:** 24 hours is a sensible default.
8. Select **Create**.

Test it in a private browser window. `https://desk.example.com` should now show a Cloudflare sign-in page first. After passing it, you reach Lighthouse's own sign-in.

## Step 5: Turn off Cloudflare features that inject scripts

Lighthouse sends a strict Content Security Policy that only allows its own scripts. Some Cloudflare optimisations inject extra scripts, which the browser will block (with console errors) or which can break pages. For the `example.com` zone:

| Setting | Where (zone dashboard) | Set to |
|---|---|---|
| Rocket Loader | **Speed → Optimization → Content Optimization** | Off |
| Email Address Obfuscation | **Security → Settings** (or **Scrape Shield**) | Off |
| Always Use HTTPS | **SSL/TLS → Edge Certificates** | On |
| Minimum TLS Version | **SSL/TLS → Edge Certificates** | TLS 1.2 |
| HSTS | **SSL/TLS → Edge Certificates** | Optional. Lighthouse already sends its own HSTS header. |

If you'd rather leave these zone-wide, create a **Configuration Rule** for `desk.example.com` that disables Rocket Loader and Email Obfuscation only for this hostname.

Caching: Cloudflare doesn't cache API responses, because Lighthouse marks them `no-store`. Leave the default cache level. **Don't** add a "Cache Everything" rule for this hostname.

## Step 6: Create the admin account

Get the one-time setup code on the server:

```bash
sudo journalctl -u lighthouse --no-pager | grep -A1 "No users yet"
```

Then open `https://desk.example.com`, enter the code, and create your admin account. Continue with [LINUX-SERVER.md](LINUX-SERVER.md) **step 9** to add users and groups.

## Step 7: Firewall, backups and updates

- **Firewall:** follow [LINUX-SERVER.md](LINUX-SERVER.md) **step 8, the Cloudflare Tunnel variant**. Only SSH needs to be allowed in, and port 3000 stays closed.
- **Backups:** follow **step 10**. For an off-site copy without opening anything inbound, use an S3 bucket (see the backup section of the AWS guide) or Cloudflare R2. R2 is S3-compatible: create a bucket and an R2 API token, then install the AWS CLI (`sudo snap install aws-cli --classic`) and put this in `/etc/lighthouse/backup.env` (mode 600):

  ```ini
  S3_URI=s3://your-bucket-name
  AWS_ENDPOINT_URL=https://<accountid>.r2.cloudflarestorage.com
  AWS_DEFAULT_REGION=auto
  AWS_ACCESS_KEY_ID=<R2 token access key>
  AWS_SECRET_ACCESS_KEY=<R2 token secret>
  ```

  Give the R2 token **Object Read & Write** on that one bucket only.
- **cloudflared updates:** it comes from Cloudflare's apt repository, so `sudo apt upgrade` keeps it current.

## Step 8 (optional): Email and text alerts

Cloudflare Tunnel only carries traffic *into* Lighthouse. Alerts go *out* directly from your server, so the server needs outbound internet access to your email service (TCP 587) and to `api.twilio.com` (TCP 443).

Cloudflare doesn't provide an SMTP service for this, so use any SMTP provider: Amazon SES, Azure Communication Services, Google Workspace, Postmark, Mailgun or your company's mail server. Step-by-step settings for each are in [ALERTS.md](ALERTS.md). Add them to `/etc/lighthouse/lighthouse.env`, run `sudo systemctl restart lighthouse`, and check **Settings → Alert delivery**.

With Cloudflare Access in front, the links in alert emails still work: people sign in through Access first and then land on the ticket.

## Checking that it's working

```bash
# On the server: tunnel connected and app healthy
systemctl status cloudflared --no-pager | head -5
curl -s http://127.0.0.1:3000/healthz

# From anywhere: HTTPS, security headers, and (with Access) a redirect to Cloudflare's login
curl -sI https://desk.example.com | grep -iE 'HTTP/|location|strict-transport|content-security'
```

After you sign in once, the security log should show your real IP rather than `127.0.0.1`:

```bash
sudo journalctl -u lighthouse -o cat | grep login.success | tail -1
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows Cloudflare error **1033** or **502 Bad Gateway** | The tunnel is down or Lighthouse isn't running. Run `systemctl status cloudflared lighthouse`. Check that the route's service URL is exactly `http://localhost:3000`. |
| Every save fails with "Request blocked. Reload the page" | `PUBLIC_URL` must be exactly `https://desk.example.com`. Restart Lighthouse after fixing it. |
| Console shows CSP errors mentioning `rocket-loader` or `email-decode` | Do step 5. |
| Every person shows the same IP in the logs | `CLIENT_IP_HEADER=cf-connecting-ip` or `TRUST_PROXY=true` is missing from the env file. |
| You're asked to sign in twice | Expected with Cloudflare Access: once at Cloudflare (who you are) and once in Lighthouse (your username and access level). |

## Sources

- [Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Create a locally-managed tunnel (includes the apt repository commands)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/local-management/create-local-tunnel)
- [Publish a self-hosted application with Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
