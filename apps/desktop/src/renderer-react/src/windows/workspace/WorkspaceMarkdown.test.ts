import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceMarkdown } from "./WorkspaceMarkdown";

function render(source: string, props: { cwd?: string; basePath?: string } = {}): string {
  return renderToStaticMarkup(createElement(WorkspaceMarkdown, { source, ...props }));
}

describe("WorkspaceMarkdown", () => {
  it("renders README HTML, local images, and GFM structures", () => {
    const source = `<div align="center">

<img src="img/logo.png" alt="Logo" width="180" />

</div>

| Name | Ready |
| --- | --- |
| Reina | yes |

- [x] rendered`;

    const html = render(source, { cwd: "C:\\repo", basePath: "README.md" });

    expect(html).toContain('<div align="center">');
    expect(html).toContain('src="file:///C:/repo/img/logo.png"');
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });

  it("renders GitHub-style alerts", () => {
    const html = render("> [!NOTE]\n> Safe local configuration.");

    expect(html).toContain('data-alert="note"');
    expect(html).toContain('data-alert-label="Note"');
    expect(html).not.toContain("[!NOTE]");
  });

  it("strips executable raw HTML and unsafe URLs", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="javascript:alert(2)" onerror="alert(3)" />\n\n[chat](irc://example.com)');

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("irc://");
  });
});
