# Website intake

Lets a website form (windpoint.net) raise tickets for people who don't have a Lighthouse account: 3D print requests and IT jobs. The website's own server-side form handler calls Lighthouse; the visitor's browser never does.

```
visitor's browser ──HTTPS──▶ windpoint.net form handler ──LAN, Bearer token──▶ Lighthouse intake port (private)
                                                                               │
                                                                               ▼
                                                              ticket in "3D Printing" or "IT Jobs"
```

## Why it's a separate port

The desk itself is reachable through Cloudflare Tunnel. The intake API must not be, so it runs on its own listener (`INTAKE_PORT`, default 3001) that the tunnel never points at. Even someone who reaches the desk through the tunnel can't call intake: the desk's port has no intake routes at all.

## Turn it on

1. Make a token (at least 32 characters):

   ```sh
   openssl rand -hex 32
   ```

2. Add to `/etc/lighthouse/lighthouse.env`:

   ```sh
   INTAKE_TOKEN=<the token>
   # Same machine as the form handler: keep the default 127.0.0.1.
   # Different container/VM: this container's LAN address, and firewall the port (step 4).
   INTAKE_HOST=127.0.0.1
   INTAKE_PORT=3001
   # Resolver group names, exactly as they appear under Settings > Groups. Unset or not found = unrouted.
   INTAKE_PRINT_GROUP="3D Printing"
   INTAKE_IT_GROUP="IT Jobs"
   ```

3. Create the two resolver groups in the desk and add yourself to them, so new website requests alert you.

4. If the form handler runs in another Proxmox container, allow only its address to reach the intake port. On the Lighthouse container (nftables example; or use the Proxmox firewall for the container):

   ```sh
   nft add rule inet filter input tcp dport 3001 ip saddr != <windpoint container IP> drop
   ```

   With Docker instead: set `INTAKE_HOST=0.0.0.0` inside the container and publish the port only to the address the handler uses, e.g. `"10.0.0.20:3001:3001"` under `ports`.

5. Restart: `sudo systemctl restart lighthouse`. The log shows `Website intake listening on http://…`. If the token is too short, it says intake is OFF instead.

6. Check it: `curl http://<INTAKE_HOST>:3001/healthz` should print `ok`. Make sure the tunnel's ingress still points only at `PORT` (3000).

## API

Every request except `/healthz` needs `Authorization: Bearer <INTAKE_TOKEN>`. Errors come back as `{ "error": "<reason>" }` with a 4xx status; the reason is safe to show the visitor.

### `POST /intake/requests`

JSON body:

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `"print"` or `"it"` |
| `name` | yes | up to 80 characters |
| `email` | yes | up to 160 characters |
| `details` | yes | up to 4000 characters; the first line becomes the ticket title |
| `neededBy` | no | `YYYY-MM-DD` |
| `notes` | no | up to 2000 characters |
| `material` | print: yes | `"PLA"` or `"PETG"` |
| `quantity` | print: no | whole number 1–100, default 1 |
| `link` | print: no | `http(s)://` link to the model |
| `location` | it: yes | where the job is, up to 200 characters |

Answer: `201 { "ticketId": 1042, "reference": "TKT-1042" }`.

The ticket is P3, category *Request*, status *New*, tagged `website` plus `3d-print` or `it-job`, and has no requester account. Staff see the person's name and email (as a mailto link) in the ticket panel. Lighthouse doesn't email the person; you do.

### `POST /intake/requests/:ticketId/files`

The file itself is the request body; its name goes in `X-File-Name` (URL-encode non-ASCII names).

- Only `.stl`, `.3mf`, `.step`, `.stp`; up to 50 MB each; up to 5 per request.
- Only for tickets created through intake, still open, within an hour of the request.

Answer: `201 { "fileName": "bracket.stl", "sizeBytes": 48211 }`.

Status codes: `401` wrong or missing token · `404` not a website request · `403` closed or past the hour · `400` wrong type, too many files or empty · `413` too large · `429` limit reached.

### Limits

- 30 requests per hour, desk-wide. The form handler should also limit per visitor.
- 10 wrong tokens per address per 15 minutes, then that address is refused for the rest of the window.

## Example (Node, in the form handler)

```js
const INTAKE = "http://10.0.0.20:3001";
const auth = { Authorization: `Bearer ${process.env.LIGHTHOUSE_INTAKE_TOKEN}` };

const made = await fetch(`${INTAKE}/intake/requests`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "print", name, email, details, material: "PETG", quantity: 2, neededBy }),
});
if (!made.ok) throw new Error((await made.json()).error);
const { ticketId, reference } = await made.json();

await fetch(`${INTAKE}/intake/requests/${ticketId}/files`, {
  method: "POST",
  headers: { ...auth, "X-File-Name": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
  body: file.stream(), duplex: "half",
});
```

Keep the token in the form handler's server-side environment only. Never put it in the website's pages or scripts.
