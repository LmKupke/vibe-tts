import { hasPendingMermaidDiagrams } from "./mermaid-placeholders";
import { renderMermaidDiagrams, type MermaidRenderSummary } from "./mermaid-renderer";

declare global {
  interface Window {
    __vibeTtsMermaidRenderPromise?: Promise<MermaidRenderSummary>;
  }
}

export function runMermaidEntry(
  root: ParentNode = document,
  runtimeWindow: Window = window,
): Promise<MermaidRenderSummary> | undefined {
  if (!hasPendingMermaidDiagrams(root)) return undefined;
  if (runtimeWindow.__vibeTtsMermaidRenderPromise) {
    return runtimeWindow.__vibeTtsMermaidRenderPromise;
  }

  const renderPromise = renderMermaidDiagrams(root);
  runtimeWindow.__vibeTtsMermaidRenderPromise = renderPromise;
  const clearGuard = (): void => {
    if (runtimeWindow.__vibeTtsMermaidRenderPromise === renderPromise) {
      delete runtimeWindow.__vibeTtsMermaidRenderPromise;
    }
  };
  void renderPromise.then(clearGuard, clearGuard);
  return renderPromise;
}

void runMermaidEntry();
