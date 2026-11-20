import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceRelativePath,
  workspaceAbsolutePath,
  workspaceFileUrl,
} from "./workspace-markdown-utils";

describe("resolveWorkspaceRelativePath", () => {
  it("resolves paths relative to the markdown file", () => {
    expect(resolveWorkspaceRelativePath("docs/guide.md", "../img/logo.png")).toBe("img/logo.png");
    expect(resolveWorkspaceRelativePath("README.md", "./CONTRIBUTING.md#rules")).toBe("CONTRIBUTING.md");
  });

  it("rejects paths that leave the workspace or use executable schemes", () => {
    expect(resolveWorkspaceRelativePath("README.md", "../secret.png")).toBeNull();
    expect(resolveWorkspaceRelativePath("README.md", "%2e%2e/secret.png")).toBeNull();
    expect(resolveWorkspaceRelativePath("README.md", "javascript:alert(1)")).toBeNull();
    expect(resolveWorkspaceRelativePath("README.md", "file:///etc/passwd")).toBeNull();
  });
});

describe("workspace paths", () => {
  it("creates platform-appropriate absolute paths", () => {
    expect(workspaceAbsolutePath("C:\\repo", "img/logo.png")).toBe("C:\\repo\\img\\logo.png");
    expect(workspaceAbsolutePath("/repo", "img/logo.png")).toBe("/repo/img/logo.png");
  });

  it("creates encoded file URLs for safe local images", () => {
    expect(workspaceFileUrl("C:\\My Repo", "README.md", "img/logo 1.png"))
      .toBe("file:///C:/My%20Repo/img/logo%201.png");
  });
});
