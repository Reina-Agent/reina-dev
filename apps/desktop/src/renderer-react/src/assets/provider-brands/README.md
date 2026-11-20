# Provider brand assets

These provider logos are vendored from [Lobe Icons](https://github.com/lobehub/lobe-icons), distributed under the MIT license reproduced in LICENSE.txt. No runtime icon-package dependency is required. Brand names and marks remain their respective owners' trademarks and identify the configured provider.

The reference is `参考/maka/apps/desktop/src/renderer/`. Its provider-brand-marks.tsx identifies Lobe Icons `@lobehub/icons-static-svg@1.91.0` as the source of its SVG paths. Inline path geometry and brand fills were retained; JSX SVG attribute names were converted to XML. The copied standalone SVG files are byte-for-byte identical to that reference. MiniMax was retrieved from the pinned Lobe Icons package rather than adding Maka's Simple Icons dependency.

Monochrome assets (OpenAI, Kimi, Xiaomi, xAI, Z.AI, Ollama) render through a CSS mask so their foreground follows the active theme. Other assets preserve the original brand fills.

## File provenance and SHA-256

- `openai.svg`: Extracted SVG from Maka provider-brand-marks.tsx OpenAI; JSX SVG attribute names converted to XML.
  SHA-256: `e73a5eeb84bcc5dcad3abce14b137dab941ea88b8d9ecb726eda7deee62238e2`
- `anthropic.svg`: Extracted SVG from Maka provider-brand-marks.tsx Claude; JSX SVG attribute names converted to XML.
  SHA-256: `2f18c1202a7a27a964a4ccf1a799531f514e06c5afb12fb6019ac60bd66643ec`
- `deepseek.svg`: Extracted SVG from Maka provider-brand-marks.tsx DeepSeek; JSX SVG attribute names converted to XML.
  SHA-256: `e8d458f8811bf6d7b78fd861825a6b7ceadb9dc8e0b8d9ef1717433afbbca645`
- `kimi.svg`: Extracted SVG from Maka provider-brand-marks.tsx Moonshot; JSX SVG attribute names converted to XML.
  SHA-256: `54185f85498c8e9c1264da9ca30bc0fc58d57d2a63a70bdd888898cbd4486633`
- `gemini.svg`: Extracted SVG from Maka provider-brand-marks.tsx Gemini; JSX SVG attribute names converted to XML.
  SHA-256: `f766a836f138a42feeb22f984fa1c368b1cfcffae428f8ddc922bf4d6ff0fdf2`
- `ollama.svg`: Extracted SVG from Maka provider-brand-marks.tsx Ollama; JSX SVG attribute names converted to XML.
  SHA-256: `4b7c549d32dd06052eacfe7c78a877472dfc5780d5a8539478994d3b8a964d65`
- `xiaomi.svg`: Copied unchanged from Maka assets/provider-brands/xiaomimimo.svg.
  SHA-256: `b04ad7dad52af2212c4567daf0ee6856f2c4625c92c680a27f9880295d558b71`
- `alibaba.svg`: Copied unchanged from Maka assets/provider-brands/alibabacloud.svg.
  SHA-256: `73ea97baf919edb3d888a77cd45b21574e190a80124a59e199ea6953a28a959c`
- `xai.svg`: Copied unchanged from Maka assets/provider-brands/xai.svg.
  SHA-256: `89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451`
- `zai.svg`: Copied unchanged from Maka assets/provider-brands/zai.svg.
  SHA-256: `e748cb5108ce37b116d7a5ba97d37e0ae97eadf6849b0de11afb248e244a01e1`
- `openrouter.svg`: Copied unchanged from Maka assets/provider-brands/openrouter.svg.
  SHA-256: `17bede1b89166f824ee06753dc526a3f5e18b769706deaab09d04a3a98de1a78`
- `mistral.svg`: Copied unchanged from Maka assets/provider-brands/mistral.svg.
  SHA-256: `722f74b289d95486b43662fe24fa883b333701296f618406cd0ed502299170b6`
- `minimax.svg`: Copied unchanged from https://unpkg.com/@lobehub/icons-static-svg@1.91.0/icons/minimax-color.svg.
  SHA-256: `7f7187fa6d9b341ac5f22f6c5a970523afb439dc45566d64eb4f4b9b604d6b01`

## Pinned upstream references for standalone assets

| Local file | Lobe Icons upstream path | Revision recorded by Maka |
| --- | --- | --- |
| `xai.svg` | `packages/static-svg/icons/xai.svg` | `32f4083f7a20b67ecdc7b29c0af031ada5a29c52` |
| `xiaomi.svg` | `packages/static-svg/icons/xiaomimimo.svg` | `@lobehub/icons-static-svg@1.91.0` |
| `zai.svg` | `packages/static-svg/icons/zai.svg` | `@lobehub/icons-static-svg@1.91.0` |
| `openrouter.svg` | `packages/static-svg/icons/openrouter-color.svg` | `df132de5a0cef315b9a2f155b1949e39f4b89bb5` |
| `alibaba.svg` | `packages/static-svg/icons/alibabacloud-color.svg` | `e4302041fbb3039608d25f9f618bd462783b875e` |
| `mistral.svg` | `packages/static-svg/icons/mistral-color.svg` | `e4302041fbb3039608d25f9f618bd462783b875e` |

The inline Ollama path also records upstream `packages/static-svg/icons/ollama.svg` at commit `32f4083f7a20b67ecdc7b29c0af031ada5a29c52` in Maka's source notice.
