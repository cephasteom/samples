const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');
const { execFileSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '.env');
const TOKEN_PATH = path.join(__dirname, '.freesound-token.json');
// the API's maximum page size
const SEARCH_POOL_SIZE = 150;
const QUALITY_FILTER = 'type:(wav OR flac) bitdepth:[24 TO *] samplerate:[44100 TO *]';

function loadEnv() {
    try {
        process.loadEnvFile(ENV_PATH);
    } catch (err) {
        console.error(`Could not load ${ENV_PATH}: ${err.message}`);
        console.error('Create a .env file with FREESOUND_CLIENT_ID and FREESOUND_CLIENT_SECRET (see FREESOUND.md).');
        process.exit(1);
    }

    const { FREESOUND_CLIENT_ID, FREESOUND_CLIENT_SECRET } = process.env;
    if (!FREESOUND_CLIENT_ID || !FREESOUND_CLIENT_SECRET) {
        console.error('Missing FREESOUND_CLIENT_ID or FREESOUND_CLIENT_SECRET in .env');
        process.exit(1);
    }

    return { clientId: FREESOUND_CLIENT_ID, clientSecret: FREESOUND_CLIENT_SECRET };
}

async function authorize(rl, clientId) {
    const state = Math.random().toString(36).slice(2);
    const authorizeUrl = `https://freesound.org/apiv2/oauth2/authorize/?client_id=${clientId}&response_type=code&state=${state}`;

    console.log('\nOpen this URL in a browser, log in, and authorize the app:');
    console.log(authorizeUrl);
    console.log('\nYou will land on a dead page after authorizing - copy the "code" query param from its address bar.\n');

    return (await rl.question('Paste the code here: ')).trim();
}

async function requestToken(params, clientId, clientSecret) {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });

    const res = await fetch('https://freesound.org/apiv2/oauth2/access_token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const token = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        // refresh a minute early so a token never expires mid-run
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
    return token;
}

function readCachedToken() {
    try {
        return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch {
        return null;
    }
}

async function getAccessToken(rl, clientId, clientSecret) {
    const cached = readCachedToken();

    if (cached && Date.now() < cached.expiresAt) {
        console.log('Using cached Freesound token.');
        return cached.accessToken;
    }

    if (cached?.refreshToken) {
        try {
            console.log('Refreshing Freesound token...');
            const token = await requestToken(
                { grant_type: 'refresh_token', refresh_token: cached.refreshToken },
                clientId,
                clientSecret,
            );
            return token.accessToken;
        } catch (err) {
            console.warn(`Refresh failed, logging in again. (${err.message})`);
        }
    }

    const code = await authorize(rl, clientId);
    console.log('Exchanging code for access token...');
    const token = await requestToken({ grant_type: 'authorization_code', code }, clientId, clientSecret);
    return token.accessToken;
}

async function searchSounds(query, maxDuration, accessToken) {
    const url = new URL('https://freesound.org/apiv2/search/');
    url.searchParams.set('query', query);
    url.searchParams.set('page_size', String(SEARCH_POOL_SIZE));
    const durationFilter = maxDuration ? ` duration:[* TO ${maxDuration}]` : '';
    url.searchParams.set('filter', QUALITY_FILTER + durationFilter);
    url.searchParams.set('fields', 'id,name,username,license,type');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
        throw new Error(`Search failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    return data.results || [];
}

function readExistingBank(destDir) {
    let credits = [];
    try {
        credits = JSON.parse(fs.readFileSync(path.join(destDir, 'credits.json'), 'utf8'));
    } catch {}

    const ids = new Set(credits.map((c) => c.id));
    for (const file of fs.readdirSync(destDir)) {
        const id = parseInt(file, 10);
        if (!Number.isNaN(id)) ids.add(id);
    }
    return { credits, ids };
}

function pickRandom(items, n) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, n);
}

async function downloadSound(sound, destDir, accessToken) {
    const res = await fetch(`https://freesound.org/apiv2/sounds/${sound.id}/download/`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new Error(`Download failed for sound ${sound.id}: ${res.status} ${await res.text()}`);
    }

    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const originalName = match ? match[1] : `${sound.name}.${sound.type}`;
    const filename = `${sound.id}-${originalName}`;

    fs.writeFileSync(path.join(destDir, filename), Buffer.from(await res.arrayBuffer()));
    return filename;
}

async function main() {
    const { clientId, clientSecret } = loadEnv();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
        const accessToken = await getAccessToken(rl, clientId, clientSecret);

        const query = (await rl.question('Search terms: ')).trim();
        const directory = (await rl.question('Bank directory name: ')).trim();
        const countInput = (await rl.question('Number of samples to download [16]: ')).trim();
        const count = countInput ? parseInt(countInput, 10) : 16;
        const maxDurationInput = (await rl.question('Max length in seconds [no limit]: ')).trim();
        const maxDuration = maxDurationInput ? Number(maxDurationInput) : null;

        if (!query || !directory) {
            throw new Error('Search terms and directory name are required.');
        }
        if (maxDuration !== null && !(maxDuration > 0)) {
            throw new Error(`Max length must be a positive number of seconds, got "${maxDurationInput}".`);
        }

        const destDir = path.join(__dirname, 'samples', 'fs', directory);
        fs.mkdirSync(destDir, { recursive: true });
        const existing = readExistingBank(destDir);
        if (existing.ids.size > 0) {
            console.log(`Bank "${directory}" already has ${existing.ids.size} sound(s); those will be skipped.`);
        }

        console.log(`Searching Freesound for "${query}"...`);
        const results = await searchSounds(query, maxDuration, accessToken);
        const candidates = results.filter((sound) => !existing.ids.has(sound.id));
        if (candidates.length === 0) {
            console.log(results.length === 0 ? 'No results found.' : 'No new sounds left for this search in this bank.');
            return;
        }

        const picked = pickRandom(candidates, count);
        console.log(`Picked ${picked.length} random sound(s) from ${candidates.length} new match(es). Downloading...`);

        const credits = existing.credits;
        for (const sound of picked) {
            const filename = await downloadSound(sound, destDir, accessToken);
            console.log(`Downloaded ${filename}`);
            credits.push({
                id: sound.id,
                name: sound.name,
                username: sound.username,
                license: sound.license,
            });
        }

        fs.writeFileSync(path.join(destDir, 'credits.json'), JSON.stringify(credits, null, 2));
        console.log(`Wrote credits.json with ${credits.length} entries.`);

        console.log('Regenerating samples.json via samplesToJSON.js...');
        execFileSync('node', ['samplesToJSON.js'], { cwd: __dirname, stdio: 'inherit' });

        console.log('Done.');
    } finally {
        rl.close();
    }
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
