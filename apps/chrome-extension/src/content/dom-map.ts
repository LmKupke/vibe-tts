export interface DOMTextSegment {
  nodeId: string;
  normalizedStart: number;
  normalizedEnd: number;
  rawStartOffset: number;
  rawEndOffset: number;
}

interface SourceCharacter {
  nodeId: string;
  rawStart: number;
  rawEnd: number;
}

export interface NormalizedDOMText {
  text: string;
  segments: DOMTextSegment[];
  rangeForOffsets(startOffset: number, endOffset: number): Range | undefined;
  normalizedOffsetForPoint(
    node: Node,
    rawOffset: number,
    bias?: "start" | "end",
  ): number | undefined;
  containsNode(node: Node): boolean;
  fullRange(): Range | undefined;
}

export interface NormalizeElementTextOptions {
  shouldSkipElement?: (element: Element) => boolean;
}

const SPACE_PATTERN = /\s/u;

export class TextNodeRegistry {
  readonly #ids = new WeakMap<Text, string>();
  readonly #nodes = new Map<string, Text>();
  #nextId = 0;

  idFor(node: Text): string {
    const existing = this.#ids.get(node);
    if (existing) return existing;
    const id = `text-${this.#nextId++}`;
    this.#ids.set(node, id);
    this.#nodes.set(id, node);
    return id;
  }

  nodeFor(id: string): Text | undefined {
    return this.#nodes.get(id);
  }

  clear(): void {
    this.#nodes.clear();
    this.#nextId = 0;
  }
}

interface PendingSpace {
  nodeId: string;
  rawStart: number;
  rawEnd: number;
}

export function normalizeElementText(
  element: Element,
  registry: TextNodeRegistry,
  options: NormalizeElementTextOptions = {},
): NormalizedDOMText {
  const normalizedCharacters: string[] = [];
  const sources: SourceCharacter[] = [];
  let pendingSpace: PendingSpace | undefined;

  const appendSpace = (source: PendingSpace): void => {
    if (normalizedCharacters.length === 0 || normalizedCharacters.at(-1) === " ") return;
    normalizedCharacters.push(" ");
    sources.push({ nodeId: source.nodeId, rawStart: source.rawStart, rawEnd: source.rawEnd });
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const value = textNode.data;
      const nodeId = registry.idFor(textNode);

      for (let rawOffset = 0; rawOffset < value.length; rawOffset += 1) {
        const character = value[rawOffset];
        if (character === undefined) continue;
        if (SPACE_PATTERN.test(character) || character === "\u00a0") {
          if (!pendingSpace) {
            pendingSpace = { nodeId, rawStart: rawOffset, rawEnd: rawOffset + 1 };
          } else if (pendingSpace.nodeId === nodeId) {
            pendingSpace.rawEnd = rawOffset + 1;
          }
          continue;
        }

        if (pendingSpace) {
          appendSpace(pendingSpace);
          pendingSpace = undefined;
        }
        normalizedCharacters.push(character);
        sources.push({ nodeId, rawStart: rawOffset, rawEnd: rawOffset + 1 });
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const childElement = node as Element;
    if (childElement !== element && options.shouldSkipElement?.(childElement)) return;
    if (childElement.tagName === "BR") {
      const previousSource = sources.at(-1);
      if (previousSource) {
        pendingSpace = {
          nodeId: previousSource.nodeId,
          rawStart: previousSource.rawEnd,
          rawEnd: previousSource.rawEnd,
        };
      }
      return;
    }

    for (const child of childElement.childNodes) visit(child);
  };

  visit(element);

  const text = normalizedCharacters.join("");
  const segments = createSegments(sources);

  const pointFor = (source: SourceCharacter, edge: "start" | "end"): [Text, number] | undefined => {
    const node = registry.nodeFor(source.nodeId);
    if (!node?.isConnected) return undefined;
    return [node, edge === "start" ? source.rawStart : source.rawEnd];
  };

  const rangeForOffsets = (startOffset: number, endOffset: number): Range | undefined => {
    if (
      startOffset < 0 ||
      endOffset > sources.length ||
      startOffset >= endOffset ||
      !sources[startOffset] ||
      !sources[endOffset - 1]
    ) {
      return undefined;
    }
    const startSource = sources[startOffset];
    const endSource = sources[endOffset - 1];
    if (!startSource || !endSource) return undefined;
    const start = pointFor(startSource, "start");
    const end = pointFor(endSource, "end");
    if (!start || !end) return undefined;
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    return range;
  };

  const normalizedOffsetForPoint = (
    node: Node,
    rawOffset: number,
    bias: "start" | "end" = "start",
  ): number | undefined => {
    const textNode = node.nodeType === Node.TEXT_NODE ? (node as Text) : undefined;
    if (!textNode) return undefined;
    const nodeId = registry.idFor(textNode);
    let nearest: number | undefined;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (!source || source.nodeId !== nodeId) continue;
      if (rawOffset <= source.rawStart) return index;
      if (rawOffset < source.rawEnd) return bias === "end" ? index + 1 : index;
      if (rawOffset === source.rawEnd) return index + 1;
      nearest = index + 1;
    }
    return nearest;
  };

  return {
    text,
    segments,
    rangeForOffsets,
    normalizedOffsetForPoint,
    containsNode: (node: Node) => element.contains(node),
    fullRange: () => rangeForOffsets(0, text.length),
  };
}

function createSegments(sources: readonly SourceCharacter[]): DOMTextSegment[] {
  const segments: DOMTextSegment[] = [];
  sources.forEach((source, normalizedOffset) => {
    const previous = segments.at(-1);
    if (
      previous &&
      previous.nodeId === source.nodeId &&
      previous.normalizedEnd === normalizedOffset &&
      previous.rawEndOffset === source.rawStart
    ) {
      previous.normalizedEnd += 1;
      previous.rawEndOffset = source.rawEnd;
      return;
    }
    segments.push({
      nodeId: source.nodeId,
      normalizedStart: normalizedOffset,
      normalizedEnd: normalizedOffset + 1,
      rawStartOffset: source.rawStart,
      rawEndOffset: source.rawEnd,
    });
  });
  return segments;
}
