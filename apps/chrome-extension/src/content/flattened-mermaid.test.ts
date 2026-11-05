import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";

import { prepareFlattenedMermaidArtifacts } from "./flattened-mermaid";

function flattenedCss(diagramId = "mermaid-r5", ruleCount = 12): string {
  const nodeRules = Array.from(
    { length: ruleCount },
    (_, index) =>
      `#${diagramId} .node .shape-${index}{fill:#eee;stroke:#999;stroke-width:${index + 1}px;}`,
  ).join("");
  return `#${diagramId}{font-family:inherit;font-size:16px;fill:#000000;}@keyframes dash{to{stroke-dashoffset:0;}}${nodeRules}#${diagramId} :root{--mermaid-font-family:inherit;}`;
}

describe("prepareFlattenedMermaidArtifacts", () => {
  it.each(["mermaid-ra", "mermaid-rA7", "mermaid-r_a-2", "MERMAID-RA"])(
    "recognizes generated Mermaid IDs containing letters, digits, underscores, and hyphens: %s",
    (diagramId) => {
      const css = flattenedCss(diagramId);
      const prepared = prepareFlattenedMermaidArtifacts(`Before\n\n${css}\n\nAfter`);

      expect(prepared.artifacts).toEqual([
        expect.objectContaining({
          cssLength: css.length,
          diagramId,
        }),
      ]);
      expect(prepared.markdown).not.toContain(css);
      expect(prepared.markdown).toContain("Before");
      expect(prepared.markdown).toContain("After");
    },
  );

  it.each(["mermaid-r.dot", "mermaid-r:colon", "mermaid-r/slash"])(
    "does not accept punctuation outside the generated Mermaid ID character set: %s",
    (diagramId) => {
      const markdown = flattenedCss(diagramId);

      expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
        artifacts: [],
        markdown,
      });
    },
  );

  it("replaces multiple flattened exports while preserving following labels and captions", () => {
    const first = flattenedCss("mermaid-r5");
    const second = flattenedCss("mermaid-r6");
    const markdown = `# Read-heavy systems

${first}

Client

The read-heavy skeleton.

${second}

Cache miss
`;

    const prepared = prepareFlattenedMermaidArtifacts(markdown);

    expect(prepared.artifacts).toHaveLength(2);
    expect(prepared.artifacts).toEqual([
      expect.objectContaining({
        cssLength: first.length,
        diagramId: "mermaid-r5",
        ordinal: 0,
        sourceEnd: markdown.indexOf(first) + first.length,
        sourceLine: 3,
        sourceStart: markdown.indexOf(first),
      }),
      expect.objectContaining({
        cssLength: second.length,
        diagramId: "mermaid-r6",
        ordinal: 1,
        sourceEnd: markdown.indexOf(second) + second.length,
        sourceLine: 9,
        sourceStart: markdown.indexOf(second),
      }),
    ]);
    expect(prepared.markdown).not.toContain("#mermaid-r5{");
    expect(prepared.markdown).not.toContain("#mermaid-r6{");
    expect(prepared.markdown).toContain("Client");
    expect(prepared.markdown).toContain("The read-heavy skeleton.");
    expect(prepared.markdown).toContain("Cache miss");
    for (const artifact of prepared.artifacts) {
      expect(prepared.markdown).toContain(artifact.marker);
    }
  });

  it("isolates generated CSS between concatenated sequence labels", () => {
    const css = flattenedCss("mermaid-r7");
    const prepared = prepareFlattenedMermaidArtifacts(
      `AliceBob${css}insert("my ", 0) @seq41\nCaption after the diagram.`,
    );

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]).toEqual(
      expect.objectContaining({ cssLength: css.length, diagramId: "mermaid-r7" }),
    );
    expect(prepared.markdown).toMatch(/AliceBob\s+\uE000VIBETTSFLATTENEDMERMAID/u);
    expect(prepared.markdown).toMatch(
      /\uE001\s+insert\("my ", 0\) @seq41\s+Caption after the diagram\./u,
    );
  });

  it("does not touch artifact-shaped text inside backtick or tilde fences", () => {
    const css = flattenedCss();
    const markdown = `Before

\`\`\`css
${css}
\`\`\`

~~~text
${css}
~~~

After`;

    expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
      artifacts: [],
      markdown,
    });
  });

  it("does not rewrite artifact-shaped text inside variable-length inline code spans", () => {
    const css = flattenedCss();
    const singleBackticks = `Explain \`${css}\` as literal CSS.`;
    const doubleBackticks = `Explain \`\`one \` plus ${css}\`\` as literal CSS.`;

    expect(prepareFlattenedMermaidArtifacts(singleBackticks)).toEqual({
      artifacts: [],
      markdown: singleBackticks,
    });
    expect(prepareFlattenedMermaidArtifacts(doubleBackticks)).toEqual({
      artifacts: [],
      markdown: doubleBackticks,
    });
  });

  it("treats only the first backtick in an escaped run as escaped", () => {
    const css = flattenedCss();

    for (const markdown of [`\\\`\`${css}\``, `\\\`\`\`${css}\`\``]) {
      expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
        artifacts: [],
        markdown,
      });
    }
  });

  it("agrees with Markdown-it about whether delimiter variants protect the artifact", () => {
    const css = flattenedCss();
    const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
    const delimiters = ["`", "``", "```", "\\`", "\\``", "\\```"];

    for (const opener of delimiters) {
      for (const closer of delimiters) {
        for (const separator of ["", "\n"]) {
          const markdown = `Before ${opener}${separator}${css}${closer} after`;
          const artifactIsCode = parser
            .parse(markdown, {})
            .some((token) =>
              token.children?.some(
                (child) => child.type === "code_inline" && child.content.includes("#mermaid-r5{"),
              ),
            );
          const prepared = prepareFlattenedMermaidArtifacts(markdown);
          expect(prepared.artifacts, markdown).toHaveLength(artifactIsCode ? 0 : 1);
        }
      }
    }
  });

  it("does not rewrite artifact-shaped text inside multiline inline code spans", () => {
    const css = flattenedCss();
    const singleBackticks = `Explain \`literal CSS starts here
${css}
and ends here\` safely.`;
    const doubleBackticks = `Explain \`\`literal \` CSS starts here
${css}
and ends here\`\` safely.`;

    expect(prepareFlattenedMermaidArtifacts(singleBackticks)).toEqual({
      artifacts: [],
      markdown: singleBackticks,
    });
    expect(prepareFlattenedMermaidArtifacts(doubleBackticks)).toEqual({
      artifacts: [],
      markdown: doubleBackticks,
    });
  });

  it("does not let unmatched or mismatched backticks hide real artifacts", () => {
    const css = flattenedCss();
    const samples = [
      `Typo \` before ${css}`,
      `Typo with unmatched \`
${css}`,
      `Mismatched \`\` opener
\` ${css}`,
      `> Quoted unmatched \`

${css}`,
      `    Indented unmatched \`

${css}`,
    ];

    for (const markdown of samples) {
      const prepared = prepareFlattenedMermaidArtifacts(markdown);
      expect(prepared.artifacts, markdown).toHaveLength(1);
      expect(prepared.markdown, markdown).not.toContain(css);
    }
  });

  it("leaves list-contained fenced and quoted CSS examples unchanged", () => {
    const css = flattenedCss();
    const markdown = `- \`\`\`css
  ${css}
  \`\`\`

- > ${css}`;

    expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
      artifacts: [],
      markdown,
    });
  });

  it("preserves lazy list and blockquote continuation lines", () => {
    const css = flattenedCss();

    for (const markdown of [`> CSS example:\n${css}`, `- CSS example:\n${css}`]) {
      expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
        artifacts: [],
        markdown,
      });
    }
  });

  it("can detect an artifact after preserving an inline CSS example on the same line", () => {
    const example = flattenedCss("mermaid-r5");
    const artifact = flattenedCss("mermaid-r6");
    const prepared = prepareFlattenedMermaidArtifacts(
      `Intro line
Example: \`${example}\` Result: ${artifact}`,
    );

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]?.diagramId).toBe("mermaid-r6");
    expect(prepared.markdown).toContain(`\`${example}\``);
    expect(prepared.markdown).not.toContain(artifact);
  });

  it("rejects short lookalikes and ordinary long CSS", () => {
    const shortLookalike = "#mermaid-r5{font-family:inherit;color:red;}";
    const unrelated = `#mermaid-r5{font-family:inherit;}${".ordinary{color:red;}".repeat(50)}`;
    const markdown = `${shortLookalike}\n\n${unrelated}`;

    expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
      artifacts: [],
      markdown,
    });
  });

  it("continues past a rejected lookalike to find a later valid artifact", () => {
    const lookalike = "#mermaid-r5{font-family:inherit;color:red;}";
    const artifact = flattenedCss("mermaid-r6");
    const prepared = prepareFlattenedMermaidArtifacts(`${lookalike} ${artifact}`);

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]?.diagramId).toBe("mermaid-r6");
    expect(prepared.markdown).toContain(lookalike);
    expect(prepared.markdown).not.toContain(artifact);
  });

  it("leaves indented code and block quotes unchanged", () => {
    const css = flattenedCss();
    const markdown = `    ${css}\n\n> ${css}`;

    expect(prepareFlattenedMermaidArtifacts(markdown)).toEqual({
      artifacts: [],
      markdown,
    });
  });

  it("recognizes artifacts with one to three spaces of paragraph indentation", () => {
    const css = flattenedCss();

    for (const indentation of [" ", "  ", "   "]) {
      const prepared = prepareFlattenedMermaidArtifacts(`${indentation}${css}`);
      expect(prepared.artifacts).toHaveLength(1);
      expect(prepared.artifacts[0]?.sourceStart).toBe(indentation.length);
      expect(prepared.markdown).not.toContain(css);
    }
  });

  it("uses marker text that cannot collide with existing Markdown", () => {
    const css = flattenedCss();
    const existingMarkerPrefix = "\uE000VIBETTSFLATTENEDMERMAID";
    const prepared = prepareFlattenedMermaidArtifacts(`${existingMarkerPrefix}\n${css}`);

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]?.marker).toBe("\uE000VIBETTSFLATTENEDMERMAIDX-0\uE001");
    expect(prepared.markdown).toContain(existingMarkerPrefix);
  });

  it("avoids marker text produced by Markdown entity decoding", () => {
    const css = flattenedCss();
    const encodedMarker = "&#xE000;VIBETTSFLATTENEDMERMAID-0&#xE001;";
    const prepared = prepareFlattenedMermaidArtifacts(`${encodedMarker}\n\n${css}`);

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]?.marker).toBe("\uE000VIBETTSFLATTENEDMERMAIDX-0\uE001");
    const template = document.createElement("template");
    template.innerHTML = new MarkdownIt({ html: false }).render(prepared.markdown);
    expect(
      Array.from(template.content.querySelectorAll("p"), (paragraph) => paragraph.textContent),
    ).toEqual(["\uE000VIBETTSFLATTENEDMERMAID-0\uE001", prepared.artifacts[0]?.marker]);
  });

  it("preserves CRLF output around replacement markers", () => {
    const css = flattenedCss();
    const prepared = prepareFlattenedMermaidArtifacts(`Before\r\n${css}\r\nAfter`);

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.markdown).not.toMatch(/(?<!\r)\n/u);
    expect(prepared.markdown).toContain("Before\r\n");
    expect(prepared.markdown).toContain("\r\nAfter");
  });

  it("scans a large flattened export without quadratic rule-by-rule slicing", () => {
    const css = flattenedCss("mermaid-r99", 20_000);
    const startedAt = performance.now();
    const prepared = prepareFlattenedMermaidArtifacts(css);
    const elapsed = performance.now() - startedAt;

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]?.cssLength).toBe(css.length);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("rejects many adjacent lookalikes without repeatedly rescanning the suffix", () => {
    const lookalikes = "#mermaid-r5{font-family:inherit;color:red;}".repeat(8_000);
    const startedAt = performance.now();
    const prepared = prepareFlattenedMermaidArtifacts(lookalikes);
    const elapsed = performance.now() - startedAt;

    expect(prepared).toEqual({ artifacts: [], markdown: lookalikes });
    expect(elapsed).toBeLessThan(1_000);
  });

  it("rejects many unbalanced lookalikes without repeatedly scanning to the end", () => {
    const lookalikes = "#mermaid-r5{font-family:inherit;".repeat(8_000);
    const startedAt = performance.now();
    const prepared = prepareFlattenedMermaidArtifacts(lookalikes);
    const elapsed = performance.now() - startedAt;

    expect(prepared).toEqual({ artifacts: [], markdown: lookalikes });
    expect(elapsed).toBeLessThan(1_000);
  });

  it("chooses a collision-free marker salt in linear time", () => {
    const prefix = "\uE000VIBETTSFLATTENEDMERMAID";
    const collision = `${prefix}${"X".repeat(80_000)}`;
    const css = flattenedCss();
    const startedAt = performance.now();
    const prepared = prepareFlattenedMermaidArtifacts(`${collision}\n\n${css}`);
    const elapsed = performance.now() - startedAt;

    expect(prepared.artifacts).toHaveLength(1);
    expect(prepared.artifacts[0]?.marker).toHaveLength(prefix.length + 80_001 + 3);
    expect(elapsed).toBeLessThan(1_000);
  });
});
