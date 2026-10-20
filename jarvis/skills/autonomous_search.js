// JARVIS Skill: Autonomous Web Search
// Performs an invisible background search on the web to retrieve snippets.
const args = JSON.parse(process.argv[2] || '{"query":""}');
const query = (args.query || '').trim();

if (!query) {
  console.log(JSON.stringify({ ok: false, error: 'No search query provided.' }));
  process.exit(0);
}

async function search() {
  try {
    const q = query.slice(0, 512);
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(q)
    });
    
    if (!res.ok) {
      console.log(JSON.stringify({ ok: false, error: `Search failed with status: ${res.status}` }));
      return;
    }
    
    const html = await res.text();
    const results = [];
    const linkRegex = /<a rel="nofollow" href="([^"]+)" class='result-link'>([^<]+)<\/a>/g;
    const snippetRegex = /<td class='result-snippet'>\s*(.*?)\s*<\/td>/gs;

    let linkMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null && results.length < 5) {
      const url = linkMatch[1];
      const title = linkMatch[2];
      const snippetMatch = snippetRegex.exec(html);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim() : "";
      
      const cleanSnippet = snippet.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
      const cleanTitle = title.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
      
      results.push({ url, title: cleanTitle, snippet: cleanSnippet });
    }
    
    console.log(JSON.stringify({ ok: true, data: results }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  }
}

search();
