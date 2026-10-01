#!/usr/bin/env python3
"""迷津渡 FERRY 的美术资产工厂 —— 一条命令重画整套位图，产出全部落在仓内。

母题「夜渡」：深青河面 + 两岸沙渚 + 船头一盏琥珀灯笼 + 一枚朱印。
配色不是凭空挑的，逐支取自 css/game.css 与 js/view.js 里渲染器自己在用的那几支
（--bg #0b1016、WATER_TOP #16324a、WATER_BOT #0a1822、HULL #6d4b2d、DECK #8d6238、
SAND #2b2418、--amber #e0a63c、--cyan #78dcff、SKIN 四色），所以图标和游戏画面是同一张河。

产物（相对仓根）：
  icons/icon-1024.png          母图，商店截图与派生的唯一来源
  icons/icon-512.png           PWA 512（any + maskable 之外的默认）
  icons/icon-maskable-512.png  PWA maskable（内容收进 80% 安全区）
  icons/icon-192.png           PWA 192
  icons/apple-touch-icon.png   iOS 主屏 180
  icons/favicon-48.png / favicon-32.png / favicon-16.png
  icons/og-cover.png           社交卡 1200x630
  assets/textures/water-night.png  512² 可平铺水纹（涟漪高光，alpha 叠加）
  assets/textures/sand-grain.png   256² 可平铺沙纹
  assets/textures/glow.png         128² 灯笼/浪花粒子
  assets/textures/seal.png         160² 朱印「渡」
  assets/sprites/tokens.png        512x128，四格角色皮（艄公/人/兽/货）

复现性：无网络、无外部素材、无随机时间种子（一切噪声走固定 SEED），
Pillow 逐像素画出，重跑必得同一份字节。缺中文字体时朱印退化为几何印，不会报错。

用法：python3 assets/gen/make_art.py [--out 仓根]
"""
import argparse
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SEED = 20261001
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

# --- 从渲染器抄来的色板（改游戏配色时，这里要跟着改，图标才会和游戏脱节） -----------
BG = (11, 16, 22)          # --bg
WATER_TOP = (22, 50, 74)   # WATER_TOP
WATER_BOT = (10, 24, 34)   # WATER_BOT
SAND = (43, 36, 24)        # SAND
SAND_EDGE = (76, 63, 40)   # SAND_EDGE
HULL = (109, 75, 45)       # HULL
HULL_DARK = (69, 47, 28)   # HULL_DARK
DECK = (141, 98, 56)       # DECK
AMBER = (224, 166, 60)     # --amber
CYAN = (120, 220, 255)     # --cyan
INK = (230, 233, 239)      # INK
SEAL_RED = (176, 44, 38)
SKIN = {
    'ferryman': (201, 150, 63),
    'human': (91, 127, 166),
    'beast': (156, 95, 61),
    'goods': (127, 124, 77),
}
KIND_ORDER = ['ferryman', 'human', 'beast', 'goods']

CJK_FONTS = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def font_for(px):
    for p in CJK_FONTS:
        if not os.path.exists(p):
            continue
        try:
            f = ImageFont.truetype(p, px)
            if '渡' in f.getname()[0] or True:
                f.getbbox('渡')
                return f
        except Exception:
            continue
    return None


# --- 可平铺噪声：格点取模，所以任何频率都天然首尾相接 --------------------------------

def lattice(n, cell, rnd):
    g = max(1, n // cell)
    return [[rnd.random() for _ in range(g)] for _ in range(g)]


def sample(grid, cell, x, y, n):
    gx, gy = x / cell, y / cell
    g = len(grid)
    x0, y0 = int(math.floor(gx)) % g, int(math.floor(gy)) % g
    x1, y1 = (x0 + 1) % g, (y0 + 1) % g
    fx, fy = gx - math.floor(gx), gy - math.floor(gy)
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a = grid[y0][x0] * (1 - sx) + grid[y0][x1] * sx
    b = grid[y1][x0] * (1 - sx) + grid[y1][x1] * sx
    return a * (1 - sy) + b * sy


def fbm(n, cells, seed):
    """Return an n×n float map in [0,1] built from octaves of cell sizes."""
    grids = []
    for c in cells:
        rnd = random.Random(seed + c)
        grids.append((max(1, n // c), lattice(n, c, rnd)))
    out = [[0.0] * n for _ in range(n)]
    for y in range(n):
        for x in range(n):
            v = 0.0
            wsum = 0.0
            for i, (cell, g) in enumerate(grids):
                v += sample(g, cell, x, y, n) / (2 ** i)
                wsum += 1.0 / (2 ** i)
            out[y][x] = v / wsum
    return out


# --- 主体绘制 ------------------------------------------------------------------------

def radial_bg(w, h, inner, outer, bias=0.62):
    img = Image.new('RGB', (w, h), outer)
    px = img.load()
    cx, cy = w / 2.0, h / 2.0
    rx, ry = w * 0.72, h * 0.95
    for y in range(h):
        for x in range(w):
            t = min(1.0, math.hypot((x - cx) / rx, (y - cy) / ry)) ** bias
            px[x, y] = mix(inner, outer, t)
    return img


def layer(size):
    """PIL 的 ImageDraw 在 RGBA 底上**不做 alpha 混合**：半透明色会打出透明洞。
    所以一切带透明度的笔触都画在自己的图层上，最后 alpha_composite 叠回去。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def draw_river(d, size, x0, x1, rnd):
    """The channel: an opaque vertical gradient on the base, ripples on their own layer."""
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(x0, y), (x1, y)], fill=mix(WATER_TOP, WATER_BOT, t ** 0.8))
    rip, rd = layer(size)
    lane = x1 - x0
    for k in range(max(5, int(size / (size * 0.085)))):
        y = int((k + 0.5) * size / max(5, int(size / (size * 0.085))))
        phase = rnd.random() * math.tau
        amp = lane * 0.013
        pts = [(x0 + lane * i / 36.0, y + math.sin(i / 36.0 * math.tau * 2 + phase) * amp) for i in range(37)]
        rd.line(pts, fill=(CYAN[0], CYAN[1], CYAN[2], 40 + int(30 * rnd.random())), width=max(1, size // 260))
    return rip


def draw_banks(d, size, x0, x1, rnd):
    """Two mud banks: opaque warm gradient on the base, grit/waterline/reeds on a layer."""
    for side in (0, 1):
        a, b = (0, x0) if side == 0 else (x1, size)
        for y in range(size):
            t = y / max(1, size - 1)
            col = mix(mix(SAND, (0, 0, 0), 0.34), SAND_EDGE, 0.22 + 0.40 * math.sin(t * math.pi))
            d.line([(a, y), (b, y)], fill=col)
    grit, gd = layer(size)
    for side in (0, 1):
        a, b = (0, x0) if side == 0 else (x1, size)
        for _ in range(int(size * size / 5200)):  # sparse grit: dense speckle reads as snow
            x, y = rnd.uniform(a, b), rnd.uniform(0, size)
            r = rnd.uniform(size * 0.0015, size * 0.0045)
            col = mix(SAND_EDGE, INK, 0.55) if rnd.random() < 0.6 else mix(SAND, (0, 0, 0), 0.55)
            gd.ellipse([x - r, y - r, x + r, y + r], fill=col + (rnd.randint(26, 62),))
        edge = float(x0 if side == 0 else x1)
        sgn = 1 if side == 0 else -1
        pts = [(edge - sgn * size * 0.010 * math.sin(y / size * math.tau * 3), y)
               for y in range(0, size + 1, max(1, size // 48))]
        gd.line(pts, fill=mix(SAND_EDGE, CYAN, 0.42) + (200,), width=max(2, size // 170))
        for k in range(4):  # reeds leaning into the channel
            y = size * (0.14 + 0.24 * k)
            dx = size * 0.055
            base = edge + sgn * size * 0.022
            gd.line([(base, y), (base + sgn * dx, y - dx * 0.85)], fill=(126, 148, 96, 215), width=max(2, size // 200))
            gd.line([(base, y + dx * 0.25), (base + sgn * dx * 0.62, y - dx * 0.5)],
                    fill=(126, 148, 96, 150), width=max(1, size // 260))
    return grit


def lens_path(d, bx, by, bw, bh, fill, outline=None, width=0):
    """Top-down leaf hull: two half-ellipses meeting at a pointed bow and stern."""
    d.chord([bx, by, bx + bw, by + bh], -90, 90, fill=fill, outline=outline, width=width)
    d.chord([bx, by, bx + bw, by + bh], 90, 270, fill=fill, outline=outline, width=width)
    return by + bh / 2.0


def draw_boat(size, rnd, crew=3):
    art, d = layer(size)
    bw, bh = size * 0.50, size * 0.22
    bx, by = (size - bw) / 2, size * 0.50
    mid = by + bh / 2.0
    d.ellipse([bx + bw * 0.04, by + bh * 0.16, bx + bw * 1.00, by + bh * 1.06], fill=(0, 0, 0, 60))
    lens_path(d, bx, by, bw, bh, HULL, HULL_DARK, max(2, size // 210))
    pad = bh * 0.26
    lens_path(d, bx + bw * 0.07, by + pad, bw * 0.86, bh - pad * 2, DECK)
    half_h = (bh - pad * 2) / 2.0
    for k in range(4):  # deck planks, clipped to the lens
        y = mid + half_h * ((k + 0.5) / 2.0 - 0.75)
        half = math.sqrt(max(0.0, 1 - ((y - mid) / half_h) ** 2)) * (bw * 0.86 / 2.0)
        d.line([(size / 2 - half, y), (size / 2 + half, y)], fill=(255, 244, 226, 26), width=max(1, size // 340))
    slot = (bw * 0.68) / crew
    x0 = (size - bw * 0.68) / 2
    r = min(slot * 0.40, bh * 0.38)
    for k in range(crew):
        cx = x0 + slot * (k + 0.5)
        cy = mid - bh * 0.02
        col = SKIN[KIND_ORDER[k % 4]]
        d.ellipse([cx - r * 0.92, cy - r * 0.30, cx + r * 0.92, cy + r * 0.36], fill=(0, 0, 0, 52))
        d.ellipse([cx - r, cy - r * 2.1, cx + r, cy - r * 0.1], fill=mix(col, (0, 0, 0), 0.25))
        d.pieslice([cx - r, cy - r * 2.1, cx + r, cy - r * 0.1], 200, 340, fill=mix(col, INK, 0.34))
        d.ellipse([cx - r, cy - r * 2.1, cx + r, cy - r * 0.1], outline=(12, 16, 22, 200), width=max(2, size // 280))
    bow, ly = bx + bw * 0.965, mid
    halo, hd = layer(size)
    hr = size * 0.105
    for i in range(16, 0, -1):
        t = i / 16.0
        hd.ellipse([bow - hr * t, ly - hr * t, bow + hr * t, ly + hr * t],
                   fill=(AMBER[0], AMBER[1], AMBER[2], int(26 * (1 - t) ** 2)))
    lr = size * 0.034
    hd.ellipse([bow - lr, ly - lr, bow + lr, ly + lr], fill=AMBER + (255,))
    hd.ellipse([bow - lr * 0.45, ly - lr * 0.5, bow + lr * 0.35, ly + lr * 0.2], fill=(255, 240, 210, 255))
    art.alpha_composite(halo)
    return art


def draw_moon(size):
    art, d = layer(size)
    mx, my, r = size * 0.845, size * 0.135, size * 0.042
    for i in range(10, 0, -1):  # bloom first, so the disc stays crisp
        t = i / 10.0
        rr = r * (1 + 1.7 * t)
        d.ellipse([mx - rr, my - rr, mx + rr, my + rr], fill=(214, 232, 246, int(10 * (1 - t))))
    d.ellipse([mx - r, my - r, mx + r, my + r], fill=(238, 244, 250, 250))
    d.ellipse([mx - r * 0.44, my - r * 0.30, mx + r * 0.08, my + r * 0.22], fill=(205, 219, 233, 215))
    d.ellipse([mx + r * 0.16, my + r * 0.08, mx + r * 0.56, my + r * 0.48], fill=(212, 225, 237, 205))
    return art


def draw_seal(size, x, y, box):
    """朱印：有中文就刻「渡」，没字体就画一方几何印，两条路都是真像素。"""
    art, d = layer(size)
    f = font_for(int(box * 0.72))
    d.rounded_rectangle([x, y, x + box, y + box], radius=box * 0.12, fill=(SEAL_RED[0], SEAL_RED[1], SEAL_RED[2], 236))
    d.rounded_rectangle([x + box * 0.1, y + box * 0.1, x + box * 0.9, y + box * 0.9],
                        radius=box * 0.09, outline=(240, 226, 214, 215), width=max(2, int(box * 0.045)))
    if f is not None:
        tb = d.textbbox((0, 0), '渡', font=f)
        d.text((x + (box - (tb[2] - tb[0])) / 2 - tb[0], y + (box - (tb[3] - tb[1])) / 2 - tb[1]),
               '渡', font=f, fill=(244, 232, 220, 246))
    else:
        d.line([(x + box * 0.3, y + box * 0.32), (x + box * 0.7, y + box * 0.32)], fill=(244, 232, 220, 235), width=box // 12)
        d.line([(x + box * 0.5, y + box * 0.3), (x + box * 0.5, y + box * 0.72)], fill=(244, 232, 220, 235), width=box // 14)
        d.line([(x + box * 0.3, y + box * 0.7), (x + box * 0.7, y + box * 0.7)], fill=(244, 232, 220, 235), width=box // 12)
    return art


def icon_master(size=1024):
    rnd = random.Random(SEED)
    img = radial_bg(size, size, mix(WATER_TOP, BG, 0.35), mix(BG, (0, 0, 0), 0.35)).convert('RGBA')
    d = ImageDraw.Draw(img)
    x0, x1 = int(size * 0.26), int(size * 0.74)
    river = draw_river(d, size, x0, x1, rnd)
    banks = draw_banks(d, size, x0, x1, rnd)
    img.alpha_composite(river)
    img.alpha_composite(banks)
    img.alpha_composite(draw_moon(size))
    img.alpha_composite(draw_boat(size, rnd))
    img.alpha_composite(draw_seal(size, size * 0.795, size * 0.76, size * 0.13))
    return img


def maskable_variant(master):
    size = master.width
    bg = radial_bg(size, size, mix(WATER_TOP, BG, 0.5), mix(BG, (0, 0, 0), 0.45)).convert('RGBA')
    inner = master.resize((int(size * 0.80), int(size * 0.80)), Image.LANCZOS)
    bg.alpha_composite(inner, ((size - inner.width) // 2, (size - inner.height) // 2))
    return bg


def og_cover(master, w=1200, h=630):
    art = master.resize((h, h), Image.LANCZOS)
    img = radial_bg(w, h, mix(WATER_TOP, BG, 0.55), mix(BG, (0, 0, 0), 0.4)).convert('RGBA')
    img.paste(art, (0, 0), art)
    # The art is opaque, so the text panel has to be laid down *after* the paste.
    band = Image.new('RGBA', (w - h, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bw = band.width
    for x in range(bw):  # a soft left edge so the river bleeds into the copy
        a = int(250 * min(1.0, (x / (bw * 0.22)) ** 0.7))
        bd.line([(x, 0), (x, h)], fill=(BG[0], BG[1], BG[2], a))
    img.alpha_composite(band, (h, 0))
    d = ImageDraw.Draw(img)
    f_big, f_mid, f_sm, f_xs = (font_for(int(h * 0.19)), font_for(int(h * 0.072)),
                                font_for(int(h * 0.048)), font_for(int(h * 0.040)))
    x = h + int(w * 0.045)
    right = w - int(w * 0.035)
    if f_big:
        d.text((x, h * 0.14), '迷津渡', font=f_big, fill=INK + (255,))
        d.text((x + 4, h * 0.36), 'FERRY', font=f_mid, fill=CYAN + (235,))
    else:
        d.rounded_rectangle([x, h * 0.18, x + int(w * 0.26), h * 0.40], radius=18, outline=CYAN + (200,), width=5)
    for i, line in enumerate([
        '每一渡的「最少单程」由 2^(n+1) 状态图上的 BFS 量出',
        '艄公船 / 自由船 两种口径 · 24 渡战役 + 每日一渡 + 随渡',
    ]):
        if f_sm:
            d.text((x + 4, h * 0.50 + i * h * 0.085), line, font=f_sm, fill=(214, 232, 246, 240))
    d.line([(x + 4, h * 0.76), (right, h * 0.76)], fill=(214, 232, 246, 70), width=2)
    if f_xs:
        d.text((x + 4, h * 0.80), 'Electron · Canvas · 零依赖', font=f_xs, fill=(141, 155, 176, 240))
    return img


def water_texture(n=256):
    rnd = random.Random(SEED + 7)
    field = fbm(n, [n // 2, n // 6, n // 20], SEED + 11)
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    px = img.load()
    for y in range(n):
        for x in range(n):
            v = field[y][x]
            crest = max(0.0, (v - 0.52)) * 2.2
            # alpha is quantised to 1/8 steps: per-pixel entropy would make the tile un-compressible
            a = int(min(70, crest * 90) // 8 * 8)
            col = mix(CYAN, (214, 236, 250, ), 0.35) if crest > 0.34 else WATER_TOP
            px[x, y] = (col[0], col[1], col[2], a)
    d = ImageDraw.Draw(img)
    for k in range(9):  # ripple crests as sine strokes, period divides n so the tile is seamless
        y0 = int((k + 0.5) * n / 9)
        phase = rnd.random() * math.tau
        pts = [(i, y0 + math.sin(i / n * math.tau * 3 + phase) * n * 0.012) for i in range(0, n + 1, 4)]
        d.line(pts, fill=(CYAN[0], CYAN[1], CYAN[2], 26), width=2)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def sand_texture(n=256):
    field = fbm(n, [64, 22, 7], SEED + 23)
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    px = img.load()
    for y in range(n):
        for x in range(n):
            v = field[y][x]
            lit = mix(SAND_EDGE, INK, 0.12)
            dark = mix(SAND, (0, 0, 0), 0.5)
            col = mix(dark, lit, max(0.0, min(1.0, (v - 0.32) * 1.7)))
            px[x, y] = (col[0], col[1], col[2], int(38 + 62 * max(0.0, v - 0.4)))
    return img


def glow_texture(n=128):
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    px = img.load()
    c = (n - 1) / 2.0
    for y in range(n):
        for x in range(n):
            t = min(1.0, math.hypot(x - c, y - c) / c)
            a = int(255 * (1 - t) ** 2.6)
            px[x, y] = (AMBER[0], int(AMBER[1] * 0.92 + 40), int(AMBER[2] * 0.72 + 30), a)
    return img


def seal_texture(n=160):
    return draw_seal(n, int(n * 0.06), int(n * 0.06), int(n * 0.88))


def token_sheet(cell=128):
    """四格角色皮：艄公（桨）/ 人（斗篷）/ 兽（双耳）/ 货（箱角），和 view.js 的 kind 标记同源。"""
    img = Image.new('RGBA', (cell * len(KIND_ORDER), cell), (0, 0, 0, 0))
    for i, kind in enumerate(KIND_ORDER):
        d = ImageDraw.Draw(img)
        cx = cell * i + cell / 2
        cy = cell / 2
        r = cell * 0.40
        body = SKIN[kind]
        for t in range(10, 0, -1):  # soft drop shadow under the token
            k = t / 10.0
            d.ellipse([cx - r * k, cy - r * k + cell * 0.03, cx + r * k, cy + r * k + cell * 0.03],
                      fill=(0, 0, 0, int(20 * (1 - k))))
        # shaded disc: two arcs of highlight so it reads as a lantern-lit round stamp
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=mix(body, (0, 0, 0), 0.28))
        d.pieslice([cx - r, cy - r, cx + r, cy + r], 200, 340, fill=mix(body, INK, 0.30))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(12, 16, 22, 200), width=max(2, cell // 48))
        ink = (12, 16, 22, 210)
        if kind == 'beast':
            for s in (-1, 1):
                d.polygon([(cx + s * r * 0.5, cy - r * 0.72), (cx + s * r * 0.9, cy - r * 1.4),
                           (cx + s * r * 0.12, cy - r * 0.95)], fill=ink)
        elif kind == 'goods':
            d.rectangle([cx - r * 0.46, cy - r * 0.46, cx + r * 0.46, cy + r * 0.46], outline=ink, width=cell // 40)
            d.line([(cx - r * 0.46, cy - r * 0.46), (cx + r * 0.46, cy + r * 0.46)], fill=ink, width=cell // 56)
        elif kind == 'ferryman':
            d.line([(cx - r * 1.15, cy + r * 0.95), (cx + r * 1.15, cy - r * 0.95)], fill=ink, width=cell // 26)
            d.ellipse([cx + r * 0.75, cy - r * 1.15, cx + r * 1.25, cy - r * 0.65], fill=ink)
        else:
            d.pieslice([cx - r * 0.66, cy - r * 0.9, cx + r * 0.66, cy + r * 0.42], 180, 360, outline=ink,
                       width=cell // 34)
    return img


def write(img, rel, out_root):
    path = os.path.join(out_root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=ROOT)
    args = ap.parse_args()
    out = os.path.abspath(args.out)

    master = icon_master(1024)
    jobs = [(master, 'icons/icon-1024.png')]
    for s in (512, 192, 180, 48, 32, 16):
        rel = {512: 'icons/icon-512.png', 192: 'icons/icon-192.png', 180: 'icons/apple-touch-icon.png',
               48: 'icons/favicon-48.png', 32: 'icons/favicon-32.png', 16: 'icons/favicon-16.png'}[s]
        jobs.append((master.resize((s, s), Image.LANCZOS), rel))
    jobs.append((maskable_variant(master), 'icons/icon-maskable-512.png'))
    jobs.append((og_cover(master), 'icons/og-cover.png'))
    jobs.append((water_texture(256), 'assets/textures/water-night.png'))
    jobs.append((sand_texture(256), 'assets/textures/sand-grain.png'))
    jobs.append((glow_texture(128), 'assets/textures/glow.png'))
    jobs.append((seal_texture(160), 'assets/textures/seal.png'))
    jobs.append((token_sheet(128), 'assets/sprites/tokens.png'))

    for img, rel in jobs:
        p = write(img, rel, out)
        print(f'{os.path.relpath(p, out):38s} {img.width}x{img.height} {img.mode} '
              f'{os.path.getsize(p)} bytes')
    print(f'OK {len(jobs)} files -> {out}')


if __name__ == '__main__':
    sys.exit(main())
