# Deploying Lighthouse on Microsoft Azure

## Which Azure setup this is

Lighthouse keeps its data in a SQLite file. SQLite needs a disk attached to one machine, so the right Azure shape is **one Linux virtual machine with a managed disk**:

```
Browser ──HTTPS──▶ Static public IP ──▶ Azure VM [ Caddy :443 ──▶ Lighthouse 127.0.0.1:3000 ──▶ managed disk ]
                                           │
                                           └──▶ nightly backup ──▶ private Blob container (via managed identity)
```

Some Azure services that look like a fit aren't:

- **App Service and Container Apps** can only keep data on Azure Files, which is an SMB network share. SQLite's locking isn't reliable on network shares, so the database can corrupt.
- **Scaling out to more than one instance** doesn't work either: each instance would have its own separate database.

One small VM comfortably handles a desk of hundreds of users.

**Cost:** you pay for one small VM, its disk, a static public IP, a little Blob storage, and Azure Backup if you enable it. Check the [Linux VM pricing page](https://azure.microsoft.com/pricing/details/virtual-machines/linux/) for your region. A **B2s** or similar 2 vCPU / 4 GiB burstable size is plenty, and 2 GiB sizes also work.

Throughout this guide the hostname is `desk.example.com`. Create everything in the same region.

---

## Step 1: Create a resource group

1. In the [Azure portal](https://portal.azure.com), search for **Resource groups** and select **Create**.
2. **Name:** `lighthouse-rg`. **Region:** the one closest to your team.
3. Select **Review + create**, then **Create**.

Everything below goes into `lighthouse-rg`, so you can see the whole deployment, or remove it, in one place.

## Step 2: Create the virtual machine

Search for **Virtual machines**, select **Create → Azure virtual machine**, and fill in each tab:

**Basics**

| Setting | Value |
|---|---|
| Resource group | `lighthouse-rg` |
| Virtual machine name | `lighthouse-vm` |
| Availability options | No infrastructure redundancy required |
| Security type | Trusted launch virtual machines (the default) |
| Image | **Ubuntu Server 26.04 LTS** (or 24.04 LTS), x64 Gen2 |
| Size | B2s, or another 2 vCPU size |
| Authentication type | **SSH public key** (never password) |
| Username | `azureuser` |
| SSH public key source | Generate new key pair, or use your existing key |
| Public inbound ports | Allow selected ports: **SSH (22), HTTP (80), HTTPS (443)**. You'll lock SSH down to your own IP in Step 4. |

**Disks**

| Setting | Value |
|---|---|
| OS disk type | Standard SSD (or Premium SSD) |
| Delete with VM | **Unchecked**, so the data survives if the VM is deleted by mistake |
| Encryption | Platform-managed key (the default; disks are encrypted at rest) |

**Networking**

- Leave the new virtual network and subnet as proposed.
- **Public IP:** new, and keep the default **Standard** SKU, which is static.
- **NIC network security group:** Basic, with the ports from the Basics tab.

**Management**

| Setting | Value |
|---|---|
| Identity | **Enable system assigned managed identity** ✓ (used for backups without stored keys) |
| Auto-shutdown | Off. This is a server. |
| Backup | **Enable backup** ✓, create a new Recovery Services vault (`lighthouse-vault`), and keep the default daily policy |
| Guest OS updates / patch orchestration | **Azure-orchestrated** if offered, otherwise leave Ubuntu's own automatic updates on |

Select **Review + create**, then **Create**. If you generated a key, **download the private key when prompted**. It is offered only once.

## Step 3: Give the VM a DNS name

1. Open **lighthouse-vm** and select its **Public IP address**.
2. Under **Settings → Configuration**, confirm **Assignment** is **Static**.
3. Point your hostname at it:
   - **Your own domain (recommended):** add an **A** record `desk` → the public IP at your DNS provider, or in an **Azure DNS** zone.
   - **No domain yet:** set a **DNS name label** here, for example `lighthouse-yourco`. Azure then gives you `lighthouse-yourco.<region>.cloudapp.azure.com`, which works with Caddy and HTTPS too.

Check from your computer and wait until it prints the VM's IP:

```bash
nslookup desk.example.com
```

## Step 4: Lock SSH to your own address

1. Open **lighthouse-vm → Networking → Network settings**.
2. Open the inbound rule for port **22**.
3. Change **Source** from *Any* to **My IP address** (or **IP Addresses** with your office range), then select **Save**.

Ports 80 and 443 stay open to the internet. Caddy needs 80 briefly to obtain the certificate, and then redirects it to HTTPS.

If you'd rather not expose SSH at all, deploy **Azure Bastion** in the VM's virtual network, delete the port 22 rule, and connect from the portal with **Connect → Bastion**. Bastion has its own hourly cost.

## Step 5: Connect and install Lighthouse

```bash
chmod 400 ~/Downloads/lighthouse-vm_key.pem
ssh -i ~/Downloads/lighthouse-vm_key.pem azureuser@desk.example.com
```

Follow [LINUX-SERVER.md](LINUX-SERVER.md) **steps 1 to 10**, using **variant 7a (Caddy)**, and `azureuser@` in the `scp` command. In step 5, set:

```ini
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://desk.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
```

## Step 6: Create a private Blob container for off-site backups

1. Search for **Storage accounts**, then select **Create**.
   - **Resource group:** `lighthouse-rg`. **Name:** a unique name such as `yourcolighthousebk`.
   - **Primary service:** Azure Blob Storage. **Performance:** Standard. **Redundancy:** GRS if you want a copy in a second region, otherwise LRS.
   - On the **Advanced** tab, confirm **Allow enabling anonymous access on individual containers** is **off**.
   - On the **Data protection** tab, enable **soft delete for blobs** (14 days).
   - Select **Review + create**, then **Create**.
2. Open the storage account, go to **Data storage → Containers → + Container**, name it `lighthouse-backups`, and keep access level **Private**.
3. **Make backups undeletable for 30 days:** open the container, go to **Access policy → Add policy**, and choose **Time-based retention** with 30 days. Save. Not even someone holding the VM's identity can delete or overwrite a backup during that window.
4. **Let the VM write to it:** in the container, go to **Access Control (IAM) → Add → Add role assignment**.
   - **Role:** **Storage Blob Data Contributor**
   - **Assign access to:** Managed identity → select **lighthouse-vm**
   - Select **Review + assign**.

## Step 7: Send backups to Blob storage

On the VM, install `azcopy`, Microsoft's storage copy tool:

```bash
curl -sSL -o /tmp/azcopy.tgz https://aka.ms/downloadazcopy-v10-linux
tar -xzf /tmp/azcopy.tgz -C /tmp
sudo install -m 755 /tmp/azcopy_linux_amd64_*/azcopy /usr/local/bin/azcopy
azcopy --version
```

Point the backup at your container:

```bash
echo 'AZ_CONTAINER_URL=https://yourcolighthousebk.blob.core.windows.net/lighthouse-backups' | sudo tee /etc/lighthouse/backup.env
sudo chmod 600 /etc/lighthouse/backup.env
sudo systemctl start lighthouse-backup.service
sudo journalctl -u lighthouse-backup.service -n 5 --no-pager     # "Copied to https://..."
```

The role assignment can take a few minutes to apply. If the first run says `403`, wait five minutes and run it again. Check that the file arrived under **Containers → lighthouse-backups** in the portal.

You now have three layers of backup:

1. Nightly database copies on the VM (14 days).
2. Off-site copies in Blob storage, undeletable for 30 days.
3. Azure Backup snapshots of the whole VM, from Step 2.

## Step 8 (optional): Send logs to Azure Monitor

Lighthouse writes security events (sign-ins, failed sign-ins, user changes, blocked requests) as one JSON object per line to the systemd journal, which feeds syslog on Ubuntu.

1. Create a **Log Analytics workspace** in `lighthouse-rg`.
2. Go to **Monitor → Data Collection Rules → Create**, add **lighthouse-vm** as a resource, and add a **Linux Syslog** data source (facility `daemon` and `user`, level `Info`) sent to the workspace. This installs the Azure Monitor Agent.
3. In the workspace, query failed sign-ins:

   ```kusto
   Syslog
   | where SyslogMessage has "login.failure"
   | extend e = parse_json(SyslogMessage)
   | summarize failures = count() by tostring(e.ip), bin(TimeGenerated, 15m)
   ```

   Add an alert rule on that query to be emailed on bursts.

## Step 9 (optional): More protection in front

- **Restrict who can reach the site.** If your team works from known office or VPN ranges, change the source of the HTTP and HTTPS NSG rules from *Any* to those ranges.
- **Identity-aware gate.** Put Cloudflare Access in front (see [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)). The tunnel runs on this VM, after which you can remove the 80 and 443 rules entirely. If you already use Microsoft Entra ID, connect it as the identity provider in Cloudflare Access so sign-in uses your existing accounts and MFA.
- **Application Gateway with WAF.** For a managed web application firewall, put an Application Gateway (WAF v2) in front with your certificate. Then set `HOST=0.0.0.0` and allow port 3000 on the VM **only from the gateway's subnet**, and skip Caddy. Keep `TRUST_PROXY=true` and `TRUST_PROXY_HOPS=1`. This adds noticeable monthly cost.

## Step 10 (optional): Email and text alerts with Azure Communication Services

Lighthouse can email and text people when tickets need them. On Azure, use **Azure Communication Services (ACS) Email** over SMTP. Full instructions are in [ALERTS.md](ALERTS.md#azure-communication-services-email-good-fit-if-you-deployed-on-azure). In short:

1. Create an **Email Communication Services** resource with a domain (Azure-managed or your own), and a **Communication Services** resource connected to that domain.
2. Register a **Microsoft Entra app** (`lighthouse-smtp`), create a client secret, and give it the **Communication and Email Service Owner** role on the Communication Services resource.
3. In the Communication Services resource, open **SMTP Usernames** and add a username for that app.
4. Add the settings to `/etc/lighthouse/lighthouse.env`:

   ```ini
   SMTP_HOST=smtp.azurecomm.net
   SMTP_PORT=587
   SMTP_SECURE=starttls
   SMTP_USER=<ACS SMTP username>
   SMTP_PASS=<Entra app client secret>
   SMTP_FROM="Lighthouse Service Desk <DoNotReply@your-verified-domain>"
   TZ=America/Chicago
   ```

5. For texts, add the Twilio settings from [ALERTS.md, part 2](ALERTS.md#part-2-text-messages-twilio).
6. Run `sudo systemctl restart lighthouse`, then check **Settings → Alert delivery** and send yourself a test from **Settings → My alerts**.

Azure blocks outbound port 25 from most VMs, so use **587**. The client secret expires on the date you chose, so set a reminder to replace it.

If your company uses Microsoft 365, don't point Lighthouse at `smtp.office365.com` with a mailbox password. Microsoft is switching that sign-in method off by default for existing tenants in late December 2026. ACS is the supported route.

## Checking that it's working

```bash
curl -sI https://desk.example.com | grep -iE 'HTTP/|strict-transport|content-security'
sudo systemctl status lighthouse caddy --no-pager | grep -E 'Active|●'
sudo ls -l /var/backups/lighthouse/
```

In the portal, the latest backup should appear under **lighthouse-vault → Backup items**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Site times out | Check that the NSG allows 80 and 443, the VM is running, and DNS resolves to its public IP. |
| Caddy log shows `challenge failed` | Port 80 is blocked in the NSG, or DNS doesn't point here yet. |
| `azcopy login --identity` fails | The system-assigned identity isn't enabled. Go to **VM → Security → Identity**. |
| Upload returns `403 AuthorizationPermissionMismatch` | The role assignment is missing, or still applying. Check **Access Control (IAM)** on the container. |
| Upload fails with `BlobImmutableDueToPolicy` | A file with that name already exists. Backup names include the time, so this only happens if you run two backups in the same minute. |

## Sources

- [Caddy install instructions](https://caddyserver.com/docs/install)
- [Azure Linux VM pricing](https://azure.microsoft.com/pricing/details/virtual-machines/linux/)
