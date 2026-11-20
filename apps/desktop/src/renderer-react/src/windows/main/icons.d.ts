// Type surface for the verbatim-copied legacy icons.js (SVG sprite injector).
export function icon(name: string, opts?: { className?: string; size?: number }): string;
export function iconNode(name: string, opts?: { className?: string; size?: number }): SVGElement | null;
export function decorateButtons(): void;
export const ICON_NAMES: string[];
