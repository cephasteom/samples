const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');
const { execFileSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '.env');

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

async function exchangeCodeForToken(code, clientId, clientSecret) {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
    });

    const res = await fetch('https://freesound.org/apiv2/oauth2/access_token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    return data.access_token;
}

async function searchSounds(query, pageSize, accessToken) {
    const url = new URL('https://freesound.org/apiv2/search/text/');
    url.searchParams.set('query', query);
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('fields', 'id,name,username,license,type');

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
        throw new Error(`Search failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    return data.results || [];
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
        const code = await authorize(rl, clientId);
        console.log('Exchanging code for access token...');
        const accessToken = await exchangeCodeForToken(code, clientId, clientSecret);

        const query = (await rl.question('Search terms: ')).trim();
        const directory = (await rl.question('Bank directory name: ')).trim();
        const countInput = (await rl.question('Number of samples to download [16]: ')).trim();
        const count = countInput ? parseInt(countInput, 10) : 16;

        if (!query || !directory) {
            throw new Error('Search terms and directory name are required.');
        }

        const destDir = path.join(__dirname, 'samples', 'freesound', directory);
        if (fs.existsSync(destDir)) {
            console.warn(`Warning: ${destDir} already exists. Matching files will be overwritten, but stale files from a previous run with different results will remain.`);
        }
        fs.mkdirSync(destDir, { recursive: true });

        console.log(`Searching Freesound for "${query}"...`);
        const results = await searchSounds(query, count, accessToken);
        if (results.length === 0) {
            console.log('No results found.');
            return;
        }
        console.log(`Found ${results.length} sound(s). Downloading...`);

        const credits = [];
        for (const sound of results) {
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
