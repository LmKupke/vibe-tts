import {
  createRequestId,
  DEFAULT_READER_PREFERENCES,
  INITIAL_READER_SNAPSHOT,
  isExtensionMessage,
  isReaderBootstrap,
  type CatalogSnapshot,
  type ExtensionMessage,
  type MessageReply,
  type PanelCommand,
  type ReaderSnapshot,
  type ReaderPreferences,
} from "@vibe-tts/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const EMPTY_CATALOG: CatalogSnapshot = {
  providers: [
    {
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
    },
  ],
  voices: [],
  serverConnected: false,
};

interface ReaderPanelModel {
  snapshot: ReaderSnapshot;
  preferences: ReaderPreferences;
  catalog: CatalogSnapshot;
  busy: boolean;
  panelError: string | undefined;
  command: (command: PanelCommand) => Promise<boolean>;
  prepareAndPlay: (mode: "beginning" | "selection") => Promise<void>;
}

function replyData<T>(reply: unknown): T | undefined {
  if (typeof reply !== "object" || reply === null) return undefined;
  const typed = reply as MessageReply<T>;
  return typed.ok ? typed.data : undefined;
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

function isReaderPreferences(value: unknown): value is ReaderPreferences {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.playbackRate === "number" &&
    typeof candidate.providerId === "string" &&
    typeof candidate.autoScroll === "boolean" &&
    typeof candidate.serverUrl === "string"
  );
}

export function useReader(): ReaderPanelModel {
  const [snapshot, setSnapshot] = useState<ReaderSnapshot>(INITIAL_READER_SNAPSHOT);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_READER_PREFERENCES);
  const [catalog, setCatalog] = useState<CatalogSnapshot>(EMPTY_CATALOG);
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState<string>();
  const mounted = useRef(true);

  const send = useCallback(async (message: ExtensionMessage): Promise<unknown> => {
    return chrome.runtime.sendMessage(message);
  }, []);

  const command = useCallback(
    async (panelCommand: PanelCommand): Promise<boolean> => {
      setPanelError(undefined);
      setBusy(true);
      const message: ExtensionMessage = {
        type: "panel-command",
        requestId: createRequestId("panel"),
        source: "sidepanel",
        target: "background",
        command: panelCommand,
      };
      try {
        const rawReply = await send(message);
        const reply = rawReply as MessageReply<ReaderSnapshot> | undefined;
        if (reply && !reply.ok) {
          if (mounted.current)
            setPanelError(reply.error?.message ?? "The command could not be completed.");
          return false;
        }
        const nextSnapshot = replyData<unknown>(rawReply);
        if (isReaderSnapshot(nextSnapshot) && mounted.current) setSnapshot(nextSnapshot);
        if (isReaderPreferences(nextSnapshot) && mounted.current) setPreferences(nextSnapshot);
        return true;
      } catch (error) {
        if (mounted.current) {
          setPanelError(
            error instanceof Error ? error.message : "The extension service is unavailable.",
          );
        }
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [send],
  );

  const prepareAndPlay = useCallback(
    async (mode: "beginning" | "selection"): Promise<void> => {
      const prepared = await command({ type: "prepare", startMode: mode });
      if (prepared) await command({ type: "play" });
    },
    [command],
  );

  useEffect(() => {
    mounted.current = true;
    const listener = (rawMessage: unknown): undefined => {
      if (!isExtensionMessage(rawMessage) || rawMessage.target !== "sidepanel") return undefined;
      if (rawMessage.type === "reader-state") setSnapshot(rawMessage.snapshot);
      if (rawMessage.type === "catalog-update") setCatalog(rawMessage.catalog);
      return undefined;
    };
    chrome.runtime.onMessage.addListener(listener);

    const initialize = async (): Promise<void> => {
      const request: ExtensionMessage = {
        type: "request-state",
        requestId: createRequestId("state"),
        source: "sidepanel",
        target: "background",
      };
      try {
        const reply = await send(request);
        const state = replyData<unknown>(reply);
        if (!isReaderBootstrap(state) || !mounted.current) return;
        setSnapshot(state.snapshot);
        setPreferences(state.preferences);
        if (state.catalog) setCatalog(state.catalog);

        await command({ type: "refresh-providers" });
        if (
          mounted.current &&
          state.snapshot.status === "idle" &&
          !state.snapshot.sessionId &&
          state.snapshot.sentenceCount === 0
        ) {
          await command({ type: "prepare", startMode: "beginning" });
        }
      } catch {
        // Commands surface actionable connection errors; bootstrap is best effort.
      }
    };
    void initialize();

    return () => {
      mounted.current = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
    // Initial synchronization deliberately runs once per panel lifetime.
  }, [command, send]);

  return useMemo(
    () => ({ snapshot, preferences, catalog, busy, panelError, command, prepareAndPlay }),
    [snapshot, preferences, catalog, busy, panelError, command, prepareAndPlay],
  );
}
