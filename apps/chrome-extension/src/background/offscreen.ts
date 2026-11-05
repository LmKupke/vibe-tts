import { createRequestId, type ExtensionMessage, type MessageReply } from "@vibe-tts/shared";

const OFFSCREEN_PATH = "offscreen.html";

let creation: Promise<void> | undefined;

export function isMessageReply(value: unknown): value is MessageReply {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ok === "boolean" && typeof candidate.requestId === "string";
}

export async function hasOffscreenDocument(): Promise<boolean> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl],
  });
  return contexts.length > 0;
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (creation) return creation;
  creation = (async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Play webpage narration and track synchronized speech timing.",
    });
  })();
  try {
    await creation;
  } finally {
    creation = undefined;
  }
}

export async function sendOffscreenMessage<T>(
  message: Extract<ExtensionMessage, { target: "offscreen" }>,
  create = true,
): Promise<MessageReply<T>> {
  if (create) {
    await ensureOffscreenDocument();
  } else if (!(await hasOffscreenDocument())) {
    throw new Error("No active narration session was found.");
  }
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isMessageReply(response) || response.requestId !== message.requestId) {
    throw new Error("The playback context returned an invalid response.");
  }
  return response as MessageReply<T>;
}

export function offscreenCommand(
  command: Extract<ExtensionMessage, { type: "offscreen-command" }>["command"],
): Extract<ExtensionMessage, { type: "offscreen-command" }> {
  return {
    type: "offscreen-command",
    requestId: createRequestId("background-offscreen"),
    source: "background",
    target: "offscreen",
    command,
  };
}
