import mermaid, { type MermaidConfig } from "mermaid";

import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_TEXT_SIZE,
  PENDING_MERMAID_FIGURE_SELECTOR,
  markMermaidDiagramError,
  mermaidCanvasFor,
  mermaidSourceFor,
  mermaidStatusFor,
  setMermaidState,
} from "./mermaid-placeholders";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SHADOW_STYLE = `
  :host { display: block; max-width: 100%; overflow: auto; }
  svg {
    display: block;
    width: max(100%, 40rem);
    max-width: none !important;
    height: auto;
    margin-inline: auto;
  }
`;

export interface MermaidRenderSummary {
  rendered: number;
  failed: number;
}

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: MAX_MERMAID_TEXT_SIZE,
  maxEdges: MAX_MERMAID_EDGES,
  deterministicIds: true,
  deterministicIDSeed: "vibe-tts-mermaid",
  htmlLabels: false,
  look: "classic",
  theme: "base",
  fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  themeVariables: {
    background: "#f7f7f2",
    primaryColor: "#eceee9",
    primaryTextColor: "#172026",
    primaryBorderColor: "#838d88",
    secondaryColor: "#dfe5f9",
    secondaryTextColor: "#172026",
    secondaryBorderColor: "#2853d8",
    tertiaryColor: "#ffffff",
    tertiaryTextColor: "#172026",
    tertiaryBorderColor: "#ccd1cc",
    lineColor: "#5a646a",
    textColor: "#172026",
    titleColor: "#172026",
    edgeLabelBackground: "#f7f7f2",
    clusterBkg: "#ffffff",
    clusterBorder: "#aeb6b1",
    noteBkgColor: "#fff1c2",
    noteBorderColor: "#d69e00",
    noteTextColor: "#172026",
    actorBkg: "#eceee9",
    actorBorder: "#838d88",
    actorTextColor: "#172026",
    signalColor: "#5a646a",
    signalTextColor: "#172026",
    labelBoxBkgColor: "#f7f7f2",
    labelBoxBorderColor: "#838d88",
    labelTextColor: "#172026",
    loopTextColor: "#172026",
    activationBorderColor: "#2853d8",
    activationBkgColor: "#dfe5f9",
    sequenceNumberColor: "#ffffff",
  },
  secure: [
    "securityLevel",
    "startOnLoad",
    "suppressErrorRendering",
    "maxTextSize",
    "maxEdges",
    "deterministicIds",
    "deterministicIDSeed",
    "htmlLabels",
    "theme",
    "themeVariables",
    "themeCSS",
    "dompurifyConfig",
  ],
};

function sanitizeCss(css: string): string {
  const withoutImports = css.replace(/@import\s+[^;]*(?:;|$)/giu, "");
  const withoutDangerousSyntax = withoutImports.replace(
    /(?:expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding\s*:|behavior\s*:)/giu,
    "",
  );
  return withoutDangerousSyntax.replace(/url\(\s*([^)]+?)\s*\)/giu, (_match, rawValue: string) => {
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/u, "$2");
    return /^#[A-Za-z_][\w:.-]*$/u.test(value) ? `url(${value})` : "none";
  });
}

function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}

function sanitizeSvgMarkup(svgMarkup: string, sourceDocument: Document): Element {
  const DOMParserConstructor = sourceDocument.defaultView?.DOMParser;
  if (!DOMParserConstructor) throw new Error("SVG parsing is unavailable");

  const parsed = new DOMParserConstructor().parseFromString(svgMarkup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    svg.localName.toLocaleLowerCase() !== "svg" ||
    svg.namespaceURI !== SVG_NAMESPACE ||
    parsed.querySelector("parsererror")
  ) {
    throw new Error("Mermaid returned invalid SVG");
  }

  const blockedElements = new Set([
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "image",
    "audio",
    "video",
    "canvas",
  ]);

  for (const element of Array.from(svg.querySelectorAll("*"))) {
    const name = element.localName.toLocaleLowerCase();
    if (name === "a") {
      unwrapElement(element);
      continue;
    }
    if (blockedElements.has(name)) {
      element.remove();
      continue;
    }

    if (name === "style") {
      const css = sanitizeCss(element.textContent ?? "");
      if (css.trim()) element.textContent = css;
      else element.remove();
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLocaleLowerCase();
      const value = attribute.value.trim();
      if (
        attributeName.startsWith("on") ||
        attributeName === "target" ||
        attributeName === "download" ||
        attributeName === "src"
      ) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (attributeName === "href" || attributeName === "xlink:href") {
        if (!/^#[A-Za-z_][\w:.-]*$/u.test(value)) element.removeAttributeNode(attribute);
        continue;
      }
      if (attributeName === "style") {
        const css = sanitizeCss(value);
        if (css.trim()) element.setAttribute(attribute.name, css);
        else element.removeAttributeNode(attribute);
        continue;
      }
      if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/iu.test(value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }

  for (const attribute of Array.from(svg.attributes)) {
    const attributeName = attribute.name.toLocaleLowerCase();
    const value = attribute.value.trim();
    if (
      attributeName.startsWith("on") ||
      attributeName === "target" ||
      attributeName === "download" ||
      attributeName === "src"
    ) {
      svg.removeAttributeNode(attribute);
      continue;
    }
    if (attributeName === "href" || attributeName === "xlink:href") {
      if (!/^#[A-Za-z_][\w:.-]*$/u.test(value)) svg.removeAttributeNode(attribute);
      continue;
    }
    if (attributeName === "style") {
      const css = sanitizeCss(value);
      if (css.trim()) svg.setAttribute(attribute.name, css);
      else svg.removeAttributeNode(attribute);
      continue;
    }
    if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/iu.test(value)) {
      svg.removeAttributeNode(attribute);
    }
  }
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("vibe-md-mermaid__svg");
  return sourceDocument.importNode(svg, true);
}

function uniqueSvgId(): string {
  const entropy = new Uint32Array(3);
  crypto.getRandomValues(entropy);
  return `vibe-tts-mermaid-svg-${Array.from(entropy, (value) => value.toString(36)).join("-")}`;
}

function installSvg(canvas: HTMLElement, svg: Element): void {
  const shadow = canvas.shadowRoot ?? canvas.attachShadow({ mode: "open" });
  const style = canvas.ownerDocument.createElement("style");
  style.textContent = SHADOW_STYLE;
  shadow.replaceChildren(style, svg);
}

async function renderPlaceholder(figure: HTMLElement): Promise<boolean> {
  const source = mermaidSourceFor(figure);
  const canvas = mermaidCanvasFor(figure);
  if (source === undefined || !source.trim() || source.length > MAX_MERMAID_TEXT_SIZE || !canvas) {
    markMermaidDiagramError(figure);
    return false;
  }

  setMermaidState(figure, "rendering");
  try {
    const result = await mermaid.render(uniqueSvgId(), source);
    const svg = sanitizeSvgMarkup(result.svg, figure.ownerDocument);
    installSvg(canvas, svg);
    canvas.setAttribute("aria-label", "Mermaid diagram");
    canvas.removeAttribute("aria-busy");
    const status = mermaidStatusFor(figure);
    if (status) status.textContent = "Mermaid diagram";
    setMermaidState(figure, "rendered");
    return true;
  } catch {
    markMermaidDiagramError(figure);
    return false;
  }
}

/**
 * Renders pending shells with the extension-bundled Mermaid runtime. Mermaid's
 * optional bindFunctions callback is intentionally never called; the sanitized
 * SVG is inert and all source remains available in the disclosure fallback.
 */
export async function renderMermaidDiagrams(
  root: ParentNode = document,
): Promise<MermaidRenderSummary> {
  mermaid.initialize(MERMAID_CONFIG);
  const figures = Array.from(root.querySelectorAll<HTMLElement>(PENDING_MERMAID_FIGURE_SELECTOR));
  let rendered = 0;
  let failed = 0;

  for (const figure of figures) {
    if (await renderPlaceholder(figure)) rendered += 1;
    else failed += 1;
  }
  return { rendered, failed };
}
