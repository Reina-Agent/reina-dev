import type { ProviderBrand } from "./providerBrands";
import openai from "../assets/provider-brands/openai.svg";
import anthropic from "../assets/provider-brands/anthropic.svg";
import deepseek from "../assets/provider-brands/deepseek.svg";
import kimi from "../assets/provider-brands/kimi.svg";
import xiaomi from "../assets/provider-brands/xiaomi.svg";
import alibaba from "../assets/provider-brands/alibaba.svg";
import xai from "../assets/provider-brands/xai.svg";
import gemini from "../assets/provider-brands/gemini.svg";
import zai from "../assets/provider-brands/zai.svg";
import minimax from "../assets/provider-brands/minimax.svg";
import openrouter from "../assets/provider-brands/openrouter.svg";
import mistral from "../assets/provider-brands/mistral.svg";
import ollama from "../assets/provider-brands/ollama.svg";

export const PROVIDER_BRAND_ASSETS: Record<ProviderBrand, { src: string; monochrome?: boolean }> = {
  openai: { src: openai, monochrome: true },
  anthropic: { src: anthropic },
  deepseek: { src: deepseek },
  kimi: { src: kimi, monochrome: true },
  xiaomi: { src: xiaomi, monochrome: true },
  alibaba: { src: alibaba },
  xai: { src: xai, monochrome: true },
  gemini: { src: gemini },
  zai: { src: zai, monochrome: true },
  minimax: { src: minimax },
  openrouter: { src: openrouter },
  mistral: { src: mistral },
  ollama: { src: ollama, monochrome: true },
};
