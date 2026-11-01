import { parseInline, parseMarkdown } from './chat-markdown';

const ids = new Set([5, 12]);

describe('chat markdown', () => {
  it('renders bold, italic and code, with citations inside them', () => {
    expect(parseInline('**Drone 2 [#5]** was *spoofed* at `T+30`', ids)).toEqual([
      { kind: 'text', text: 'Drone 2 ', bold: true },
      { kind: 'cite', id: 5 },
      { kind: 'text', text: ' was ' },
      { kind: 'text', text: 'spoofed', italic: true },
      { kind: 'text', text: ' at ' },
      { kind: 'text', text: 'T+30', code: true },
    ]);
  });

  it('only links citations the backend validated', () => {
    expect(parseInline('see [#99] and [fleet]', ids)).toEqual([
      { kind: 'text', text: 'see ' }, { kind: 'text', text: '[#99]' }, { kind: 'text', text: ' and ' }, { kind: 'fleet' },
    ]);
  });

  it('leaves stray asterisks and snake_case alone', () => {
    expect(parseInline('2 * 3 = 6, RETURN_TO_HOME', ids)).toEqual([{ kind: 'text', text: '2 * 3 = 6, RETURN_TO_HOME' }]);
  });

  it('splits paragraphs, headings and lists', () => {
    const blocks = parseMarkdown('### Rezumat\nPrima linie\na doua linie\n\n* **D2** spoofed [#5]\n* D5 link lost [#12]\n\n1. Loiter\n2. Corridor', ids);
    expect(blocks.map(b => b.kind)).toEqual(['h', 'p', 'ul', 'ol']);
    expect(blocks[1]).toEqual({ kind: 'p', content: [{ kind: 'text', text: 'Prima linie' }, { kind: 'br' }, { kind: 'text', text: 'a doua linie' }] });
    const ul = blocks[2] as { items: { content: unknown[] }[] };
    expect(ul.items.length).toBe(2);
    expect(ul.items[0].content[0]).toEqual({ kind: 'text', text: 'D2', bold: true });
  });

  it('keeps nested and wrapped items in their list', () => {
    const [list] = parseMarkdown('1. Spoofing\n   - D2 [#5]\n   - D3\n2. Jammer\n   still item two', ids) as unknown as [{ kind: string; start: number; items: { depth: number; content: unknown[] }[] }];
    expect(list.kind).toBe('ol');
    expect(list.items.map(i => i.depth)).toEqual([0, 1, 1, 0]);
    expect(list.items[3].content).toEqual([{ kind: 'text', text: 'Jammer' }, { kind: 'text', text: ' ' }, { kind: 'text', text: 'still item two' }]);
  });

  it('never produces markup from model output', () => {
    const [p] = parseMarkdown('<img src=x onerror=alert(1)> **<b>hi</b>**', ids) as unknown as [{ content: { text?: string }[] }];
    expect(p.content.map(c => c.text).join('')).toBe('<img src=x onerror=alert(1)> <b>hi</b>');
  });
});

describe('grouped citations', () => {
  it('links every validated id in [ex. #5, #12, #99]', () => {
    expect(parseInline('jumps [ex. #5, #12, #99] seen', ids)).toEqual([
      { kind: 'text', text: 'jumps ' },
      { kind: 'text', text: 'ex. ' }, { kind: 'cite', id: 5 }, { kind: 'cite', id: 12 }, { kind: 'text', text: ' #99' }, // unknown id: plain text
      { kind: 'text', text: ' seen' },
    ]);
    expect(parseInline('[#5, #12]', ids)).toEqual([{ kind: 'cite', id: 5 }, { kind: 'cite', id: 12 }]);
  });

  it('leaves brackets with no validated id as text', () => {
    const out = parseInline('[#99] and [step 2]', ids);
    expect(out.every(s => s.kind === 'text')).toBeTrue();
    expect(out.map(s => (s as { text: string }).text).join('')).toBe('[#99] and [step 2]');
  });
});
