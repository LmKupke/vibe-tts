import {
  INITIAL_READER_SNAPSHOT,
  createRequestId,
  isExtensionMessage,
  type CatalogSnapshot,
  type ContentCommand,
  type ContentResponse,
  type ExtensionMessage,
  type MessageReply,
  type OffscreenCommand,
  type PanelCommand,
  type ReaderBootstrap,
  type ReaderError,
  type ReaderPreferences,
  type ReaderSnapshot,
  type ReaderStartMode,
} from "@vibe-tts/shared";

import { ReaderPreferenceStore, normalizeServerUrl } from "../storage/preferences";
import {
  ensureOffscreenDocument,
  hasOffscreenDocument,
  isMessageReply,
  offscreenCommand,
  sendOffscreenMessage,
} from "./offscreen";
import {
  ServerPermissionError,
  hasServerPermission,
  removeServerPermission,
  requestServerPermission,
  serverOriginPattern,
} from "./permissions";

type PanelMessage = Extract<ExtensionMessage, { type: "panel-command" }>;
type PreparedContent = Extract<ContentResponse, { ok: true; type: "prepared" }>;
type PreparationCommand = Extract<ContentCommand, { type: "prepare" | "prepare-from-block" }>;
type TransportCommand = Extract<
  PanelCommand,
  {
    type:
      | "play"
      | "pause"
      | "resume"
      | "stop"
      | "previous-sentence"
      | "next-sentence"
      | "seek-sentence";
  }
>;

class CoordinatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function coordinatorErrorCode(error: unknown, fallback: string): string {
  if (error instanceof CoordinatorError || error instanceof ServerPermissionError) {
    return error.code;
  }
  return fallback;
}

function isReaderSnapshot(value: unknown): value is ReaderSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === "string" &&
    typeof candidate.currentSentenceIndex === "number" &&
    typeof candidate.sentenceCount === "number"
  );
}

function isCatalogSnapshot(value: unknown): value is CatalogSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.voices) &&
    typeof candidate.serverConnected === "boolean"
  );
}

function isPreparedContent(value: unknown): value is PreparedContent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true && candidate.type === "prepared" && isRecord(candidate.document);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSupportedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isFilePage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

function samePageIgnoringHash(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left.split("#")[0] === right.split("#")[0];
  }
}

const INLINE_BLOCK_KEY_PATTERN = /^md-[0-9]{1,6}$/u;

function readerErrorCode(code: string): ReaderError["code"] {
  switch (code) {
    case "unsupported-page":
    case "file-access-denied":
    case "empty-document":
    case "content-unavailable":
    case "speech-unavailable":
    case "server-offline":
    case "provider-unavailable":
    case "model-loading-failed":
    case "synthesis-failed":
    case "malformed-alignment":
    case "audio-failed":
    case "navigation":
      return code;
    default:
      return "unknown";
  }
}

export class BackgroundCoordinator {
  readonly #preferences = new ReaderPreferenceStore();
  #lastSnapshot: ReaderSnapshot = { ...INITIAL_READER_SNAPSHOT };
  #lastCatalog: CatalogSnapshot | undefined;
  #sessionTabId: number | undefined;
  #stateRecovery: Promise<void> | undefined;
  #inlineReadRevision = 0;
  readonly #stateWaiters = new Set<(tabId: number | undefined) => void>();
  readonly #terminatingTabs = new Set<number>();

  start(): void {
    chrome.runtime.onMessage.addListener(this.#onMessage);
    chrome.action.onClicked.addListener(this.#onActionClicked);
    chrome.commands.onCommand.addListener(this.#onCommand);
    chrome.tabs.onUpdated.addListener(this.#onTabUpdated);
    chrome.tabs.onRemoved.addListener(this.#onTabRemoved);
  }

  #onMessage = (
    rawMessage: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageReply<unknown>) => void,
  ): boolean | undefined => {
    if (!isExtensionMessage(rawMessage) || rawMessage.target !== "background") return undefined;
    if (sender.id && sender.id !== chrome.runtime.id) return undefined;
    void this.#handleMessage(rawMessage, sender).then(
      (response) => sendResponse(response),
      (error: unknown) => {
        const hasExistingSession =
          this.#lastSnapshot.sessionId !== undefined && this.#lastSnapshot.sentenceCount > 0;
        if (
          rawMessage.type === "read-from-block" ||
          (rawMessage.type === "panel-command" &&
            (rawMessage.command.type === "play" ||
              (rawMessage.command.type === "prepare" && !hasExistingSession)))
        ) {
          void this.#publishError(
            coordinatorErrorCode(error, "speech-unavailable"),
            errorMessage(error, "Reading could not be started."),
          );
        }
        sendResponse(
          this.#errorReply(
            rawMessage.requestId,
            coordinatorErrorCode(error, "background-error"),
            errorMessage(error, "The extension could not complete that request."),
          ),
        );
      },
    );
    // Chrome 120 requires the callback channel to be kept alive explicitly.
    return true;
  };

  #onActionClicked = (tab: chrome.tabs.Tab): void => {
    void this.#activate(tab).catch((error: unknown) => {
      void this.#publishError(
        coordinatorErrorCode(error, "content-unavailable"),
        errorMessage(error, "This page cannot be read by the extension."),
      );
    });
  };

  #onCommand = (command: string): void => {
    void this.#handleKeyboardCommand(command).catch((error: unknown) => {
      void this.#publishError(
        coordinatorErrorCode(error, "speech-unavailable"),
        errorMessage(error, "The keyboard command could not be completed."),
      );
    });
  };

  #onTabUpdated = (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void => {
    if (changeInfo.status !== "loading" && changeInfo.url === undefined) return;
    void this.#handlePotentialNavigation(
      tabId,
      "The page navigated while it was being read.",
      true,
      changeInfo.status === "loading" ? undefined : changeInfo.url,
    );
  };

  #onTabRemoved = (tabId: number): void => {
    void this.#handlePotentialNavigation(tabId, "The page being read was closed.", false);
  };

  async #handlePotentialNavigation(
    tabId: number,
    message: string,
    clearContent: boolean,
    hashCandidateUrl?: string,
  ): Promise<void> {
    if (
      hashCandidateUrl &&
      this.#lastSnapshot.documentUrl &&
      samePageIgnoringHash(hashCandidateUrl, this.#lastSnapshot.documentUrl)
    ) {
      return;
    }
    this.#cancelInlineReads();
    if (this.#sessionTabId === undefined) await this.#recoverStateFromOffscreen();
    if (this.#sessionTabId !== tabId) return;
    await this.#terminateSession(tabId, message, clearContent);
  }

  async #handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<MessageReply<unknown>> {
    const requestId = message.requestId;
    switch (message.type) {
      case "panel-command":
        return this.#handlePanelCommand(message);
      case "request-state":
        return this.#handleStateRequest(message.requestId);
      case "reader-state":
        if (
          message.snapshot.providerId === "browser" &&
          this.#lastSnapshot.providerId !== "browser" &&
          message.snapshot.error
        ) {
          const preferences = await this.#preferences.get();
          if (preferences.providerId !== "browser") {
            await this.#preferences.update({ providerId: "browser", voiceId: undefined });
          }
        }
        this.#lastSnapshot = message.snapshot;
        if (message.tabId !== undefined) this.#sessionTabId = message.tabId;
        for (const waiter of this.#stateWaiters) waiter(message.tabId);
        this.#stateWaiters.clear();
        if (
          message.snapshot.status === "idle" &&
          !message.snapshot.sessionId &&
          message.snapshot.sentenceCount === 0
        ) {
          this.#sessionTabId = undefined;
        }
        await this.#broadcastState(message.snapshot, message.tabId);
        return this.#okReply(message.requestId);
      case "highlight-update":
        await this.#routeHighlight(message);
        return this.#okReply(message.requestId);
      case "catalog-update":
        this.#lastCatalog = message.catalog;
        await this.#broadcastCatalog(message.catalog);
        return this.#okReply(message.requestId);
      case "read-from-block":
        return this.#handleReadFromBlock(message, sender);
      case "page-changed": {
        const tabId = sender.tab?.id ?? message.tabId;
        if (tabId === undefined) {
          return this.#errorReply(
            message.requestId,
            "missing-tab",
            "The page change could not be associated with a browser tab.",
          );
        }
        this.#cancelInlineReads();
        if (this.#sessionTabId === undefined) await this.#recoverStateFromOffscreen();
        if (this.#sessionTabId === tabId) {
          await this.#terminateSession(tabId, "The page changed while it was being read.", true);
        }
        return this.#okReply(message.requestId);
      }
      case "page-invalidated": {
        const tabId = sender.tab?.id ?? message.tabId;
        if (tabId === undefined) {
          return this.#errorReply(
            message.requestId,
            "missing-tab",
            "The changed content could not be associated with a browser tab.",
          );
        }
        this.#cancelInlineReads();
        if (this.#sessionTabId === undefined) await this.#recoverStateFromOffscreen();
        if (this.#sessionTabId === tabId) {
          if (message.reason === "view-mode-changed") {
            await this.#stopAndClear();
          } else {
            await this.#terminateSession(
              tabId,
              "The readable page content changed while it was being read.",
              true,
            );
          }
        }
        return this.#okReply(message.requestId);
      }
      default:
        return this.#errorReply(
          requestId,
          "invalid-message",
          "The background worker received a message for the wrong context.",
        );
    }
  }

  async #handleReadFromBlock(
    message: Extract<ExtensionMessage, { type: "read-from-block" }>,
    sender: chrome.runtime.MessageSender,
  ): Promise<MessageReply<unknown>> {
    const tab = sender.tab;
    if (tab?.id === undefined) {
      return this.#errorReply(
        message.requestId,
        "missing-tab",
        "The reading position could not be associated with a browser tab.",
      );
    }
    if (typeof message.blockKey !== "string" || !INLINE_BLOCK_KEY_PATTERN.test(message.blockKey)) {
      return this.#errorReply(
        message.requestId,
        "invalid-block-key",
        "Choose a valid paragraph or heading to read from.",
      );
    }
    if (typeof message.url !== "string" || !isSupportedPage(message.url)) {
      return this.#errorReply(
        message.requestId,
        "unsupported-page",
        "Chrome does not allow this page to be read.",
      );
    }
    if (tab.url && !samePageIgnoringHash(tab.url, message.url)) {
      return this.#errorReply(
        message.requestId,
        "stale-page",
        "The page changed before reading could begin.",
      );
    }

    const revision = ++this.#inlineReadRevision;
    const isCurrent = (): boolean => revision === this.#inlineReadRevision;
    const sourceTab: chrome.tabs.Tab = tab.url ? tab : { ...tab, url: message.url };
    try {
      await this.#prepare(
        sourceTab,
        "here",
        true,
        undefined,
        { type: "prepare-from-block", blockKey: message.blockKey },
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) return this.#okReply(message.requestId);
      throw error;
    }
    return this.#okReply(message.requestId);
  }

  async #activate(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id === undefined) {
      throw new CoordinatorError(
        "unsupported-page",
        "The active browser tab could not be identified.",
      );
    }
    // This begins directly in the action handler so sidePanel.open retains the user gesture.
    const panelPromise = chrome.sidePanel.open({ tabId: tab.id });
    if (!isSupportedPage(tab.url)) {
      try {
        await panelPromise;
      } catch (error) {
        throw new CoordinatorError(
          "side-panel-unavailable",
          errorMessage(error, "The reader panel could not be opened."),
        );
      }
      throw new CoordinatorError(
        "unsupported-page",
        "Chrome does not allow this page to be read. Open a regular webpage and try again.",
      );
    }
    await this.#assertFileSchemeAccess(tab.url);
    // Content injection also starts within the action event's user-activation window.
    const contentPromise = this.#ensureContent(tab.id);
    const activationResults = Promise.allSettled([panelPromise, contentPromise]);
    if (this.#sessionTabId !== undefined && this.#sessionTabId !== tab.id) {
      await this.#terminateSession(
        this.#sessionTabId,
        "Reading moved to a different browser tab.",
        true,
      );
    }
    const [panelResult, contentResult] = await activationResults;
    if (contentResult.status === "rejected") throw contentResult.reason;
    if (panelResult.status === "rejected") {
      throw new CoordinatorError(
        "side-panel-unavailable",
        errorMessage(panelResult.reason, "The reader panel could not be opened."),
      );
    }
  }

  async #handlePanelCommand(message: PanelMessage): Promise<MessageReply<unknown>> {
    const command = message.command;
    switch (command.type) {
      case "prepare": {
        this.#cancelInlineReads();
        const tab = await this.#activeTab();
        await this.#prepare(tab, command.startMode, false);
        return this.#okReply(message.requestId);
      }
      case "play":
      case "pause":
      case "resume":
      case "previous-sentence":
      case "next-sentence":
      case "seek-sentence":
      case "stop":
        await this.#executeTransport(command);
        return this.#okReply(message.requestId);
      case "set-rate": {
        const preferences = await this.#preferences.update({ playbackRate: command.rate });
        await this.#publishPreferences(preferences);
        await this.#sendIfOffscreenExists({ type: "set-rate", rate: preferences.playbackRate });
        return this.#okReply(message.requestId, preferences);
      }
      case "set-auto-scroll": {
        const preferences = await this.#preferences.update({ autoScroll: command.enabled });
        await this.#publishPreferences(preferences);
        await this.#sendIfOffscreenExists({
          type: "set-auto-scroll",
          enabled: preferences.autoScroll,
        });
        if (this.#sessionTabId !== undefined) {
          await this.#sendContentCommand(this.#sessionTabId, {
            type: "set-auto-scroll",
            enabled: preferences.autoScroll,
          }).catch(() => undefined);
        }
        return this.#okReply(message.requestId, preferences);
      }
      case "set-voice": {
        const preferences = await this.#preferences.update({ voiceId: command.voiceId });
        await this.#publishPreferences(preferences);
        await this.#sendIfOffscreenExists({
          type: "set-voice",
          ...(command.voiceId === undefined ? {} : { voiceId: command.voiceId }),
        });
        return this.#okReply(message.requestId, preferences);
      }
      case "set-provider": {
        const preferences = await this.#setProvider(command.providerId);
        return this.#okReply(message.requestId, preferences);
      }
      case "set-server-url": {
        let serverUrl: string;
        try {
          serverUrl = normalizeServerUrl(command.serverUrl);
        } catch (error) {
          throw new CoordinatorError(
            "invalid-server-url",
            errorMessage(error, "Choose a valid HTTP or HTTPS neural server URL."),
          );
        }
        const previous = await this.#preferences.get();
        const preferences = await this.#preferences.update({ serverUrl });
        try {
          await requestServerPermission(preferences.serverUrl);
        } catch (error) {
          if (preferences.providerId !== "browser") {
            await this.#fallBackToBrowser(
              preferences.serverUrl,
              errorMessage(error, "Neural server access was not granted."),
            );
          } else {
            await this.#publishServerError(
              errorMessage(error, "Neural server access was not granted."),
            );
          }
          throw error;
        }
        if (
          serverOriginPattern(previous.serverUrl) !== serverOriginPattern(preferences.serverUrl)
        ) {
          await removeServerPermission(previous.serverUrl).catch(() => undefined);
        }
        if (preferences.providerId !== "browser") {
          await this.#sendIfOffscreenExists({
            type: "set-provider",
            providerId: preferences.providerId,
            serverUrl: preferences.serverUrl,
          });
        }
        const catalog = await this.#sendOffscreenChecked<CatalogSnapshot>({
          type: "get-catalog",
          serverUrl: preferences.serverUrl,
        });
        if (isCatalogSnapshot(catalog)) {
          this.#lastCatalog = catalog;
          await this.#broadcastCatalog(catalog);
        }
        return this.#okReply(message.requestId, preferences);
      }
      case "refresh-providers": {
        const preferences = await this.#preferences.get();
        if (preferences.providerId !== "browser") {
          await requestServerPermission(preferences.serverUrl);
        }
        const catalog = await this.#sendOffscreenChecked<CatalogSnapshot>({
          type: "get-catalog",
          serverUrl: preferences.serverUrl,
        });
        if (isCatalogSnapshot(catalog)) {
          this.#lastCatalog = catalog;
          await this.#broadcastCatalog(catalog);
        }
        return this.#okReply(message.requestId);
      }
    }
  }

  async #setProvider(providerId: string): Promise<ReaderPreferences> {
    const requestedProvider = providerId.trim();
    if (!requestedProvider) {
      throw new CoordinatorError("invalid-provider", "Choose a valid speech provider.");
    }
    const current = await this.#preferences.get();
    if (requestedProvider !== "browser") {
      try {
        await requestServerPermission(current.serverUrl);
      } catch (error) {
        await this.#fallBackToBrowser(
          current.serverUrl,
          errorMessage(error, "Neural server access was not granted."),
        );
        throw error;
      }
    }
    const preferences = await this.#preferences.update({
      providerId: requestedProvider,
      voiceId: undefined,
    });
    await this.#publishPreferences(preferences);
    try {
      await this.#sendIfOffscreenExists({
        type: "set-provider",
        providerId: preferences.providerId,
        serverUrl: preferences.serverUrl,
      });
    } catch (error) {
      if (requestedProvider !== "browser") {
        await this.#fallBackToBrowser(
          preferences.serverUrl,
          errorMessage(error, "The neural provider could not be activated."),
        );
      }
      throw error;
    }
    return preferences;
  }

  async #prepare(
    tab: chrome.tabs.Tab,
    startMode: ReaderStartMode,
    play: boolean,
    restoreSession?: "beginning" | "current",
    preparationCommand?: PreparationCommand,
    isCurrent: () => boolean = () => true,
  ): Promise<PreparedContent | undefined> {
    if (!isCurrent()) return undefined;
    if (tab.id === undefined || !isSupportedPage(tab.url)) {
      throw new CoordinatorError(
        "unsupported-page",
        "Chrome does not allow this page to be read. Open a regular webpage and try again.",
      );
    }
    await this.#assertFileSchemeAccess(tab.url);
    if (!isCurrent()) return undefined;
    if (this.#sessionTabId !== undefined && this.#sessionTabId !== tab.id) {
      await this.#terminateSession(
        this.#sessionTabId,
        "Reading moved to a different browser tab.",
        true,
      );
    }
    if (!isCurrent()) return undefined;
    let preferences = await this.#preferences.get();
    if (!isCurrent()) return undefined;
    await this.#ensureContent(tab.id);
    if (!isCurrent()) return undefined;
    await this.#sendContentCommand(tab.id, {
      type: "set-auto-scroll",
      enabled: preferences.autoScroll,
    });
    if (!isCurrent()) return undefined;
    const contentResponse = await this.#sendContentCommand(
      tab.id,
      preparationCommand ?? {
        type: "prepare",
        startMode,
        ...(restoreSession === undefined ? {} : { restoreSession }),
      },
    );
    if (!isCurrent()) return undefined;
    if (!isPreparedContent(contentResponse)) {
      if (isRecord(contentResponse) && contentResponse.ok === false) {
        throw new CoordinatorError(
          typeof contentResponse.code === "string" ? contentResponse.code : "content-unavailable",
          typeof contentResponse.message === "string"
            ? contentResponse.message
            : "The page did not return readable content.",
        );
      }
      throw new CoordinatorError(
        "content-unavailable",
        "The page returned an invalid reading document.",
      );
    }

    this.#lastSnapshot = {
      ...INITIAL_READER_SNAPSHOT,
      status: "preparing",
      playbackRate: preferences.playbackRate,
      providerId: preferences.providerId,
      autoScroll: preferences.autoScroll,
      startMode,
      ...(preferences.voiceId === undefined ? {} : { voiceId: preferences.voiceId }),
    };
    await this.#broadcastState(this.#lastSnapshot, tab.id);
    if (!isCurrent()) return undefined;

    if (preferences.providerId !== "browser") {
      try {
        await requestServerPermission(preferences.serverUrl);
      } catch (error) {
        preferences = await this.#fallBackToBrowser(
          preferences.serverUrl,
          errorMessage(error, "Neural server access was not granted."),
        );
        if (!(error instanceof ServerPermissionError)) throw error;
      }
    }
    if (!isCurrent()) return undefined;
    await ensureOffscreenDocument();
    if (!isCurrent()) return undefined;
    const load: OffscreenCommand = {
      type: "load",
      tabId: tab.id,
      document: contentResponse.document,
      startSentenceIndex: contentResponse.startSentenceIndex,
      preferences,
      ...(contentResponse.selection === undefined ? {} : { selection: contentResponse.selection }),
    };
    try {
      await this.#sendOffscreenChecked(load);
    } catch (error) {
      if (preferences.providerId === "browser") throw error;
      preferences = await this.#fallBackToBrowser(
        preferences.serverUrl,
        errorMessage(error, "The neural provider was unavailable; browser speech will be used."),
      );
      await this.#sendOffscreenChecked({ ...load, preferences });
    }
    if (!isCurrent()) return undefined;
    this.#sessionTabId = tab.id;
    if (play) await this.#sendOffscreenChecked({ type: "play" });
    return contentResponse;
  }

  async #activeTab(): Promise<chrome.tabs.Tab> {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab) throw new CoordinatorError("missing-tab", "No active browser tab was found.");
    return tab;
  }

  async #assertFileSchemeAccess(url: string | undefined): Promise<void> {
    if (!isFilePage(url)) return;

    // The API is available in supported Chrome builds. Keeping this guard lets
    // partial browser/test shims fall through to the normal injection error.
    if (typeof chrome.extension?.isAllowedFileSchemeAccess !== "function") return;

    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      throw new CoordinatorError(
        "file-access-denied",
        "Local file access is off. Open Manage Extension, enable ‘Allow access to file URLs,’ reload this file, and try again.",
      );
    }
  }

  async #ensureContent(tabId: number): Promise<void> {
    try {
      const response = await this.#sendContentCommand(tabId, { type: "ping" });
      if (isRecord(response) && response.ok === true && response.type === "pong") {
        await this.#ensureMermaid(tabId, response);
        return;
      }
    } catch {
      // A missing receiver is expected before the first injection.
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const response = await this.#sendContentCommand(tabId, { type: "ping" });
      if (!isRecord(response) || response.ok !== true || response.type !== "pong") {
        throw new Error("The content script did not start correctly.");
      }
      await this.#ensureMermaid(tabId, response);
    } catch (error) {
      throw new CoordinatorError(
        "content-unavailable",
        `This page cannot be read by the extension. ${errorMessage(error, "Content access failed.")}`,
      );
    }
  }

  async #ensureMermaid(tabId: number, response: Record<string, unknown>): Promise<void> {
    if (response.needsMermaid !== true) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["mermaid.js"],
      world: "ISOLATED",
    });
  }

  async #sendContentCommand(tabId: number, command: ContentCommand): Promise<ContentResponse> {
    const message: Extract<ExtensionMessage, { type: "content-command" }> = {
      type: "content-command",
      requestId: createRequestId("background-content"),
      source: "background",
      target: "content",
      command,
    };
    const response: unknown = await chrome.tabs.sendMessage(tabId, message);
    if (!isMessageReply(response) || response.requestId !== message.requestId) {
      throw new CoordinatorError(
        "content-unavailable",
        "The page returned an invalid content-script response.",
      );
    }
    if (!response.ok) {
      throw new CoordinatorError(
        response.error?.code ?? "content-unavailable",
        response.error?.message ?? "The page could not complete the reader command.",
      );
    }
    if (response.data === undefined) {
      throw new CoordinatorError(
        "content-unavailable",
        "The page did not return a content-script response.",
      );
    }
    return response.data as ContentResponse;
  }

  async #sendOffscreenChecked<T = unknown>(
    command: OffscreenCommand,
    create = true,
  ): Promise<T | undefined> {
    let response: MessageReply<T>;
    try {
      response = await sendOffscreenMessage<T>(offscreenCommand(command), create);
    } catch (error) {
      throw new CoordinatorError(
        "speech-unavailable",
        errorMessage(error, "The playback context is unavailable."),
      );
    }
    if (!response.ok) {
      throw new CoordinatorError(
        response.error?.code ?? "speech-unavailable",
        response.error?.message ?? "The playback context could not complete the command.",
      );
    }
    return response.data;
  }

  async #sendIfOffscreenExists(command: OffscreenCommand): Promise<void> {
    if (!(await hasOffscreenDocument())) return;
    await this.#sendOffscreenChecked(command, false);
  }

  async #hasLoadedSession(): Promise<boolean> {
    if (!(await hasOffscreenDocument())) {
      await this.#clearStaleSessionState();
      return false;
    }
    await this.#recoverStateFromOffscreen();
    return this.#sessionTabId !== undefined && this.#lastSnapshot.sentenceCount > 0;
  }

  async #executeTransport(command: TransportCommand): Promise<void> {
    this.#cancelInlineReads();
    if (command.type === "stop") {
      await this.#stopAndClear();
      return;
    }

    const previousSnapshot = { ...this.#lastSnapshot };
    const previousTabId = this.#sessionTabId;
    if (await this.#hasLoadedSession()) {
      await this.#sendOffscreenChecked(command, false);
      return;
    }

    const hadSession =
      previousTabId !== undefined &&
      previousSnapshot.sessionId !== undefined &&
      previousSnapshot.sentenceCount > 0;
    if (command.type === "pause" && !hadSession) return;

    const recovery = await this.#tabForRecovery(previousTabId);
    const canRestore = hadSession && recovery.sameSessionTab;
    const restartCompleted =
      canRestore &&
      previousSnapshot.status === "completed" &&
      (command.type === "play" || command.type === "resume");
    const startMode: ReaderStartMode = canRestore && !restartCompleted ? "here" : "beginning";
    const restoreSession = canRestore ? (restartCompleted ? "beginning" : "current") : undefined;
    await this.#prepare(recovery.tab, startMode, false, restoreSession);

    if (command.type === "pause") return;
    if (command.type === "play" || command.type === "resume") {
      await this.#sendOffscreenChecked({ type: "play" }, false);
      return;
    }

    await this.#sendOffscreenChecked(command, false);
    if (previousSnapshot.status === "playing" || previousSnapshot.status === "buffering") {
      await this.#sendOffscreenChecked({ type: "play" }, false);
    }
  }

  #cancelInlineReads(): void {
    this.#inlineReadRevision += 1;
  }

  async #tabForRecovery(
    preferredTabId: number | undefined,
  ): Promise<{ tab: chrome.tabs.Tab; sameSessionTab: boolean }> {
    if (preferredTabId !== undefined) {
      try {
        const tab = await chrome.tabs.get(preferredTabId);
        if (tab.id === preferredTabId && isSupportedPage(tab.url)) {
          return { tab, sameSessionTab: true };
        }
      } catch {
        // The old tab may have closed while the offscreen document was expiring.
      }
    }
    return { tab: await this.#activeTab(), sameSessionTab: false };
  }

  async #clearStaleSessionState(): Promise<void> {
    this.#sessionTabId = undefined;
    const preferences = await this.#preferences.get();
    this.#lastSnapshot = this.#applyPreferences({ ...INITIAL_READER_SNAPSHOT }, preferences);
  }

  async #recoverStateFromOffscreen(): Promise<void> {
    if (this.#stateRecovery) return this.#stateRecovery;
    this.#stateRecovery = (async () => {
      if (!(await hasOffscreenDocument())) {
        await this.#clearStaleSessionState();
        return;
      }
      const stateEvent = this.#waitForStateEvent();
      try {
        const data = await this.#sendOffscreenChecked<unknown>({ type: "get-state" }, false);
        if (isReaderSnapshot(data)) {
          this.#lastSnapshot = data;
        } else if (isRecord(data)) {
          if (isReaderSnapshot(data.snapshot)) this.#lastSnapshot = data.snapshot;
          if (typeof data.tabId === "number") this.#sessionTabId = data.tabId;
        }
        if (this.#lastSnapshot.sessionId && this.#sessionTabId === undefined) {
          const recoveredTabId = await stateEvent;
          if (recoveredTabId !== undefined) this.#sessionTabId = recoveredTabId;
        }
        if (!this.#lastSnapshot.sessionId || this.#lastSnapshot.sentenceCount === 0) {
          this.#sessionTabId = undefined;
        }
      } catch {
        await this.#clearStaleSessionState();
      }
    })();
    try {
      await this.#stateRecovery;
    } finally {
      this.#stateRecovery = undefined;
    }
  }

  #waitForStateEvent(): Promise<number | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (tabId: number | undefined): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        this.#stateWaiters.delete(finish);
        resolve(tabId);
      };
      const timer = globalThis.setTimeout(() => finish(undefined), 250);
      this.#stateWaiters.add(finish);
    });
  }

  async #handleStateRequest(requestId: string): Promise<MessageReply<ReaderBootstrap>> {
    await this.#recoverStateFromOffscreen();
    let preferences = await this.#preferences.get();
    if (
      preferences.providerId !== "browser" &&
      !(await hasServerPermission(preferences.serverUrl))
    ) {
      preferences = await this.#fallBackToBrowser(
        preferences.serverUrl,
        "Neural server permission is no longer available; browser speech will be used.",
      );
    }
    if (!this.#lastSnapshot.sessionId || this.#lastSnapshot.sentenceCount === 0) {
      this.#lastSnapshot = this.#applyPreferences(this.#lastSnapshot, preferences);
    }
    await this.#broadcastState(this.#lastSnapshot, this.#sessionTabId);
    if (!this.#lastCatalog && (await hasOffscreenDocument())) {
      try {
        const catalog = await this.#sendOffscreenChecked<CatalogSnapshot>(
          { type: "get-catalog", serverUrl: preferences.serverUrl },
          false,
        );
        if (isCatalogSnapshot(catalog)) this.#lastCatalog = catalog;
      } catch {
        // The snapshot remains useful when catalog refresh is temporarily unavailable.
      }
    }
    if (this.#lastCatalog) await this.#broadcastCatalog(this.#lastCatalog);
    const bootstrap: ReaderBootstrap = {
      snapshot: this.#lastSnapshot,
      preferences,
      ...(this.#lastCatalog === undefined ? {} : { catalog: this.#lastCatalog }),
    };
    return this.#okReply(requestId, bootstrap);
  }

  async #routeHighlight(
    message: Extract<ExtensionMessage, { type: "highlight-update" }>,
  ): Promise<void> {
    const command: ContentCommand =
      message.clear || !message.blockId || !message.sentenceId
        ? { type: "clear-highlights" }
        : {
            type: "highlight",
            blockId: message.blockId,
            sentenceId: message.sentenceId,
            ...(message.wordId === undefined ? {} : { wordId: message.wordId }),
            ...(message.sourceStart === undefined ? {} : { sourceStart: message.sourceStart }),
            ...(message.sourceEnd === undefined ? {} : { sourceEnd: message.sourceEnd }),
            ...(message.wordStart === undefined ? {} : { wordStart: message.wordStart }),
            ...(message.wordEnd === undefined ? {} : { wordEnd: message.wordEnd }),
          };
    try {
      await this.#sendContentCommand(message.tabId, command);
    } catch (error) {
      if (message.clear) return;
      const pageError: ReaderError = {
        code: "content-unavailable",
        message: `Narration stopped because the page text mapping is no longer available. ${errorMessage(
          error,
          "Reload the page and try again.",
        )}`,
        recoverable: true,
      };
      try {
        await this.#sendOffscreenChecked({ type: "page-error", error: pageError }, false);
      } catch {
        await this.#publishError(pageError.code, pageError.message);
      }
    }
  }

  async #broadcastState(snapshot: ReaderSnapshot, tabId?: number): Promise<void> {
    const message: Extract<ExtensionMessage, { type: "reader-state" }> = {
      type: "reader-state",
      requestId: createRequestId("background-state"),
      source: "background",
      target: "sidepanel",
      snapshot,
      ...(tabId === undefined ? {} : { tabId }),
    };
    await chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  async #broadcastCatalog(catalog: CatalogSnapshot): Promise<void> {
    const message: Extract<ExtensionMessage, { type: "catalog-update" }> = {
      type: "catalog-update",
      requestId: createRequestId("background-catalog"),
      source: "background",
      target: "sidepanel",
      catalog,
    };
    await chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  async #publishError(code: string, message: string): Promise<void> {
    this.#lastSnapshot = {
      ...this.#lastSnapshot,
      status: "error",
      error: {
        code: readerErrorCode(code),
        message,
        recoverable: code !== "unsupported-page",
      },
    };
    await this.#broadcastState(this.#lastSnapshot, this.#sessionTabId);
  }

  async #fallBackToBrowser(serverUrl: string, serverError?: string): Promise<ReaderPreferences> {
    const preferences = await this.#preferences.update({
      providerId: "browser",
      voiceId: undefined,
    });
    await this.#publishPreferences(preferences);
    await this.#sendIfOffscreenExists({
      type: "set-provider",
      providerId: "browser",
      serverUrl,
    }).catch(() => undefined);
    if (serverError) await this.#publishServerError(serverError);
    return preferences;
  }

  async #publishServerError(message: string): Promise<void> {
    const previousProviders = this.#lastCatalog?.providers ?? [];
    const providers = previousProviders.map((provider) =>
      provider.id === "browser"
        ? provider
        : {
            ...provider,
            available: false,
            status: "unavailable" as const,
            detail: message,
          },
    );
    if (!providers.some((provider) => provider.id === "browser")) {
      providers.unshift({
        id: "browser",
        name: "Browser speech",
        available: true,
        local: true,
        status: "ready",
        capabilities: {
          streaming: true,
          voiceSelection: true,
          voiceCloning: false,
          voiceDesign: false,
          nativeAlignment: true,
        },
      });
    }
    this.#lastCatalog = {
      providers,
      voices: (this.#lastCatalog?.voices ?? []).filter((voice) => voice.providerId === "browser"),
      serverConnected: false,
      serverError: message,
    };
    await this.#broadcastCatalog(this.#lastCatalog);
  }

  async #stopAndClear(): Promise<void> {
    if (await hasOffscreenDocument()) {
      await this.#sendOffscreenChecked({ type: "stop" }, false).catch(() => undefined);
    }
    if (this.#sessionTabId !== undefined) {
      await this.#sendContentCommand(this.#sessionTabId, {
        type: "clear-highlights",
        resetSession: true,
      }).catch(() => undefined);
    }
    this.#sessionTabId = undefined;
    const preferences = await this.#preferences.get();
    this.#lastSnapshot = this.#applyPreferences({ ...INITIAL_READER_SNAPSHOT }, preferences);
    await this.#broadcastState(this.#lastSnapshot);
  }

  async #terminateSession(tabId: number, message: string, clearContent: boolean): Promise<void> {
    if (this.#terminatingTabs.has(tabId)) return;
    this.#terminatingTabs.add(tabId);
    try {
      if (await hasOffscreenDocument()) {
        await this.#sendOffscreenChecked({ type: "stop" }, false).catch(() => undefined);
      }
      if (clearContent) {
        await this.#sendContentCommand(tabId, {
          type: "clear-highlights",
          resetSession: true,
        }).catch(() => undefined);
      }
      this.#sessionTabId = undefined;
      const preferences = await this.#preferences.get();
      this.#lastSnapshot = this.#applyPreferences(
        {
          ...INITIAL_READER_SNAPSHOT,
          status: "error",
          error: { code: "navigation", message, recoverable: true },
        },
        preferences,
      );
      await this.#broadcastState(this.#lastSnapshot);
    } finally {
      this.#terminatingTabs.delete(tabId);
    }
  }

  async #handleKeyboardCommand(command: string): Promise<void> {
    switch (command) {
      case "toggle-playback": {
        if (await hasOffscreenDocument()) await this.#recoverStateFromOffscreen();
        if (this.#lastSnapshot.status === "playing" || this.#lastSnapshot.status === "buffering") {
          await this.#executeTransport({ type: "pause" });
          return;
        }
        if (this.#lastSnapshot.status === "paused" && this.#sessionTabId !== undefined) {
          await this.#executeTransport({ type: "resume" });
          return;
        }
        await this.#executeTransport({ type: "play" });
        return;
      }
      case "previous-sentence":
        await this.#executeTransport({ type: "previous-sentence" });
        return;
      case "next-sentence":
        await this.#executeTransport({ type: "next-sentence" });
        return;
      case "stop-reading":
        await this.#executeTransport({ type: "stop" });
        return;
      default:
        throw new CoordinatorError("unknown-command", `Unknown keyboard command: ${command}`);
    }
  }

  #okReply<T>(requestId: string, data?: T): MessageReply<T> {
    return data === undefined ? { ok: true, requestId } : { ok: true, requestId, data };
  }

  #errorReply(requestId: string, code: string, message: string): MessageReply<never> {
    return { ok: false, requestId, error: { code, message } };
  }

  #applyPreferences(snapshot: ReaderSnapshot, preferences: ReaderPreferences): ReaderSnapshot {
    const next: ReaderSnapshot = {
      ...snapshot,
      playbackRate: preferences.playbackRate,
      providerId: preferences.providerId,
      autoScroll: preferences.autoScroll,
    };
    delete next.voiceId;
    if (preferences.voiceId !== undefined) next.voiceId = preferences.voiceId;
    return next;
  }

  async #publishPreferences(preferences: ReaderPreferences): Promise<void> {
    this.#lastSnapshot = this.#applyPreferences(this.#lastSnapshot, preferences);
    await this.#broadcastState(this.#lastSnapshot, this.#sessionTabId);
  }
}
