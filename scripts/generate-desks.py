"""Reproducible desk layers. Requires Pillow: uv run --with pillow scripts/generate-desks.py.

Each layer is drawn at one art pixel per CSS pixel and saved at 2x (nearest), so it stays crisp
on Retina and when the scene scales. Boxes are in desk-station coordinates (164x238) and must
match `DESK_BOXES` / `DESK_MONITORS` in src/shared/desks.ts.

The glowing screen glass stays CSS (`.desk-screen`): monitors draw only casing and stand.
The default pieces (green fabric chair, cup, plant, basic bezel) copy today's CSS pixel for pixel.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'sprites' / 'desk'
SCALE = 2

CHAIR_BOX = (52, 92, 60, 62)
MONITOR_BOX = (4, 100, 84, 52)
ITEM_BOX = (20, 26)
# The station rect of each monitor's glass, border included (see DESK_MONITORS).
SCREENS = {
    'basic': [(34, 122, 32, 20)],
    'wide': [(22, 120, 50, 22)],
    'crt': [(31, 117, 32, 22)],
    'laptop': [(33, 121, 32, 21)],
    'dual': [(9, 124, 28, 19), (40, 122, 30, 20)],
}


def hex_(value, alpha=255):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


class Art:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.img = Image.new('RGBA', (w, h))

    def put(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.img.putpixel((x, y), hex_(c) if isinstance(c, str) else c)

    def rect(self, x, y, w, h, c):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.put(xx, yy, c)

    def rrect(self, x, y, w, h, c, top=0, bottom=0):
        """A filled box with CSS-like rounded corners; `c` may be a function of (dx, dy)."""
        for yy in range(h):
            for xx in range(w):
                r = top if yy < h / 2 else bottom
                cx = r - 0.5 if xx < r else (w - r - 0.5 if xx >= w - r else None)
                cy = r - 0.5 if yy < r else (h - r - 0.5 if yy >= h - r else None)
                if r and cx is not None and cy is not None:
                    if (xx - cx) ** 2 + (yy - cy) ** 2 > r * r:
                        continue
                self.put(x + xx, y + yy, c(xx, yy) if callable(c) else c)

    def line(self, x0, y0, x1, y1, c, width=2):
        steps = max(abs(x1 - x0), abs(y1 - y0))
        for i in range(steps + 1):
            x = round(x0 + (x1 - x0) * i / steps)
            y = round(y0 + (y1 - y0) * i / steps)
            self.rect(x, y, width, width, c)

    def rows(self, x, y, w, bands):
        """Horizontal bands top-down: [(height, colour), ...]."""
        for h, c in bands:
            self.rect(x, y, w, h, c)
            y += h

    def pattern(self, x, y, lines, colours):
        for dy, line in enumerate(lines):
            for dx, ch in enumerate(line):
                if ch in colours:
                    self.put(x + dx, y + dy, colours[ch])

    def save(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        self.img.resize((self.w * SCALE, self.h * SCALE), Image.Resampling.NEAREST).save(
            OUT / f'{name}.png', optimize=True)


# Chairs ------------------------------------------------------------------------------------
FABRIC = {
    # name: (fabric, light, frame, drop, base, base side)
    'green': ('#4e665b', '#95a696', '#33443f', '#2c3733', '#3e4842', '#2c3530'),
    'navy': ('#3d4c78', '#8d9cc9', '#262f4d', '#1f2740', '#3a3f52', '#262a39'),
    'pink': ('#c47790', '#efb6c5', '#7a4054', '#653444', '#4d3a42', '#36282e'),
}


def fabric_chair(name):
    fabric, light, frame, drop, base, side = FABRIC[name]
    a = Art(*CHAIR_BOX[2:])
    # Today's `.office-chair` at (60,105), 44x36 with a 3px frame and a 4px drop shadow.
    x, y = 60 - CHAIR_BOX[0], 105 - CHAIR_BOX[1]
    a.rrect(x, y + 4, 44, 36, drop, top=7, bottom=2)
    a.rrect(x, y, 44, 36, frame, top=7, bottom=2)
    # The padding box: light 4px, fabric, a light seam at 23px, fabric again.
    a.rrect(x + 3, y + 3, 38, 30, lambda _, dy: light if dy < 4 or 23 <= dy < 27 else fabric,
            top=4)
    # The base (`::after`): 28x6, 4px darker ends, 12px under the seat.
    a.rows(x + 8, y + 39, 28, [(6, base)])
    a.rect(x + 8, y + 39, 4, 6, side)
    a.rect(x + 32, y + 39, 4, 6, side)
    return a


def gaming_chair():
    a = Art(*CHAIR_BOX[2:])
    ink, body, hi, red, red_dark = '#16161c', '#2b2b35', '#45454f', '#e2544c', '#a8352f'
    # A tall racing back whose headrest and red wings rise past the pet; star base below.
    a.rrect(10, 0, 40, 52, ink, top=9, bottom=3)
    a.rrect(12, 2, 36, 48, body, top=7, bottom=2)
    a.rect(15, 3, 30, 2, hi)
    a.rrect(19, 5, 22, 8, red_dark, top=3, bottom=3)
    a.rrect(20, 6, 20, 6, red, top=2, bottom=2)
    a.rect(23, 7, 14, 1, '#f08a82')
    # Racing stripes down the back.
    a.rect(16, 14, 4, 34, red)
    a.rect(40, 14, 4, 34, red)
    a.rect(19, 14, 1, 34, red_dark)
    a.rect(40, 14, 1, 34, red_dark)
    # Side wings, red-trimmed so they read around the pet.
    for x in (4, 49):
        a.rrect(x, 16, 7, 32, ink, top=3, bottom=2)
        a.rrect(x + 1, 17, 5, 30, body, top=2, bottom=1)
        a.rect(x + (1 if x < 20 else 4), 18, 1, 28, red)
    # Drop shadow and base.
    a.rect(12, 52, 36, 2, '#1d1d24')
    a.rect(26, 52, 8, 4, ink)
    a.rect(16, 55, 28, 3, '#3a3a44')
    a.rect(16, 55, 4, 3, ink)
    a.rect(40, 55, 4, 3, ink)
    a.put(14, 58, ink)
    a.put(45, 58, ink)
    return a


def stool():
    a = Art(*CHAIR_BOX[2:])
    top, wood, edge, leg, ink = '#f0cc96', '#cea36f', '#9b7349', '#7a5638', '#4b3326'
    # A round wooden seat with three legs; no back, so the pet sits in the open.
    a.rrect(12, 34, 36, 10, ink, top=4, bottom=4)
    a.rrect(13, 35, 34, 8, wood, top=3, bottom=3)
    a.rect(15, 35, 30, 2, top)
    a.rect(14, 41, 32, 2, edge)
    for x in (16, 28, 40):
        a.rect(x, 44, 4, 12, leg)
        a.rect(x, 44, 1, 12, ink)
        a.rect(x, 55, 4, 2, ink)
    a.rect(18, 49, 24, 2, edge)
    return a


# Monitors ----------------------------------------------------------------------------------
BEZEL, LIP, GLASS = '#2f3532', '#4b4f45', '#3d4a47'


def mpos(x, y):
    return x - MONITOR_BOX[0], y - MONITOR_BOX[1]


def screen(a, rect):
    """The bezel and lip CSS draws over the glass (copied so the PNG also reads alone)."""
    sx, sy, w, h = rect
    x, y = mpos(sx, sy)
    a.rect(x + 1, y + 5, w - 2, h - 2, LIP)
    a.rrect(x, y, w, h, BEZEL, top=2, bottom=2)
    a.rect(x + 3, y + 3, w - 6, h - 6, GLASS)


def stand(a, cx, top, neck=6, foot=20):
    x, y = mpos(cx, top)
    a.rect(x - neck // 2, y, neck, 4, LIP)
    a.rect(x - neck // 2, y, 1, 4, '#3a3d36')
    a.rect(x - foot // 2, y + 3, foot, 3, '#3a3d36')
    a.rect(x - foot // 2 + 1, y + 3, foot - 2, 1, '#6a6e63')


def monitor(name):
    a = Art(*MONITOR_BOX[2:])
    if name == 'basic':
        screen(a, SCREENS['basic'][0])
    elif name == 'wide':
        stand(a, 47, 142, foot=24)
        screen(a, SCREENS['wide'][0])
    elif name == 'crt':
        shell, shade, ink, light = '#e6d9ba', '#c4b48d', '#6d6352', '#f6eedb'
        x, y = mpos(25, 112)
        a.rrect(x + 4, y - 3, 36, 6, ink, top=3)
        a.rect(x + 5, y - 2, 34, 4, shade)
        a.rrect(x, y, 44, 37, ink, top=3, bottom=2)
        a.rrect(x + 1, y + 1, 42, 35, shell, top=2, bottom=1)
        a.rect(x + 1, y + 1, 42, 2, light)
        a.rect(x + 1, y + 32, 42, 4, shade)
        screen(a, SCREENS['crt'][0])
        # Chin: power light and vents.
        a.rect(x + 35, y + 30, 3, 2, '#7fd99f')
        for vx in range(x + 6, x + 22, 3):
            a.rect(vx, y + 30, 2, 1, shade)
    elif name == 'laptop':
        lid, lid_dark, deck, deck_dark, ink = '#cfd5dc', '#9aa3ad', '#dde2e7', '#a7afb8', '#5a6169'
        x, y = mpos(31, 119)
        a.rrect(x, y, 36, 25, ink, top=3)
        a.rrect(x + 1, y + 1, 34, 23, lid, top=2)
        a.rect(x + 1, y + 22, 34, 2, lid_dark)
        screen(a, SCREENS['laptop'][0])
        # The deck in perspective: wider toward the person.
        bx, by = mpos(27, 143)
        for i, w in enumerate((40, 42, 44)):
            a.rect(bx + (44 - w) // 2, by + i, w, 1, deck)
        a.rect(bx, by + 3, 44, 2, deck_dark)
        a.rect(bx + 18, by + 1, 8, 1, lid_dark)
        a.rect(bx - 1, by + 3, 1, 2, ink)
        a.rect(bx + 44, by + 3, 1, 2, ink)
    elif name == 'dual':
        stand(a, 23, 143, neck=4, foot=14)
        stand(a, 55, 142, neck=4, foot=16)
        for rect in SCREENS['dual']:
            screen(a, rect)
    return a


# Desk items --------------------------------------------------------------------------------
def item(draw):
    a = Art(*ITEM_BOX)
    draw(a)
    return a


def cup(a):
    # Today's `.desk-cup` at (4,10) in the right slot, with both of its box shadows.
    cream, rim, drop = '#f2e6c6', '#6b4f3c', '#b28c64'
    a.rect(4, 12, 11, 13, drop)
    a.rect(8, 13, 10, 11, cream)
    a.rect(4, 10, 11, 3, rim)
    a.rect(4, 13, 11, 10, cream)


def plant(a):
    # Today's `.desk-plant` at (4,8) in the right slot.
    a.rect(7, 4, 10, 14, '#679572')
    a.rect(4, 8, 10, 7, '#548260')
    a.rect(4, 15, 10, 7, '#bc8162')


def lamp(a):
    ink, metal, shade, shade_dark, glow = '#3b3b45', '#6b6d7a', '#ecc15f', '#b98a2e', '#fff3c4'
    # Base, a jointed arm up and back, and a dome shade over the desk.
    a.rrect(4, 22, 12, 3, ink, top=1)
    a.rect(5, 22, 10, 1, metal)
    a.line(9, 21, 14, 12, ink)
    a.line(14, 12, 9, 5, ink)
    a.put(14, 12, metal)
    a.put(15, 13, metal)
    a.rrect(1, 3, 11, 6, shade_dark, top=4)
    a.rrect(2, 4, 9, 4, shade, top=3)
    a.rect(3, 4, 3, 1, '#f8dd94')
    a.rect(2, 9, 9, 1, glow)
    a.rect(3, 10, 7, 1, (255, 243, 196, 150))
    a.rect(4, 11, 5, 1, (255, 243, 196, 70))


def books(a):
    # Bottom up: (width, cover, spine shade); each book is 3px thick with a 1px gap.
    stack = [(18, '#3f7cac', '#2b5a80'), (16, '#c8553d', '#94392a'),
             (17, '#e9c46a', '#b8933e'), (15, '#6a9e74', '#4b7553')]
    for i, (w, c, dark) in enumerate(stack):
        x, y = (20 - w) // 2 + (1 if i % 2 else 0), 21 - i * 4
        a.rect(x, y, w, 3, dark)
        a.rect(x, y, w - 2, 2, c)
        a.rect(x + w - 3, y + 1, 2, 1, '#f6ecd4')
    a.rect(2, 24, 16, 1, (60, 40, 30, 90))


def cat(a):
    ink, fur, shade, pink = '#3a2f36', '#fbf3e6', '#e2d3bf', '#ef9fae'
    a.pattern(4, 6, [
        '.k......k.',
        'kfk....kfk',
        'kffkkkkffk',
        'kfffffffffk',
    ], {'k': ink, 'f': fur})
    a.rrect(4, 9, 12, 8, ink, top=4, bottom=2)
    a.rrect(5, 10, 10, 6, fur, top=3, bottom=1)
    a.put(5, 7, pink)
    a.put(13, 7, pink)
    a.put(7, 12, ink)
    a.put(12, 12, ink)
    a.put(9, 13, pink)
    a.put(10, 13, pink)
    a.rrect(4, 16, 12, 9, ink, top=3, bottom=2)
    a.rrect(5, 17, 10, 7, fur, top=2)
    a.rect(5, 22, 10, 2, shade)
    a.rect(8, 17, 4, 2, '#e8606a')
    a.put(9, 19, '#f2c24f')
    a.rect(15, 19, 3, 2, ink)
    a.rect(16, 18, 2, 1, ink)
    a.rect(16, 20, 1, 1, fur)


def cactus(a):
    green, dark, light, pot, pot_dark = '#5f9f62', '#3f7445', '#8cc583', '#c97b56', '#94533a'
    a.rrect(8, 5, 5, 14, dark, top=2)
    a.rrect(9, 6, 3, 13, green, top=1)
    a.rect(9, 7, 1, 10, light)
    a.rrect(4, 9, 3, 7, dark, top=1)
    a.rect(5, 10, 1, 6, green)
    a.rect(4, 14, 5, 2, dark)
    a.rrect(14, 7, 3, 7, dark, top=1)
    a.rect(15, 8, 1, 5, green)
    a.rect(12, 12, 4, 2, dark)
    a.rect(9, 3, 3, 2, '#f08aa5')
    a.put(10, 2, '#f8c2d0')
    a.rect(5, 18, 11, 2, pot_dark)
    a.rect(6, 20, 9, 5, pot)
    a.rect(6, 20, 9, 1, pot_dark)
    a.rect(13, 21, 2, 4, pot_dark)


def duck(a):
    ink, body, shade, beak = '#5b4316', '#ffd84a', '#e8b52c', '#f08a3c'
    a.rrect(7, 6, 9, 8, ink, top=4, bottom=3)
    a.rrect(8, 7, 7, 6, body, top=3, bottom=2)
    a.rrect(3, 12, 15, 10, ink, top=4, bottom=4)
    a.rrect(4, 13, 13, 8, body, top=3, bottom=3)
    a.rect(5, 18, 11, 3, shade)
    a.rect(15, 9, 4, 2, ink)
    a.rect(15, 10, 3, 1, beak)
    a.rect(16, 9, 2, 1, beak)
    a.put(12, 9, ink)
    a.rect(4, 14, 3, 3, shade)
    a.rect(9, 8, 2, 1, '#fff2a8')
    a.rect(4, 22, 13, 1, (60, 40, 30, 80))


def frame(a):
    wood, wood_dark, sky, hill, sun = '#b07a4f', '#7a5034', '#9fd0ee', '#79b46e', '#ffd56b'
    a.rect(2, 6, 16, 18, wood_dark)
    a.rect(3, 7, 14, 16, wood)
    a.rect(5, 9, 10, 12, sky)
    a.rect(5, 17, 10, 4, hill)
    a.rect(8, 15, 5, 2, hill)
    a.rect(11, 10, 2, 2, sun)
    a.rect(5, 9, 10, 1, '#c8e6f7')
    a.rect(3, 23, 14, 1, wood_dark)
    a.rect(15, 23, 2, 2, wood_dark)


ITEMS = {'cup': cup, 'plant': plant, 'lamp': lamp, 'books': books, 'cat': cat,
         'cactus': cactus, 'duck': duck, 'frame': frame}


def main():
    for name in FABRIC:
        fabric_chair(name).save(f'chair-{name}')
    gaming_chair().save('chair-gaming')
    stool().save('chair-stool')
    for name in SCREENS:
        monitor(name).save(f'monitor-{name}')
    for name, draw in ITEMS.items():
        item(draw).save(f'item-{name}')


if __name__ == '__main__':
    main()
