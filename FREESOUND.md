# Freesound sample bank CLI — standalone tool (destined for another project)

## Context

This doc originally described a browser-based `/freesound` page doing a full OAuth2 login, downloading
samples to "browser cache," and expecting `src/oto/samples` (a source folder that doesn't exist) to pick
them up on next load.

Research into the codebase and Freesound's actual OAuth2 flow surfaced a blocking problem: Freesound's
authorization-code exchange requires a `client_secret`, and a `client_secret` can never safely live in
frontend JS — anyone can read it out of the shipped bundle, and it's a single static value shared across
every user of the app, not a per-login value. The `code` returned in the redirect is *not* the secret;
it's short-lived and single-use, but completing the exchange still needs the secret held somewhere
private.

This is resolved by moving the whole flow out of the browser: a **local Node CLI tool**, run by hand,
where `client_id`/`client_secret` live in a gitignored `.env` file that never ships to any browser. This
also removes the need for a backend/serverless proxy, and since it's OAuth2 (not the anonymous token
mode), it gets **original-quality** downloads.

On reflection, this tool doesn't belong in Satori at all — it's designed here, then relocated to a
different project. So it deliberately has **zero coupling to Satori**: no edits to `src/oto/samples.ts`,
no Satori `package.json`/`.gitignore` changes, no Vite/`public/` involvement. The destination project
already has a sibling script, `samplesToJSON.js`, which scans a samples directory and regenerates its own
manifest with no arguments — this tool's only job is to populate `samples/freesound/<directory>` with
downloaded audio and then hand off to that script.

Relevant facts (mostly moot now given no Satori coupling, but recorded for context):
- No `.env`, no env-var convention, no CLI-prompt or dotenv dependency exists in the Satori repo. Node
  v23.7.0 (per `.nvmrc`) has native `fetch`, `node:readline/promises`, and `process.loadEnvFile()` — so no
  new npm dependencies are needed for this tool, wherever it ends up.
- `samplesToJSON.js` is NOT present in this repo — it lives in the destination project. Per the project
  owner, it's run with no arguments and scans a fixed `samples/` directory to build its manifest.

## Approach

### 1. `.env` + `.gitignore`

A gitignored `.env` alongside the script:
```
FREESOUND_CLIENT_ID=rPffNykfzXOqxXmMynIr
FREESOUND_CLIENT_SECRET=<secret from the Freesound app dashboard>
```
Whichever project this ends up in, its `.gitignore` needs `.env` and `samples/freesound/` entries.

Note: Freesound requires a redirect URI to be configured on the app's dashboard (freesound.org → your
app settings) before `/authorize/` will work at all, even though nothing will actually be listening on
it. Any value works (e.g. `http://localhost:8080/callback`) — the browser will land on a dead page, but
the `code=...` param is still visible in the address bar to copy. The CLI never needs to know this value
itself.

### 2. New file: `freesound-samples.js`

A single, standalone Node script (ESM) with no dependency on anything Satori-specific — it can be dropped
into any project directory next to `samplesToJSON.js`. Flow:

1. `process.loadEnvFile('.env')`, read `FREESOUND_CLIENT_ID`/`FREESOUND_CLIENT_SECRET`, fail with a clear
   message if missing.
2. Print the authorize URL:
   `https://freesound.org/apiv2/oauth2/authorize/?client_id=<id>&response_type=code&state=<random>`
3. Prompt (via `readline/promises`) for the `code` the user copies from the redirected URL.
4. `POST https://freesound.org/apiv2/oauth2/access_token/` (form-encoded: `client_id`, `client_secret`,
   `grant_type=authorization_code`, `code`) → `access_token`. No refresh-token handling — this is a
   manual, occasional tool, so re-running the login dance per invocation is the simpler choice than
   persisting/refreshing tokens. (Flagged in critique below in case that tradeoff is wrong.)
5. Prompt for: search terms, directory name (the bank name), number of samples (default 16, same cap the
   original ask).
6. `GET https://freesound.org/apiv2/search/text/?query=<terms>&page_size=<n>&fields=id,name,username,license,type`
   with `Authorization: Bearer <access_token>`.
7. For each result: `GET https://freesound.org/apiv2/sounds/<id>/download/` with the same bearer header,
   stream the response to `samples/freesound/<directory>/<id>-<original filename>` (prefixing with the
   sound ID guarantees no collisions and keeps a traceable link back to the source sound).
8. Also write `samples/freesound/<directory>/credits.json`: one entry per sample with `id`, `name`,
   `username` (author), `license` — satisfies CC-BY-style attribution requirements. Pure sidecar data;
   assumes `samplesToJSON.js` ignores files it doesn't recognize as audio (flagged in critique).
9. Shell out to `samplesToJSON.js` with no arguments (`execFileSync('node', ['samplesToJSON.js'])` or
   equivalent) so the destination project's existing manifest-generation logic picks up the new files.
   This script does **not** write or merge any manifest itself — that's entirely `samplesToJSON.js`'s job.

## Files touched (in whichever project this lands in)

- `.env` (new, gitignored) — not committed
- `.gitignore` — add `.env`, `samples/freesound/`
- `freesound-samples.js` (new) — standalone, no Satori imports
- `samples/freesound/` (generated at runtime, gitignored) — not committed
- Nothing in Satori itself is modified: no `src/oto/samples.ts` change, no `package.json`/`vite.config.js`
  change, no `public/` involvement.

## Critique / open risks

1. **No token refresh/caching.** Every run repeats the browser login step. Fine for occasional use;
   would need revisiting if this gets run frequently.
2. **Unverified assumption about `samplesToJSON.js`.** This plan takes on faith that it (a) takes no
   arguments, (b) scans `samples/` (or `samples/freesound/` — confirm which) recursively, and (c) safely
   ignores a stray `credits.json` sitting next to audio files rather than erroring or including it as a
   "sample." Worth a quick look at that script once this moves to the destination project, before relying
   on the handoff.
3. **License awareness.** Freesound licenses include CC0, CC-BY, CC-BY-NC, and "Sampling+". The
   `credits.json` sidecar captures attribution data but doesn't block or warn on NC-licensed sounds if the
   resulting music is used commercially — purely informational, not enforced.
4. **Re-running with an existing directory name** re-downloads into the same folder; existing files with
   matching `<id>-<filename>` names get overwritten (harmless, same content), but nothing cleans up if the
   search results differ between runs — old files from a previous run of the same bank name would remain
   and get picked up by `samplesToJSON.js` too. Worth a warning prompt if the directory already exists.
5. **Freesound rate limits** (roughly 60 req/min, 2000/day) are nowhere close to being hit by one search +
   16 downloads per run, so no throttling logic is needed.

## Verification

Once relocated to the destination project (this doesn't touch Satori, so there's nothing to verify here):
1. Run the script, complete the OAuth prompt flow manually (requires a real Freesound account/app),
   confirm `samples/freesound/<directory>/` is populated with audio files + `credits.json`.
2. Run `node samplesToJSON.js` (or confirm the script already shelled out to it) and check the manifest it
   produces includes the new bank correctly.
3. Run the tool a second time with a different directory name and confirm the manifest accumulates both
   banks.
