const https = require('https');

// WMO Weather Interpretation Codes → human-readable descriptions
const WMO_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
};

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const options = { headers: { 'User-Agent': 'JARVIS-Skill/1.0', 'Accept': 'application/json' } };
        https.get(url, options, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function geocodeLocation(location) {
    // Open-Meteo geocoding API — free, no key required
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const result = await fetchJson(url);
    const place = result?.results?.[0];
    if (!place) throw new Error(`Location not found: "${location}"`);
    return {
        city: place.name,
        country: place.country,
        latitude: place.latitude,
        longitude: place.longitude
    };
}

async function runWeather() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const locationArg = (args.location || '').trim();

    try {
        let lat, lon, locationLabel;

        if (locationArg) {
            // ── Explicit location: geocode it ──────────────────────
            const geo = await geocodeLocation(locationArg);
            lat = geo.latitude;
            lon = geo.longitude;
            locationLabel = `${geo.city}, ${geo.country}`;
        } else {
            // ── Auto-detect via IP ──────────────────────────────────
            const loc = await fetchJson('https://ipapi.co/json/');
            lat = loc.latitude || 52.52;
            lon = loc.longitude || 13.41;
            locationLabel = loc.city
                ? `${loc.city}, ${loc.country_name || loc.country || ''}`
                : 'Unknown';
        }

        // Request weather including weathercode and humidity
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weathercode` +
            `&daily=temperature_2m_max,temperature_2m_min,weathercode` +
            `&timezone=auto&forecast_days=3`;
        const weather = await fetchJson(weatherUrl);
        const cur = weather.current;
        const daily = weather.daily;

        // Build a 3-day forecast summary
        const forecast = (daily?.time || []).slice(0, 3).map((day, i) => ({
            date: day,
            max_temp_c: daily.temperature_2m_max?.[i] ?? null,
            min_temp_c: daily.temperature_2m_min?.[i] ?? null,
            condition: WMO_CODES[daily.weathercode?.[i]] || `WMO code ${daily.weathercode?.[i]}`
        }));

        console.log(JSON.stringify({
            ok: true,
            skill: 'weather',
            data: {
                location: locationLabel,
                latitude: lat,
                longitude: lon,
                temperature_c: cur.temperature_2m,
                humidity_pct: cur.relative_humidity_2m,
                wind_speed_kmh: cur.wind_speed_10m,
                condition: WMO_CODES[cur.weathercode] || `WMO code ${cur.weathercode}`,
                units: weather.current_units,
                forecast_3day: forecast
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'weather',
            error: err.message || err.toString()
        }));
    }
}

runWeather();
