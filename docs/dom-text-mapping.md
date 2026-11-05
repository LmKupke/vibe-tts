# Normalized text to DOM mapping

## Coordinate system

Every sentence and word offset is end-exclusive and relative to its block's normalized text. The content script keeps the only map between those coordinates and actual `Text` nodes.

Normalization is deliberately narrow:

1. traverse text nodes in DOM order, including text inside inline elements;
2. replace each run of Unicode whitespace, including non-breaking spaces, with one ordinary space;
3. trim leading and trailing whitespace by never emitting an unpaired edge run;
4. preserve every other UTF-16 code unit exactly.

For every emitted code unit, the map stores the source text-node ID and raw start/end offsets. Adjacent entries are compacted into `DOMTextSegment` records for diagnostics, but range reconstruction uses the character map so collapsed whitespace and repeated words remain unambiguous.

```text
block offset [start, end)
  -> first and last mapped source characters
  -> source Text nodes + raw offsets
  -> Range.setStart / Range.setEnd
```

DOM nodes never cross an extension-message boundary. A block ID and word ID can be sent to the content script; only that script resolves them to a `Range`.

The neural HTTP contract uses the same UTF-16 coordinate system. Server-side provider offsets are validated in Python's native Unicode code-point coordinates and converted to UTF-16 code units immediately before serialization. This keeps an alignment entry after an emoji or another supplementary character pointed at the same DOM text as its JavaScript consumer.

## Inline example

```html
<p>This is <strong>very important</strong> information.</p>
```

The paragraph is one block and normally one sentence. Its source map contains three text nodes, but `Range` endpoints may land in different nodes, so sentence highlighting remains continuous.

## Raw Markdown files

Chrome exposes a directly opened Markdown file as one `text/markdown` document with a single `body > pre` text node. On injection, the content script recognizes that shape, preserves the exact `<pre>`, and inserts a semantic `<main>` sibling. Only one root is active; the other remains mounted but hidden and inert. The **View source** / **View rendered** control therefore switches coordinate systems without rebuilding either DOM tree.

In rendered mode, the ordinary DOM mapper indexes headings, paragraphs, list items, quotes, and table cells, so ranges point to visible rendered prose. In source mode, the raw-Markdown parser emits the same semantic block types while retaining offsets into the original `<pre>` text node. Formatting syntax, frontmatter, comments, reference definitions, thematic breaks, fenced or standalone code, Mermaid definitions, URL destinations, and page-control copy are omitted, so source highlights still cover only spoken characters.

Each view keeps its own DOM selection snapshot and page scroll position. The inactive root's persistent nodes also preserve generated Mermaid SVG and disclosure state. Switching modes clears ranges and invalidates the current `ReadingDocument`; prepared or playing narration stops, and the next prepare selects the active root and constructs a fresh map. The tab title changes independently of the mapping: source uses the original title, while rendered mode uses the first H1 when present.

The transformation is tab-local and non-persistent: it never edits the file, and a reload restores Chrome's raw view. Raw HTML is escaped rather than inserted into the page. Remote image syntax is rendered as a labeled link instead of an `<img>`, preventing a local document from initiating an unexpected network request.

A fenced `mermaid` block is a visual-only region. Its generated SVG, accessible figure caption, source disclosure, and any inline error are kept outside the readable block map, so diagram syntax and labels cannot become narration units or highlight targets. The surrounding prose retains the same document order and offset model whether diagram rendering succeeds or falls back to the preserved source.

## Rendered Markdown block starts

After the semantic reading root is built, each eligible H1–H6 or paragraph receives a tab-local block key for its left-gutter **Read from here** control. The gutter and its controls are marked narration-skipped, so their labels, status text, and icons never enter extraction or shift document offsets.

Activating a control resolves the live target element, finds the same element by identity in the existing `BlockDOMMap`, and counts preceding sentences to produce the target block's first sentence index. Playback then consumes the ordinary `ReadingDocument`; no second text extraction or highlight map is created. The first highlight therefore uses that sentence's existing ID and begins exactly where narration begins, then both continue through the following document units.

The controls belong only to rendered mode. When exact raw source is active, the rendered root and its gutter are hidden and inert; source-mode narration continues to use raw offsets in the preserved `<pre>`.

## Mutation policy

The MVP indexes the active readable root and watches that indexed content. A view switch, or a debounced text or child mutation that touches an indexed block, clears its ranges, stops the active session, and marks the document for re-extraction; unrelated page-chrome, animation, and attribute churn are ignored. The next prepare action builds a fresh map. Meaningful route changes do the same immediately, while fragment-only navigation does not interrupt narration.
