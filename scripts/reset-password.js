// Emergency password reset from the server's command line, for example if every admin is locked out.
//
//   npm run reset-password -- <username> "<new temporary password>" [--admin]
//
// The person must choose a new password at their next sign-in. With --admin they are also moved to the
// Administrator access level and their account is reactivated.
const { one, run } = require("../lib/db");
const { hashPassword, passwordProblem } = require("../lib/passwords");

(async () => {
  const [usernameArgument, password, flag] = process.argv.slice(2);
  if (!usernameArgument || !password) {
    console.error('Usage: npm run reset-password -- <username> "<new temporary password>" [--admin]');
    process.exit(1);
  }
  const problem = passwordProblem(password);
  if (problem) { console.error(problem); process.exit(1); }

  const username = usernameArgument.trim().toLowerCase();
  const person = one("SELECT * FROM users WHERE username = ?", username);
  if (!person) { console.error(`No user with username "${username}".`); process.exit(1); }

  const makeAdministrator = flag === "--admin";
  run("UPDATE users SET password_hash = ?, active = 1, must_change_password = 1 WHERE id = ?", await hashPassword(password), person.id);
  if (makeAdministrator) run("UPDATE users SET access_level_id = (SELECT id FROM access_levels WHERE is_administrator = 1) WHERE id = ?", person.id);
  run("DELETE FROM sessions WHERE user_id = ?", person.id);

  console.log(JSON.stringify({ ts: new Date().toISOString(), event: "cli.password_reset", target: person.id, madeAdministrator: makeAdministrator }));
  console.log(`Password reset for ${person.name} (${person.username})${makeAdministrator ? ", now an Administrator" : ""}. They will choose a new password at next sign-in.`);
})();
