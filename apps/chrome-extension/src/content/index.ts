import { ContentController } from "./controller";
import { renderMarkdownReadingView } from "./markdown-view";

const installationKey = "__vibeTtsContentController";
const scope = globalThis as typeof globalThis & { [installationKey]?: ContentController };

if (!scope[installationKey]) {
  renderMarkdownReadingView();
  scope[installationKey] = new ContentController();
  scope[installationKey].start();
}
