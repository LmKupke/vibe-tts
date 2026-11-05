const GUTTER_ID = "vibe-tts-markdown-read-gutter";
const HINT_ID = "vibe-tts-markdown-read-hint";
const STATUS_ID = "vibe-tts-markdown-read-status";
const TARGET_SELECTOR = "h1,h2,h3,h4,h5,h6,p";
const TARGET_ATTRIBUTE = "vibeTtsReadBlock";
const CONTROL_ATTRIBUTE = "vibeTtsReadFor";
const BUTTON_CLASS = "vibe-md-read-from-here";
const MAX_LABEL_LENGTH = 60;

export const MARKDOWN_READ_FROM_BLOCK_EVENT = "vibe-tts-markdown-read-from-block";

export type MarkdownReadControlState = "idle" | "preparing" | "active" | "error";

export interface MarkdownReadFromBlockDetail {
  blockKey: string;
}

interface GutterEntry {
  block: HTMLElement;
  button: HTMLButtonElement;
  blockKey: string;
  hideTimer?: number;
}

interface GutterSession {
  reader: HTMLElement;
  gutter: HTMLElement;
  status: HTMLElement;
  entries: GutterEntry[];
  resizeObserver?: ResizeObserver;
  positionFrame?: number;
}

const sessions = new WeakMap<Document, GutterSession>();

function normalizedSnippet(block: HTMLElement): string {
  const value = (block.textContent ?? "").replace(/\s+/gu, " ").trim();
  if (value.length <= MAX_LABEL_LENGTH) return value;
  return `${value.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

function isEligibleTarget(block: HTMLElement): boolean {
  if (!block.textContent?.trim()) return false;
  if (block.closest("li,table,figure,details,[data-vibe-tts-narration-skip='true']")) return false;
  return true;
}

function playIcon(sourceDocument: Document): SVGSVGElement {
  const icon = sourceDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("vibe-md-read-from-here__icon");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = sourceDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 3.25 12.25 8 5 12.75Z");
  path.setAttribute("fill", "currentColor");
  icon.append(path);
  return icon;
}

function retryIcon(sourceDocument: Document): SVGSVGElement {
  const icon = sourceDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("vibe-md-read-from-here__retry");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = sourceDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12.6 5.4A5 5 0 1 0 13 10.7M12.6 2.8v2.6H10");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  return icon;
}

function loadingMark(sourceDocument: Document): HTMLElement {
  const mark = sourceDocument.createElement("span");
  mark.className = "vibe-md-read-from-here__loading";
  mark.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) mark.append(sourceDocument.createElement("i"));
  return mark;
}

function buttonForEntry(
  sourceDocument: Document,
  block: HTMLElement,
  blockKey: string,
): HTMLButtonElement {
  const snippet = normalizedSnippet(block);
  const button = sourceDocument.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.dataset[CONTROL_ATTRIBUTE] = blockKey;
  button.dataset.vibeTtsReadState = "idle";
  button.dataset.vibeTtsNarrationSkip = "true";
  button.setAttribute("aria-label", `Read from here: ${snippet}`);
  button.setAttribute("aria-describedby", HINT_ID);
  button.title = "Read from here";
  button.tabIndex = -1;

  const plate = sourceDocument.createElement("span");
  plate.className = "vibe-md-read-from-here__plate";
  plate.append(playIcon(sourceDocument), retryIcon(sourceDocument), loadingMark(sourceDocument));
  button.append(plate);
  return button;
}

function entryForKey(session: GutterSession, blockKey: string): GutterEntry | undefined {
  return session.entries.find((entry) => entry.blockKey === blockKey);
}

function makeRoving(session: GutterSession, entry: GutterEntry): void {
  for (const candidate of session.entries) candidate.button.tabIndex = candidate === entry ? 0 : -1;
}

function showEntry(entry: GutterEntry): void {
  if (entry.hideTimer !== undefined) {
    entry.button.ownerDocument.defaultView?.clearTimeout(entry.hideTimer);
    delete entry.hideTimer;
  }
  entry.button.dataset.vibeTtsReadVisible = "true";
}

function hideEntrySoon(entry: GutterEntry): void {
  const sourceWindow = entry.button.ownerDocument.defaultView;
  if (!sourceWindow || entry.button.dataset.vibeTtsReadState !== "idle") return;
  if (entry.hideTimer !== undefined) sourceWindow.clearTimeout(entry.hideTimer);
  entry.hideTimer = sourceWindow.setTimeout(() => {
    delete entry.hideTimer;
    if (entry.button.matches(":hover,:focus-visible")) return;
    delete entry.button.dataset.vibeTtsReadVisible;
  }, 80);
}

function selectionIsCollapsed(sourceDocument: Document): boolean {
  const selection = sourceDocument.defaultView?.getSelection();
  return !selection || selection.isCollapsed;
}

function eventStartedOnInteractiveElement(event: Event): boolean {
  const target = event.target;
  return (
    target instanceof Element &&
    target.closest("a,button,input,select,textarea,summary,[contenteditable='true']") !== null
  );
}

function firstLineCenter(block: HTMLElement): number {
  const style = getComputedStyle(block);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.25;
  return Math.min(block.getBoundingClientRect().height, lineHeight) / 2;
}

function positionEntries(session: GutterSession): void {
  const readerRect = session.reader.getBoundingClientRect();
  const gutterLeft = Math.max(8 - readerRect.left, -52);
  for (const entry of session.entries) {
    const blockRect = entry.block.getBoundingClientRect();
    entry.button.style.insetInlineStart = `${gutterLeft}px`;
    entry.button.style.top = `${blockRect.top - readerRect.top + firstLineCenter(entry.block) - 22}px`;
  }
}

function schedulePosition(session: GutterSession): void {
  const sourceWindow = session.reader.ownerDocument.defaultView;
  if (!sourceWindow || session.positionFrame !== undefined) return;
  session.positionFrame = sourceWindow.requestAnimationFrame(() => {
    delete session.positionFrame;
    positionEntries(session);
  });
}

function moveFocus(session: GutterSession, current: GutterEntry, direction: -1 | 1): void {
  const currentIndex = session.entries.indexOf(current);
  const next = session.entries[currentIndex + direction];
  if (!next) return;
  makeRoving(session, next);
  showEntry(next);
  next.button.focus();
}

function installEntryInteractions(session: GutterSession, entry: GutterEntry): void {
  const { block, button } = entry;
  block.addEventListener("pointerenter", () => {
    makeRoving(session, entry);
    showEntry(entry);
  });
  block.addEventListener("pointerleave", (event) => {
    if (event.relatedTarget === button || button.contains(event.relatedTarget as Node | null))
      return;
    hideEntrySoon(entry);
  });
  block.addEventListener("click", (event) => {
    const sourceWindow = block.ownerDocument.defaultView;
    if (!sourceWindow?.matchMedia("(hover: none)").matches) return;
    if (eventStartedOnInteractiveElement(event) || !selectionIsCollapsed(block.ownerDocument))
      return;
    for (const candidate of session.entries) {
      if (candidate !== entry && candidate.button.dataset.vibeTtsReadState === "idle") {
        delete candidate.button.dataset.vibeTtsReadVisible;
      }
    }
    makeRoving(session, entry);
    showEntry(entry);
  });
  button.addEventListener("pointerenter", () => showEntry(entry));
  button.addEventListener("pointerleave", (event) => {
    if (event.relatedTarget === block || block.contains(event.relatedTarget as Node | null)) return;
    hideEntrySoon(entry);
  });
  button.addEventListener("focus", () => {
    makeRoving(session, entry);
    showEntry(entry);
  });
  button.addEventListener("blur", () => hideEntrySoon(entry));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(session, entry, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(session, entry, -1);
    }
  });
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-disabled") === "true") return;
    setMarkdownReadControlState(block.ownerDocument, entry.blockKey, "preparing");
    block.ownerDocument.defaultView?.dispatchEvent(
      new block.ownerDocument.defaultView.CustomEvent<MarkdownReadFromBlockDetail>(
        MARKDOWN_READ_FROM_BLOCK_EVENT,
        { detail: { blockKey: entry.blockKey } },
      ),
    );
  });
}

function createVisuallyHiddenText(sourceDocument: Document, id: string, text: string): HTMLElement {
  const element = sourceDocument.createElement("span");
  element.id = id;
  element.className = "vibe-md-read-gutter__sr-only";
  element.textContent = text;
  return element;
}

export function installMarkdownReadGutter(reader: HTMLElement): boolean {
  const sourceDocument = reader.ownerDocument;
  if (sourceDocument.getElementById(GUTTER_ID)) return false;
  const targets = Array.from(reader.querySelectorAll<HTMLElement>(TARGET_SELECTOR)).filter(
    isEligibleTarget,
  );
  if (targets.length === 0) return false;

  const gutter = sourceDocument.createElement("aside");
  gutter.id = GUTTER_ID;
  gutter.className = "vibe-md-read-gutter";
  gutter.dataset.vibeTtsNarrationSkip = "true";
  gutter.setAttribute("aria-label", "Read from a section");

  const hint = createVisuallyHiddenText(
    sourceDocument,
    HINT_ID,
    "Use Up and Down Arrow keys to choose another section.",
  );
  const status = createVisuallyHiddenText(sourceDocument, STATUS_ID, "");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  gutter.append(hint, status);

  const entries = targets.map((block, index): GutterEntry => {
    const blockKey = `md-${index}`;
    block.dataset[TARGET_ATTRIBUTE] = blockKey;
    block.classList.add("vibe-md-read-target");
    const button = buttonForEntry(sourceDocument, block, blockKey);
    gutter.append(button);
    return { block, button, blockKey };
  });
  entries[0]!.button.tabIndex = 0;
  reader.classList.add("vibe-md-document--with-read-gutter");
  reader.prepend(gutter);

  const session: GutterSession = { reader, gutter, status, entries };
  sessions.set(sourceDocument, session);
  for (const entry of entries) installEntryInteractions(session, entry);

  const sourceWindow = sourceDocument.defaultView;
  if (sourceWindow && typeof sourceWindow.ResizeObserver === "function") {
    session.resizeObserver = new sourceWindow.ResizeObserver(() => schedulePosition(session));
    session.resizeObserver.observe(reader);
    for (const entry of entries) session.resizeObserver.observe(entry.block);
  }
  sourceWindow?.addEventListener("resize", () => schedulePosition(session), { passive: true });
  reader.addEventListener("toggle", () => schedulePosition(session), true);
  schedulePosition(session);
  return true;
}

export function markdownReadTarget(
  sourceDocument: Document,
  blockKey: string,
): HTMLElement | undefined {
  const session = sessions.get(sourceDocument);
  return session ? entryForKey(session, blockKey)?.block : undefined;
}

export function markdownReadBlockKey(element: Element): string | undefined {
  return element instanceof HTMLElement ? element.dataset[TARGET_ATTRIBUTE] : undefined;
}

export function setMarkdownReadControlState(
  sourceDocument: Document,
  blockKey: string,
  state: MarkdownReadControlState,
): void {
  const session = sessions.get(sourceDocument);
  if (!session) return;
  const entry = entryForKey(session, blockKey);
  if (!entry) return;

  if (state === "active") {
    for (const candidate of session.entries) {
      if (candidate === entry || candidate.button.dataset.vibeTtsReadState !== "active") continue;
      candidate.button.dataset.vibeTtsReadState = "idle";
      candidate.button.removeAttribute("aria-current");
      if (!candidate.button.matches(":hover,:focus-visible")) {
        delete candidate.button.dataset.vibeTtsReadVisible;
      }
    }
  }

  entry.button.dataset.vibeTtsReadState = state;
  entry.button.toggleAttribute("aria-busy", state === "preparing");
  if (state === "preparing") entry.button.setAttribute("aria-disabled", "true");
  else entry.button.removeAttribute("aria-disabled");
  if (state === "active") entry.button.setAttribute("aria-current", "true");
  else entry.button.removeAttribute("aria-current");

  const snippet = normalizedSnippet(entry.block);
  const accessibleLabel =
    state === "active"
      ? `Reading from here: ${snippet}`
      : state === "error"
        ? `Retry from here: ${snippet}. The last attempt failed.`
        : `Read from here: ${snippet}`;
  entry.button.setAttribute("aria-label", accessibleLabel);
  entry.button.title = state === "error" ? "Couldn’t start here. Try again." : "Read from here";
  if (state !== "idle") showEntry(entry);

  if (state === "preparing") session.status.textContent = `Preparing from ${snippet}.`;
  if (state === "active") session.status.textContent = `Reading from ${snippet}.`;
  if (state === "error") session.status.textContent = "Couldn’t start here. Try again.";
}

export function clearMarkdownReadControlStates(sourceDocument: Document): void {
  const session = sessions.get(sourceDocument);
  if (!session) return;
  for (const entry of session.entries) {
    entry.button.dataset.vibeTtsReadState = "idle";
    entry.button.removeAttribute("aria-busy");
    entry.button.removeAttribute("aria-disabled");
    entry.button.removeAttribute("aria-current");
    entry.button.setAttribute("aria-label", `Read from here: ${normalizedSnippet(entry.block)}`);
    entry.button.title = "Read from here";
    if (!entry.button.matches(":hover,:focus-visible")) {
      delete entry.button.dataset.vibeTtsReadVisible;
    }
  }
  session.status.textContent = "";
}

export function setMarkdownReadActiveElement(sourceDocument: Document, element?: Element): void {
  const blockKey = element ? markdownReadBlockKey(element) : undefined;
  if (!blockKey) {
    clearMarkdownReadControlStates(sourceDocument);
    return;
  }
  setMarkdownReadControlState(sourceDocument, blockKey, "active");
}
