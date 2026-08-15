// read_url.js — JARVIS skill: Scrape and extract text from a URL
// args: { url: string }
const args = JSON.parse(process.argv[3] || '{}');
const url = (args.url || '').trim();

if (!url) {
  console.log(JSON.stringify({ ok: false, error: 'No URL provided.' }));
  process.exit(0);
}

// Check if valid URL
try {
  new URL(url);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Invalid URL format.' }));
  process.exit(0);
}

async function scrape() {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const html = await res.text();
    
    // Very basic regex HTML to text converter without external dependencies
    let text = html
      // Remove head, script, style tags and their contents
      .replace(/<(head|script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // Replace some tags with newlines for formatting
      .replace(/<\/(p|div|h[1-6]|br|li)>/gi, '\n')
      // Remove all remaining tags
      .replace(/<[^>]+>/g, ' ')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Remove excessive whitespace and empty lines
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
      
    // Truncate to avoid context window explosion (approx 3000 tokens ~ 12000 chars)
    if (text.length > 12000) {
      text = text.substring(0, 12000) + '... (Content truncated for length)';
    }

    console.log(JSON.stringify({ ok: true, result: text }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  }
}

scrape();
