/**
 * The small Markdown subset Gemini uses in copilot answers: paragraphs, headings, bullet and
 * numbered lists, **bold**, *italic*, `code`, plus ORION's [#id] / [fleet] citations.
 * Parsed into plain data the template renders with Angular bindings, never as HTML, so model
 * output can't inject markup.
 */

export type Inline =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean }
  | { kind: 'cite'; id: number }
  | { kind: 'fleet' }
  | { kind: 'br' };

export type Block =
  | { kind: 'p'; content: Inline[] }
  | { kind: 'h'; content: Inline[] }
  | { kind: 'ul' | 'ol'; start: number; items: { content: Inline[]; depth: number }[] };

type Style = { bold?: boolean; italic?: boolean };

/** `validIds`: only citations the backend checked against the log become links. */
export function parseInline(text: string, validIds: Set<number>, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`\n]+`)|(\*\*(?=\S)[\s\S]*?\S\*\*|__(?=\S)[\s\S]*?\S__)|(\*(?=\S)[^*\n]*?\S\*|(?<![\w])_(?=\S)[^_\n]*?\S_(?![\w]))|(\[[^\]\n]*?#\d+[^\]\n]*\])|(\[fleet\])/g;
  let last = 0;
  const push = (t: string) => {
    if (t) out.push({ kind: 'text', text: t, ...style });
  };
  for (const m of text.matchAll(re)) {
    push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1]) out.push({ kind: 'text', text: m[1].slice(1, -1), code: true, ...style });
    else if (m[2]) out.push(...parseInline(m[2].slice(2, -2), validIds, { ...style, bold: true }));
    else if (m[3]) out.push(...parseInline(m[3].slice(1, -1), validIds, { ...style, italic: true }));
    else if (m[4]) out.push(...parseCitations(m[4], validIds, style));
    else out.push({ kind: 'fleet' });
  }
  push(text.slice(last));
  return out;
}

/** [#5], [#5, #12] or [ex. #5, #12]: each validated id becomes a link, the rest stays text. */
function parseCitations(group: string, validIds: Set<number>, style: Style): Inline[] {
  const ids = [...group.matchAll(/#(\d+)/g)].map(x => Number(x[1]));
  if (!ids.some(id => validIds.has(id))) return [{ kind: 'text', text: group, ...style }];
  const out: Inline[] = [];
  let last = 0;
  for (const x of group.matchAll(/#(\d+)/g)) {
    const id = Number(x[1]);
    if (!validIds.has(id)) continue;
    // Keep any words ("ex.", "vezi") but drop the brackets and the separators between ids.
    const between = group.slice(last, x.index).replace(/^\[|[\s,;]+$/g, '').trim();
    if (between) out.push({ kind: 'text', text: between + ' ', ...style });
    out.push({ kind: 'cite', id });
    last = x.index! + x[0].length;
  }
  const rest = group.slice(last).replace(/^[\s,;]+|\]$/g, '').trim();
  if (rest) out.push({ kind: 'text', text: ' ' + rest, ...style });
  return out;
}

const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*$/;

export function parseMarkdown(text: string, validIds: Set<number>): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const content: Inline[] = [];
    para.forEach((line, i) => {
      if (i) content.push({ kind: 'br' });
      content.push(...parseInline(line, validIds));
    });
    blocks.push({ kind: 'p', content });
    para = [];
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line.trim());
    const b = BULLET.exec(line);
    const n = NUMBERED.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', content: parseInline(h[1], validIds) });
    } else if (b || n) {
      flush();
      const kind = b ? 'ul' : 'ol';
      const depth = Math.min(3, Math.floor((b ? b[1] : n![1]).replace(/\t/g, '  ').length / 2));
      const item = { content: parseInline(b ? b[2] : n![3], validIds), depth };
      const prev = blocks.at(-1);
      // Nested items stay in the list they belong to, whatever their marker.
      if (prev && (prev.kind === kind || ((prev.kind === 'ul' || prev.kind === 'ol') && depth > 0))) {
        (prev as Extract<Block, { items: unknown }>).items.push(item);
      } else {
        blocks.push({ kind, start: n ? Number(n[2]) : 1, items: [item] });
      }
    } else {
      const prev = blocks.at(-1);
      if (!para.length && prev && (prev.kind === 'ul' || prev.kind === 'ol') && /^\s{2,}\S/.test(raw)) {
        // A wrapped list item: continuation line indented under it.
        const items = prev.items;
        items[items.length - 1].content.push({ kind: 'text', text: ' ' }, ...parseInline(line.trim(), validIds));
      } else {
        para.push(line.trim());
      }
    }
  }
  flush();
  return blocks;
}
