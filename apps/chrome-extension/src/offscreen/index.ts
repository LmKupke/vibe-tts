import { ReaderController } from "./reader-controller";
import { createChromeEventSink, installOffscreenRuntime } from "./runtime";

const installationKey = "__vibeTtsOffscreenController";
const scope = globalThis as typeof globalThis & {
  [installationKey]?: { controller: ReaderController; uninstall: () => void };
};

if (!scope[installationKey]) {
  const controller = new ReaderController(createChromeEventSink());
  const uninstall = installOffscreenRuntime(controller);
  scope[installationKey] = { controller, uninstall };
  void controller.initialize().catch(() => undefined);
}
