import type { PanelCommand, ReaderSnapshot } from "@vibe-tts/shared";
import { useId, useMemo, useState, type CSSProperties, type JSX } from "react";

import {
  ChevronIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  RefreshIcon,
  SelectionIcon,
  StopIcon,
  VolumeIcon,
} from "./icons";
import { useReader } from "./use-reader";

function statusCopy(snapshot: ReaderSnapshot): string {
  switch (snapshot.status) {
    case "idle":
      return "Ready when you are";
    case "preparing":
      return "Finding the readable text";
    case "buffering":
      return "Preparing the next sentence";
    case "playing":
      return "Reading now";
    case "paused":
      return "Paused";
    case "completed":
      return "Finished";
    case "error":
      return "Needs attention";
  }
}

function sentenceProgress(snapshot: ReaderSnapshot): number {
  if (snapshot.sentenceCount <= 1) return 0;
  return Math.round((snapshot.currentSentenceIndex / (snapshot.sentenceCount - 1)) * 100);
}

function TransportButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="transport__secondary"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function App(): JSX.Element {
  const { snapshot, preferences, catalog, busy, panelError, command, prepareAndPlay } = useReader();
  const [serverUrlDraft, setServerUrlDraft] = useState<string>();
  const serverUrl = serverUrlDraft ?? preferences.serverUrl;
  const providerId = snapshot.providerId;
  const voices = useMemo(
    () => catalog.voices.filter((voice) => voice.providerId === providerId),
    [catalog.voices, providerId],
  );
  const titleId = useId();
  const isPlaying = snapshot.status === "playing" || snapshot.status === "buffering";
  const canNavigate = snapshot.sentenceCount > 0 && snapshot.status !== "preparing";
  const progress = sentenceProgress(snapshot);

  const primaryAction = (): void => {
    if (isPlaying) {
      void command({ type: "pause" });
    } else if (snapshot.status === "paused") {
      void command({ type: "resume" });
    } else if (snapshot.status === "completed") {
      void prepareAndPlay("beginning");
    } else {
      void command({ type: "play" });
    }
  };

  const setVoice = (voiceId: string): void => {
    const next: PanelCommand = voiceId ? { type: "set-voice", voiceId } : { type: "set-voice" };
    void command(next);
  };

  return (
    <main className="panel" aria-labelledby={titleId} data-reader-state={snapshot.status}>
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="masthead__copy">
          <p className="product-name">Vibe TTS</p>
          <h1 id={titleId}>{snapshot.documentTitle || "Read with the page"}</h1>
        </div>
        <span className={`status-dot status-dot--${snapshot.status}`} aria-hidden="true" />
      </header>

      <section className="transport" aria-label="Playback controls">
        <div className="transport__status" aria-live="polite">
          <span>{statusCopy(snapshot)}</span>
          <span className="transport__count tabular">
            {snapshot.sentenceCount > 0
              ? `${Math.min(snapshot.currentSentenceIndex + 1, snapshot.sentenceCount)} / ${snapshot.sentenceCount}`
              : "— / —"}
          </span>
        </div>

        <label className="seek">
          <span className="sr-only">Seek by sentence</span>
          <input
            type="range"
            min="0"
            max={Math.max(0, snapshot.sentenceCount - 1)}
            value={Math.min(snapshot.currentSentenceIndex, Math.max(0, snapshot.sentenceCount - 1))}
            style={{ "--seek-progress": `${progress}%` } as CSSProperties}
            onChange={(event) =>
              void command({ type: "seek-sentence", sentenceIndex: Number(event.target.value) })
            }
            disabled={!canNavigate}
            aria-valuetext={
              snapshot.sentenceCount > 0
                ? `Sentence ${snapshot.currentSentenceIndex + 1} of ${snapshot.sentenceCount}`
                : "No readable sentences"
            }
          />
        </label>

        <div className="transport__controls">
          <TransportButton
            label="Previous sentence"
            onClick={() => void command({ type: "previous-sentence" })}
            disabled={!canNavigate || snapshot.currentSentenceIndex === 0}
          >
            <PreviousIcon />
          </TransportButton>
          <button
            className="transport__primary"
            type="button"
            aria-label={isPlaying ? "Pause reading" : "Play reading"}
            onClick={primaryAction}
            disabled={busy || snapshot.status === "preparing"}
          >
            <span className="transport__pulse" aria-hidden="true" />
            {isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={31} />}
          </button>
          <TransportButton
            label="Next sentence"
            onClick={() => void command({ type: "next-sentence" })}
            disabled={!canNavigate || snapshot.currentSentenceIndex >= snapshot.sentenceCount - 1}
          >
            <NextIcon />
          </TransportButton>
          <TransportButton
            label="Stop reading"
            onClick={() => void command({ type: "stop" })}
            disabled={snapshot.status === "idle"}
          >
            <StopIcon />
          </TransportButton>
        </div>
      </section>

      <section className="now-reading" aria-label="Current reading position">
        <p className="now-reading__label">
          <span className="live-marker" aria-hidden="true" />
          On the page
        </p>
        <p className="now-reading__sentence" aria-live="polite">
          {snapshot.currentSentenceText ??
            (snapshot.status === "preparing"
              ? "Building a source-aware reading map…"
              : "Press play to begin at the first readable sentence.")}
        </p>
        <p className="now-reading__word">
          {snapshot.currentWordText ? (
            <>
              Current word <strong>{snapshot.currentWordText}</strong>
            </>
          ) : (
            "Word focus will appear here when the voice provides boundaries."
          )}
        </p>
      </section>

      {(snapshot.error || panelError) && (
        <section className="notice notice--error" role="alert">
          <p>{snapshot.error?.message ?? panelError}</p>
          {providerId !== "browser" && (
            <button
              type="button"
              onClick={() => void command({ type: "set-provider", providerId: "browser" })}
            >
              Use browser speech
            </button>
          )}
        </section>
      )}

      <section className="quick-actions" aria-label="Reading start options">
        <button type="button" onClick={() => void prepareAndPlay("beginning")}>
          <PlayIcon size={17} />
          Read from beginning
        </button>
        <button type="button" onClick={() => void prepareAndPlay("selection")}>
          <SelectionIcon />
          Read selection
        </button>
      </section>

      <section className="controls" aria-label="Reading settings">
        <div className="control-row">
          <label htmlFor="speed">
            <span>Speed</span>
            <small>Playback pace</small>
          </label>
          <div className="select-wrap">
            <select
              id="speed"
              value={snapshot.playbackRate}
              onChange={(event) =>
                void command({ type: "set-rate", rate: Number(event.target.value) })
              }
            >
              {[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((rate) => (
                <option value={rate} key={rate}>
                  {rate}×
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
        </div>

        <div className="control-row">
          <label htmlFor="provider">
            <span>Voice engine</span>
            <small>
              {providerId === "browser" ? "Browser-managed" : "Sends text to your server"}
            </small>
          </label>
          <div className="select-wrap">
            <select
              id="provider"
              value={providerId}
              onChange={(event) =>
                void command({ type: "set-provider", providerId: event.target.value })
              }
            >
              {catalog.providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.available}>
                  {provider.name}
                  {provider.available ? "" : " — unavailable"}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
        </div>

        <p className="provider-disclosure">
          {providerId === "browser"
            ? "Neural engines send each sentence to your configured server only after you select one."
            : "This engine sends each sentence to your configured server for synthesis."}
        </p>

        <details className="server" open={providerId !== "browser"}>
          <summary>
            <span className="server__summary">
              <VolumeIcon />
              Neural speech server
            </span>
            <span className="server__meta">
              <span className={`connection ${catalog.serverConnected ? "connection--online" : ""}`}>
                {catalog.serverConnected ? "Connected" : "Offline"}
              </span>
              <span className="server__chevron" aria-hidden="true">
                <ChevronIcon />
              </span>
            </span>
          </summary>
          <div className="server__body">
            <label htmlFor="server-url">Server URL</label>
            <div className="server__address">
              <input
                id="server-url"
                type="url"
                inputMode="url"
                value={serverUrl}
                onChange={(event) => setServerUrlDraft(event.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                aria-label="Save server URL and reconnect"
                title="Save and reconnect"
                onClick={() => {
                  void command({ type: "set-server-url", serverUrl }).then((saved) => {
                    if (saved) setServerUrlDraft(undefined);
                  });
                }}
              >
                <RefreshIcon />
              </button>
            </div>
            <p>
              Page text is sent only when a neural engine is selected. Browser speech does not use
              this server.
            </p>
            {catalog.serverError && <p className="server__error">{catalog.serverError}</p>}
          </div>
        </details>

        <div className="control-row">
          <label htmlFor="voice">
            <span>Voice</span>
            <small>{voices.length > 0 ? `${voices.length} available` : "Provider default"}</small>
          </label>
          <div className="select-wrap select-wrap--wide">
            <select
              id="voice"
              value={snapshot.voiceId ?? ""}
              onChange={(event) => setVoice(event.target.value)}
            >
              <option value="">Default voice</option>
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name}
                  {voice.language ? ` · ${voice.language}` : ""}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
        </div>

        <div className="control-row control-row--toggle">
          <label htmlFor="auto-scroll">
            <span>Follow the narration</span>
            <small>Pauses when you scroll away</small>
          </label>
          <button
            id="auto-scroll"
            type="button"
            className="switch"
            role="switch"
            aria-checked={snapshot.autoScroll}
            onClick={() => void command({ type: "set-auto-scroll", enabled: !snapshot.autoScroll })}
          >
            <span />
          </button>
        </div>
      </section>

      <footer className="panel-footer">
        <span>{snapshot.providerId === "browser" ? "Browser speech" : snapshot.providerId}</span>
        <span className="tabular">{snapshot.bufferedSentenceCount} buffered</span>
      </footer>
    </main>
  );
}
