import { describe, expect, it } from "vitest";
import { isProviderLogo } from "./providerLogoUpload";

const PNG_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";

describe("isProviderLogo", () => {
  it("accepts a stored PNG data URL", () => {
    expect(isProviderLogo(PNG_LOGO)).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    "",
    "https://example.com/logo.png",
    "file:///logo.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,",
    "data:image/png;base64,bm90LWEtcG5n",
    PNG_LOGO.replace("iVBORw", "iVBOR?"),
    `${PNG_LOGO}\n`,
    PNG_LOGO.slice(0, -1),
    `${PNG_LOGO}${"A".repeat(128 * 1024)}`,
  ])("rejects unsupported or malformed stored values (%#)", (value) => {
    expect(isProviderLogo(value)).toBe(false);
  });
});
