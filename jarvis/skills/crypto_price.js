const https = require('https');

// Map common names/symbols → CoinGecko IDs
const COIN_MAP = {
    bitcoin: 'bitcoin', btc: 'bitcoin',
    ethereum: 'ethereum', eth: 'ethereum',
    solana: 'solana', sol: 'solana',
    dogecoin: 'dogecoin', doge: 'dogecoin',
    litecoin: 'litecoin', ltc: 'litecoin',
    cardano: 'cardano', ada: 'cardano',
    ripple: 'ripple', xrp: 'ripple',
    polkadot: 'polkadot', dot: 'polkadot',
    binancecoin: 'binancecoin', bnb: 'binancecoin',
    tether: 'tether', usdt: 'tether',
    shiba: 'shiba-inu', shib: 'shiba-inu', 'shiba-inu': 'shiba-inu',
    avalanche: 'avalanche-2', avax: 'avalanche-2',
    polygon: 'matic-network', matic: 'matic-network',
    chainlink: 'chainlink', link: 'chainlink',
    uniswap: 'uniswap', uni: 'uniswap',
    cosmos: 'cosmos', atom: 'cosmos',
    monero: 'monero', xmr: 'monero',
    tron: 'tron', trx: 'tron',
    near: 'near', 'near protocol': 'near',
};

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

async function runCrypto() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const rawCoin = (args.coin || 'bitcoin').toLowerCase().trim();
    const coinId = COIN_MAP[rawCoin] || rawCoin;

    try {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(coinId)}&order=market_cap_desc&per_page=1&page=1&sparkline=false&price_change_percentage=24h`;
        const result = await fetchJson(url);

        if (!result || !result.length) {
            return console.log(JSON.stringify({
                ok: true,
                skill: 'crypto_price',
                data: { found: false, coin: rawCoin, message: `Could not find data for "${rawCoin}". Try a full name like "bitcoin" or "ethereum".` }
            }));
        }

        const c = result[0];
        console.log(JSON.stringify({
            ok: true,
            skill: 'crypto_price',
            data: {
                name: c.name,
                symbol: c.symbol.toUpperCase(),
                price_usd: c.current_price,
                change_24h_pct: c.price_change_percentage_24h != null ? +c.price_change_percentage_24h.toFixed(2) : null,
                market_cap_usd: c.market_cap,
                last_updated: c.last_updated
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'crypto_price',
            error: err.message || err.toString()
        }));
    }
}

runCrypto();
