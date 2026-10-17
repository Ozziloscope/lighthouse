// Security audit log. Each event is one line of JSON on standard output, which systemd's journal,
// Docker, CloudWatch and Azure Monitor all collect. Never put passwords, codes or tokens in `details`.
function audit(eventName, request, details = {}) {
  const entry = { ts: new Date().toISOString(), event: eventName, ip: request?.ip ?? null, user: request?.user?.id ?? null, ...details };
  console.log(JSON.stringify(entry));
}

module.exports = { audit };
