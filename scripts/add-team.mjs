#!/usr/bin/env node
// Puts an email on the team list for /team (the holiday party's dashboard), so that person can
// sign in with an emailed code. The first member is added here; after that, team members add and
// remove each other on the page. The list is data in D1, never in the repo.
//   node scripts/add-team.mjs --env preview --email someone@example.com
//   flags: --remove (take that email off the list; the row stays, marked removed), --dry-run
// Refuses: no --env, no or a malformed --email. Prints how many are on the list after.
import { cleanEmail } from "../functions/_lib/booth.js";
import { d1, parseArgs, sqlText, stopOnError, targets } from "./lib/cf.mjs";

stopOnError();
const args = parseArgs(process.argv.slice(2), { env: "value", email: "value", remove: "flag", "dry-run": "flag" });
if (!args.env) { console.error("STOPPED: say where: --env preview | production"); process.exit(2); }
const email = cleanEmail(args.email ?? "");
if (!email) { console.error("STOPPED: say who: --email <their email>"); process.exit(2); }
const target = targets(args.env);
const masked = email.replace(/^(.).*(@.*)$/, "$1…$2");
if (args["dry-run"]) { console.log(`dry run: would ${args.remove ? "remove" : "add"} ${masked} ${args.remove ? "from" : "to"} the team list in ${target.db}; nothing written`); process.exit(0); }
const now = Date.now();
const sql = args.remove
  ? `UPDATE team_members SET removed_at = ${now} WHERE email = ${sqlText(email)} AND removed_at IS NULL;`
  : `INSERT INTO team_members (email, added_at) VALUES (${sqlText(email)}, ${now}) ON CONFLICT (email) DO UPDATE SET removed_at = NULL;`;
const [{ n }] = await d1(target, `${sql}\nSELECT COUNT(*) AS n FROM team_members WHERE removed_at IS NULL;`);
console.log(`${args.remove ? "removed" : "added"} ${masked} ${args.remove ? "from" : "to"} the team list in ${target.db}: ${n} on the list now.`);
if (n === 0) { console.error("STOPPED: the team list is empty, so nobody can sign in to /team. Add someone."); process.exit(1); }
