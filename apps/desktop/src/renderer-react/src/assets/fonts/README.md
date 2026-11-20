# Bundled fonts

Latin variable-weight woff2 subsets, vendored from the corresponding
`@fontsource-variable/*` npm packages. All five are licensed under the
SIL Open Font License 1.1, which permits bundling and redistribution
inside an application.

| File | Family | Upstream | License |
| --- | --- | --- | --- |
| inter-latin-wght-normal.woff2 | Inter | github.com/rsms/inter | OFL-1.1 |
| familjen-grotesk-latin-wght-normal.woff2 | Familjen Grotesk | github.com/Familjen-Sthlm/Familjen-Grotesk | OFL-1.1 |
| reina-sans-latin-wght-normal.woff2 | Reina Sans | derived from Familjen Grotesk (see below) | OFL-1.1 |
| jetbrains-mono-latin-wght-normal.woff2 | JetBrains Mono | github.com/JetBrains/JetBrainsMono | OFL-1.1 |
| fira-code-latin-wght-normal.woff2 | Fira Code | github.com/tonsky/FiraCode | OFL-1.1 |
| source-code-pro-latin-wght-normal.woff2 | Source Code Pro | github.com/adobe-fonts/source-code-pro | OFL-1.1 |
| cascadia-code-latin-wght-normal.woff2 | Cascadia Code | github.com/microsoft/cascadia-code | OFL-1.1 |

License text: https://openfontlicense.org/open-font-license-official-text/

To refresh: `npm pack @fontsource-variable/<name>` and copy
`files/<name>-latin-wght-normal.woff2` here, then keep the `font-weight`
range in `fonts.css` in sync with the package's `wght.css`.

## Reina Sans

Reina Sans is Familjen Grotesk with its metrics aligned to Anthropic Sans
Text (Regular): outlines and advances scaled 1.08× so the x-height ratio is
0.54em, advances padded to a 0.547em average (glyphs recentered), and the
line box redistributed to 0.9925em ascent / −0.2575em descent. Only numeric
metrics were read from the proprietary font — no outline or table data.
Renamed per OFL §1; still OFL 1.1 with the original copyright notice.
Regenerate with `python scripts/build-reina-sans.py <path-to-AnthropicSans-Romans-Variable.ttf>`.
