// Lighthouse Service Desk — starts the web server.
//
// Where to find things:
//   lib/app.js             builds the app: database, services, routes, HTTP handling
//   lib/constants.js       every fixed number and limit, with names
//   lib/config.js          settings read from environment variables
//   lib/access.js          permissions and access levels
//   lib/db.js, migrations  the database and its schema history
//   routes/*.js            the API, one file per area (tickets, projects, users, ...)
//   alerts/*.js            email and text alerts
//   public/                the web app the browser loads
//   tests/                 automated tests (npm test)
// Show up as "lighthouse" rather than "node": in ps/top/htop on Linux, and as the console window title on Windows.
// (Windows Task Manager names a process after its .exe file; windows/start-lighthouse.ps1 handles that.)
const PROCESS_NAME = "lighthouse";
process.title = PROCESS_NAME;

const { server, intakeServer, config, db, startBackgroundWork } = require("./lib/app");

startBackgroundWork();
server.listen(config.port, config.host, () => {
  console.log(`Lighthouse Service Desk listening on http://${config.host}:${config.port}`);
  if (!config.servedOverHttps) console.log("COOKIE_SECURE is off. Turn it on (COOKIE_SECURE=true) once the site is served over HTTPS.");
});
// Website intake: a separate, private port. Never point the tunnel or proxy at it.
intakeServer?.listen(config.intake.port, config.intake.host, () => {
  console.log(`Website intake listening on http://${config.intake.host}:${config.intake.port} (private: keep it off the tunnel)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    intakeServer?.close();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}
