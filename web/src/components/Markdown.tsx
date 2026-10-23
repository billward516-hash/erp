import type { ReactNode } from 'react';

/**
 * A small, safe Markdown subset for policies (D-128): headings (## and ###), paragraphs, bullet and numbered lists,
 * **bold** and _italic_. It builds React elements, never HTML strings, so policy text cannot inject markup.
 * [[placeholders]] are highlighted; a line holding only a {{token}} is replaced by `tokens[token]`.
 */
export function Markdown({ text, tokens = {} }: { text: string; tokens?: Record<string, ReactNode> }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0; let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) { i++; continue; }
    const token = /^\{\{(\w+)\}\}$/.exec(t);
    if (token) { blocks.push(<div key={k++}>{tokens[token[1]!] ?? null}</div>); i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      const level = h[1]!.length;
      const content = inline(h[2]!);
      blocks.push(level <= 2 ? <h2 key={k++}>{content}</h2> : <h3 key={k++}>{content}</h3>);
      i++; continue;
    }
    if (/^([-*]|\d+\.)\s+/.test(t)) {
      const ordered = /^\d+\./.test(t);
      const items: ReactNode[] = [];
      while (i < lines.length && /^([-*]|\d+\.)\s+/.test(lines[i]!.trim())) {
        items.push(<li key={items.length}>{inline(lines[i]!.trim().replace(/^([-*]|\d+\.)\s+/, ''))}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|[-*]\s|\d+\.\s|\{\{\w+\}\}$)/.test(lines[i]!.trim())) { para.push(lines[i]!.trim()); i++; }
    blocks.push(<p key={k++}>{inline(para.join(' '))}</p>);
  }
  return <div className="prose">{blocks}</div>;
}

/** **bold**, _italic_ and [[placeholder]] inside a line. */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_|\[\[[^\]]*\]\])/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const x = m[0];
    if (x.startsWith('**')) out.push(<strong key={k++}>{x.slice(2, -2)}</strong>);
    else if (x.startsWith('[[')) out.push(<mark key={k++} className="placeholder" title="To complete before publishing">{x}</mark>);
    else out.push(<em key={k++}>{x.slice(1, -1)}</em>);
    last = m.index + x.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
