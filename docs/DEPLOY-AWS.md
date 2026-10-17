# Deploying Lighthouse on AWS

## Which AWS setup this is

Lighthouse keeps its data in a SQLite file. SQLite needs a disk attached to one machine, so the right AWS shape is **one EC2 instance with an EBS volume**:

```
Browser ──HTTPS──▶ Elastic IP ──▶ EC2 instance [ Caddy :443 ──▶ Lighthouse 127.0.0.1:3000 ──▶ EBS disk ]
                                       │
                                       └──▶ nightly backup ──▶ private S3 bucket
```

Some AWS services that look like a fit aren't:

- **Lambda and App Runner** don't keep a local disk.
- **ECS/Fargate with EFS** puts the database on a network file system. SQLite's locking is unreliable there, and you risk a corrupted database.
- **Running more than one instance** behind a load balancer doesn't work either: each instance would have its own separate database.

One small instance comfortably handles a desk of hundreds of users.

> **Simpler alternative:** Amazon Lightsail gives you the same thing (an Ubuntu VM with a static IP and a firewall) with flat monthly pricing and a simpler console. If you use Lightsail, create an Ubuntu instance, attach a static IP, open ports 80 and 443 under **Networking**, enable automatic snapshots, then continue from **Step 5** of this guide.

**Cost:** you pay for one small instance, its disk, an Elastic IP, and a little S3 storage. Check the [EC2 pricing page](https://aws.amazon.com/ec2/pricing/) for your region. A `t4g.small` (ARM) or `t3.small` is plenty.

Throughout this guide the hostname is `desk.example.com` and the region is your choice. Stay in the same region for every step.

---

## Step 1: Create a private S3 bucket for off-site backups

1. Open the **S3** console and select **Create bucket**.
2. **Bucket name:** something unique, such as `yourcompany-lighthouse-backups`.
3. Leave **Block all public access** turned **on** (the default).
4. **Bucket Versioning:** Enable. A deleted or overwritten backup can then still be recovered.
5. **Default encryption:** SSE-S3 (the default) is fine.
6. Select **Create bucket**.
7. Open the bucket, go to **Management → Create lifecycle rule**, and add a rule that expires objects after 90 days, so old backups don't pile up forever.

## Step 2: Create an IAM role so the server can write backups without stored keys

1. Open **IAM → Roles → Create role**.
2. **Trusted entity:** AWS service. **Use case:** EC2. Select **Next**.
3. On the permissions page, attach **AmazonSSMManagedInstanceCore**. This lets you open a shell from the browser through Session Manager, so you can close SSH entirely if you want. Select **Next**.
4. **Role name:** `lighthouse-ec2`. Create the role.
5. Open the role and choose **Add permissions → Create inline policy → JSON**. Paste this, with your bucket name:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject"],
       "Resource": "arn:aws:s3:::yourcompany-lighthouse-backups/*"
     }]
   }
   ```

   Name it `lighthouse-backup-write` and save it.

The server can add backups to the bucket but can't read, list or delete them. If the server were ever compromised, the attacker couldn't wipe your off-site copies.

## Step 3: Launch the EC2 instance

Open **EC2 → Instances → Launch instances**.

| Setting | Value |
|---|---|
| **Name** | `lighthouse` |
| **AMI** | Ubuntu Server 26.04 LTS (or 24.04 LTS). Match the architecture: **64-bit (Arm)** for `t4g`, **64-bit (x86)** for `t3`. |
| **Instance type** | `t4g.small` or `t3.small` |
| **Key pair** | Create one (ED25519, `.pem`) and keep the file safe, or choose **Proceed without a key pair** if you'll use Session Manager only |
| **Network settings → Firewall** | Create a security group named `lighthouse-sg`:<br>• **Allow SSH traffic from:** *My IP* (never *Anywhere*)<br>• **Allow HTTPS traffic from the internet:** ✓<br>• **Allow HTTP traffic from the internet:** ✓ (Caddy needs it to obtain the certificate, then redirects it to HTTPS) |
| **Configure storage** | 20 GiB, **gp3**. Open **Advanced**, set **Encrypted: Yes** (the default KMS key is fine), and set **Delete on termination: No** so the data outlives an accidental termination. |
| **Advanced details → IAM instance profile** | `lighthouse-ec2` |
| **Advanced details → Metadata version** | V2 only (token required). This is the default on new instances. Confirm it. |
| **Advanced details → Termination protection** | Enable |

Select **Launch instance**.

## Step 4: Give it a permanent address and a DNS name

1. Go to **EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address → Allocate**.
2. Select the new address, choose **Actions → Associate Elastic IP address**, pick the `lighthouse` instance, and select **Associate**.
3. Create the DNS record:
   - **Route 53:** **Hosted zones →** your domain **→ Create record**. Record name `desk`, type **A**, value the Elastic IP, TTL 300.
   - **Any other DNS provider:** add an **A** record for `desk` pointing at the Elastic IP.

Check from your computer. It should print the Elastic IP:

```bash
nslookup desk.example.com
```

Wait until it does before Step 6, because Caddy needs it to obtain a certificate.

## Step 5: Connect to the instance

**With SSH:**

```bash
chmod 400 ~/Downloads/lighthouse.pem
ssh -i ~/Downloads/lighthouse.pem ubuntu@desk.example.com
```

**Or without opening port 22:** select the instance in the EC2 console, choose **Connect → Session Manager → Connect**, then run `sudo su - ubuntu`. This takes a minute or two to become available after launch. If you go this route, you can delete the SSH rule from `lighthouse-sg`. Copy the zip over with S3 instead of `scp`: upload it to the bucket from your computer, then run `aws s3 cp` on the server. That direction needs `s3:GetObject` added to the role temporarily.

## Step 6: Install Lighthouse

Follow [LINUX-SERVER.md](LINUX-SERVER.md) **steps 1 to 10**, using **variant 7a (Caddy)**. In step 5, set:

```ini
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://desk.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
```

The security group is your main firewall, so `ufw` in step 8 is optional extra defence.

## Step 7: Send backups to S3

The nightly backup from LINUX-SERVER step 10 stays on the instance's disk. Add the off-site copy:

```bash
sudo snap install aws-cli --classic
echo 'S3_URI=s3://yourcompany-lighthouse-backups' | sudo tee /etc/lighthouse/backup.env
sudo chmod 600 /etc/lighthouse/backup.env
sudo systemctl start lighthouse-backup.service
sudo journalctl -u lighthouse-backup.service -n 5 --no-pager    # "Copied to s3://..."
```

No access keys are stored on the server: the AWS CLI picks up the `lighthouse-ec2` role automatically.

## Step 8: Snapshot the whole disk as well

Disk snapshots let you rebuild the entire server, not just the database.

1. Tag the volume: **EC2 → Elastic Block Store → Volumes**, select the instance's volume, then **Tags → Manage tags → Add** `Backup` = `lighthouse`.
2. Go to **EC2 → Elastic Block Store → Lifecycle Manager → Create lifecycle policy**.
3. Choose **EBS snapshot policy**. **Target resource:** Volume, with tag `Backup = lighthouse`.
4. **Schedule:** daily, retain 7.
5. Choose **Create policy**.

## Step 9 (optional): Ship logs to CloudWatch

Lighthouse writes security events (sign-ins, failed sign-ins, user changes, blocked requests) as one JSON object per line to the systemd journal. To keep them off the instance, install the CloudWatch agent:

1. Add **CloudWatchAgentServerPolicy** to the `lighthouse-ec2` role.
2. Install the agent and point it at the journal. The [CloudWatch agent documentation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html) walks through it.
3. Create a metric filter on `{ $.event = "login.failure" }` with an alarm, so a burst of failed sign-ins emails you.

## Step 10 (optional): More protection in front

- **Restrict who can reach the site.** If your team always works from known office or VPN addresses, change the HTTPS and HTTP rules in `lighthouse-sg` from *Anywhere* to those ranges.
- **Identity-aware gate.** Put Cloudflare Access in front (see [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)). The tunnel can run on this same EC2 instance, after which you can close ports 80 and 443 completely.
- **Application Load Balancer + AWS WAF.** For managed rate-limiting rules and AWS-issued certificates: create an ACM certificate, an ALB with an HTTPS listener forwarding to a target group on port 3000, and attach a WAF web ACL. Then set `HOST=0.0.0.0` and allow port 3000 in `lighthouse-sg` **only from the ALB's security group**, and skip Caddy. Keep `TRUST_PROXY=true` and `TRUST_PROXY_HOPS=1`, since the ALB appends the client IP to `X-Forwarded-For`. This adds noticeable monthly cost.

## Step 11 (optional): Email and text alerts with Amazon SES

Lighthouse can email and text people when tickets need them. On AWS, the natural email service is **Amazon SES**. Full instructions are in [ALERTS.md](ALERTS.md#amazon-ses-good-fit-if-you-deployed-on-aws). In short:

1. In the SES console, verify your domain (**Configuration → Identities → Create identity → Domain**) and add the DKIM records to Route 53.
2. Request production access (**Account dashboard → Request production access**). Until it is approved, SES only delivers to addresses you have verified.
3. Create SMTP credentials (**SMTP settings → Create SMTP credentials**).
4. Add the settings to `/etc/lighthouse/lighthouse.env`:

   ```ini
   SMTP_HOST=email-smtp.<your-region>.amazonaws.com
   SMTP_PORT=587
   SMTP_SECURE=starttls
   SMTP_USER=<SES SMTP user name>
   SMTP_PASS=<SES SMTP password>
   SMTP_FROM="Lighthouse Service Desk <desk@yourcompany.com>"
   TZ=America/Chicago
   ```

5. For texts, add the Twilio settings from [ALERTS.md, part 2](ALERTS.md#part-2-text-messages-twilio).
6. Run `sudo systemctl restart lighthouse`, then open **Settings → Alert delivery** to confirm both channels show **On**, and send yourself a test from **Settings → My alerts**.

Use port **587**, because EC2 throttles outbound port 25. The default security group already allows outbound traffic. If you have locked outbound traffic down, allow TCP 587 to SES and TCP 443 to `api.twilio.com`.

## Checking that it's working

```bash
curl -sI https://desk.example.com | grep -iE 'HTTP/|strict-transport|content-security'
sudo systemctl status lighthouse caddy --no-pager | grep -E 'Active|●'
aws s3 ls s3://yourcompany-lighthouse-backups/    # expect AccessDenied: the role can write but not list, by design
```

Check the backup arrived from the **S3 console** instead.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Site times out | Check that the security group allows 443 and 80, the Elastic IP is associated, and DNS resolves to it. |
| Caddy log shows `challenge failed` | Port 80 is blocked, or DNS doesn't point here yet. |
| Backup log shows `Unable to locate credentials` | The IAM role isn't attached. Go to **Instance → Actions → Security → Modify IAM role**. |
| Backup log shows `AccessDenied` on `PutObject` | The bucket name in the inline policy doesn't match `S3_URI`. |

## Sources

- [Caddy install instructions](https://caddyserver.com/docs/install)
- [Amazon EC2 pricing](https://aws.amazon.com/ec2/pricing/)
- [Install the CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html)
