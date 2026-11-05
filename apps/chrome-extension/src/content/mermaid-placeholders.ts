const MERMAID_CODE_SELECTOR = "pre > code";
const MERMAID_LANGUAGE_ALIASES = new Set(["mermaid", "mmd"]);
export const PENDING_MERMAID_FIGURE_SELECTOR =
  'figure.vibe-md-mermaid[data-vibe-tts-mermaid-state="pending"]';

export const MAX_MERMAID_TEXT_SIZE = 50_000;
export const MAX_MERMAID_EDGES = 500;

export type MermaidDiagramState = "pending" | "rendering" | "rendered" | "error";

function diagramHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function ownerDocumentFor(root: ParentNode): Document {
  return root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : (root.ownerDocument ?? document);
}

function isMermaidCodeElement(code: HTMLElement): boolean {
  return Array.from(code.classList).some((className) => {
    if (!className.toLocaleLowerCase().startsWith("language-")) return false;
    const language = className
      .slice("language-".length)
      .toLocaleLowerCase()
      .replace(/^\{\./u, "")
      .replace(/\}$/u, "");
    return MERMAID_LANGUAGE_ALIASES.has(language);
  });
}

function uniqueRenderId(sourceDocument: Document, source: string): string {
  const base = `vibe-tts-mermaid-${diagramHash(source)}`;
  let id = base;
  let suffix = 2;
  while (sourceDocument.getElementById(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function setMermaidState(figure: HTMLElement, state: MermaidDiagramState): void {
  figure.dataset.vibeTtsMermaidState = state;
}

function createStatus(sourceDocument: Document): HTMLElement {
  const status = sourceDocument.createElement("aside");
  status.className = "vibe-md-mermaid__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Rendering diagram…";
  return status;
}

function createSourceFallback(sourceDocument: Document, source: string): HTMLDetailsElement {
  const details = sourceDocument.createElement("details");
  details.className = "vibe-md-mermaid__source";

  const summary = sourceDocument.createElement("summary");
  summary.textContent = "View diagram source";
  const pre = sourceDocument.createElement("pre");
  const code = sourceDocument.createElement("code");
  code.className = "language-mermaid";
  code.textContent = source;
  pre.append(code);
  details.append(summary, pre);
  return details;
}

function createPlaceholder(sourceDocument: Document, source: string): HTMLElement {
  const figure = sourceDocument.createElement("figure");
  figure.className = "vibe-md-mermaid";
  figure.dataset.vibeTtsNarrationSkip = "true";
  setMermaidState(figure, "pending");

  const canvas = sourceDocument.createElement("div");
  canvas.id = uniqueRenderId(sourceDocument, source);
  canvas.className = "vibe-md-mermaid__canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Mermaid diagram");
  canvas.setAttribute("aria-busy", "true");

  figure.append(canvas, createStatus(sourceDocument), createSourceFallback(sourceDocument, source));
  return figure;
}

/**
 * Replaces Markdown-it Mermaid fences with accessible diagram shells while keeping
 * the diagram source in a disclosure. This phase is synchronous so the ordinary
 * reading-document extraction never sees the diagram source as prose.
 */
export function upgradeMermaidCodeBlocks(root: ParentNode): HTMLElement[] {
  const sourceDocument = ownerDocumentFor(root);
  const upgraded: HTMLElement[] = [];

  for (const code of root.querySelectorAll<HTMLElement>(MERMAID_CODE_SELECTOR)) {
    if (!isMermaidCodeElement(code)) continue;
    const pre = code.parentElement;
    if (!pre || pre.tagName !== "PRE" || pre.children.length !== 1) continue;
    if (pre.closest("figure.vibe-md-mermaid")) continue;

    const source = code.textContent ?? "";
    const figure = createPlaceholder(sourceDocument, source);
    pre.replaceWith(figure);
    upgraded.push(figure);
  }

  return upgraded;
}

export function hasPendingMermaidDiagrams(root: ParentNode = document): boolean {
  return root.querySelector(PENDING_MERMAID_FIGURE_SELECTOR) !== null;
}

export function mermaidSourceFor(figure: HTMLElement): string | undefined {
  return figure.querySelector<HTMLElement>(
    ":scope > details.vibe-md-mermaid__source pre > code.language-mermaid",
  )?.textContent;
}

export function mermaidCanvasFor(figure: HTMLElement): HTMLElement | undefined {
  const canvas = figure.querySelector<HTMLElement>(":scope > .vibe-md-mermaid__canvas");
  return canvas ?? undefined;
}

export function mermaidStatusFor(figure: HTMLElement): HTMLElement | undefined {
  const status = figure.querySelector<HTMLElement>(":scope > aside.vibe-md-mermaid__status");
  return status ?? undefined;
}

export function markMermaidDiagramError(figure: HTMLElement): void {
  setMermaidState(figure, "error");
  const canvas = mermaidCanvasFor(figure);
  if (canvas) {
    canvas.replaceChildren();
    canvas.setAttribute("aria-label", "Mermaid diagram could not be rendered");
    canvas.removeAttribute("aria-busy");
  }
  const status = mermaidStatusFor(figure);
  if (status) {
    status.textContent = "Couldn’t render this Mermaid diagram. Source is preserved below.";
  }
  const details = figure.querySelector<HTMLDetailsElement>(
    ":scope > details.vibe-md-mermaid__source",
  );
  if (details) details.open = true;
}
