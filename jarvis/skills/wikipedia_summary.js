const https = require('https');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'JARVIS-Skill/1.0 (educational; contact@jarvis.local)',
                'Accept': 'application/json'
            }
        };
        https.get(url, options, (res) => {
            // Follow redirects (301/302)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function runWikipedia() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const query = (args.query || '').trim();

    if (!query) {
        return console.log(JSON.stringify({
            ok: false,
            skill: 'wikipedia_summary',
            error: 'Missing required param "query"'
        }));
    }

    try {
        // Search for the best matching article title
        const encoded = encodeURIComponent(query);
        const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=1&format=json&origin=*`;
        const searchResult = await fetchJson(searchUrl);
        const hits = searchResult?.query?.search || [];

        if (!hits.length) {
            return console.log(JSON.stringify({
                ok: true,
                skill: 'wikipedia_summary',
                data: { found: false, query }
            }));
        }

        const title = hits[0].title;
        const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;
        const page = await fetchJson(summaryUrl);

        console.log(JSON.stringify({
            ok: true,
            skill: 'wikipedia_summary',
            data: {
                found: true,
                title: page.title,
                extract: page.extract || page.description || 'No summary available.',
                url: page.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodedTitle}`
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'wikipedia_summary',
            error: err.message || err.toString()
        }));
    }
}

runWikipedia();
