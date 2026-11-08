// Builds store.json, what NeoStore shows of every plugin without asking GitHub's API itself (60 requests an hour per computer):
// every repository with the topic neodex-plugin and a plugin.json, whether NeoDex approved it (index.json), its English name and
// description (locales/en.json), how many times its archive was downloaded, its stars, and its reviews (issues « avis » of this repository).
// Run every hour by .github/workflows/store.yml. Locally: GITHUB_TOKEN=… node tools/store.js   (node tools/store.js test: self-check)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), API = 'https://api.github.com', RAW = 'https://raw.githubusercontent.com/';
const REPO = process.env.GITHUB_REPOSITORY || 'NDesumeur/neodex-store-catalog';
const H = { 'User-Agent': 'neodex-store-robot', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) };

async function api(url) {
  const r = await fetch(url.startsWith('http') ? url : API + url, { headers: H });
  if (!r.ok) throw new Error(url + ' : ' + r.status);
  return { data: await r.json(), next: /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')?.[1] };
}
async function all(url) { const out = []; for (let u = url, n = 0; u && n < 10; n++) { const r = await api(u); out.push(...(Array.isArray(r.data) ? r.data : r.data.items || [])); u = r.next; } return out; }
async function raw(repo, file) { const r = await fetch(RAW + repo + '/HEAD/' + file, { headers: { 'User-Agent': H['User-Agent'] } }); return r.ok ? r.text() : null; }
const json = s => { try { return JSON.parse(s); } catch { return null; } };

// a review: the issue form of .github/ISSUE_TEMPLATE/avis.yml (### Plugin, ### Note, ### Avis); one per person and plugin, the latest
const parseReview = body => { const f = {}; for (const part of String(body || '').split(/^### /m).slice(1)) { const nl = part.indexOf('\n'); f[part.slice(0, nl).trim().toLowerCase()] = part.slice(nl + 1).trim(); } return f; };
function ratings(issues) {
  const by = {};  // plugin id -> [review]
  for (const is of [...issues].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const f = parseReview(is.body), id = (f.plugin || '').trim(), stars = +(/[1-5]/.exec(f.note || '') || [0])[0], who = is.user?.login || '';
    if (!id || !stars) continue;
    const list = by[id] ||= [];
    if (list.some(r => r.who === who)) continue;
    list.push({ who, stars, text: (f.avis || '').replace(/^_No response_$/, '').slice(0, 2000), at: is.created_at, url: is.html_url });
  }
  const out = {};
  for (const [id, list] of Object.entries(by)) out[id] = { average: Math.round(list.reduce((a, r) => a + r.stars, 0) / list.length * 100) / 100, count: list.length, list: list.slice(0, 20) };
  return out;
}

async function build() {
  const index = json(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8')) || {}, approved = new Map((index.plugins || []).map(p => [p.id, p]));
  const repos = await all('/search/repositories?q=topic:neodex-plugin&per_page=100');
  const reviews = ratings(await all('/repos/' + REPO + '/issues?labels=avis&state=open&per_page=100').catch(() => []));
  const plugins = [];
  for (let i = 0; i < repos.length; i += 8) await Promise.all(repos.slice(i, i + 8).map(async r => {
    const m = json(await raw(r.full_name, 'plugin.json'));
    if (!m || typeof m.id !== 'string') return;
    const en = json(await raw(r.full_name, 'locales/en.json')), a = approved.get(m.id);
    const rels = await all('/repos/' + r.full_name + '/releases?per_page=100').catch(() => []);
    const installs = rels.reduce((n, rel) => n + (rel.assets || []).filter(x => /\.zip$/i.test(x.name)).reduce((s, x) => s + (x.download_count || 0), 0), 0);
    const name = String(m.name || r.name), description = String(m.description || r.description || '');
    plugins.push({
      id: m.id, repo: r.full_name, name, description, version: String(m.version || ''), category: m.category || '',
      approved: !!(a && a.repo === r.full_name), stars: r.stargazers_count || 0, installs, updated: r.pushed_at,
      langs: en ? ['fr', 'en'] : ['fr'],
      en: en ? { name: en[name.replace(/\s+/g, ' ').trim()] || name, description: en[description.replace(/\s+/g, ' ').trim()] || description } : null,
      rating: reviews[m.id] || { average: 0, count: 0, list: [] },
    });
  }));
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return { storeVersion: 1, updated: new Date().toISOString(), plugins };
}

if (process.argv[2] === 'test') {
  const assert = require('assert'), mk = (who, id, note, at, avis = '') => ({ user: { login: who }, created_at: at, html_url: 'u', body: '### Plugin\n\n' + id + '\n\n### Note\n\n' + note + '\n\n### Avis\n\n' + (avis || '_No response_') });
  const r = ratings([mk('a', 'neodex.x', '5 ★★★★★', '2026-01-01'), mk('a', 'neodex.x', '3 ★★★☆☆', '2026-02-01', 'bof'), mk('b', 'neodex.x', '4 ★★★★☆', '2026-01-15'), mk('c', 'neodex.y', '', '2026-01-01')]);
  assert.deepStrictEqual([r['neodex.x'].average, r['neodex.x'].count, r['neodex.x'].list[0].text, r['neodex.x'].list[1].text], [3.5, 2, 'bof', '']);  // a's latest review only; « _No response_ » is no text
  assert(!r['neodex.y']);  // no note, no review
  console.log('store: ok');
} else build().then(s => {
  const f = path.join(ROOT, 'store.json'), old = json(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  if (old && JSON.stringify(old.plugins) === JSON.stringify(s.plugins)) return console.log('store.json : rien de neuf');  // no commit every hour for nothing
  fs.writeFileSync(f, JSON.stringify(s, null, 1) + '\n');
  console.log('store.json : ' + s.plugins.length + ' plugins');
}).catch(e => { console.error(e); process.exit(1); });
