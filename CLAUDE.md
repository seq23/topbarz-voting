# topbarz-voting

The CultureCon track vote for Top Barz at voting.topbarz.xyz: a static page in `public/` (no framework, no bundler), an API in `functions/api/` (Cloudflare Pages Functions), D1 for tracks, voters, likes and comments, and R2 for the audio and photos, served at `/media/*`. It runs on the Cloudflare Pages project `topbarz-voting` in Sequoia's account (`8d147e242033699dd37c6f5a451f48d2`). **Operating steps and the API a front end calls are in `RUNBOOK.md`; read it before changing anything.**

- **Brand.** "Top Barz" is two words. The slogan is JUMP IN THE BOOTH. Never write "spit your bars". A test fails on any of these in `public/` or `functions/`.
- **The vote.** One like per email per track, a toggle; any number of tracks. Every like and un-like is a row in `like_events` and is never deleted: the count and the tie-break are computed from those rows (`functions/_lib/tally.js`).
- **The end time lives in one place**, `functions/_lib/config.js` (`2026-10-12 06:59 UTC` = Sunday 11 Oct 2026, 11:59 PM PDT). The server rejects likes and comments after it. A test fails if the literal appears anywhere else.
- **Two environments that never share data.** Production (`main` branch; D1 `topbarz-voting`, R2 `topbarz-voting-media`) and preview (every other branch, `staging` is the stable one; D1 `topbarz-voting-preview`, R2 `topbarz-voting-media-preview`). Test tracks and test photos go to preview only: the loaders refuse a "Test …" folder or file for production.
- **Scooter Taylor's own track is never in the vote.** `scripts/load-tracks.mjs` excludes any file named for him and switches off any such row it finds.
- **Voter data never enters the repo.** Emails never leave the server; comments show a first name only. `npm run export` writes to `exports/` (git-ignored).
- **Secrets.** `VOTER_TOKEN_SECRET` and `GIPHY_BETA_KEY` are Pages secrets, never in a file or on a command line. With no Giphy key the GIF routes answer `{available:false}` and `/api/state` says so.
- **Checks.** `npm run check` = `npm test` (every rule, against a real local D1 and R2) + `npm run test:smoke` (every route over HTTP). That is the merge gate (`Validate`, about a minute); there is no browser suite. A changed rule means a rewritten test, at least as strict.
- **Deploy.** Merge with `land <pr>`. A green `Validate` on `main` fires `Deploy`: staging, a live check, then production, then a live check. Never a bare `wrangler deploy`.
