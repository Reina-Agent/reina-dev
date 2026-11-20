# Build "Reina Sans": Familjen Grotesk (OFL 1.1) with its metrics aligned to
# Anthropic Sans Text. Only numeric FACTS are read from the proprietary font
# (x-height, ascender/descender, average advance) — no outline, hinting, or
# table data is copied. The derived font is renamed per OFL and stays OFL.
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.varLib.instancer import instantiateVariableFont

if len(sys.argv) != 2:
    sys.exit("usage: python scripts/build-reina-sans.py <AnthropicSans-Romans-Variable.ttf>")
ANTHROPIC = sys.argv[1]
FONTS_DIR = Path(__file__).resolve().parents[1] / "apps/desktop/src/renderer-react/src/assets/fonts"
FAMILJEN = str(FONTS_DIR / "familjen-grotesk-latin-wght-normal.woff2")
OUT = str(FONTS_DIR / "reina-sans-latin-wght-normal.woff2")

# Mixed-case probe with spaces/digits — matches real UI text; a lowercase-only
# probe overstates the target tracking (Anthropic's lowercase is relatively
# wide, its spaces/caps relatively narrow) and pads the font ~4% too wide.
PROBE = "The quick brown fox jumps over reina 0123"


def probe_avg(font):
    upem = font["head"].unitsPerEm
    hmtx = font["hmtx"]
    cmap = font.getBestCmap()
    widths = [hmtx[cmap[ord(c)]][0] for c in PROBE if ord(c) in cmap]
    return sum(widths) / len(widths) / upem


# ── measure the target at its UI instance (Text Regular: opsz 16, wght 400) ──
a = TTFont(ANTHROPIC)
instantiateVariableFont(a, {"wght": 400, "opsz": 16}, inplace=True)
a_upem = a["head"].unitsPerEm
target = {
    "xh": a["OS/2"].sxHeight / a_upem,
    "cap": a["OS/2"].sCapHeight / a_upem,
    "typoAsc": a["OS/2"].sTypoAscender / a_upem,
    "typoDesc": a["OS/2"].sTypoDescender / a_upem,
    "avg": probe_avg(a),
}
print("target (Anthropic Sans Text Regular):", {k: round(v, 4) for k, v in target.items()})

# ── scale Familjen so its x-height ratio matches ─────────────────────────────
f = TTFont(FAMILJEN)
upem = f["head"].unitsPerEm  # 1200
k = target["xh"] / (f["OS/2"].sxHeight / upem)
print(f"scale factor k={k:.4f}")
# scale_upem multiplies every coordinate/metric by (new/old) and keeps the
# rendered size identical; resetting unitsPerEm afterwards makes everything k×
# larger relative to the em — glyphs, advances, kerning and gvar deltas move
# together.
scale_upem(f, round(upem * k))
f["head"].unitsPerEm = upem

# ── letterspacing: pad advances toward the target average ────────────────────
cur_avg = probe_avg(f)
pad = round((target["avg"] - cur_avg) * upem)
print(f"avg advance: now {cur_avg:.4f}em, target {target['avg']:.4f}em, pad {pad} units/glyph")
if pad > 0:
    hmtx = f["hmtx"]
    for name in f.getGlyphOrder():
        adv, lsb = hmtx[name]
        if adv > 0:
            # split the pad so the glyph stays centered in its widened box
            hmtx[name] = (adv + pad, lsb + pad // 2)
    # shifting via lsb alone doesn't move TrueType outlines; move them too
    glyf = f["glyf"]
    shift = pad // 2
    if shift:
        from fontTools.pens.ttGlyphPen import TTGlyphPen
        from fontTools.misc.transform import Offset
        from fontTools.pens.transformPen import TransformPen
        for name in f.getGlyphOrder():
            g = glyf[name]
            if g.isComposite() or g.numberOfContours == 0:
                continue
            pen = TTGlyphPen(f.getGlyphSet())
            g.draw(TransformPen(pen, Offset(shift, 0)), glyf)
            glyf[name] = pen.glyph()

# ── vertical metrics: adopt the target's line-box distribution ───────────────
os2, hhea = f["OS/2"], f["hhea"]
asc = round(target["typoAsc"] * upem)
desc = round(target["typoDesc"] * upem)
os2.sTypoAscender = asc
os2.sTypoDescender = desc
os2.sTypoLineGap = 0
os2.usWinAscent = asc
os2.usWinDescent = -desc
hhea.ascent = asc
hhea.descent = desc
hhea.lineGap = 0

# ── rename per OFL (derivative must not use the original name) ───────────────
FAMILY = "Reina Sans"
name = f["name"]
for rec in name.names:
    if rec.nameID in (1, 16):
        rec.string = FAMILY
    elif rec.nameID == 3:
        rec.string = f"1.000;{FAMILY};derived-from-FamiljenGrotesk"
    elif rec.nameID == 4:
        rec.string = FAMILY
    elif rec.nameID == 6:
        rec.string = "ReinaSans-Regular"
    elif rec.nameID == 0:
        rec.string = (
            str(rec.toUnicode())
            + " Reina Sans is a modified version of Familjen Grotesk (metrics aligned; SIL OFL 1.1)."
        )
print("RFN check name13:", (name.getDebugName(13) or "")[:120])

f.flavor = "woff2"
f.save(OUT)
print("saved", OUT)

# ── verify the result ────────────────────────────────────────────────────────
v = TTFont(OUT)
vu = v["head"].unitsPerEm
print("result:", {
    "family": v["name"].getDebugName(1),
    "xh": round(v["OS/2"].sxHeight / vu, 4),
    "typoAsc": round(v["OS/2"].sTypoAscender / vu, 4),
    "typoDesc": round(v["OS/2"].sTypoDescender / vu, 4),
    "avg": round(probe_avg(v), 4),
    "axes": [(x.axisTag, x.minValue, x.maxValue) for x in v["fvar"].axes] if "fvar" in v else None,
})
