/**
 * Builds the user guide: docs/guide-src/*.html (body fragments) -> web/public/guide/*.html (full pages with navigation,
 * search index, print styles). The web build copies web/public into the app, which serves it at /guide/.
 *
 *   npx tsx scripts/build-guide.ts [--check]     (--check also fails on broken links and missing metadata)
 *
 * A fragment starts with one comment line:  <!-- title: Work orders | group: Maintenance | order: 20 | summary: One line. | audience: everyone|admin -->
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SRC = 'docs/guide-src', OUT = 'web/public/guide';
const GROUPS = ['Start here', 'My day', 'Company', 'Maintenance', 'Field service', 'Production', 'Quality and safety', 'Sales and supply', 'Finance', 'Insight', 'Administrator brief', 'Reference'];
interface Page { slug: string; title: string; group: string; order: number; summary: string; admin: boolean; body: string }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const pages: Page[] = [];
const problems: string[] = [];
for (const f of (await readdir(SRC)).filter((x) => x.endsWith('.html')).sort()) {
  const raw = await readFile(path.join(SRC, f), 'utf8');
  const m = raw.match(/^\s*<!--\s*(.*?)\s*-->\s*/s);
  const meta: Record<string, string> = {};
  if (m) for (const part of m[1]!.split('|')) { const i = part.indexOf(':'); if (i > 0) meta[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  const slug = f.replace(/\.html$/, '');
  for (const k of ['title', 'group', 'order', 'summary']) if (!meta[k]) problems.push(`${f}: missing "${k}" in the header comment`);
  if (meta.group && !GROUPS.includes(meta.group)) problems.push(`${f}: unknown group "${meta.group}"`);
  pages.push({ slug, title: meta.title ?? slug, group: meta.group ?? 'Reference', order: Number(meta.order ?? 100), summary: meta.summary ?? '', admin: meta.group === 'Administrator brief', body: raw.slice(m ? m[0].length : 0) });
}
pages.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.order - b.order || a.title.localeCompare(b.title));
const known = new Set(pages.map((p) => p.slug));

// Link check: relative links to other guide pages (with optional #anchor) must exist.
for (const p of pages) {
  const ids = new Set([...p.body.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
  for (const l of p.body.matchAll(/href="([^"]+)"/g)) {
    const href = l[1]!;
    if (/^(https?:|mailto:|\/)/.test(href)) continue;
    const [pg, anchor] = href.split('#');
    if (!pg && anchor) { if (!ids.has(anchor)) problems.push(`${p.slug}: anchor #${anchor} not found`); continue; }
    const target = pg!.replace(/\.html$/, '');
    if (!known.has(target)) { problems.push(`${p.slug}: link to unknown page "${href}"`); continue; }
    if (anchor) { const t = pages.find((x) => x.slug === target)!; if (!new RegExp(`\\sid="${anchor}"`).test(t.body)) problems.push(`${p.slug}: ${target} has no anchor #${anchor}`); }
  }
}

// Headings get ids and a table of contents.
function prepare(p: Page) {
  const toc: { id: string; text: string }[] = []; const seen = new Set<string>();
  const body = p.body.replace(/<h2(\s[^>]*)?>(.*?)<\/h2>/gs, (_m, attrs: string | undefined, inner: string) => {
    const existing = attrs?.match(/id="([^"]+)"/)?.[1];
    let id = existing ?? strip(inner).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    while (seen.has(id)) id += '-2';
    seen.add(id); toc.push({ id, text: strip(inner) });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  // The callout label is added by the stylesheet; drop a repeated leading label.
  const clean = body.replace(/(<div class="(?:who|tip|warn|admin)">\s*)<p>\s*<strong>(?:Who can do this|For administrators|Tip|Careful|Administrators?)\s*:?\s*<\/strong>\s*:?\s*<\/p>\s*/gi, '$1');
  return { body: clean, toc };
}

const nav = (current?: string) => GROUPS.map((g) => {
  const items = pages.filter((p) => p.group === g);
  if (!items.length) return '';
  return `<div class="grp"><h3>${esc(g)}</h3><ul>${items.map((p) => `<li><a href="${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul></div>`;
}).join('');

const shell = (p: { title: string; summary: string; slug: string; group: string; admin?: boolean }, main: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} · User guide</title>
<meta name="description" content="${esc(p.summary)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="guide.css">
<script src="guide.js" defer></script>
</head>
<body${p.admin ? ' class="admin-page"' : ''}>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><button type="button" id="menu" aria-expanded="false" aria-controls="side">Menu</button><a class="brand" href="index.html">User guide</a>
<form id="search" role="search"><input type="search" id="q" placeholder="Search the guide" aria-label="Search the guide" autocomplete="off"><ul id="results" hidden></ul></form>
<a class="app" href="/">Back to the app</a></header>
<div class="layout"><nav id="side" aria-label="Guide contents">${nav(p.slug)}</nav><main id="main">${main}</main></div>
</body></html>
`;

await mkdir(OUT, { recursive: true });
const index: { slug: string; title: string; group: string; text: string }[] = [];
for (let i = 0; i < pages.length; i++) {
  const p = pages[i]!; const { body, toc } = prepare(p);
  const prev = pages[i - 1], next = pages[i + 1];
  const main = `<article><p class="crumb">${esc(p.group)}</p><h1>${esc(p.title)}</h1><p class="lede">${esc(p.summary)}</p>
${p.admin ? '<p class="badge">Administrator brief: more technical, written for the person who sets the system up.</p>' : ''}
${toc.length > 2 ? `<nav class="toc" aria-label="On this page"><strong>On this page</strong><ul>${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : ''}
${body}
<nav class="pager" aria-label="Previous and next">${prev ? `<a rel="prev" href="${prev.slug}.html"><small>Previous</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a rel="next" href="${next.slug}.html"><small>Next</small>${esc(next.title)}</a>` : '<span></span>'}</nav></article>`;
  await writeFile(path.join(OUT, `${p.slug}.html`), shell(p, main));
  index.push({ slug: p.slug, title: p.title, group: p.group, text: strip(body).slice(0, 6000) });
}
await writeFile(path.join(OUT, 'search-index.json'), JSON.stringify(index));
console.log(`guide: ${pages.length} pages, ${index.reduce((s, x) => s + x.text.split(' ').length, 0).toLocaleString()} words indexed`);
if (problems.length) { console.error(problems.join('\n')); if (process.argv.includes('--check')) process.exit(1); }
