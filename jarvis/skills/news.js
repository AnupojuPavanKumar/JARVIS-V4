const https = require('https');

// Topic → BBC RSS feed URL
const TOPIC_FEEDS = {
    world:        'https://feeds.bbci.co.uk/news/world/rss.xml',
    technology:   'https://feeds.bbci.co.uk/news/technology/rss.xml',
    tech:         'https://feeds.bbci.co.uk/news/technology/rss.xml',
    business:     'https://feeds.bbci.co.uk/news/business/rss.xml',
    science:      'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    health:       'https://feeds.bbci.co.uk/news/health/rss.xml',
    sports:       'https://feeds.bbci.co.uk/sport/rss.xml',
    sport:        'https://feeds.bbci.co.uk/sport/rss.xml',
    entertainment:'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
    politics:     'https://feeds.bbci.co.uk/news/politics/rss.xml',
    uk:           'https://feeds.bbci.co.uk/news/uk/rss.xml',
    us:           'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
    asia:         'https://feeds.bbci.co.uk/news/world/asia/rss.xml',
    europe:       'https://feeds.bbci.co.uk/news/world/europe/rss.xml',
    africa:       'https://feeds.bbci.co.uk/news/world/africa/rss.xml',
};

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'JARVIS-Skill/1.0',
                'Accept': 'application/rss+xml, application/xml, text/xml'
            }
        };
        const req = https.get(url, options, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                resolve(data);
            });
        });
        req.on('error', reject);
    });
}

// Minimal RSS parser — extracts <item> blocks and reads title, link, pubDate
function parseRss(xml) {
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    const tagRe = (tag) => new RegExp(`<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const title = (block.match(tagRe('title'))  || [])[1]?.trim() || '';
        const link  = (block.match(tagRe('link'))   || [])[1]?.trim()
                   || (block.match(/<link\s*\/>?\s*([^\s<>]+)/i) || [])[1]?.trim() || '';
        const date  = (block.match(tagRe('pubDate'))|| [])[1]?.trim() || '';
        const desc  = (block.match(tagRe('description')) || [])[1]?.trim() || '';
        if (title) items.push({ title, link, pubDate: date, description: desc.replace(/<[^>]+>/g,'').slice(0,150) });
    }
    return items;
}

async function runNews() {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const topic = (args.topic || 'world').toLowerCase().trim();
    const count = Math.min(parseInt(args.count) || 5, 10); // max 10

    const feedUrl = TOPIC_FEEDS[topic] || TOPIC_FEEDS['world'];

    try {
        const xml = await fetchText(feedUrl);
        const allItems = parseRss(xml);

        if (!allItems.length) {
            return console.log(JSON.stringify({
                ok: false,
                skill: 'news',
                error: 'Could not parse any headlines from the RSS feed.'
            }));
        }

        const headlines = allItems.slice(0, count).map(item => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            snippet: item.description || null
        }));

        console.log(JSON.stringify({
            ok: true,
            skill: 'news',
            data: {
                topic,
                source: 'BBC News',
                headline_count: headlines.length,
                headlines
            }
        }));
    } catch (err) {
        console.log(JSON.stringify({
            ok: false,
            skill: 'news',
            error: err.message || err.toString()
        }));
    }
}

runNews();
