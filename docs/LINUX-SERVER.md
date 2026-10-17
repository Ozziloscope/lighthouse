# Installing Lighthouse on a Linux server

These are the steps every deployment shares, whether the machine is an AWS EC2 instance, an Azure VM, a box in your own rack behind Cloudflare Tunnel, or a spare server at home. Each cloud guide sends you here at the right moment and tells you which variant of steps 7 and 8 to use.

They assume **Ubuntu Server 26.04 LTS or 24.04 LTS** and a user with `sudo`. Other systemd distributions work with their own package commands.

**What you end up with**

```
Browser ──HTTPS──▶ Caddy :443  (or cloudflared)  ──HTTP──▶ Lighthouse 127.0.0.1:3000 ──▶ /var/lib/lighthouse/lighthouse.db
```

| Path | Owner | Purpose |
|---|---|---|
| `/opt/lighthouse` | root (read-only to the app) | Application code |
| `/etc/lighthouse/lighthouse.env` | root, mode 600 | Configuration |
| `/var/lib/lighthouse` | `lighthouse` user, mode 700 | Database |
| `/var/backups/lighthouse` | root, mode 700 | Nightly backups |

The application runs as an unprivileged `lighthouse` user under a sandboxed systemd unit that can only write to its data directory.

---

## 1. Update the system

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unzip curl
```

Ubuntu installs security updates automatically through `unattended-upgrades`. Confirm it is on:

```bash
systemctl is-enabled unattended-upgrades    # should print: enabled
```

## 2. Install Node.js (22.13 or newer)

Check what the system offers:

```bash
apt-cache policy nodejs | head -3
```

**Ubuntu 26.04** ships Node 22.22, which is new enough:

```bash
sudo apt install -y nodejs
```

**Ubuntu 24.04** ships Node 18, which is too old. Install Node 24 LTS from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh          # read it before running it as root
sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
```

Confirm:

```bash
node -v      # v22.13.0 or later, or v24.x
```

## 3. Create the service account and folders

```bash
sudo useradd --system --home-dir /var/lib/lighthouse --shell /usr/sbin/nologin lighthouse
sudo install -d -o lighthouse -g lighthouse -m 700 /var/lib/lighthouse
sudo install -d -o root -g root -m 755 /opt/lighthouse
sudo install -d -o root -g root -m 755 /etc/lighthouse
```

## 4. Copy the application to the server

From **your own computer**, in the folder that holds `lighthouse.zip`:

```bash
scp lighthouse.zip ubuntu@SERVER_ADDRESS:/tmp/
```

(Use `azureuser@` on Azure, or whatever username your server uses.)

Then **on the server**:

```bash
sudo unzip -o /tmp/lighthouse.zip -d /opt/
sudo chown -R root:root /opt/lighthouse
sudo chmod -R u=rwX,go=rX /opt/lighthouse
rm /tmp/lighthouse.zip
ls /opt/lighthouse      # server.js, public/, deploy/, docs/ ...
```

The code belongs to root and the app user can only read it. Even if the app were compromised, it could not modify its own code.

## 5. Configure

```bash
sudo cp /opt/lighthouse/deploy/lighthouse.env.example /etc/lighthouse/lighthouse.env
sudo chmod 600 /etc/lighthouse/lighthouse.env
sudo nano /etc/lighthouse/lighthouse.env
```

At minimum, set `PUBLIC_URL` to your real address, for example `https://desk.example.com`, and set `TZ` to your team's time zone, for example `TZ=America/Chicago`. To send email and text alerts, also fill in the alert section of the file using [ALERTS.md](ALERTS.md). You can do that later. Your cloud guide lists any other values to change. Every setting is explained in the [README](../README.md#configuration).

## 6. Start Lighthouse

```bash
sudo cp /opt/lighthouse/deploy/lighthouse.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lighthouse
sudo systemctl status lighthouse --no-pager
curl -s http://127.0.0.1:3000/healthz      # prints: ok
```

**Get the one-time setup code.** You'll need it to create the first admin account:

```bash
sudo journalctl -u lighthouse --no-pager | grep -A1 "No users yet"
```

The code only appears while there are no users. If you set `SETUP_TOKEN` in the env file, use that value instead.

## 7. Put HTTPS in front

Pick the variant your guide tells you to use.

### 7a. Caddy (AWS, Azure, or any server with a public IP)

Before you start, the DNS record for your hostname must already point at this server's public IP, and ports 80 and 443 must be open. Caddy uses them to obtain the certificate.

Install Caddy from its official repository:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Configure it:

```bash
sudo cp /opt/lighthouse/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/desk.example.com/YOUR.HOSTNAME/' /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Check it. The first request may take a few seconds while the certificate is issued.

```bash
curl -sI https://YOUR.HOSTNAME | head -5      # HTTP/2 200 and a strict-transport-security header
sudo journalctl -u caddy --no-pager | tail -20  # look for "certificate obtained successfully"
```

Env file values for this variant: `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=1`, and leave `CLIENT_IP_HEADER` commented out.

### 7b. Cloudflare Tunnel

Follow [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md). Caddy is not needed, and no inbound ports need to be open.

After changing the env file, always restart the app:

```bash
sudo systemctl restart lighthouse
```

## 8. Host firewall

The cloud firewall (AWS security group or Azure NSG) is the main control. Turning on `ufw` adds a second layer.

**With Caddy (7a):**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

**With Cloudflare Tunnel (7b):** allow only SSH, or nothing at all if you use AWS Session Manager or Azure Bastion.

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

Port 3000 never needs to be open: Lighthouse listens on 127.0.0.1 only.

## 9. Create the admin account

1. Open `https://YOUR.HOSTNAME`.
2. Enter the setup code from step 6, your name, a **username** (what you'll sign in with), an optional email for alerts, and a password of 10 or more characters. This account is on the built-in **Administrator** access level, which always has every permission.
3. Under **Settings → Access levels**, review the starting Technician and Requester levels and create any others you need by ticking permissions.
4. Under **Settings → Users**, add your team: name, username, optional email and access level. Lighthouse shows a temporary password once; hand it over directly. Each person chooses their own password at first sign-in.
5. Under **Tickets → Resolver groups**, create your groups and add the people who take tickets.

## 10. Nightly backups

```bash
sudo install -m 755 /opt/lighthouse/deploy/lighthouse-backup.sh /usr/local/bin/lighthouse-backup
sudo cp /opt/lighthouse/deploy/lighthouse-backup.service /opt/lighthouse/deploy/lighthouse-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lighthouse-backup.timer
sudo systemctl start lighthouse-backup.service      # take one now
ls -l /var/backups/lighthouse/
```

Backups run at 02:30 server time and are kept for 14 days. For an off-site copy, see the backup section of your cloud guide. It sets `S3_URI` or `AZ_CONTAINER_URL` in `/etc/lighthouse/backup.env`.

**Restore a backup:**

```bash
sudo systemctl stop lighthouse
sudo -u lighthouse sh -c 'cd /var/lib/lighthouse && mkdir -p pre-restore && mv lighthouse.db* pre-restore/ 2>/dev/null || true'
sudo sh -c 'zcat /var/backups/lighthouse/lighthouse-YYYY-MM-DDTHHMMZ.db.gz > /var/lib/lighthouse/lighthouse.db'
sudo chown lighthouse:lighthouse /var/lib/lighthouse/lighthouse.db && sudo chmod 600 /var/lib/lighthouse/lighthouse.db
sudo systemctl start lighthouse
```

**The encryption key.** Passwords and tokens entered under Settings → Alert setup are encrypted with `/var/lib/lighthouse/lighthouse.key`. Backups contain the database but deliberately not this key, so an off-site backup on its own can't reveal them. Restoring on the same server keeps working, because the key is still there. On a new server, either copy the key back (keep a copy in your password manager: `sudo cat /var/lib/lighthouse/lighthouse.key`), or simply re-enter the mail and Twilio passwords in Settings → Alert setup.

**Test a restore once after setup.** A backup you have never restored is a guess.

## 11. Day-to-day operations

| Task | Command |
|---|---|
| App status | `sudo systemctl status lighthouse` |
| Live log | `sudo journalctl -u lighthouse -f` |
| Security events only | `sudo journalctl -u lighthouse -o cat \| grep '^{"ts"'` |
| Failed sign-ins today | `sudo journalctl -u lighthouse -o cat --since today \| grep login.failure` |
| Restart | `sudo systemctl restart lighthouse` |
| Locked out of every admin | `cd /opt/lighthouse && sudo -u lighthouse env DATA_DIR=/var/lib/lighthouse node --disable-warning=ExperimentalWarning scripts/reset-password.js <username> "temporary-password" --admin` (`--admin` moves that person to the Administrator level) |

**Upgrading to a new version:**

```bash
sudo systemctl start lighthouse-backup.service          # back up first
scp lighthouse.zip ubuntu@SERVER:/tmp/                  # from your computer
sudo rm -rf /opt/lighthouse.old && sudo mv /opt/lighthouse /opt/lighthouse.old
sudo unzip -o /tmp/lighthouse.zip -d /opt/ && sudo chown -R root:root /opt/lighthouse
sudo systemctl restart lighthouse && sudo journalctl -u lighthouse -n 20 --no-pager
```

Database changes apply automatically at startup. To roll back, move `/opt/lighthouse.old` back into place and restore the backup you just took.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `systemctl status` shows `node: not found` or a syntax error | Node is too old or missing. Run `node -v` and redo step 2. |
| `No such built-in module: node:sqlite` | Node is older than 22.13. Upgrade it. |
| Browser shows "Request blocked. Reload the page" on every save | `PUBLIC_URL` doesn't exactly match the address in the browser (scheme, host, and port if any). Fix it and restart. |
| You sign in, then are immediately signed out | `COOKIE_SECURE=true` while you browse over plain `http://`. Use the HTTPS address. |
| Caddy cannot get a certificate | DNS isn't pointing at the server yet, or ports 80/443 are closed in the cloud firewall. |
| Alerts not arriving | Open **Settings → Alert delivery** as an admin. Each failed send shows the exact error, and [ALERTS.md](ALERTS.md#troubleshooting) explains them. |
| An env setting is ignored or broken | Put comments on their own lines. A trailing `# comment` becomes part of the value. Wrap values containing spaces or `<` in double quotes. |
| Every login is throttled at once | Multiple people share one IP and `TRUST_PROXY` is off, or the hop count is wrong. Check that `ip` in the `login.failure` log lines shows real client addresses. |
