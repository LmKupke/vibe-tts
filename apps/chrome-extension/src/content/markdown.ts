import type { ReadingBlockType } from "@vibe-tts/shared";

import type { DOMTextSegment, NormalizedDOMText, TextNodeRegistry } from "./dom-map";
import { prepareFlattenedMermaidArtifacts } from "./flattened-mermaid";

interface RawLine {
  start: number;
  contentEnd: number;
  text: string;
}

interface SourceSpan {
  start: number;
  end: number;
}

interface MappedCharacter {
  value: string;
  rawStart: number;
  rawEnd: number;
}

interface MarkdownDraft {
  type: ReadingBlockType;
  characters: MappedCharacter[];
  spanStart: number;
  spanEnd: number;
}

export interface RawMarkdownBlock {
  type: ReadingBlockType;
  element: HTMLPreElement;
  normalized: NormalizedDOMText;
}

const MARKDOWN_CONTENT_TYPES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);
const MARKDOWN_PATH_PATTERN = /\.(?:md|markdown)$/iu;
const FRONTMATTER_BOUNDARY_PATTERN = /^\s*(?:---|\.\.\.)\s*$/u;
const REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[([^\]]+)\]:\s*\S+/u;
const THEMATIC_BREAK_PATTERN = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

function documentLooksLikeMarkdown(sourceDocument: Document): boolean {
  const contentType = sourceDocument.contentType.toLocaleLowerCase().split(";", 1)[0]?.trim();
  if (contentType && MARKDOWN_CONTENT_TYPES.has(contentType)) return true;

  try {
    const url = new URL(sourceDocument.location?.href ?? "about:blank");
    return url.protocol === "file:" && MARKDOWN_PATH_PATTERN.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

function rawMarkdownPre(
  sourceDocument: Document,
  isVisible: (element: Element) => boolean,
): { pre: HTMLPreElement; textNode: Text } | undefined {
  if (!documentLooksLikeMarkdown(sourceDocument)) return undefined;
  const body = sourceDocument.body;
  if (!body) return undefined;

  const visibleChildren = Array.from(body.children).filter(isVisible);
  if (visibleChildren.length !== 1) return undefined;
  const candidate = visibleChildren[0];
  if (!(candidate instanceof HTMLPreElement) || candidate.parentElement !== body) return undefined;
  if (Array.from(candidate.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE)) {
    return undefined;
  }
  const textNodes = Array.from(candidate.childNodes).filter(
    (node): node is Text => node.nodeType === Node.TEXT_NODE,
  );
  if (textNodes.length !== 1 || !textNodes[0]?.data.trim()) return undefined;
  return { pre: candidate, textNode: textNodes[0] };
}

function splitLines(source: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf("\n", start);
    let contentEnd = newline < 0 ? source.length : newline;
    if (contentEnd > start && source[contentEnd - 1] === "\r") contentEnd -= 1;
    lines.push({ start, contentEnd, text: source.slice(start, contentEnd) });
    if (newline < 0) break;
    start = newline + 1;
    if (start === source.length) break;
  }
  return lines;
}

function frontmatterLineIndexes(lines: readonly RawLine[]): Set<number> {
  const skipped = new Set<number>();
  if (lines[0]?.text.trim() !== "---") return skipped;
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && FRONTMATTER_BOUNDARY_PATTERN.test(line.text),
  );
  if (closingIndex < 1) return skipped;
  for (let index = 0; index <= closingIndex; index += 1) skipped.add(index);
  return skipped;
}

function htmlCommentSpans(source: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const match of source.matchAll(/<!--[\s\S]*?(?:-->|$)/gu)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function closingDelimiter(
  source: string,
  start: number,
  end: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 1;
  for (let index = start; index < end; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === open) depth += 1;
    if (source[index] !== close) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function appendRawCharacters(
  target: MappedCharacter[],
  source: string,
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index += 1) {
    const value = source[index];
    if (value !== undefined) target.push({ value, rawStart: index, rawEnd: index + 1 });
  }
}

function normalizedReferenceId(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function parseInline(
  source: string,
  start: number,
  end: number,
  ignoredSpans: readonly SourceSpan[],
  referenceIds: ReadonlySet<string>,
): MappedCharacter[] {
  const characters: MappedCharacter[] = [];
  let index = start;

  while (index < end) {
    const ignoredSpan = ignoredSpans.find((span) => index >= span.start && index < span.end);
    if (ignoredSpan) {
      index = Math.min(ignoredSpan.end, end);
      continue;
    }

    const character = source[index];
    if (character === undefined) break;

    if (character === "\\" && index + 1 < end) {
      const escaped = source[index + 1];
      if (escaped !== undefined) {
        characters.push({ value: escaped, rawStart: index + 1, rawEnd: index + 2 });
        index += 2;
        continue;
      }
    }

    const imagePrefix = character === "!" && source[index + 1] === "[";
    const labelOpen = imagePrefix ? index + 1 : index;
    if (source[labelOpen] === "[") {
      const labelClose = closingDelimiter(source, labelOpen + 1, end, "[", "]");
      if (labelClose !== undefined) {
        let suffixStart = labelClose + 1;
        while (suffixStart < end && /[ \t]/u.test(source[suffixStart] ?? "")) suffixStart += 1;
        let linkEnd: number | undefined;
        if (source[suffixStart] === "(") {
          const destinationEnd = closingDelimiter(source, suffixStart + 1, end, "(", ")");
          if (destinationEnd !== undefined) linkEnd = destinationEnd + 1;
        } else if (source[suffixStart] === "[") {
          const referenceEnd = closingDelimiter(source, suffixStart + 1, end, "[", "]");
          if (referenceEnd !== undefined) linkEnd = referenceEnd + 1;
        } else {
          const label = source.slice(labelOpen + 1, labelClose);
          if (referenceIds.has(normalizedReferenceId(label))) linkEnd = labelClose + 1;
        }

        if (linkEnd !== undefined) {
          characters.push(
            ...parseInline(source, labelOpen + 1, labelClose, ignoredSpans, referenceIds),
          );
          index = linkEnd;
          continue;
        }
      }
    }

    if (character === "`") {
      let runEnd = index + 1;
      while (runEnd < end && source[runEnd] === "`") runEnd += 1;
      const delimiter = source.slice(index, runEnd);
      const codeEnd = source.indexOf(delimiter, runEnd);
      if (codeEnd >= runEnd && codeEnd < end) {
        appendRawCharacters(characters, source, runEnd, codeEnd);
        index = codeEnd + delimiter.length;
        continue;
      }
    }

    if (character === "<") {
      const close = source.indexOf(">", index + 1);
      if (close >= 0 && close < end) {
        const tag = source.slice(index, close + 1);
        if (/^<\/?[A-Za-z][^>]*>$/u.test(tag) || /^<(?:https?:\/\/|mailto:)/iu.test(tag)) {
          index = close + 1;
          continue;
        }
      }
    }

    if (character === "~" && source[index + 1] === "~") {
      index += 2;
      continue;
    }
    if (character === "*") {
      const previous = source[index - 1] ?? " ";
      const next = source[index + 1] ?? " ";
      if (!/\s/u.test(previous) || !/\s/u.test(next)) {
        index += 1;
        continue;
      }
    }
    if (character === "_") {
      const previous = source[index - 1] ?? " ";
      const next = source[index + 1] ?? " ";
      const insideIdentifier = /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
      if (!insideIdentifier && (!/\s/u.test(previous) || !/\s/u.test(next))) {
        index += 1;
        continue;
      }
    }

    characters.push({ value: character, rawStart: index, rawEnd: index + 1 });
    index += 1;
  }

  return characters;
}

function normalizeCharacters(characters: readonly MappedCharacter[]): MappedCharacter[] {
  const normalized: MappedCharacter[] = [];
  let pendingSpace: MappedCharacter | undefined;
  for (const character of characters) {
    if (/\s/u.test(character.value) || character.value === "\u00a0") {
      pendingSpace = pendingSpace
        ? { value: " ", rawStart: pendingSpace.rawStart, rawEnd: character.rawEnd }
        : { ...character, value: " " };
      continue;
    }
    if (pendingSpace && normalized.length > 0) normalized.push(pendingSpace);
    pendingSpace = undefined;
    normalized.push(character);
  }
  return normalized;
}

function createSegments(nodeId: string, characters: readonly MappedCharacter[]): DOMTextSegment[] {
  const segments: DOMTextSegment[] = [];
  characters.forEach((character, normalizedOffset) => {
    const previous = segments.at(-1);
    if (
      previous &&
      previous.nodeId === nodeId &&
      previous.normalizedEnd === normalizedOffset &&
      previous.rawEndOffset === character.rawStart
    ) {
      previous.normalizedEnd += 1;
      previous.rawEndOffset = character.rawEnd;
      return;
    }
    segments.push({
      nodeId,
      normalizedStart: normalizedOffset,
      normalizedEnd: normalizedOffset + 1,
      rawStartOffset: character.rawStart,
      rawEndOffset: character.rawEnd,
    });
  });
  return segments;
}

function createNormalizedText(
  textNode: Text,
  registry: TextNodeRegistry,
  draft: MarkdownDraft,
): NormalizedDOMText | undefined {
  const characters = normalizeCharacters(draft.characters);
  if (characters.length === 0) return undefined;
  const nodeId = registry.idFor(textNode);
  const text = characters.map((character) => character.value).join("");

  const rangeForOffsets = (startOffset: number, endOffset: number): Range | undefined => {
    const start = characters[startOffset];
    const end = characters[endOffset - 1];
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset > characters.length ||
      startOffset >= endOffset ||
      !start ||
      !end ||
      !textNode.isConnected
    ) {
      return undefined;
    }
    const range = textNode.ownerDocument.createRange();
    range.setStart(textNode, start.rawStart);
    range.setEnd(textNode, end.rawEnd);
    return range;
  };

  const normalizedOffsetForPoint = (
    node: Node,
    rawOffset: number,
    bias: "start" | "end" = "start",
  ): number | undefined => {
    if (node !== textNode || rawOffset < draft.spanStart || rawOffset > draft.spanEnd) {
      return undefined;
    }
    for (let offset = 0; offset < characters.length; offset += 1) {
      const source = characters[offset];
      if (!source) continue;
      if (rawOffset <= source.rawStart) return offset;
      if (rawOffset < source.rawEnd) return bias === "end" ? offset + 1 : offset;
      if (rawOffset === source.rawEnd) return offset + 1;
    }
    return characters.length;
  };

  return {
    text,
    segments: createSegments(nodeId, characters),
    rangeForOffsets,
    normalizedOffsetForPoint,
    containsNode: (node: Node) => node === textNode,
    fullRange: () => rangeForOffsets(0, characters.length),
  };
}

function appendLine(
  draft: MarkdownDraft,
  characters: MappedCharacter[],
  line: RawLine,
  contentStart: number,
): void {
  if (draft.characters.length > 0 && characters.length > 0) {
    draft.characters.push({ value: " ", rawStart: draft.spanEnd, rawEnd: contentStart });
  }
  draft.characters.push(...characters);
  draft.spanEnd = line.contentEnd;
}

function parseDrafts(source: string): MarkdownDraft[] {
  const lines = splitLines(source);
  const flattenedMermaidArtifacts = prepareFlattenedMermaidArtifacts(source).artifacts;
  const ignoredSpans: SourceSpan[] = [
    ...htmlCommentSpans(source),
    ...flattenedMermaidArtifacts.map(({ sourceEnd: end, sourceStart: start }) => ({ end, start })),
  ];
  const frontmatter = frontmatterLineIndexes(lines);
  const referenceIds = new Set<string>();
  lines.forEach((line) => {
    const match = line.text.match(REFERENCE_DEFINITION_PATTERN);
    const id = match?.[1];
    if (id) referenceIds.add(normalizedReferenceId(id));
  });

  const drafts: MarkdownDraft[] = [];
  let active: MarkdownDraft | undefined;
  let fence: { character: string; length: number } | undefined;

  const flush = (): void => {
    if (active?.characters.length) drafts.push(active);
    active = undefined;
  };
  const startDraft = (
    type: ReadingBlockType,
    line: RawLine,
    contentStart: number,
    contentEnd = line.contentEnd,
  ): MarkdownDraft => ({
    type,
    characters: parseInline(source, contentStart, contentEnd, ignoredSpans, referenceIds),
    spanStart: line.start,
    spanEnd: line.contentEnd,
  });

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.text.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (fence) {
      const marker = fenceMatch?.[1];
      if (marker?.[0] === fence.character && marker.length >= fence.length) fence = undefined;
      return;
    }
    if (fenceMatch?.[1]) {
      flush();
      fence = { character: fenceMatch[1][0] ?? "`", length: fenceMatch[1].length };
      return;
    }
    if (frontmatter.has(lineIndex)) {
      flush();
      return;
    }
    if (!line.text.trim()) {
      flush();
      return;
    }
    const lineArtifacts = flattenedMermaidArtifacts.filter(
      ({ sourceEnd, sourceStart }) => sourceStart >= line.start && sourceEnd <= line.contentEnd,
    );
    if (lineArtifacts.length > 0) {
      let remainder = line.text;
      for (const artifact of [...lineArtifacts].reverse()) {
        remainder =
          remainder.slice(0, artifact.sourceStart - line.start) +
          remainder.slice(artifact.sourceEnd - line.start);
      }
      if (!remainder.trim()) {
        flush();
        return;
      }
    }

    const setext = line.text.match(/^\s{0,3}(?:=+|-+)\s*$/u);
    if (setext && active?.type === "paragraph") {
      active.type = "heading";
      active.spanEnd = line.contentEnd;
      flush();
      return;
    }
    if (REFERENCE_DEFINITION_PATTERN.test(line.text) || THEMATIC_BREAK_PATTERN.test(line.text)) {
      flush();
      return;
    }

    const heading = line.text.match(/^\s{0,3}#{1,6}[ \t]+/u);
    if (heading) {
      flush();
      const contentStart = line.start + heading[0].length;
      const trailing = source.slice(contentStart, line.contentEnd).match(/[ \t]+#+[ \t]*$/u);
      const contentEnd =
        trailing?.index === undefined ? line.contentEnd : contentStart + trailing.index;
      const draft = startDraft("heading", line, contentStart, contentEnd);
      if (draft.characters.length) drafts.push(draft);
      return;
    }

    const listItem = line.text.match(/^\s{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u);
    if (listItem) {
      flush();
      let contentStart = line.start + listItem[0].length;
      const task = source.slice(contentStart, line.contentEnd).match(/^\[[ xX]\][ \t]+/u);
      if (task) contentStart += task[0].length;
      active = startDraft("list-item", line, contentStart);
      return;
    }

    const quote = line.text.match(/^\s{0,3}(?:>[ \t]?)+/u);
    if (quote) {
      const contentStart = line.start + quote[0].length;
      const characters = parseInline(
        source,
        contentStart,
        line.contentEnd,
        ignoredSpans,
        referenceIds,
      );
      if (active?.type !== "quote") {
        flush();
        active = {
          type: "quote",
          characters,
          spanStart: line.start,
          spanEnd: line.contentEnd,
        };
      } else {
        appendLine(active, characters, line, contentStart);
      }
      return;
    }

    if (/^(?: {4}|\t)/u.test(line.text) && active?.type !== "list-item") {
      flush();
      return;
    }

    const leadingWhitespace = line.text.match(/^[ \t]*/u)?.[0].length ?? 0;
    const contentStart = line.start + leadingWhitespace;
    const characters = parseInline(
      source,
      contentStart,
      line.contentEnd,
      ignoredSpans,
      referenceIds,
    );
    if (characters.length === 0) return;
    if (active && ["paragraph", "list-item", "quote"].includes(active.type)) {
      appendLine(active, characters, line, contentStart);
      return;
    }
    flush();
    active = {
      type: "paragraph",
      characters,
      spanStart: line.start,
      spanEnd: line.contentEnd,
    };
  });

  flush();
  return drafts;
}

export function extractRawMarkdownBlocks(
  sourceDocument: Document,
  registry: TextNodeRegistry,
  isVisible: (element: Element) => boolean,
): RawMarkdownBlock[] {
  const raw = rawMarkdownPre(sourceDocument, isVisible);
  if (!raw) return [];

  return parseDrafts(raw.textNode.data).flatMap((draft) => {
    const normalized = createNormalizedText(raw.textNode, registry, draft);
    return normalized && /[\p{L}\p{N}]/u.test(normalized.text)
      ? [{ type: draft.type, element: raw.pre, normalized }]
      : [];
  });
}
