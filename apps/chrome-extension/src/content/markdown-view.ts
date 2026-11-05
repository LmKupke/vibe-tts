import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from "markdown-it";

import { extractReadingDocument, type BlockDOMMap } from "./extractor";
import {
  prepareFlattenedMermaidArtifacts,
  type FlattenedMermaidArtifact,
} from "./flattened-mermaid";
import { installMarkdownReadGutter } from "./markdown-gutter";
import { upgradeMermaidCodeBlocks } from "./mermaid";
import { mapSelectionToDocument } from "./selection";

const MARKDOWN_VIEW_ATTRIBUTE = "vibeTtsMarkdownView";
const MARKDOWN_RENDERED_VALUE = "rendered";
const MARKDOWN_SOURCE_VALUE = "source";
const READER_ID = "vibe-tts-markdown-reader";
const SOURCE_ID = "vibe-tts-markdown-source";
const MARKER_ID = "vibe-tts-markdown-marker";
const TOGGLE_ID = "vibe-tts-markdown-view-toggle";
const STYLE_ID = "vibe-tts-markdown-view-styles";
const VIEWPORT_ID = "vibe-tts-markdown-viewport";
const FLATTENED_MERMAID_MARKER_ATTRIBUTE = "data-vibe-tts-flattened-mermaid-marker";

export const MARKDOWN_VIEW_CHANGED_EVENT = "vibe-tts-markdown-view-changed";

const MARKDOWN_CONTENT_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const MARKDOWN_PATH_PATTERN = /\.(?:md|markdown)$/iu;
const FRONTMATTER_BOUNDARY_PATTERN = /^\s*(?:---|\.\.\.)\s*$/u;

interface PreservedSelection {
  start: number;
  end: number;
  startMarker: string;
  endMarker: string;
}

interface TextPoint {
  node: Text;
  offset: number;
}

interface SourceLine {
  start: number;
  end: number;
  text: string;
}

type MarkdownViewMode = typeof MARKDOWN_RENDERED_VALUE | typeof MARKDOWN_SOURCE_VALUE;

interface SelectionSnapshot {
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

interface ScrollPosition {
  left: number;
  top: number;
}

interface MarkdownControls {
  button: HTMLButtonElement;
  viewLabel: HTMLElement;
  announcement: HTMLElement;
}

interface MarkdownViewSession {
  sourceDocument: Document;
  source: HTMLPreElement;
  reader: HTMLElement;
  originalTitle: string;
  renderedTitle: string;
  mode: MarkdownViewMode;
  controls: MarkdownControls;
  selections: Partial<Record<MarkdownViewMode, SelectionSnapshot>>;
  scrollPositions: Partial<Record<MarkdownViewMode, ScrollPosition>>;
  scrollRevision: number;
}

function documentLooksLikeMarkdown(sourceDocument: Document): boolean {
  const contentType = sourceDocument.contentType.toLocaleLowerCase().split(";", 1)[0]?.trim();
  if (contentType && MARKDOWN_CONTENT_TYPES.has(contentType)) return true;

  try {
    return MARKDOWN_PATH_PATTERN.test(
      decodeURIComponent(new URL(sourceDocument.location?.href ?? "about:blank").pathname),
    );
  } catch {
    return false;
  }
}

function rawMarkdownPre(sourceDocument: Document): HTMLPreElement | undefined {
  if (!documentLooksLikeMarkdown(sourceDocument)) return undefined;
  const body = sourceDocument.body;
  if (!body || body.children.length !== 1) return undefined;

  const candidate = body.firstElementChild;
  if (!(candidate instanceof HTMLPreElement) || candidate.parentElement !== body) return undefined;
  if (candidate.childNodes.length !== 1 || !(candidate.firstChild instanceof Text)) {
    return undefined;
  }
  return candidate.textContent?.trim() ? candidate : undefined;
}

function stripFrontmatter(source: string): string {
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return source;
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && FRONTMATTER_BOUNDARY_PATTERN.test(line),
  );
  return closingIndex > 0 ? lines.slice(closingIndex + 1).join("\n") : source;
}

function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
}

function isLocalImageSource(source: string, sourceDocument: Document): boolean {
  if (/^data:image\//iu.test(source) || /^blob:/iu.test(source)) return true;
  try {
    const resolved = new URL(source, sourceDocument.baseURI);
    return (
      resolved.protocol === "file:" &&
      (resolved.hostname === "" || resolved.hostname.toLocaleLowerCase() === "localhost")
    );
  } catch {
    return false;
  }
}

function createMarkdownParser(
  sourceDocument: Document,
  flattenedMermaidMarkers: ReadonlySet<string> = new Set(),
): MarkdownItInstance {
  const parser = new MarkdownIt({
    breaks: false,
    html: false,
    linkify: false,
    typographer: false,
  });

  if (flattenedMermaidMarkers.size > 0) {
    parser.inline.ruler.before("text", "vibe_tts_flattened_mermaid_marker", (state, silent) => {
      const marker = Array.from(flattenedMermaidMarkers).find((candidate) =>
        state.src.startsWith(candidate, state.pos),
      );
      if (!marker) return false;
      if (!silent) {
        const token = state.push("vibe_tts_flattened_mermaid_marker", "span", 0);
        token.content = marker;
      }
      state.pos += marker.length;
      return true;
    });
    parser.renderer.rules.vibe_tts_flattened_mermaid_marker = (tokens, index) => {
      const marker = tokens[index]?.content ?? "";
      return `<span ${FLATTENED_MERMAID_MARKER_ATTRIBUTE}="${parser.utils.escapeHtml(marker)}"></span>`;
    };
  }

  parser.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
    const token = tokens[index];
    const href = String(token?.attrGet("href") ?? "");
    if (href && !href.startsWith("#")) {
      token?.attrSet("target", "_blank");
      token?.attrSet("rel", "noopener noreferrer");
    }
    return renderer.renderToken(tokens, index, options);
  };

  parser.renderer.rules.image = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const source = String(token.attrGet("src") ?? "");
    const alt = renderer.renderInlineAsText(token.children ?? [], options, environment).trim();
    const escapedAlt = parser.utils.escapeHtml(alt || "Image");

    if (!source) {
      return `<span class="vibe-md-remote-image" role="img" aria-label="Image source missing"><span class="vibe-md-remote-image__label">${escapedAlt}</span><span class="vibe-md-remote-image__status" aria-hidden="true">Image source missing</span></span>`;
    }

    if (!isLocalImageSource(source, sourceDocument)) {
      const escapedSource = parser.utils.escapeHtml(source);
      const accessibleLabel = parser.utils.escapeHtml(
        alt ? `Open remote image: ${alt}` : "Open remote image",
      );
      const visibleAlt = alt
        ? `<span class="vibe-md-remote-image__label">${escapedAlt}</span>`
        : `<span class="vibe-md-remote-image__label" aria-hidden="true">Image</span>`;
      return `<span class="vibe-md-remote-image" role="group" aria-label="Remote image not loaded">${visibleAlt}<span class="vibe-md-remote-image__status" aria-hidden="true">Remote image not loaded</span><a class="vibe-md-remote-image__link" href="${escapedSource}" target="_blank" rel="noopener noreferrer" aria-label="${accessibleLabel}"><span aria-hidden="true">Open image&nbsp;↗</span></a></span>`;
    }

    token.attrSet("alt", alt);
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    token.attrJoin("class", "vibe-md-image");
    const caption = alt ? `<span class="vibe-md-image__caption">${escapedAlt}</span>` : "";
    const attributes = renderer.renderAttrs(token).replace(/\ssrc="[^"]*"/u, "");
    const escapedSource = parser.utils.escapeHtml(source);
    return `<span class="vibe-md-image-frame"><img src="${escapedSource}"${attributes}>${caption}</span>`;
  };

  return parser;
}

function installFlattenedMermaidWarnings(
  root: HTMLElement,
  artifacts: readonly FlattenedMermaidArtifact[],
): HTMLElement[] {
  if (artifacts.length === 0) return [];
  const markers = new Map(artifacts.map((artifact) => [artifact.marker, artifact]));
  const warnings: HTMLElement[] = [];

  for (const markerNode of root.querySelectorAll<HTMLElement>(
    `span[${FLATTENED_MERMAID_MARKER_ATTRIBUTE}]`,
  )) {
    const artifact = markers.get(markerNode.getAttribute(FLATTENED_MERMAID_MARKER_ATTRIBUTE) ?? "");
    const paragraph = markerNode.parentElement;
    if (
      !artifact ||
      !(paragraph instanceof HTMLParagraphElement) ||
      paragraph.childNodes.length !== 1 ||
      paragraph.firstChild !== markerNode
    ) {
      continue;
    }

    const warning = root.ownerDocument.createElement("aside");
    const base = `vibe-tts-mermaid-export-${artifact.ordinal}`;
    let idBase = base;
    let suffix = 2;
    while (
      root.ownerDocument.getElementById(`${idBase}-title`) ||
      root.ownerDocument.getElementById(`${idBase}-detail`)
    ) {
      idBase = `${base}-${suffix}`;
      suffix += 1;
    }
    warning.className = "vibe-md-mermaid-export-warning";
    warning.dataset.vibeTtsNarrationSkip = "true";
    warning.dataset.vibeTtsMermaidSourceLine = String(artifact.sourceLine);
    warning.setAttribute("role", "note");
    warning.setAttribute("aria-labelledby", `${idBase}-title`);
    warning.setAttribute("aria-describedby", `${idBase}-detail`);

    const title = root.ownerDocument.createElement("strong");
    title.id = `${idBase}-title`;
    title.textContent = "Diagram source missing";
    const detail = root.ownerDocument.createElement("p");
    detail.id = `${idBase}-detail`;
    detail.append(
      "This Markdown export kept Mermaid styling and labels, but not the diagram definition. Re-export it with a fenced ",
      Object.assign(root.ownerDocument.createElement("code"), { textContent: "mermaid" }),
      " block to render the diagram.",
    );
    warning.append(title, detail);
    paragraph.replaceWith(warning);
    warnings.push(warning);
  }

  return warnings;
}

function selectionMarkers(source: string): { startMarker: string; endMarker: string } {
  let salt = "";
  while (source.includes(`\uE000VIBETTSSTART${salt}\uE001`)) salt += "X";
  return {
    startMarker: `\uE000VIBETTSSTART${salt}\uE001`,
    endMarker: `\uE000VIBETTSEND${salt}\uE001`,
  };
}

function projectedRawOffset(
  blockMap: BlockDOMMap,
  offset: number,
  edge: "start" | "end",
): number | undefined {
  const length = blockMap.normalized.text.length;
  const boundedOffset = Math.max(0, Math.min(offset, length));
  const range =
    edge === "start"
      ? boundedOffset < length
        ? blockMap.normalized.rangeForOffsets(boundedOffset, boundedOffset + 1)
        : blockMap.normalized.fullRange()
      : boundedOffset > 0
        ? blockMap.normalized.rangeForOffsets(boundedOffset - 1, boundedOffset)
        : blockMap.normalized.fullRange();
  if (!range) return undefined;
  const container = edge === "start" ? range.startContainer : range.endContainer;
  if (!(container instanceof Text)) return undefined;
  if (edge === "start") return boundedOffset < length ? range.startOffset : range.endOffset;
  return boundedOffset > 0 ? range.endOffset : range.startOffset;
}

function includeEscapePrefix(source: string, offset: number): number {
  let prefixStart = offset;
  while (prefixStart > 0 && source[prefixStart - 1] === "\\") prefixStart -= 1;
  return (offset - prefixStart) % 2 === 1 ? prefixStart : offset;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf("\n", start);
    let end = newline < 0 ? source.length : newline;
    if (end > start && source[end - 1] === "\r") end -= 1;
    lines.push({ start, end, text: source.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function isTableSeparator(line: SourceLine): boolean {
  const trimmed = line.text.trim().replace(/^\||\|$/gu, "");
  const cells = trimmed.split("|");
  return cells.length > 1 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function lineContentBoundary(
  source: string,
  line: SourceLine,
  offset: number,
  edge: "start" | "end",
): number | undefined {
  if (edge === "start") {
    for (let index = Math.max(line.start, offset); index < line.end; index += 1) {
      if (!/[\s|]/u.test(source[index] ?? "")) return index;
    }
    return undefined;
  }

  for (let index = Math.min(line.end, offset) - 1; index >= line.start; index -= 1) {
    if (!/[\s|]/u.test(source[index] ?? "")) return index + 1;
  }
  return undefined;
}

function safeTableBoundary(
  source: string,
  offset: number,
  edge: "start" | "end",
): number | undefined {
  const lines = sourceLines(source);
  const probe = Math.max(0, Math.min(source.length - 1, edge === "end" ? offset - 1 : offset));
  const lineIndex = lines.findIndex((line) => probe >= line.start && probe <= line.end);
  const line = lines[lineIndex];
  if (!line || !line.text.includes("|")) return offset;

  if (!isTableSeparator(line)) {
    return lineContentBoundary(source, line, offset, edge);
  }

  const direction = edge === "start" ? 1 : -1;
  for (let index = lineIndex + direction; index >= 0 && index < lines.length; index += direction) {
    const candidate = lines[index];
    if (!candidate || !candidate.text.includes("|")) break;
    if (isTableSeparator(candidate)) continue;
    const boundary = lineContentBoundary(
      source,
      candidate,
      edge === "start" ? candidate.start : candidate.end,
      edge,
    );
    if (boundary !== undefined) return boundary;
  }
  return undefined;
}

function captureSelection(
  sourceDocument: Document,
  source: string,
): PreservedSelection | undefined {
  const selection = sourceDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const extraction = extractReadingDocument(sourceDocument);
  const mapped = mapSelectionToDocument(extraction, selection);
  if (!mapped) return undefined;
  const startMap = extraction.blockMaps.get(mapped.startBlockId);
  const endMap = extraction.blockMaps.get(mapped.endBlockId);
  if (!startMap || !endMap) return undefined;
  const projectedStart = projectedRawOffset(startMap, mapped.startOffset, "start");
  const projectedEnd = projectedRawOffset(endMap, mapped.endOffset, "end");
  if (projectedStart === undefined || projectedEnd === undefined) return undefined;
  const tableSafeStart = safeTableBoundary(source, projectedStart, "start");
  const end = safeTableBoundary(source, projectedEnd, "end");
  if (tableSafeStart === undefined || end === undefined) return undefined;
  const start = includeEscapePrefix(source, tableSafeStart);
  if (start >= end || end > source.length) {
    return undefined;
  }
  return { start, end, ...selectionMarkers(source) };
}

function sourceWithSelectionMarkers(source: string, selection?: PreservedSelection): string {
  if (!selection) return source;
  return `${source.slice(0, selection.start)}${selection.startMarker}${source.slice(selection.start, selection.end)}${selection.endMarker}${source.slice(selection.end)}`;
}

function textNodes(root: Node): Text[] {
  const sourceDocument = root.ownerDocument;
  if (!sourceDocument) return [];
  const walker = sourceDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current instanceof Text) nodes.push(current);
  }
  return nodes;
}

function textPointAt(root: Node, offset: number, preferPrevious: boolean): TextPoint | undefined {
  const nodes = textNodes(root);
  let consumed = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const nodeEnd = consumed + node.length;
    if (
      offset < nodeEnd ||
      (offset === nodeEnd && (preferPrevious || index === nodes.length - 1))
    ) {
      return { node, offset: Math.max(0, Math.min(offset - consumed, node.length)) };
    }
    consumed = nodeEnd;
  }
  const last = nodes.at(-1);
  return last && offset === consumed ? { node: last, offset: last.length } : undefined;
}

function scrubMarkerFromAttributes(root: Element, marker: string): void {
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value.includes(marker)) {
        element.setAttribute(attribute.name, attribute.value.replaceAll(marker, ""));
      }
    }
  }
}

function restoreSelection(
  sourceDocument: Document,
  root: HTMLElement,
  preserved?: PreservedSelection,
): void {
  if (!preserved) return;
  let startOffset: number | undefined;
  let endOffset: number | undefined;
  let consumed = 0;

  for (const node of textNodes(root)) {
    const original = node.data;
    const startIndex = original.indexOf(preserved.startMarker);
    const endIndex = original.indexOf(preserved.endMarker);
    if (startIndex >= 0) startOffset = consumed + startIndex;
    if (endIndex >= 0) {
      endOffset = consumed + endIndex - (startIndex >= 0 ? preserved.startMarker.length : 0);
    }
    const cleaned = original
      .replaceAll(preserved.startMarker, "")
      .replaceAll(preserved.endMarker, "");
    node.data = cleaned;
    consumed += cleaned.length;
  }
  scrubMarkerFromAttributes(root, preserved.startMarker);
  scrubMarkerFromAttributes(root, preserved.endMarker);
  if (startOffset === undefined || endOffset === undefined || startOffset >= endOffset) return;

  const start = textPointAt(root, startOffset, false);
  const end = textPointAt(root, endOffset, true);
  const selection = sourceDocument.defaultView?.getSelection();
  if (!start || !end || !selection) return;

  try {
    const range = sourceDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // The rendered document remains usable even when a browser cannot restore this selection.
  }
}

function selectionSnapshot(
  sourceDocument: Document,
  root: HTMLElement,
): SelectionSnapshot | undefined {
  const selection = sourceDocument.defaultView?.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return undefined;
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined;
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

function restoreSelectionSnapshot(sourceDocument: Document, snapshot?: SelectionSnapshot): void {
  const selection = sourceDocument.defaultView?.getSelection();
  if (!selection || !snapshot) return;
  if (!snapshot.anchorNode.isConnected || !snapshot.focusNode.isConnected) return;

  try {
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(
        snapshot.anchorNode,
        snapshot.anchorOffset,
        snapshot.focusNode,
        snapshot.focusOffset,
      );
      return;
    }

    const range = sourceDocument.createRange();
    range.setStart(snapshot.anchorNode, snapshot.anchorOffset);
    range.setEnd(snapshot.focusNode, snapshot.focusOffset);
    selection.addRange(range);
  } catch {
    // A stale selection must never make switching views fail.
  }
}

function currentScrollPosition(sourceDocument: Document): ScrollPosition {
  const sourceWindow = sourceDocument.defaultView;
  return {
    left: sourceWindow?.scrollX ?? sourceDocument.documentElement.scrollLeft,
    top: sourceWindow?.scrollY ?? sourceDocument.documentElement.scrollTop,
  };
}

function maximumScroll(sourceDocument: Document): ScrollPosition {
  const sourceWindow = sourceDocument.defaultView;
  const body = sourceDocument.body;
  const root = sourceDocument.documentElement;
  return {
    left: Math.max(
      0,
      Math.max(root.scrollWidth, body?.scrollWidth ?? 0) - (sourceWindow?.innerWidth ?? 0),
    ),
    top: Math.max(
      0,
      Math.max(root.scrollHeight, body?.scrollHeight ?? 0) - (sourceWindow?.innerHeight ?? 0),
    ),
  };
}

function scrollProgress(sourceDocument: Document, position: ScrollPosition): ScrollPosition {
  const maximum = maximumScroll(sourceDocument);
  return {
    left: maximum.left > 0 ? position.left / maximum.left : 0,
    top: maximum.top > 0 ? position.top / maximum.top : 0,
  };
}

function positionFromProgress(sourceDocument: Document, progress: ScrollPosition): ScrollPosition {
  const maximum = maximumScroll(sourceDocument);
  return {
    left: maximum.left * Math.max(0, Math.min(1, progress.left)),
    top: maximum.top * Math.max(0, Math.min(1, progress.top)),
  };
}

function restoreScrollPosition(session: MarkdownViewSession, position: ScrollPosition): void {
  const sourceWindow = session.sourceDocument.defaultView;
  if (!sourceWindow) return;
  const revision = ++session.scrollRevision;
  const restore = (): void => {
    if (revision !== session.scrollRevision) return;
    const maximum = maximumScroll(session.sourceDocument);
    const left = Math.max(0, Math.min(position.left, maximum.left));
    const top = Math.max(0, Math.min(position.top, maximum.top));
    if (left === sourceWindow.scrollX && top === sourceWindow.scrollY) return;
    sourceWindow.scrollTo(left, top);
  };
  if (typeof sourceWindow.requestAnimationFrame === "function") {
    sourceWindow.requestAnimationFrame(restore);
  } else {
    sourceWindow.setTimeout(restore, 0);
  }
}

function setViewRootActive(root: HTMLElement, active: boolean): void {
  root.hidden = !active;
  root.toggleAttribute("inert", !active);
}

function updateControls(session: MarkdownViewSession): void {
  const sourceMode = session.mode === MARKDOWN_SOURCE_VALUE;
  session.controls.button.textContent = sourceMode ? "View rendered" : "View source";
  session.controls.viewLabel.textContent = sourceMode ? "Source view" : "Reading view";
  session.controls.announcement.textContent = sourceMode
    ? "Raw Markdown source shown"
    : "Rendered Markdown shown";
}

function switchMarkdownView(session: MarkdownViewSession, nextMode: MarkdownViewMode): void {
  if (session.mode === nextMode) return;
  const currentRoot = session.mode === MARKDOWN_RENDERED_VALUE ? session.reader : session.source;
  const currentSelection = selectionSnapshot(session.sourceDocument, currentRoot);
  if (currentSelection) session.selections[session.mode] = currentSelection;
  session.scrollPositions[session.mode] = currentScrollPosition(session.sourceDocument);

  session.mode = nextMode;
  session.sourceDocument.documentElement.dataset[MARKDOWN_VIEW_ATTRIBUTE] = nextMode;
  setViewRootActive(session.reader, nextMode === MARKDOWN_RENDERED_VALUE);
  setViewRootActive(session.source, nextMode === MARKDOWN_SOURCE_VALUE);
  const gutter = session.reader.querySelector<HTMLElement>("#vibe-tts-markdown-read-gutter");
  if (gutter) setViewRootActive(gutter, nextMode === MARKDOWN_RENDERED_VALUE);
  session.sourceDocument.title =
    nextMode === MARKDOWN_RENDERED_VALUE ? session.renderedTitle : session.originalTitle;
  updateControls(session);

  restoreSelectionSnapshot(session.sourceDocument, session.selections[nextMode]);
  const storedScroll = session.scrollPositions[nextMode];
  if (storedScroll) restoreScrollPosition(session, storedScroll);

  const sourceWindow = session.sourceDocument.defaultView;
  sourceWindow?.dispatchEvent(
    new sourceWindow.CustomEvent(MARKDOWN_VIEW_CHANGED_EVENT, { detail: { mode: nextMode } }),
  );
}

function enhanceTaskItems(root: HTMLElement): void {
  for (const item of root.querySelectorAll("li")) {
    const firstText = textNodes(item)[0];
    const match = firstText?.data.match(/^\s*\[([ xX])\]\s+/u);
    if (!firstText || !match) continue;
    firstText.deleteData(0, match[0].length);
    const checkbox = root.ownerDocument.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = match[1]?.toLocaleLowerCase() === "x";
    checkbox.disabled = true;
    checkbox.tabIndex = -1;
    checkbox.setAttribute("aria-hidden", "true");
    item.classList.add("vibe-md-task");
    item.insertBefore(checkbox, item.firstChild);
  }
}

function addHeadingIds(root: HTMLElement): void {
  const counts = new Map<string, number>();
  for (const heading of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const base =
      (heading.textContent ?? "")
        .normalize("NFKD")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "section";
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    heading.id = count === 1 ? base : `${base}-${count}`;
  }
}

function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("vibe-md-table-scroll")) continue;
    const wrapper = root.ownerDocument.createElement("div");
    wrapper.className = "vibe-md-table-scroll";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Scrollable table");
    table.before(wrapper);
    wrapper.append(table);
  }
}

function installViewport(sourceDocument: Document): void {
  if (sourceDocument.querySelector("meta[name='viewport']")) return;
  const viewport = sourceDocument.createElement("meta");
  viewport.id = VIEWPORT_ID;
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  (sourceDocument.head ?? sourceDocument.documentElement).append(viewport);
}

function installMarker(sourceDocument: Document): MarkdownControls {
  const existingMarker = sourceDocument.getElementById(MARKER_ID);
  const existingButton = sourceDocument.getElementById(TOGGLE_ID);
  const existingViewLabel = existingMarker?.querySelector<HTMLElement>(".vibe-md-marker__view");
  const existingAnnouncement = existingMarker?.querySelector<HTMLElement>(
    ".vibe-md-marker__announcement",
  );
  if (existingButton instanceof HTMLButtonElement && existingViewLabel && existingAnnouncement) {
    return {
      button: existingButton,
      viewLabel: existingViewLabel,
      announcement: existingAnnouncement,
    };
  }

  const marker = sourceDocument.createElement("aside");
  marker.id = MARKER_ID;
  marker.setAttribute("aria-label", "Markdown view controls");
  marker.dataset.vibeTtsNarrationSkip = "true";

  const brand = sourceDocument.createElement("span");
  brand.className = "vibe-md-marker__brand";
  brand.setAttribute("aria-hidden", "true");

  const mark = sourceDocument.createElement("span");
  mark.className = "vibe-md-marker__mark";
  for (const height of [10, 16, 7]) {
    const bar = sourceDocument.createElement("i");
    bar.style.height = `${height}px`;
    mark.append(bar);
  }
  const copy = sourceDocument.createElement("span");
  copy.className = "vibe-md-marker__copy";
  const viewLabel = sourceDocument.createElement("span");
  viewLabel.className = "vibe-md-marker__view";
  viewLabel.textContent = "Reading view";
  copy.append(
    Object.assign(sourceDocument.createElement("strong"), { textContent: "Vibe TTS" }),
    viewLabel,
  );
  brand.append(mark, copy);

  const button = sourceDocument.createElement("button");
  button.id = TOGGLE_ID;
  button.className = "vibe-md-marker__toggle";
  button.type = "button";
  button.textContent = "View source";
  button.setAttribute("aria-controls", `${READER_ID} ${SOURCE_ID}`);

  const announcement = sourceDocument.createElement("span");
  announcement.className = "vibe-md-marker__announcement";
  announcement.setAttribute("aria-live", "polite");
  announcement.textContent = "Rendered Markdown shown";

  marker.append(brand, button, announcement);
  sourceDocument.body.append(marker);
  return { button, viewLabel, announcement };
}

function installStyles(sourceDocument: Document): void {
  if (sourceDocument.getElementById(STYLE_ID)) return;
  const style = sourceDocument.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    html[data-vibe-tts-markdown-view="rendered"],
    html[data-vibe-tts-markdown-view="source"] {
      color-scheme: light;
      background: #f7f7f2;
      scrollbar-color: #838d88 #f7f7f2;
      scrollbar-width: thin;
    }

    html[data-vibe-tts-markdown-view="rendered"] body,
    html[data-vibe-tts-markdown-view="source"] body {
      min-width: 0;
      min-height: 100vh;
      margin: 0;
      background: #f7f7f2;
      color: #172026;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }

    #${READER_ID} {
      position: relative;
      box-sizing: border-box;
      width: min(calc(100% - 3rem), 72ch);
      margin-inline: auto;
      padding-block: clamp(4.5rem, 10vw, 8rem) clamp(6rem, 12vw, 10rem);
      font-size: clamp(1rem, 0.95rem + 0.28vw, 1.13rem);
      line-height: 1.72;
      overflow-wrap: break-word;
    }

    #${READER_ID}[hidden],
    #${SOURCE_ID}[hidden] { display: none !important; }

    #${SOURCE_ID} {
      box-sizing: border-box;
      display: block;
      width: min(calc(100% - 3rem), 92ch);
      margin: 0 auto;
      padding: clamp(5.75rem, 10vw, 8rem) 0 clamp(6rem, 12vw, 10rem);
      border: 0;
      background: transparent;
      color: #172026;
      font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: clamp(0.82rem, 0.79rem + 0.16vw, 0.94rem);
      line-height: 1.62;
      overflow-x: auto;
      tab-size: 2;
      white-space: pre;
    }

    #${SOURCE_ID}:focus-visible {
      outline: 3px solid color-mix(in srgb, #1746ce 72%, white);
      outline-offset: 3px;
    }

    #${SOURCE_ID}::selection {
      background: #173996;
      color: #ffffff;
    }

    #${READER_ID} .vibe-md-read-gutter {
      position: absolute;
      z-index: 4;
      inset: 0;
      height: 100%;
      pointer-events: none;
    }

    #${READER_ID} .vibe-md-read-gutter__sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }

    #${READER_ID} .vibe-md-read-target {
      position: relative;
    }

    #${READER_ID} .vibe-md-read-target::before {
      position: absolute;
      inset-block-start: -0.35rem;
      inset-block-end: -0.35rem;
      inset-inline-start: -3.25rem;
      width: 3.25rem;
      content: "";
    }

    #${READER_ID} .vibe-md-read-from-here {
      position: absolute;
      display: grid;
      width: 44px;
      height: 44px;
      margin: 0;
      padding: 0;
      place-items: center;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: #2853d8;
      cursor: pointer;
      opacity: 0;
      pointer-events: auto;
      transition: opacity 120ms ease-out;
      -webkit-tap-highlight-color: transparent;
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-visible="true"],
    #${READER_ID} .vibe-md-read-from-here:focus-visible,
    #${READER_ID} .vibe-md-read-from-here:not([data-vibe-tts-read-state="idle"]) {
      opacity: 1;
    }

    #${READER_ID} .vibe-md-read-from-here__plate {
      display: grid;
      box-sizing: border-box;
      width: 32px;
      height: 32px;
      place-items: center;
      border: 1px solid #838d88;
      background: #f7f7f2;
      color: #2853d8;
    }

    #${READER_ID} .vibe-md-read-from-here__icon {
      display: block;
      width: 15px;
      height: 15px;
      transform: translateX(1px);
    }

    #${READER_ID} .vibe-md-read-from-here__retry {
      display: none;
      width: 16px;
      height: 16px;
    }

    #${READER_ID} .vibe-md-read-from-here__loading {
      display: none;
      height: 15px;
      align-items: center;
      gap: 2px;
    }

    #${READER_ID} .vibe-md-read-from-here__loading i {
      display: block;
      width: 2px;
      height: 11px;
      background: currentColor;
      animation: vibe-md-read-loading 600ms ease-in-out infinite alternate;
      transform-origin: center;
    }

    #${READER_ID} .vibe-md-read-from-here__loading i:nth-child(2) {
      height: 15px;
      animation-delay: -300ms;
    }

    #${READER_ID} .vibe-md-read-from-here__loading i:nth-child(3) {
      height: 8px;
      animation-delay: -150ms;
    }

    #${READER_ID} .vibe-md-read-from-here:hover .vibe-md-read-from-here__plate,
    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="active"]
      .vibe-md-read-from-here__plate {
      border-color: #2853d8;
      background: #2853d8;
      color: #ffffff;
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="preparing"]
      .vibe-md-read-from-here__icon {
      display: none;
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="preparing"]
      .vibe-md-read-from-here__loading {
      display: flex;
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="active"]::after {
      position: absolute;
      inset-block: 13px;
      inset-inline-start: 0;
      width: 2px;
      background: #d83c1c;
      content: "";
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="error"]
      .vibe-md-read-from-here__icon {
      display: none;
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="error"]
      .vibe-md-read-from-here__retry {
      display: block;
    }

    #${READER_ID} .vibe-md-read-from-here[data-vibe-tts-read-state="error"]
      .vibe-md-read-from-here__plate {
      border-color: #172026;
      color: #172026;
    }

    #${READER_ID} .vibe-md-read-from-here:focus-visible {
      outline: 3px solid color-mix(in srgb, #1746ce 72%, white);
      outline-offset: 3px;
    }

    #${READER_ID} .vibe-md-read-from-here:active .vibe-md-read-from-here__plate {
      transform: translateY(1px);
    }

    @keyframes vibe-md-read-loading {
      from { transform: scaleY(0.45); }
      to { transform: scaleY(1); }
    }

    #${READER_ID} > :first-child { margin-top: 0; }
    #${READER_ID} > :last-child { margin-bottom: 0; }

    #${READER_ID} h1,
    #${READER_ID} h2,
    #${READER_ID} h3,
    #${READER_ID} h4,
    #${READER_ID} h5,
    #${READER_ID} h6 {
      color: #172026;
      font-family: inherit;
      font-weight: 720;
      line-height: 1.12;
      text-wrap: balance;
      overflow-wrap: anywhere;
      scroll-margin-top: 2.5rem;
    }

    #${READER_ID} h1 {
      max-width: 13ch;
      margin: 0 0 clamp(2.5rem, 7vw, 4.75rem);
      padding-bottom: clamp(1.25rem, 3vw, 2rem);
      border-bottom: 3px solid #172026;
      font-size: clamp(2.65rem, 7.5vw, 5.45rem);
      letter-spacing: -0.038em;
    }

    #${READER_ID} h2 {
      margin: clamp(3.75rem, 9vw, 6rem) 0 1.25rem;
      padding-top: 1.35rem;
      border-top: 1px solid #aeb6b1;
      font-size: clamp(1.75rem, 4vw, 2.55rem);
      letter-spacing: -0.03em;
    }

    #${READER_ID} h3 {
      margin: 2.9rem 0 0.9rem;
      font-size: clamp(1.34rem, 2.5vw, 1.7rem);
      letter-spacing: -0.022em;
    }

    #${READER_ID} h4,
    #${READER_ID} h5,
    #${READER_ID} h6 {
      margin: 2.25rem 0 0.7rem;
      font-size: 1.05em;
      line-height: 1.35;
      letter-spacing: -0.012em;
    }

    #${READER_ID} p { margin: 0 0 1.45em; }
    #${READER_ID} strong { font-weight: 720; }
    #${READER_ID} em { color: #5a646a; }

    #${READER_ID} a {
      color: #2853d8;
      text-decoration-line: underline;
      text-decoration-color: color-mix(in srgb, #2853d8 52%, transparent);
      text-decoration-thickness: 0.08em;
      text-underline-offset: 0.17em;
    }

    #${READER_ID} a:hover {
      color: #173996;
      text-decoration-color: currentColor;
    }

    #${READER_ID} a:focus-visible,
    #${READER_ID} .vibe-md-table-scroll:focus-visible {
      outline: 3px solid color-mix(in srgb, #1746ce 72%, white);
      outline-offset: 3px;
    }

    #${READER_ID} ul,
    #${READER_ID} ol {
      margin: 0 0 1.65em;
      padding-inline-start: 1.55em;
    }

    #${READER_ID} li {
      margin-block: 0.48em;
      padding-inline-start: 0.35em;
    }

    #${READER_ID} li::marker {
      color: #5a646a;
      font-variant-numeric: tabular-nums;
      font-weight: 650;
    }

    #${READER_ID} li.vibe-md-task {
      list-style: none;
      position: relative;
    }

    #${READER_ID} li.vibe-md-task > input[type="checkbox"] {
      appearance: none;
      position: absolute;
      width: 1rem;
      height: 1rem;
      margin: 0.42em 0 0 -1.7em;
      border: 1px solid #838d88;
      border-radius: 0;
      background: #ffffff;
      opacity: 1;
    }

    #${READER_ID} li.vibe-md-task > input[type="checkbox"]:checked {
      border-color: #2853d8;
      background: #2853d8;
      box-shadow: inset 0 0 0 3px #f7f7f2;
    }

    #${READER_ID} blockquote {
      margin: 2.2rem 0;
      padding: 0.25rem 0 0.25rem clamp(1.2rem, 3vw, 2rem);
      border-inline-start: 1px solid #838d88;
      color: #5a646a;
      font-size: 1.08em;
      font-weight: 520;
    }

    #${READER_ID} blockquote > :last-child { margin-bottom: 0; }

    #${READER_ID} hr {
      height: 1px;
      margin: clamp(3.5rem, 8vw, 5.5rem) 0;
      border: 0;
      background: #aeb6b1;
    }

    #${READER_ID} code,
    #${READER_ID} pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-variant-ligatures: none;
    }

    #${READER_ID} :not(pre) > code {
      box-decoration-break: clone;
      padding: 0.12em 0.34em;
      border: 1px solid #d5dad5;
      border-radius: 0;
      background: #eceee9;
      color: #172026;
      font-size: 0.87em;
    }

    #${READER_ID} pre {
      box-sizing: border-box;
      max-width: 100%;
      margin: 2rem 0;
      padding: clamp(1.15rem, 3vw, 1.6rem);
      overflow: auto;
      border: 0;
      border-radius: 0;
      background: #172026;
      color: #f7f7f2;
      font-size: 0.84em;
      line-height: 1.62;
      tab-size: 2;
      scrollbar-color: #aeb6b1 #172026;
    }

    #${READER_ID} pre code {
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font-size: inherit;
    }

    #${READER_ID} .vibe-md-table-scroll {
      max-width: 100%;
      margin: 2.25rem 0;
      overflow-x: auto;
      border-block: 1px solid #838d88;
    }

    #${READER_ID} table {
      width: 100%;
      min-width: 34rem;
      border-collapse: collapse;
      font-size: 0.9em;
      line-height: 1.48;
    }

    #${READER_ID} th,
    #${READER_ID} td {
      padding: 0.8rem 0.9rem;
      border-bottom: 1px solid #ccd1cc;
      text-align: start;
      vertical-align: top;
    }

    #${READER_ID} th {
      background: #eceee9;
      color: #172026;
      font-size: 0.78em;
      font-weight: 760;
      letter-spacing: 0.055em;
      text-transform: uppercase;
    }

    #${READER_ID} tr:last-child td { border-bottom: 0; }

    #${READER_ID} .vibe-md-image-frame {
      display: block;
      margin: 2.5rem 0;
    }

    #${READER_ID} .vibe-md-image {
      display: block;
      max-width: 100%;
      height: auto;
      border: 1px solid #ccd1cc;
    }

    #${READER_ID} .vibe-md-image__caption {
      display: block;
      margin-top: 0.65rem;
      color: #5a646a;
      font-size: 0.8em;
      line-height: 1.45;
    }

    #${READER_ID} .vibe-md-remote-image {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0.35rem 0.8rem;
      margin: 2rem 0;
      padding-block: 0.85rem;
      border-block: 1px solid #ccd1cc;
    }

    #${READER_ID} .vibe-md-remote-image__label {
      flex: 1 1 15rem;
      min-width: 0;
      color: #172026;
      font-weight: 650;
    }

    #${READER_ID} .vibe-md-remote-image__status {
      color: #5a646a;
      font-size: 0.78em;
    }

    #${READER_ID} .vibe-md-remote-image__link {
      margin-inline-start: auto;
      font-size: 0.78em;
      font-weight: 680;
      white-space: nowrap;
    }

    #${READER_ID} .vibe-md-mermaid {
      box-sizing: border-box;
      max-width: 100%;
      margin: clamp(2.6rem, 6vw, 4rem) 0;
      border-block: 1px solid #838d88;
      background: #ffffff;
      color: #172026;
      break-inside: avoid;
    }

    #${READER_ID} .vibe-md-mermaid__canvas {
      box-sizing: border-box;
      display: grid;
      min-height: 12rem;
      max-width: 100%;
      place-items: center;
      padding: clamp(1.25rem, 4vw, 2.5rem);
      overflow: auto;
      overscroll-behavior-inline: contain;
      scrollbar-color: #838d88 #ffffff;
    }

    #${READER_ID} .vibe-md-mermaid__svg {
      display: block;
      width: 100%;
      min-width: min(30rem, 100%);
      max-width: 100%;
      height: auto;
      margin: auto;
    }

    #${READER_ID} .vibe-md-mermaid__status {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      margin: 0;
      padding: 0.72rem clamp(1rem, 3vw, 1.5rem);
      border-top: 1px solid #ccd1cc;
      color: #5a646a;
      font-size: 0.69em;
      font-style: normal;
      font-weight: 720;
      letter-spacing: 0.055em;
      line-height: 1.4;
      text-transform: uppercase;
    }

    #${READER_ID} .vibe-md-mermaid__status::before {
      width: 1.45rem;
      border-top: 2px solid #2853d8;
      content: "";
      flex: 0 0 auto;
    }

    #${READER_ID} .vibe-md-mermaid[data-vibe-tts-mermaid-state="pending"]
      .vibe-md-mermaid__status::before,
    #${READER_ID} .vibe-md-mermaid[data-vibe-tts-mermaid-state="rendering"]
      .vibe-md-mermaid__status::before {
      animation: vibe-md-mermaid-pulse 1.2s ease-in-out infinite alternate;
      transform-origin: left center;
    }

    #${READER_ID} .vibe-md-mermaid[data-vibe-tts-mermaid-state="error"]
      .vibe-md-mermaid__canvas {
      display: none;
    }

    #${READER_ID} .vibe-md-mermaid[data-vibe-tts-mermaid-state="error"]
      .vibe-md-mermaid__status {
      color: #172026;
      letter-spacing: 0;
      text-transform: none;
    }

    #${READER_ID} .vibe-md-mermaid__source {
      border-top: 1px solid #ccd1cc;
    }

    #${READER_ID} .vibe-md-mermaid__source > summary {
      width: fit-content;
      padding: 0.72rem clamp(1rem, 3vw, 1.5rem);
      color: #2853d8;
      cursor: pointer;
      font-size: 0.75em;
      font-weight: 690;
      line-height: 1.4;
      list-style-position: inside;
    }

    #${READER_ID} .vibe-md-mermaid__source > summary:hover {
      color: #173996;
    }

    #${READER_ID} .vibe-md-mermaid__source > summary:focus-visible {
      outline: 3px solid color-mix(in srgb, #1746ce 72%, white);
      outline-offset: 3px;
    }

    #${READER_ID} .vibe-md-mermaid__source > pre {
      max-height: 24rem;
      margin: 0;
      border-top: 1px solid #ccd1cc;
    }

    #${READER_ID} .vibe-md-mermaid-export-warning {
      display: grid;
      gap: 0.45rem;
      margin: clamp(2.6rem, 6vw, 4rem) 0 1rem;
      padding: 1rem 0;
      border-block: 1px solid #838d88;
      color: #172026;
    }

    #${READER_ID} .vibe-md-mermaid-export-warning > strong {
      font-size: 0.78em;
      font-weight: 760;
      letter-spacing: 0.055em;
      text-transform: uppercase;
    }

    #${READER_ID} .vibe-md-mermaid-export-warning > p {
      margin: 0;
      color: #5a646a;
      font-size: 0.88em;
      line-height: 1.55;
    }

    #${READER_ID} .vibe-md-mermaid-export-warning code {
      color: #172026;
      font-size: 0.92em;
    }

    @keyframes vibe-md-mermaid-pulse {
      from { transform: scaleX(0.45); }
      to { transform: scaleX(1); }
    }

    #${READER_ID} ::selection {
      background: #173996;
      color: #ffffff;
    }

    #${MARKER_ID} {
      display: flex;
      position: fixed;
      z-index: 2147483646;
      inset-block-start: 0.75rem;
      inset-inline-end: 0.75rem;
      flex-direction: column;
      align-items: flex-end;
      gap: 0.65rem;
      color: #5a646a;
      font-size: 0.68rem;
      line-height: 1.22;
      pointer-events: none;
      user-select: none;
    }

    #${MARKER_ID} .vibe-md-marker__brand {
      display: none;
      align-items: center;
      gap: 0.7rem;
    }

    #${MARKER_ID} .vibe-md-marker__mark {
      display: flex;
      width: 28px;
      height: 26px;
      align-items: flex-end;
      justify-content: center;
      gap: 3px;
      box-sizing: border-box;
      border: 1px solid #2853d8;
      background: #f7f7f2;
    }

    #${MARKER_ID} .vibe-md-marker__mark i {
      display: block;
      width: 3px;
      background: #2853d8;
    }

    #${MARKER_ID} .vibe-md-marker__copy {
      display: grid;
      gap: 0.08rem;
    }

    #${MARKER_ID} strong {
      color: #173996;
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    #${TOGGLE_ID} {
      box-sizing: border-box;
      min-width: 6.8rem;
      min-height: 2.75rem;
      padding: 0.65rem 0.8rem;
      border: 1px solid #838d88;
      border-radius: 0;
      background: #f7f7f2;
      color: #172026;
      cursor: pointer;
      font: 720 0.69rem/1.15 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.055em;
      pointer-events: auto;
      text-transform: uppercase;
    }

    #${TOGGLE_ID}:hover {
      border-color: #2853d8;
      background: #2853d8;
      color: #ffffff;
    }

    #${TOGGLE_ID}:active { transform: translateY(1px); }

    #${TOGGLE_ID}:focus-visible {
      outline: 3px solid color-mix(in srgb, #1746ce 72%, white);
      outline-offset: 3px;
    }

    #${MARKER_ID} .vibe-md-marker__announcement {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }

    @media (min-width: 72rem) {
      #${MARKER_ID} {
        inset-block-start: clamp(4.75rem, 10vw, 8rem);
        inset-inline-start: max(1.5rem, calc((100vw - 76rem) / 2));
        inset-inline-end: auto;
        align-items: flex-start;
      }

      #${MARKER_ID} .vibe-md-marker__brand { display: flex; }
    }

    @media (max-width: 42rem) {
      #${MARKER_ID} { position: absolute; }

      #${READER_ID} {
        width: min(calc(100% - 2rem), 72ch);
        padding-block: 5.25rem 6rem;
        line-height: 1.67;
      }

      #${SOURCE_ID} {
        width: min(calc(100% - 2rem), 92ch);
        padding-block: 5.25rem 6rem;
      }

      #${READER_ID} h1 {
        margin-bottom: 2.6rem;
        font-size: clamp(2.35rem, 13vw, 3.7rem);
      }

      #${READER_ID} h2 { margin-top: 3.6rem; }
      #${READER_ID} .vibe-md-remote-image__link { margin-inline-start: 0; }
      #${READER_ID} .vibe-md-mermaid__canvas {
        min-height: 9rem;
        padding: 1rem;
      }
    }

    @media (max-width: 64rem) {
      #${READER_ID}.vibe-md-document--with-read-gutter {
        width: min(calc(100% - 5rem), 72ch);
        margin-inline: 4rem auto;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      html[data-vibe-tts-markdown-view="rendered"] *,
      html[data-vibe-tts-markdown-view="rendered"] *::before,
      html[data-vibe-tts-markdown-view="rendered"] *::after,
      html[data-vibe-tts-markdown-view="source"] *,
      html[data-vibe-tts-markdown-view="source"] *::before,
      html[data-vibe-tts-markdown-view="source"] *::after {
        scroll-behavior: auto !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }

    @media print {
      html[data-vibe-tts-markdown-view="rendered"],
      html[data-vibe-tts-markdown-view="rendered"] body,
      html[data-vibe-tts-markdown-view="source"],
      html[data-vibe-tts-markdown-view="source"] body { background: #ffffff; }
      #${READER_ID} { width: 100%; padding: 0; }
      #${SOURCE_ID} { width: 100%; padding: 0; }
      #${MARKER_ID} { display: none; }
      #${READER_ID} a { color: inherit; }
    }
  `;
  (sourceDocument.head ?? sourceDocument.documentElement).append(style);
}

/**
 * Replaces Chrome's raw `body > pre` Markdown presentation with a semantic reading view.
 * The function is deliberately conservative and only runs for Markdown MIME types or URLs.
 */
export function renderMarkdownReadingView(sourceDocument: Document = document): boolean {
  const managedMode = sourceDocument.documentElement.dataset[MARKDOWN_VIEW_ATTRIBUTE];
  if (
    managedMode === MARKDOWN_RENDERED_VALUE ||
    managedMode === MARKDOWN_SOURCE_VALUE ||
    sourceDocument.getElementById(READER_ID) ||
    sourceDocument.getElementById(SOURCE_ID) ||
    sourceDocument.getElementById(MARKER_ID)
  ) {
    return false;
  }

  const pre = rawMarkdownPre(sourceDocument);
  const rawSource = pre?.textContent;
  if (!pre || !rawSource) return false;

  const sourceSelection = selectionSnapshot(sourceDocument, pre);
  const preservedSelection = captureSelection(sourceDocument, rawSource);
  const initialScroll = currentScrollPosition(sourceDocument);
  const initialScrollProgress = scrollProgress(sourceDocument, initialScroll);
  const originalTitle = sourceDocument.title;
  const markedSource = sourceWithSelectionMarkers(rawSource, preservedSelection);
  const source = stripHtmlComments(stripFrontmatter(markedSource));
  const preparedSource = prepareFlattenedMermaidArtifacts(source);
  const rendered = createMarkdownParser(
    sourceDocument,
    new Set(preparedSource.artifacts.map((artifact) => artifact.marker)),
  ).render(preparedSource.markdown);
  if (!rendered.trim()) return false;

  const template = sourceDocument.createElement("template");
  template.innerHTML = rendered;
  const reader = sourceDocument.createElement("main");
  reader.id = READER_ID;
  reader.className = "vibe-md-document";
  reader.setAttribute("aria-label", "Rendered Markdown document");
  reader.append(template.content);

  pre.id = SOURCE_ID;
  pre.className = "vibe-md-source";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Raw Markdown source");
  pre.before(reader);
  setViewRootActive(reader, true);
  setViewRootActive(pre, false);
  sourceDocument.documentElement.dataset[MARKDOWN_VIEW_ATTRIBUTE] = MARKDOWN_RENDERED_VALUE;
  installViewport(sourceDocument);
  installStyles(sourceDocument);
  const controls = installMarker(sourceDocument);
  enhanceTaskItems(reader);
  addHeadingIds(reader);
  wrapTables(reader);
  installFlattenedMermaidWarnings(reader, preparedSource.artifacts);
  upgradeMermaidCodeBlocks(reader);
  restoreSelection(sourceDocument, reader, preservedSelection);
  installMarkdownReadGutter(reader);

  const renderedTitle = reader.querySelector("h1")?.textContent?.trim() || originalTitle;
  sourceDocument.title = renderedTitle;
  const renderedSelection = selectionSnapshot(sourceDocument, reader);
  const selections: Partial<Record<MarkdownViewMode, SelectionSnapshot>> = {};
  if (sourceSelection) selections[MARKDOWN_SOURCE_VALUE] = sourceSelection;
  if (renderedSelection) selections[MARKDOWN_RENDERED_VALUE] = renderedSelection;

  const session: MarkdownViewSession = {
    sourceDocument,
    source: pre,
    reader,
    originalTitle,
    renderedTitle,
    mode: MARKDOWN_RENDERED_VALUE,
    controls,
    selections,
    scrollPositions: {
      [MARKDOWN_SOURCE_VALUE]: initialScroll,
    },
    scrollRevision: 0,
  };
  const renderedScroll = positionFromProgress(sourceDocument, initialScrollProgress);
  session.scrollPositions[MARKDOWN_RENDERED_VALUE] = renderedScroll;
  restoreScrollPosition(session, renderedScroll);
  controls.button.addEventListener("click", () => {
    switchMarkdownView(
      session,
      session.mode === MARKDOWN_RENDERED_VALUE ? MARKDOWN_SOURCE_VALUE : MARKDOWN_RENDERED_VALUE,
    );
  });
  return true;
}
