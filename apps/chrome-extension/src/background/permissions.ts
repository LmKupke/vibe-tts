export class ServerPermissionError extends Error {
  readonly code = "server-permission-denied";

  constructor(message = "Access to the configured neural TTS server was not granted.") {
    super(message);
    this.name = "ServerPermissionError";
  }
}

export function serverOriginPattern(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The neural TTS server must use HTTP or HTTPS.");
  }
  return `${url.origin}/*`;
}

export function hasServerPermission(serverUrl: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [serverOriginPattern(serverUrl)] });
}

export async function requestServerPermission(serverUrl: string): Promise<void> {
  const origin = serverOriginPattern(serverUrl);
  const permissions = { origins: [origin] };
  if (await hasServerPermission(serverUrl)) return;
  const granted = await chrome.permissions.request(permissions);
  if (!granted) throw new ServerPermissionError();
}

export async function removeServerPermission(serverUrl: string): Promise<void> {
  const origin = serverOriginPattern(serverUrl);
  await chrome.permissions.remove({ origins: [origin] });
}
