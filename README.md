# Samples

Add samples in folders under `samples/`. Web browsers like wavs (only `.wav` and `.mp3` files are included in the manifest).

Each folder becomes a bank. Nested folders produce dotted bank names, e.g. `samples/lw/kick/` becomes the bank `lw.kick`. Use nested folders rather than periods in folder names.

## Setup

* `npm i` to install dependencies

## Compiling the manifest

* `npm run compile` at the root of the project to compile a new `samples.json` file, containing any new samples
* to access the json file online, use https://raw.githubusercontent.com/<username>/<repo>/<branch>/samples.json

`samplesToJSON.js` accepts optional flags:

* `--base <url>` - the `_base` URL that sample paths are resolved against (default: `https://raw.githubusercontent.com/cephasteom/samples/main/`)
* `--out <path>` - where to write the manifest (default: `./samples.json`)

```
node samplesToJSON.js --base http://localhost:8080/ --out mySamples.json
```

## Serving locally

* `npm run serve` generates `localSamples.json` with a base URL of `http://localhost:3000/`, then serves the project at that address with CORS enabled
* load the manifest from http://localhost:3000/localSamples.json

`localSamples.json` is gitignored.

## Downloading samples from Freesound

`freesound-samples.js` searches [Freesound](https://freesound.org), downloads original-quality sounds into `samples/freesound/<bank>/`, writes a `credits.json` with attribution and licence info, then recompiles `samples.json`.

1. Create a `.env` file at the project root (gitignored):
   ```
   FREESOUND_CLIENT_ID=<your client id>
   FREESOUND_CLIENT_SECRET=<your client secret>
   ```
   Your Freesound app must have a redirect URI configured (any value works, e.g. `http://localhost:8080/callback`).
2. Run `node freesound-samples.js`
3. Open the printed URL, authorize the app, and paste the `code` param from the redirected URL's address bar
4. Enter search terms, a bank name, the number of samples (default 16), and optionally a max length in seconds

Only WAV and FLAC files at 24-bit or higher and 44.1 kHz or higher are searched for. Freesound's own docs warn its bit depth data isn't fully reliable, so the occasional 16-bit file may still get through.

Sounds are picked at random from the top 150 matches, so repeat runs give different results. Sounds already in the bank are skipped and `credits.json` is appended to, so running the same search into the same bank adds new sounds.

Step 3 only happens on the first run: the token is cached in `.freesound-token.json` (gitignored) and refreshed automatically when it expires. Delete that file to force a fresh login.

Check `credits.json` before using sounds - some Freesound licences require attribution or forbid commercial use.

`samples/freesound/` is gitignored, so these banks are for local use with `npm run serve`.
