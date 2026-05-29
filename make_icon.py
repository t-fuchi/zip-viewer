#!/usr/bin/env python3
"""
Generate Zip Viewer VS Code extension icon.
Concept: Open archive/box with stacked file icons visible inside + magnifying glass.
Render at 512px, downsample to 128px with Lanczos.
"""

import math
from PIL import Image, ImageDraw, ImageFilter

S = 512  # working size

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# ── helpers ──────────────────────────────────────────────────────────────────

def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(len(c1)))

def rounded_rect(draw, xy, radius, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = xy
    r = radius
    # four corners + body
    draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
    draw.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
    draw.ellipse([x0, y0, x0 + 2*r, y0 + 2*r], fill=fill)
    draw.ellipse([x1 - 2*r, y0, x1, y0 + 2*r], fill=fill)
    draw.ellipse([x0, y1 - 2*r, x0 + 2*r, y1], fill=fill)
    draw.ellipse([x1 - 2*r, y1 - 2*r, x1, y1], fill=fill)
    if outline:
        # draw outline as a thick rounded rect border
        rounded_rect_outline(draw, xy, radius, outline, width)

def rounded_rect_outline(draw, xy, radius, color, width):
    x0, y0, x1, y1 = xy
    r = radius
    w = width
    for i in range(w):
        o = i
        draw.arc([x0+o, y0+o, x0+2*r-o, y0+2*r-o], 180, 270, fill=color)
        draw.arc([x1-2*r+o, y0+o, x1-o, y0+2*r-o], 270, 360, fill=color)
        draw.arc([x0+o, y1-2*r+o, x0+2*r-o, y1-o], 90, 180, fill=color)
        draw.arc([x1-2*r+o, y1-2*r+o, x1-o, y1-o], 0, 90, fill=color)
        draw.line([x0+r, y0+o, x1-r, y0+o], fill=color)
        draw.line([x0+r, y1-o, x1-r, y1-o], fill=color)
        draw.line([x0+o, y0+r, x0+o, y1-r], fill=color)
        draw.line([x1-o, y0+r, x1-o, y1-r], fill=color)

# ── background gradient (dark navy → VS Code blue) ───────────────────────────
bg = Image.new("RGBA", (S, S))
bg_draw = ImageDraw.Draw(bg)
top_col    = (0,  30,  80, 255)
bottom_col = (0,  90, 180, 255)
for y in range(S):
    t = y / S
    c = lerp_color(top_col, bottom_col, t)
    bg_draw.line([(0, y), (S, y)], fill=c)

# Rounded background card
bg_radius = 64
bg2 = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bg2_draw = ImageDraw.Draw(bg2)
rounded_rect(bg2_draw, (0, 0, S-1, S-1), bg_radius, fill=(255, 255, 255, 255))
bg.putalpha(bg2.split()[3])
img = Image.alpha_composite(Image.new("RGBA", (S, S), (0, 0, 0, 0)), bg)
draw = ImageDraw.Draw(img)

# Re-draw background with rounded mask
bg_flat = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bg_flat_draw = ImageDraw.Draw(bg_flat)
for y in range(S):
    t = y / S
    c = lerp_color(top_col, bottom_col, t)
    bg_flat_draw.line([(0, y), (S, y)], fill=c)

mask = Image.new("L", (S, S), 0)
mask_draw = ImageDraw.Draw(mask)
# Draw rounded rect in mask
x0, y0, x1, y1 = 0, 0, S-1, S-1
r = bg_radius
mask_draw.rectangle([x0+r, y0, x1-r, y1], fill=255)
mask_draw.rectangle([x0, y0+r, x1, y1-r], fill=255)
mask_draw.ellipse([x0, y0, x0+2*r, y0+2*r], fill=255)
mask_draw.ellipse([x1-2*r, y0, x1, y0+2*r], fill=255)
mask_draw.ellipse([x0, y1-2*r, x0+2*r, y1], fill=255)
mask_draw.ellipse([x1-2*r, y1-2*r, x1, y1], fill=255)
bg_flat.putalpha(mask)

img = Image.alpha_composite(Image.new("RGBA", (S, S), (0, 0, 0, 0)), bg_flat)
draw = ImageDraw.Draw(img)

# ── BOX BODY (bottom half of open box) ───────────────────────────────────────
# Centered, leaving room for lid on top and magnifier overlapping bottom-right
bx0, by0 = 90, 185
bx1, by1 = 390, 390
box_radius = 28
box_fill   = (0, 60, 130, 255)       # deep blue
box_stroke = (255, 255, 255, 220)    # bright white edge

# Shadow
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sdraw = ImageDraw.Draw(shadow)
rounded_rect(sdraw, (bx0+10, by0+12, bx1+10, by1+12), box_radius, fill=(0, 0, 0, 100))
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
img = Image.alpha_composite(img, shadow)
draw = ImageDraw.Draw(img)

# Box body fill (slightly lighter gradient feel — we paint two rects)
box_body = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bb_draw = ImageDraw.Draw(box_body)
for row in range(by0, by1+1):
    t = (row - by0) / (by1 - by0)
    c = lerp_color((10, 80, 170, 255), (0, 50, 120, 255), t)
    bb_draw.line([(bx0, row), (bx1, row)], fill=c)
box_mask = Image.new("L", (S, S), 0)
bm_draw = ImageDraw.Draw(box_mask)
rounded_rect(bm_draw, (bx0, by0, bx1, by1), box_radius, fill=255)
box_body.putalpha(box_mask)
img = Image.alpha_composite(img, box_body)
draw = ImageDraw.Draw(img)

# Box body stroke
rounded_rect_outline(draw, (bx0, by0, bx1, by1), box_radius, (255, 255, 255, 200), 5)

# ── STACKED FILE ICONS inside the box ────────────────────────────────────────
# Three small document icons, stacked/fanned slightly, suggesting contents
file_w, file_h = 68, 88
fold_size = 18  # dog-ear corner

def draw_file_icon(draw, cx, cy, angle_deg, fill_col, stroke_col, alpha=255):
    """Draw a small document icon centered at cx,cy, rotated by angle_deg."""
    # Create a small image for the file
    pad = 20
    fw = file_w + pad*2
    fh = file_h + pad*2
    fi = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fi)

    x0, y0 = pad, pad
    x1, y1 = pad + file_w, pad + file_h
    fc = fold_size

    # main body (pentagon — top-right corner folded)
    body_pts = [
        (x0, y0),
        (x1 - fc, y0),
        (x1, y0 + fc),
        (x1, y1),
        (x0, y1),
    ]
    fd.polygon(body_pts, fill=fill_col + (alpha,))

    # fold triangle
    fold_pts = [
        (x1 - fc, y0),
        (x1, y0 + fc),
        (x1 - fc, y0 + fc),
    ]
    darker = tuple(max(0, c - 40) for c in fill_col)
    fd.polygon(fold_pts, fill=darker + (alpha,))

    # outline
    fd.line(body_pts + [body_pts[0]], fill=stroke_col + (alpha,), width=4)
    fd.line([(x1-fc, y0), (x1-fc, y0+fc), (x1, y0+fc)], fill=stroke_col + (alpha,), width=3)

    # horizontal lines (text lines)
    lx0, lx1 = x0 + 10, x1 - 10
    for ly in [y0 + 30, y0 + 46, y0 + 62]:
        fd.line([(lx0, ly), (lx1 - (18 if ly == y0+30 else 0), ly)],
                fill=stroke_col + (min(alpha, 160),), width=4)

    # rotate
    fi = fi.rotate(-angle_deg, expand=True, resample=Image.BICUBIC)
    # paste centered
    px = cx - fi.width // 2
    py = cy - fi.height // 2
    img.paste(fi, (px, py), fi)

# Three files: back-left, middle, front-right
file_center_x = (bx0 + bx1) // 2
file_center_y = (by0 + by1) // 2 + 15

# Back file (left-rotated, dimmer)
draw_file_icon(draw, file_center_x - 52, file_center_y + 5,
               -12, (160, 210, 255), (255, 255, 255), alpha=180)
# Middle file
draw_file_icon(draw, file_center_x + 5, file_center_y - 10,
               3, (200, 230, 255), (255, 255, 255), alpha=210)
# Front file (right, slightly right-rotated)
draw_file_icon(draw, file_center_x + 58, file_center_y + 8,
               14, (230, 245, 255), (255, 255, 255), alpha=240)

draw = ImageDraw.Draw(img)

# ── OPEN LID (trapezoid tilted, like a box lid flipped open) ─────────────────
lid_bot_x0, lid_bot_y = bx0 + 8,  by0 + 6
lid_bot_x1             = bx1 - 8
# lid tilted back: top edge is higher and narrower
lid_top_x0, lid_top_y = bx0 + 30, by0 - 88
lid_top_x1             = bx1 - 30

lid_pts = [
    (lid_bot_x0, lid_bot_y),
    (lid_bot_x1, lid_bot_y),
    (lid_top_x1, lid_top_y),
    (lid_top_x0, lid_top_y),
]

# Lid shadow
lid_shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ls_draw = ImageDraw.Draw(lid_shadow)
shifted = [(x+8, y+8) for x, y in lid_pts]
ls_draw.polygon(shifted, fill=(0, 0, 0, 80))
lid_shadow = lid_shadow.filter(ImageFilter.GaussianBlur(12))
img = Image.alpha_composite(img, lid_shadow)
draw = ImageDraw.Draw(img)

# Lid body gradient
lid_img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ld_draw = ImageDraw.Draw(lid_img)
# Fill with gradient by drawing horizontal spans clipped to polygon
# Simple approach: fill solid then we'll rely on the polygon clip
ld_draw.polygon(lid_pts, fill=(20, 100, 200, 255))
# Lighter top strip
lid_highlight = [
    (lid_top_x0, lid_top_y),
    (lid_top_x1, lid_top_y),
    (lid_top_x1, lid_top_y + 18),
    (lid_top_x0, lid_top_y + 18),
]
ld_draw.polygon(lid_highlight, fill=(60, 150, 230, 200))
img = Image.alpha_composite(img, lid_img)
draw = ImageDraw.Draw(img)

# Lid outline
draw.polygon(lid_pts, outline=(255, 255, 255, 220), width=5)

# ── ZIP TEETH / ZIPPER decoration on box front ───────────────────────────────
# Small interlocking zigzag along box top edge (where lid meets body)
tz_y = by0
tz_x0, tz_x1 = bx0 + 30, bx1 - 30
teeth_w = 18
n_teeth = int((tz_x1 - tz_x0) / teeth_w)
for i in range(n_teeth):
    tx = tz_x0 + i * teeth_w
    if i % 2 == 0:
        draw.polygon([
            (tx, tz_y - 4),
            (tx + teeth_w//2, tz_y + 9),
            (tx + teeth_w, tz_y - 4),
        ], fill=(255, 255, 255, 180))
    else:
        draw.polygon([
            (tx, tz_y + 9),
            (tx + teeth_w//2, tz_y - 4),
            (tx + teeth_w, tz_y + 9),
        ], fill=(255, 255, 255, 120))

# ── MAGNIFYING GLASS (bottom-right, overlapping archive) ─────────────────────
mg_cx, mg_cy = 345, 358   # center of lens
mg_r = 88                  # lens outer radius
mg_r_inner = 68            # lens inner (glass) radius
ring_w = mg_r - mg_r_inner  # = 20
handle_angle = 45           # degrees (pointing down-right)
handle_len = 88
handle_w = 22

# Handle shadow
ha = math.radians(handle_angle)
hx0 = mg_cx + mg_r_inner * math.cos(ha)
hy0 = mg_cy + mg_r_inner * math.sin(ha)
hx1 = mg_cx + (mg_r_inner + handle_len) * math.cos(ha)
hy1 = mg_cy + (mg_r_inner + handle_len) * math.sin(ha)
shadow2 = Image.new("RGBA", (S, S), (0, 0, 0, 0))
s2d = ImageDraw.Draw(shadow2)
s2d.line([(hx0+6, hy0+6), (hx1+6, hy1+6)], fill=(0, 0, 0, 120), width=handle_w+6)
s2d.ellipse([mg_cx - mg_r + 6, mg_cy - mg_r + 6,
             mg_cx + mg_r + 6, mg_cy + mg_r + 6], fill=(0, 0, 0, 100))
shadow2 = shadow2.filter(ImageFilter.GaussianBlur(10))
img = Image.alpha_composite(img, shadow2)
draw = ImageDraw.Draw(img)

# Handle
draw.line([(hx0, hy0), (hx1, hy1)], fill=(255, 200, 60, 255), width=handle_w)
# Handle rounded cap
cap_r = handle_w // 2
draw.ellipse([hx1 - cap_r, hy1 - cap_r, hx1 + cap_r, hy1 + cap_r],
             fill=(255, 200, 60, 255))

# Lens outer ring (gold/yellow)
draw.ellipse([mg_cx - mg_r, mg_cy - mg_r, mg_cx + mg_r, mg_cy + mg_r],
             fill=(255, 200, 60, 255))

# Lens glass (semi-transparent light blue with subtle tint)
glass_col = (180, 225, 255, 200)
draw.ellipse([mg_cx - mg_r_inner, mg_cy - mg_r_inner,
              mg_cx + mg_r_inner, mg_cy + mg_r_inner],
             fill=glass_col)

# Lens shimmer (small highlight arc top-left)
shimmer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sh_draw = ImageDraw.Draw(shimmer)
sh_r = mg_r_inner - 8
sh_draw.arc([mg_cx - sh_r, mg_cy - sh_r, mg_cx + sh_r, mg_cy + sh_r],
            200, 290, fill=(255, 255, 255, 180), width=8)
img = Image.alpha_composite(img, shimmer)
draw = ImageDraw.Draw(img)

# ── SUBTLE INNER GLOW on magnifier glass ─────────────────────────────────────
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for ri in range(10, 0, -1):
    alpha = int(30 * (1 - ri/10))
    gd.ellipse([mg_cx - ri*4, mg_cy - ri*4, mg_cx + ri*4, mg_cy + ri*4],
               fill=(255, 255, 255, alpha))
glow = glow.filter(ImageFilter.GaussianBlur(8))
img = Image.alpha_composite(img, glow)
draw = ImageDraw.Draw(img)

# ── FINAL DOWNSAMPLE to 128×128 ───────────────────────────────────────────────
out = img.resize((128, 128), Image.LANCZOS)
out.save("/Volumes/B2000/zip-viewer/images/icon.png", "PNG")
print("Saved: /Volumes/B2000/zip-viewer/images/icon.png")

# Also save the 512px version for reference
img.save("/Volumes/B2000/zip-viewer/images/icon_512.png", "PNG")
print("Saved: /Volumes/B2000/zip-viewer/images/icon_512.png")
