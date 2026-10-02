# RUNBOOK: topbarz-voting (voting.topbarz.xyz)

Everything here runs from `~/GitHub/topbarz-voting` on Sequoia's Mac, which is logged in to Cloudflare (`wrangler login`, account `8d147e242033699dd37c6f5a451f48d2`). `--env` is always one of `local`, `preview`, `production`; no script guesses it.

## Addresses

| What | Address | Data |
|---|---|---|
| Production | https://topbarz-voting.pages.dev and https://voting.topbarz.xyz | D1 `topbarz-voting`, R2 `topbarz-voting-media` |
| Staging (stable preview) | https://staging.topbarz-voting.pages.dev | D1 `topbarz-voting-preview`, R2 `topbarz-voting-media-preview` |
| Local | `npm run dev` → http://localhost:8788 | `.wrangler/state` on this Mac |

- **DNS for voting.topbarz.xyz:** Top Barz adds one record in Squarespace DNS for topbarz.xyz: type `CNAME`, host `voting`, value `topbarz-voting.pages.dev`. The domain is already attached to the Pages project and goes live a few minutes after the record exists.

## Get the files from Drive
- **`npm run sync-drive`** pulls the build package (PRD, `Tracks (First Last)`, `Gallery photos`, the two test folders) to `~/topbarz-source/drive`. Unchanged files are skipped. The Google key comes from the boss-os vault by itself.

## Load tracks
- **Preview (test tracks):** `npm run load-tracks -- --env preview` reads `~/topbarz-source/drive/Test tracks`.
- **Production (the real vote):** `npm run load-tracks -- --env production` reads `~/topbarz-source/drive/Tracks (First Last)`. Another folder: `--folder <dir>`. See what it would do first: `--dry-run`.
- **What it does:** each `First Last.mp3` becomes a track whose label and link are the first name (`Jane Doe.mp3` → "Jane", `/#jane`). Audio is re-encoded to 128 kbps MP3, uploaded to R2 and recorded in D1. Two Janes: the second becomes "Jane R." (`/#jane-r`).
- **Safe to run again.** A file already loaded is skipped. A track's link and label never change once given, and nothing is deleted.
- **It refuses:** a "Test …" folder or file for production; any file named for Scooter Taylor, always (it prints `EXCLUDED`); an empty folder (it stops and says so).
- **Change a label (an Instagram handle):** `npx wrangler d1 execute topbarz-voting --remote --command "UPDATE tracks SET label = '@handle' WHERE slug = 'jane'"`
- **Take a track out of the vote:** `npx wrangler d1 execute topbarz-voting --remote --command "UPDATE tracks SET active = 0 WHERE slug = 'jane'"` (its likes are kept; `active = 1` puts it back).
- **Order on the page:** the `sort` column, lowest first.

## Load photos
- **Preview:** `npm run load-photos -- --env preview` (reads `Test photos`). **Production:** `npm run load-photos -- --env production` (reads `Gallery photos`).
- **What it does:** each photo is turned upright, stripped of camera data and saved at two sizes (long edge 1600 px and 640 px), uploaded, and listed in the manifest `/api/state` returns, in file-name order. The manifest always matches the folder: remove a photo from the folder, run it again, and it is gone from the page.
- **No photos yet:** it writes an empty manifest and the page hides the slider.

## Secrets (Cloudflare Pages secrets; never in a file, never on a command line)
- **`VOTER_TOKEN_SECRET`** signs voter tokens. Already set in both environments. To rotate (every visitor sees the gate once more; no vote is lost): `openssl rand -base64 48 | npx wrangler pages secret put VOTER_TOKEN_SECRET --project-name topbarz-voting` and the same with `--env preview`, then redeploy (`gh workflow run deploy.yml`).
- **`GIPHY_BETA_KEY`** (the Giphy key, when Top Barz hands it over): run `npx wrangler pages secret put GIPHY_BETA_KEY --project-name topbarz-voting`, paste the key at the hidden prompt, then the same with `--env preview`, then `gh workflow run deploy.yml`. Check: `curl -s https://topbarz-voting.pages.dev/api/state | jq .giphy` shows `{"available": true}`. Until then it shows `{"available": false, "reason": "no_key"}` and the page hides the GIF picker.
- **Giphy budget:** the beta key allows 100 calls an hour for the whole site. The server stops at 90 in any rolling hour, caches each search term for 30 minutes and trending for an hour; past the budget a cached term is still served and a new one answers `limited: true`.

## Moderate
Production commands; add `-preview --env preview` to the database name for preview (`topbarz-voting-preview --remote --env preview`).
- **Read recent comments:** `npx wrangler d1 execute topbarz-voting --remote --command "SELECT c.id, t.slug, v.name, c.body, c.gif_id FROM comments c JOIN tracks t ON t.id = c.track_id JOIN voters v ON v.id = c.voter_id WHERE c.hidden = 0 ORDER BY c.id DESC LIMIT 30"`
- **Hide a comment:** `npx wrangler d1 execute topbarz-voting --remote --command "UPDATE comments SET hidden = 1 WHERE id = 123"`. It leaves the page and the count within a few seconds.
- **Flag a voter** (their likes stop counting, live and in the export; they are marked in the contact list): `npx wrangler d1 execute topbarz-voting --remote --command "UPDATE voters SET flagged = 1, flag_reason = 'why' WHERE email = 'person@example.com'"`
- **Hide everything a flagged voter wrote:** `npx wrangler d1 execute topbarz-voting --remote --command "UPDATE comments SET hidden = 1 WHERE voter_id IN (SELECT id FROM voters WHERE flagged = 1)"`
- **Look for a cluster** (many sign-ups from one address): `npx wrangler d1 execute topbarz-voting --remote --command "SELECT ip_hash, COUNT(*) AS n FROM voters GROUP BY ip_hash HAVING n > 10 ORDER BY n DESC"`
- **Known limit:** emails are not verified (the 6-digit code is the PRD's optional upgrade), so one person with many real inboxes can vote many times. One mailbox is one voter: `+tags` and Gmail dots do not make a second one, and common throwaway domains are refused.

## Export the results
- **`npm run export -- --env production`** writes `exports/production-<time>/tally.csv` (rank, track, likes, comments, tie-break order, when it first reached its count) and `contacts.csv` (name, email, city, opt-in, first interaction, flagged). `exports/` is git-ignored; never commit or paste it.
- **Tie-break (PROPOSED by the PRD, not yet confirmed by Scooter):** tracks tied on likes are ordered by which first reached that count. `last_reached_at` is in the file too, in case the confirmed rule is "the last climb to that count".

## Prove the voting window (preview only)
- The end time is `VOTING_ENDS_AT` in `functions/_lib/config.js`. Production reads nothing else.
- **Close staging now:** `npx wrangler d1 execute topbarz-voting-preview --remote --env preview --command "INSERT OR REPLACE INTO settings (key, value) VALUES ('voting_ends_at', '2026-10-01T00:00:00Z')"`. Within about 5 seconds `/api/state` says `closed: true` and likes and comments answer 403 `voting_closed`.
- **Reopen it:** `npx wrangler d1 execute topbarz-voting-preview --remote --env preview --command "DELETE FROM settings WHERE key = 'voting_ends_at'"`

## Deploy
- **Merge with `land <pr>`.** A green `Validate` on `main` fires `Deploy`: preview database migrated → staging published → live check → production database migrated → production published → live check. A failed staging check leaves production alone.
- **Ship main again by hand:** `gh workflow run deploy.yml` (refused unless that commit has a green Validate run).
- **Break-glass from this Mac:** `npm run deploy:staging && npm run smoke:staging && npm run deploy:production && npm run smoke:production`. Never a bare `wrangler deploy`.
- **Token:** repo secrets `CLOUDFLARE_API_TOKEN` (the boss-os vault's `CLOUDFLARE_API_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID`. Re-set from the vault, value never shown: `cd ~/GitHub/boss-os && npm run -s vault:run -- sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN -R seq23/topbarz-voting'`
- **New table or column:** add `migrations/000N_name.sql`; Deploy applies it to preview, then production.

## Work on it locally
- `npm ci`, then `npm run dev:seed` (local database + the 4 test tracks + the 4 test photos), then `npm run dev` → http://localhost:8788.
- `npm run check` runs every test (about 30 seconds).

## The page (front end)
Static files in `public/`, no framework and no build step: what is in the folder is what ships.

| File | What it is |
|---|---|
| `public/index.html` | The page and every word on it, including the gate popup. |
| `public/privacy.html` | The privacy note, at `/privacy`. |
| `public/css/site.css` | All styling. The brand colours are the variables at the top. |
| `public/js/logic.js` | The rules with no screen in them (share text, sms link, countdown, like state). Unit-tested. |
| `public/js/app.js`, `player.js`, `comments.js`, `gate.js`, `gallery.js`, `api.js`, `dom.js` | The page itself: polling and cards, audio, comments and GIFs, the gate, the photo slider, requests and the remembered voter, small helpers. |
| `public/_headers` | Security headers for the static files. The page may load only its own files and GIFs from Giphy. |

- **Brand assets.** Colours and typefaces are topbarz.xyz's own: orange `hsl(16.91 100% 56.86%)`, peach `hsl(31.65 90.1% 80.2%)`, off-white, black; headings in Dela Gothic One, text in Epilogue. The two font files in `public/fonts/` are the same files topbarz.xyz serves, hosted here so the page makes no outside request. `public/img/logo.png` is the Top Barz lockup taken from Scooter's mockup PDF (topbarz.xyz has no logo image: its header is the words in Dela Gothic One). `public/img/og.png` (1200×630) is the picture a text or Instagram shows for the link; `favicon.png` and `apple-touch-icon.png` are the logo on black. To change one, replace the file under the same name and size.
- **Changing words.** Edit `public/index.html`. `npm test` proofreads it: "Top Barz" as two words, JUMP IN THE BOOTH, "for them and their friends", the locked prize wording, and the voting-ends line, which must match the end time in `functions/_lib/config.js` (the live page then rewrites that line from the server's end time).
- **How the countdown gets its time.** From the server, never the phone. Every `/api/state` answer carries the server's clock (`now`, and the `Date` header); between answers the page adds elapsed time from a timer the phone's clock setting cannot move. At zero the page shows "Voting closed" by itself and asks the server; the server refuses late likes and comments whatever the page shows.
- **Counts.** The page polls `/api/state` every 7 s, stops while the tab is hidden, and catches up when it is shown. After a voter's own like or comment, an older cached answer is ignored for that track, so the number never jumps back.
- **The remembered voter.** After the gate the browser keeps a signed token and a first name (localStorage `tbz.voter`, cookie `tbz_voter`), never the email. "Not you?" in the footer forgets them on that device. A token the server no longer accepts is forgotten and the gate shows at the next like.
- **Share links** use the address the page is open at (`https://voting.topbarz.xyz/#<slug>` in production), so a shared link always opens. iPhone gets `sms:&body=…`, Android `sms:?body=…`, a desktop copies the link.
- **Link previews.** The Open Graph tags point at `https://voting.topbarz.xyz/img/og.png`, so the preview picture appears once the DNS record for voting.topbarz.xyz exists.
- **GIF picker.** Hidden while `/api/state` says `giphy.available: false`; it appears by itself after the key is set (Secrets, above).
- **No tracks or photos yet:** the page says the tracks land soon, hides the slider and the VOTE button, and keeps polling, so loaded tracks appear without a reload.
- **Check it in a browser** (there is no browser suite in CI): on staging, like a track (the gate appears once), refresh (the heart stays), comment, share, open `/#<slug>`, then close and reopen the window (next section). Afterwards remove the test voter: `npx wrangler d1 execute topbarz-voting-preview --remote --env preview --command "DELETE FROM comments WHERE voter_id IN (SELECT id FROM voters WHERE email LIKE 'fe-test-%@example.com'); DELETE FROM like_events WHERE voter_id IN (SELECT id FROM voters WHERE email LIKE 'fe-test-%@example.com'); DELETE FROM voters WHERE email LIKE 'fe-test-%@example.com'"`

## The API a front end calls
Same origin, JSON in and out. Every error is `{ "error": "<code>", "message": "<plain words to show>" }` with a 4xx/5xx status.

| Route | What it does |
|---|---|
| `GET /api/state` | Everything the page draws. **Poll this every ~7 s.** Cached 5 s; never per-visitor. |
| `POST /api/voters` | The gate. Returns the voter's token. |
| `GET /api/me` | A returning visitor's first name and the tracks they like. |
| `POST /api/likes` | Like / un-like a track. |
| `GET /api/comments` | A track's comments. |
| `POST /api/comments` | Add a comment (text, a GIF, or both). |
| `GET /api/giphy/trending` | GIFs to show before a search. |
| `GET /api/giphy/search` | GIF search. |
| `GET /media/tracks/…`, `/media/photos/…` | Audio and photos (use the URLs from state as they are). |

**`GET /api/state`**
```json
{
  "now": "2026-10-05T16:00:00.000Z",
  "voting_ends_at": "2026-10-12T06:59:00.000Z",
  "closed": false,
  "tracks": [{ "slug": "brian", "label": "Brian", "audio_url": "/media/tracks/brian-3290fefeb1.mp3", "duration_ms": 65120, "likes": 12, "comments": 3 }],
  "photos": [{ "url": "/media/photos/08620adb653b-1600.jpg", "width": 1067, "height": 1600, "thumb_url": "/media/photos/08620adb653b-640.jpg", "thumb_width": 427, "thumb_height": 640, "alt": "Top Barz at CultureCon, photo 1" }],
  "gate": { "available": true },
  "giphy": { "available": false, "reason": "no_key" }
}
```
- **`tracks`** are in display order. The deep link is `/#<slug>`. `audio_url` is an MP3 that supports Range (iOS Safari).
- **`closed: true`**: show "Voting closed", disable like / comment / share-to-vote, keep audio playable. The server refuses likes and comments regardless of the browser's clock. Count down to `voting_ends_at` against `now` (the server's clock), not the device's.
- **`photos: []`**: hide the slider. Use `thumb_url` in the strip and `url` full-size; lazy-load.
- **`giphy.available: false`**: hide the GIF picker. **`gate.available: false`**: voting is not switched on (the signing secret is missing); show the tracks only.

**`POST /api/voters`** body `{ "name", "email", "city", "marketing_opt_in": false, "website": "" }`
- All three text fields are required. `marketing_opt_in` is `true` only if the box was ticked (default off). `website` is the honeypot: render it hidden from people (off-screen, `tabindex="-1"`, `autocomplete="off"`) and send whatever is in it.
- **200:** `{ "token": "v1.…", "voter": { "first_name": "Jane" }, "liked": ["brian"], "returning": false }`. Keep `token` (localStorage plus a cookie) and send it as `Authorization: Bearer <token>`. The same email again is the same voter and gets their `liked` list back.
- **400:** `invalid_fields` (with `fields: { email: "…" }` to show under each input), `throwaway_email`, `rejected`. **429:** `rate_limited`. **503:** `token_secret_missing`.

**`GET /api/me`** with the token → `{ "voter": { "first_name": "Jane" }, "liked": ["brian", "caleb"] }`. Call it once on load if a token is stored, to fill the hearts. **401 `invalid_token`** (here or on any route): forget the token and show the gate at the next like.

**`POST /api/likes`** with the token, body `{ "track": "brian" }` toggles; `{ "track": "brian", "liked": true }` sets a state and is safe to retry (prefer it). → `{ "track": "brian", "liked": true, "likes": 13 }`: show that count at once; the next poll agrees. Errors: 401 `invalid_token`, 403 `voting_closed`, 404 `unknown_track`, 429 `rate_limited`.

**`GET /api/comments?track=brian&limit=5`** → `{ "track", "total": 12, "has_more": true, "comments": [{ "id": 41, "first_name": "Jane", "text": "…", "gif": { "id": "…", "url": "https://media2.giphy.com/…" } | null, "created_at": "…" }] }`. The newest `limit` (default 20, max 50), oldest first, so the newest is at the bottom. "Show more": the same call with `&before=<id of the first comment shown>`. Only a first name is ever returned.

**`POST /api/comments`** with the token, body `{ "track": "brian", "text": "…", "gif": { "id": "<giphy id>", "url": "<the url from the picker>" } }` (text up to 500 characters, a GIF, or both) → 201 `{ "comment": { … }, "comments": 13 }`. Append `comment` and show the new count. Errors: 400 `empty_comment` / `comment_too_long` / `bad_gif`, 401, 403 `voting_closed`, 404, 429.

**`GET /api/giphy/trending`** and **`GET /api/giphy/search?q=fire`** → `{ "available": true, "results": [{ "id", "title", "url", "width", "height", "preview_url", "preview_width", "preview_height" }] }`, at most 12. Debounce the search box about 450 ms and ask for at least two letters. Show `preview_url` in the grid and send `{ id, url }` with the comment. `limited: true` means the hourly budget is spent: show what came back (maybe nothing) and a line saying GIFs are busy. Giphy's terms need a "Powered by GIPHY" mark on the picker.

**Share text** (built in the page, from the track label): `<label> wants you to vote on their track from the Top Barz experience https://voting.topbarz.xyz/#<slug>` (the link is on whatever address the page is open at; see "The page").

## Limits (functions/_lib/config.js)
Per hour: 40 sign-ups per IP, 10 per email. Per minute: 60 likes per voter, 240 per IP. Comments: 10 per voter per 5 minutes, 120 per IP per hour. GIF searches: 30 per IP per minute. Over a limit is a 429 `rate_limited` with a `message` to show.
