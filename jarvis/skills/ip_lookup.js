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
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function runIpLookup() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const ip = (args.ip || '').trim();

    // If no IP given, look up caller's own public IP
    const target = ip || 'json';
    const url = ip
        ? `https://ipapi.co/${encodeURIComponent(ip)}/json/`
        : 'https://ipapi.co/json/';

    try {
        const data = await fetchJson(url);

        if (data.error) {
            return console.log(JSON.stringify({
                ok: false,
                skill: 'ip_lookup',
                error: data.reason || data.error
            }));
        }

        console.log(JSON.stringify({
            ok: true,
            skill: 'ip_lookup',
            data: {
                ip: data.ip,
                city: data.city,
                region: data.region,
                country: data.country_name,
                country_code: data.country_code,
                latitude: data.latitude,
                longitude: data.longitude,
                timezone: data.timezone,
                utc_offset: data.utc_offset,
                isp: data.org,
                currency: data.currency
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'ip_lookup',
            error: err.message || err.toString()
        }));
    }
}

runIpLookup();
