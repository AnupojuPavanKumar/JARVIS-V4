const https = require('https');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'JARVIS-Skill/1.0',
                'Accept': 'application/json'
            }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 404) {
                    // Free Dictionary returns 404 for unknown words
                    try {
                        const parsed = JSON.parse(data);
                        return resolve({ _not_found: true, message: parsed.message || 'Word not found' });
                    } catch (_) {
                        return resolve({ _not_found: true, message: 'Word not found' });
                    }
                }
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function runDefine() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const word = (args.word || '').trim().toLowerCase();

    if (!word) {
        return console.log(JSON.stringify({
            ok: false,
            skill: 'define_word',
            error: 'Missing required param "word".'
        }));
    }

    try {
        const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
        const result = await fetchJson(url);

        if (result._not_found || !Array.isArray(result)) {
            return console.log(JSON.stringify({
                ok: true,
                skill: 'define_word',
                data: { found: false, word, message: result.message || 'No definition found.' }
            }));
        }

        const entry = result[0];
        // Collect up to 3 meanings
        const meanings = (entry.meanings || []).slice(0, 3).map(m => ({
            part_of_speech: m.partOfSpeech,
            definitions: (m.definitions || []).slice(0, 2).map(d => ({
                definition: d.definition,
                example: d.example || null
            })),
            synonyms: (m.synonyms || []).slice(0, 5),
            antonyms: (m.antonyms || []).slice(0, 5)
        }));

        console.log(JSON.stringify({
            ok: true,
            skill: 'define_word',
            data: {
                found: true,
                word: entry.word,
                phonetic: entry.phonetic || (entry.phonetics || []).find(p => p.text)?.text || null,
                meanings,
                audio_url: (entry.phonetics || []).find(p => p.audio)?.audio || null
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'define_word',
            error: err.message || err.toString()
        }));
    }
}

runDefine();
