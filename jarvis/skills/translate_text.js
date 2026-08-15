const https = require('https');

// BCP-47 language tag aliases for common names
const LANG_MAP = {
    english: 'en', french: 'fr', spanish: 'es', german: 'de',
    italian: 'it', portuguese: 'pt', dutch: 'nl', russian: 'ru',
    japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar',
    hindi: 'hi', turkish: 'tr', polish: 'pl', swedish: 'sv',
    norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
    czech: 'cs', hungarian: 'hu', romanian: 'ro', ukrainian: 'uk',
    hebrew: 'he', thai: 'th', vietnamese: 'vi', indonesian: 'id',
    malay: 'ms', persian: 'fa', urdu: 'ur', bengali: 'bn',
    tamil: 'ta', telugu: 'te', punjabi: 'pa', gujarati: 'gu',
    kannada: 'kn', marathi: 'mr',
};

function resolveLang(lang) {
    if (!lang) return 'en';
    const l = lang.toLowerCase().trim();
    return LANG_MAP[l] || l; // Accept raw BCP-47 tags like "fr", "de-AT"
}

function fetchTranslation(text, fromLang, toLang) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            q: text,
            langpair: `${fromLang}|${toLang}`,
            de: 'jarvis@local.dev' // MyMemory recommends an email for higher quota
        });
        const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
        const options = { headers: { 'User-Agent': 'JARVIS-Skill/1.0', 'Accept': 'application/json' } };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function runTranslate() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const text   = (args.text   || '').trim();
    const toLang = resolveLang(args.to   || args.target_language || 'en');
    const fromLang = resolveLang(args.from || args.source_language || 'autodetect');

    if (!text) {
        return console.log(JSON.stringify({
            ok: false,
            skill: 'translate_text',
            error: 'Missing required param "text". Provide "to" (target language) and optionally "from" (source language).'
        }));
    }

    // MyMemory uses "autodetect" as a special source marker (treated like auto)
    const langPairFrom = fromLang === 'autodetect' ? 'autodetect' : fromLang;

    try {
        const resp = await fetchTranslation(text, langPairFrom, toLang);
        const match = resp?.responseData;

        if (!match || resp.responseStatus !== 200) {
            return console.log(JSON.stringify({
                ok: false,
                skill: 'translate_text',
                error: resp?.responseDetails || 'Translation failed.'
            }));
        }

        // Detect if quota was hit — MyMemory returns a canned message
        const translatedText = match.translatedText || '';
        if (translatedText.toLowerCase().includes('mymemory') && translatedText.toLowerCase().includes('quota')) {
            return console.log(JSON.stringify({
                ok: false,
                skill: 'translate_text',
                error: 'Translation quota exceeded for today (5,000 chars/day free limit).'
            }));
        }

        console.log(JSON.stringify({
            ok: true,
            skill: 'translate_text',
            data: {
                original_text: text,
                translated_text: translatedText,
                source_language: fromLang === 'autodetect' ? 'auto-detected' : fromLang,
                target_language: toLang,
                confidence: match.match != null ? Math.round(match.match * 100) + '%' : null
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'translate_text',
            error: err.message || err.toString()
        }));
    }
}

runTranslate();
