/**
 * Packs the clickable preview into ONE html file (no other files to load): the recorded answers, the styles and the app.
 *   npm run demo:record   (needs a seeded server; writes web/demo/demo-data.json)
 *   npm run demo:build    (writes web/dist-demo)
 *   npx tsx scripts/build-demo-page.ts [out.html]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';

const out = process.argv[2] ?? 'web/dist-demo/preview.html';
const dir = 'web/dist-demo/assets';
const files = await readdir(dir);
const css = await readFile(`${dir}/${files.find((f) => f.endsWith('.css'))!}`, 'utf8');
const js = await readFile(`${dir}/${files.find((f) => f.endsWith('.js'))!}`, 'utf8');
const data = await readFile('web/demo/demo-data.json', 'utf8');
const safe = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
await writeFile(out, `<title>Operations Platform Preview</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${css}</style>
<div id="root"></div>
<script>window.__DEMO_DATA__ = ${safe(data)};</script>
<script type="module">${safe(js)}</script>
`);
console.log(`wrote ${out}`);
