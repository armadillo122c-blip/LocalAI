'use strict';

// fetch_url: read documentation pages, API references and GitHub files.

const http = require('http');
const https = require('https');
const net = require('net');
const { headTail } = require('../util');
const { redactSecrets } = require('../safety');

const MAX_BYTES = 3 * 1024 * 1024;

function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

// Turn github.com blob URLs into raw file URLs so the model gets source, not HTML chrome.
function rewriteUrl(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return url;
}

function htmlToText(html) {
  let s = html;
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|iframe)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => '\n```\n' + code.replace(/<[^>]+>/g, '') + '\n```\n');
  s = s.replace(/<(h[1-6])[^>]*>/gi, '\n\n## ').replace(/<\/(h[1-6])>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|\/p|\/div|\/tr|\/section|\/article|\/table|\/ul|\/ol)[^>]*>/gi, '\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `# ${title.trim()}\n\n` : '') + s;
}

function get(url, { signal, redirects = 5, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'LocalAI-Coder/1.0', Accept: 'text/html,text/plain,application/json,*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        get(next, { signal, redirects: redirects - 1, timeoutMs }).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8'), url: u.toString() }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    signal?.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
  });
}

const fetchUrlTool = {
  name: 'fetch_url',
  category: 'web',
  description: 'Download a web page or file (documentation, API reference, GitHub README or source file) and return it as text. Only http/https.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL starting with https://' },
    },
    required: ['url'],
  },
  summarize: (a) => a.url,
  async run(args, ctx) {
    let url = String(args.url || '').trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, output: 'Invalid URL. Use a full URL like https://example.com/docs' };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, output: 'Only http and https URLs are allowed.' };
    url = rewriteUrl(url);
    const priv = isPrivateHost(parsed.hostname);
    if (ctx.permissions.web !== 'auto' || priv || ctx.forceApproval) {
      const res = await ctx.approve({
        kind: priv ? 'danger' : 'web',
        category: 'web',
        title: priv ? 'Access a local network address?' : 'Fetch this URL?',
        url,
        reasons: priv ? ['This address is on your computer or local network'] : [],
        blanket: !priv,
      });
      if (!res.approved) return { ok: false, rejected: true, output: 'The user rejected this request.' + (res.feedback ? ` User feedback: ${res.feedback}` : '') };
    }
    let res;
    try {
      res = await get(url, { signal: ctx.signal });
    } catch (err) {
      return { ok: false, output: `Request failed: ${err.message}` };
    }
    let text = res.body;
    if (/html/i.test(res.type) || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text);
    else if (/json/i.test(res.type)) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
    }
    const body = headTail(redactSecrets(text), ctx.limits.readChars, 0.8);
    return { ok: res.status < 400, output: `HTTP ${res.status} ${res.url}\n\n${body}` };
  },
};

// ------------------------------------------------------------- web_search

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded url>.
function resultUrl(href) {
  const h = decodeEntities(href);
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (h.startsWith('//')) return 'https:' + h;
  return h;
}

/** Parse DuckDuckGo's HTML (html.duckduckgo.com) or lite (lite.duckduckgo.com) result page. */
function parseSearchResults(html, max = 8) {
  const results = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) || b.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const snip = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i);
    const url = resultUrl(a[1]);
    if (/duckduckgo\.com\/y\.js|\/\/duckduckgo\.com\/?$/.test(url)) continue; // ads
    results.push({ title: decodeEntities(a[2]), url, snippet: snip ? decodeEntities(snip[1]) : '' });
    if (results.length >= max) return results;
  }
  if (!results.length) {
    // lite layout: <a class="result-link" href="...">title</a> ... <td class="result-snippet">...</td>
    const re = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < max) {
      results.push({ title: decodeEntities(m[2]), url: resultUrl(m[1]), snippet: decodeEntities(m[3]) });
    }
  }
  return results;
}

const webSearchTool = {
  name: 'web_search',
  category: 'web',
  description: 'Search the web (DuckDuckGo) and get the top results with titles, links and snippets. Use fetch_url afterwards to read a result.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
    },
    required: ['query'],
  },
  summarize: (a) => a.query,
  async run(args, ctx) {
    const query = String(args.query || args.q || '').trim();
    if (!query) return { ok: false, output: 'query is required' };
    if (ctx.permissions.web !== 'auto' || ctx.forceApproval) {
      const res = await ctx.approve({ kind: 'web', category: 'web', title: 'Search the web?', url: `Search: ${query}`, reasons: [], blanket: true });
      if (!res.approved) return { ok: false, rejected: true, output: 'The user rejected this search.' + (res.feedback ? ` User feedback: ${res.feedback}` : '') };
    }
    const endpoints = [
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    ];
    let lastError = '';
    for (const url of endpoints) {
      try {
        const res = await get(url, { signal: ctx.signal });
        const results = parseSearchResults(res.body);
        if (results.length) {
          const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n');
          return { ok: true, output: `Results for "${query}":\n${text}` };
        }
        lastError = `HTTP ${res.status}, no results found`;
      } catch (err) {
        lastError = err.message;
      }
    }
    return { ok: false, output: `Web search failed (${lastError}). Check the internet connection, or use fetch_url with a known documentation URL.` };
  },
};

module.exports = { fetchUrlTool, webSearchTool, parseSearchResults, htmlToText, isPrivateHost, rewriteUrl };
