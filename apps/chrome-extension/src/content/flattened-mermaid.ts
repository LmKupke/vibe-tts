import MarkdownIt from "markdown-it";

const ARTIFACT_START_PATTERN = /#(mermaid-[a-z0-9_-]+)\{\s*font-family\s*:\s*inherit\s*;/giu;
const KEYFRAME_START_PATTERN = /@(?:-webkit-)?keyframes\b/iuy;
const MIN_ARTIFACT_LENGTH = 512;
const MIN_ARTIFACT_RULES = 5;
const MARKER_PREFIX = "\uE000VIBETTSFLATTENEDMERMAID";
const STRUCTURE_PARSER = new MarkdownIt({ html: false, linkify: false, typographer: false });

interface ArtifactSpan {
  diagramId: string;
  end: number;
  start: number;
}

interface SourceSpan {
  end: number;
  start: number;
}

interface BacktickRun extends SourceSpan {
  escaped: boolean;
  length: number;
}

interface MarkdownStructure {
  decodedTextFragments: string[];
  inlineCodeSpans: SourceSpan[];
  topLevelParagraphLines: Set<number>;
}

export interface FlattenedMermaidArtifact {
  readonly cssLength: number;
  readonly diagramId: string;
  readonly marker: string;
  readonly ordinal: number;
  readonly sourceEnd: number;
  readonly sourceLine: number;
  readonly sourceStart: number;
}

export interface PreparedFlattenedMermaidMarkdown {
  readonly artifacts: FlattenedMermaidArtifact[];
  readonly markdown: string;
}

function balancedBlockEnd(line: string, ruleStart: number): number | undefined {
  const openingBrace = line.indexOf("{", ruleStart);
  if (openingBrace < 0) return undefined;

  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let inComment = false;

  for (let index = openingBrace; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];

    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }

    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return undefined;
}

function generatedRuleStartsAt(
  line: string,
  index: number,
  diagramId: string,
  normalizedDiagramId: string,
): boolean {
  KEYFRAME_START_PATTERN.lastIndex = index;
  if (KEYFRAME_START_PATTERN.test(line)) return true;
  if (line[index] !== "#") return false;
  const idEnd = index + 1 + diagramId.length;
  if (line.slice(index + 1, idEnd).toLocaleLowerCase() !== normalizedDiagramId) return false;
  const boundary = line[idEnd];
  return boundary === "{" || /[\s.:,[\]-]/u.test(boundary ?? "");
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validArtifact(css: string, diagramId: string, ruleCount: number): boolean {
  if (css.length < MIN_ARTIFACT_LENGTH || ruleCount < MIN_ARTIFACT_RULES) return false;
  const escapedId = escapedRegExp(diagramId);
  const signatures = [
    /@(?:-webkit-)?keyframes\b/iu.test(css),
    new RegExp(
      `#${escapedId}\\s+\\.(?:actor|edgePaths|flowchart-link|messageLine\\d*|node)\\b`,
      "iu",
    ).test(css),
    new RegExp(`#${escapedId}\\s+:root\\s*\\{[^}]*--mermaid-font-family`, "iu").test(css),
  ];
  return signatures.filter(Boolean).length >= 2;
}

function artifactSpan(line: string, fromIndex: number): ArtifactSpan | undefined {
  let searchFrom = fromIndex;

  while (searchFrom < line.length) {
    ARTIFACT_START_PATTERN.lastIndex = searchFrom;
    const match = ARTIFACT_START_PATTERN.exec(line);
    const diagramId = match?.[1];
    if (!match || !diagramId) return undefined;

    const start = match.index;
    const normalizedDiagramId = diagramId.toLocaleLowerCase();
    let cursor = start;
    let ruleCount = 0;

    while (cursor < line.length) {
      while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
      if (!generatedRuleStartsAt(line, cursor, diagramId, normalizedDiagramId)) break;
      const end = balancedBlockEnd(line, cursor);
      if (end === undefined) return undefined;
      cursor = end;
      ruleCount += 1;
    }

    const css = line.slice(start, cursor);
    if (validArtifact(css, diagramId, ruleCount)) return { diagramId, end: cursor, start };
    searchFrom = Math.max(cursor, match.index + match[0].length);
  }

  return undefined;
}

function escapedAt(line: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function matchedInlineCodeSpans(source: string, start: number, end: number): SourceSpan[] {
  const runs: BacktickRun[] = [];
  let index = start;

  while (index < end) {
    if (source[index] !== "`") {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < end && source[index] === "`") index += 1;
    runs.push({
      end: index,
      escaped: escapedAt(source, runStart),
      length: index - runStart,
      start: runStart,
    });
  }

  const remainingByLength = new Map<number, number>();
  for (const run of runs) {
    remainingByLength.set(run.length, (remainingByLength.get(run.length) ?? 0) + 1);
  }

  const spans: SourceSpan[] = [];
  let opener: { length: number; start: number } | undefined;
  for (const run of runs) {
    remainingByLength.set(run.length, (remainingByLength.get(run.length) ?? 1) - 1);
    if (!opener) {
      const length = run.length - (run.escaped ? 1 : 0);
      if (length === 0 || (remainingByLength.get(length) ?? 0) === 0) continue;
      opener = { length, start: run.start + (run.escaped ? 1 : 0) };
      continue;
    }
    if (run.length !== opener.length) continue;
    spans.push({ start: opener.start, end: run.end });
    opener = undefined;
  }
  return spans;
}

function lineOffsets(parts: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (let index = 0; index < parts.length; index += 2) {
    offsets.push(offset);
    offset += (parts[index]?.length ?? 0) + (parts[index + 1]?.length ?? 0);
  }
  return offsets;
}

function markdownStructure(markdown: string, offsets: readonly number[]): MarkdownStructure {
  const topLevelParagraphLines = new Set<number>();
  const inlineCodeSpans: SourceSpan[] = [];
  const tokens = STRUCTURE_PARSER.parse(markdown, {});
  const decodedTextFragments = tokens.flatMap(
    (token) =>
      token.children?.filter((child) => child.type === "text").map((child) => child.content) ?? [],
  );

  for (const token of tokens) {
    if (token.type !== "paragraph_open" || token.level !== 0 || !token.map) continue;
    const [startLine, endLine] = token.map;
    for (let lineIndex = startLine; lineIndex < endLine; lineIndex += 1) {
      topLevelParagraphLines.add(lineIndex);
    }
    const start = offsets[startLine];
    const end = offsets[endLine] ?? markdown.length;
    if (start !== undefined) inlineCodeSpans.push(...matchedInlineCodeSpans(markdown, start, end));
  }

  return { decodedTextFragments, inlineCodeSpans, topLevelParagraphLines };
}

function markerSalt(values: readonly string[]): string {
  let found = false;
  let longestRun = 0;

  for (const value of values) {
    let searchFrom = 0;
    while (searchFrom < value.length) {
      const markerStart = value.indexOf(MARKER_PREFIX, searchFrom);
      if (markerStart < 0) break;
      found = true;
      let cursor = markerStart + MARKER_PREFIX.length;
      while (value[cursor] === "X") cursor += 1;
      longestRun = Math.max(longestRun, cursor - markerStart - MARKER_PREFIX.length);
      searchFrom = cursor;
    }
  }

  return found ? "X".repeat(longestRun + 1) : "";
}

function transformLine(
  line: string,
  lineStart: number,
  sourceLine: number,
  lineEnding: string,
  salt: string,
  artifacts: FlattenedMermaidArtifact[],
  protectedSpans: readonly SourceSpan[],
): string {
  const blocks: string[] = [];
  let cursor = 0;
  let searchFrom = 0;
  let changed = false;

  while (searchFrom < line.length) {
    const span = artifactSpan(line, searchFrom);
    if (!span) break;

    const protectedSpan = protectedSpans.find(
      (candidate) =>
        lineStart + span.start >= candidate.start && lineStart + span.start < candidate.end,
    );
    if (protectedSpan) {
      searchFrom = Math.min(line.length, protectedSpan.end - lineStart);
      continue;
    }

    const prefix = line.slice(cursor, span.start).trim();
    if (prefix) blocks.push(prefix);

    const ordinal = artifacts.length;
    const marker = `${MARKER_PREFIX}${salt}-${ordinal}\uE001`;
    artifacts.push({
      cssLength: span.end - span.start,
      diagramId: span.diagramId,
      marker,
      ordinal,
      sourceEnd: lineStart + span.end,
      sourceLine,
      sourceStart: lineStart + span.start,
    });
    blocks.push(marker);
    cursor = span.end;
    searchFrom = span.end;
    changed = true;
  }

  if (!changed) return line;
  const suffix = line.slice(cursor).trim();
  if (suffix) blocks.push(suffix);
  return `${lineEnding}${blocks.join(`${lineEnding}${lineEnding}`)}${lineEnding}`;
}

/**
 * Replaces high-confidence, flattened Mermaid SVG style artifacts with unique
 * markers in the derived Markdown used for rendering. The caller keeps the raw
 * source unchanged and can replace the returned markers with accessible notes.
 */
export function prepareFlattenedMermaidArtifacts(
  markdown: string,
): PreparedFlattenedMermaidMarkdown {
  const parts = markdown.split(/(\r\n|\n|\r)/u);
  const preferredLineEnding = markdown.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const artifacts: FlattenedMermaidArtifact[] = [];
  const offsets = lineOffsets(parts);
  const structure = markdownStructure(markdown, offsets);
  const salt = markerSalt([markdown, ...structure.decodedTextFragments]);
  let sourceOffset = 0;

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const lineEnding = parts[index + 1] ?? "";
    const lineIndex = index / 2;
    if (structure.topLevelParagraphLines.has(lineIndex)) {
      parts[index] = transformLine(
        line,
        sourceOffset,
        lineIndex + 1,
        lineEnding || preferredLineEnding,
        salt,
        artifacts,
        structure.inlineCodeSpans,
      );
    }
    sourceOffset += line.length + lineEnding.length;
  }

  return { artifacts, markdown: parts.join("") };
}
