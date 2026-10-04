"""Agent Office — 탑뷰 오피스 맵 생성기 (시안 E).

16px 타일, 20x15 = 320x240 원본. 화면에서는 3배(48px 타일)로 그린다.
- office_bg.png   : 바닥·벽·창문·의자·소파 등받이 등 캐릭터 뒤에 깔리는 것
- desk.png        : 책상 (캐릭터 앞에 와서 다리를 가림, y 정렬)
- sofa_front.png  : 소파 앉는 면 + 팔걸이 (앉은 캐릭터 앞)

좌표는 화면(3배) 기준으로 오피스 아트보드의 스크립트와 맞춘다.
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

W, H = 320, 240
DESK_COLS = [40, 104, 168]      # 책상 중심 x (원본 px)
SEAT_ROWS = [95, 167]           # 앉은 캐릭터 발끝 y (원본 px)

INK = (43, 38, 52)


def rect(d, x0, y0, x1, y1, c):
    d.rectangle([x0, y0, x1, y1], fill=c)


def floor(d):
    base, seam, light = (201, 154, 107), (176, 131, 88), (214, 170, 124)
    rect(d, 0, 48, W - 1, H - 1, base)
    for y in range(48, H, 8):
        rect(d, 0, y, W - 1, y, seam)
        rect(d, 0, y + 1, W - 1, y + 1, light)
        off = 0 if (y // 8) % 2 else 20
        for x in range(off, W, 40):
            rect(d, x, y + 1, x, y + 7, seam)


def wall(d):
    rect(d, 0, 0, W - 1, 7, (59, 74, 94))
    rect(d, 0, 8, W - 1, 43, (143, 179, 201))
    for x in range(0, W, 8):
        rect(d, x, 8, x, 43, (134, 170, 192))
    rect(d, 0, 44, W - 1, 47, (91, 111, 133))
    rect(d, 0, 48, W - 1, 49, (150, 112, 76))


def window(d, x0, y0, w, h):
    rect(d, x0 - 2, y0 - 2, x0 + w + 1, y0 + h + 1, (241, 244, 248))
    rect(d, x0, y0, x0 + w - 1, y0 + h - 1, (191, 227, 245))
    rect(d, x0, y0 + h - 7, x0 + w - 1, y0 + h - 1, (164, 214, 160))
    for i in range(6):
        d.point((x0 + 4 + i, y0 + 10 - i), fill=(235, 248, 255))
        d.point((x0 + 10 + i, y0 + 14 - i), fill=(235, 248, 255))
    rect(d, x0 + w // 2 - 1, y0, x0 + w // 2, y0 + h - 1, (241, 244, 248))
    rect(d, x0, y0 + h // 2 - 1, x0 + w - 1, y0 + h // 2, (241, 244, 248))
    rect(d, x0 - 3, y0 + h + 2, x0 + w + 2, y0 + h + 3, (224, 230, 238))


def whiteboard(d, x0, y0):
    rect(d, x0 - 1, y0 - 1, x0 + 56, y0 + 20, (120, 128, 140))
    rect(d, x0, y0, x0 + 55, y0 + 19, (250, 251, 252))
    rect(d, x0 + 4, y0 + 4, x0 + 22, y0 + 4, (64, 132, 222))
    rect(d, x0 + 4, y0 + 8, x0 + 30, y0 + 8, (64, 132, 222))
    rect(d, x0 + 4, y0 + 12, x0 + 16, y0 + 12, (230, 90, 90))
    rect(d, x0 + 34, y0 + 4, x0 + 50, y0 + 15, (255, 226, 140))
    rect(d, x0 + 36, y0 + 7, x0 + 47, y0 + 7, (180, 140, 60))
    rect(d, x0 + 36, y0 + 10, x0 + 44, y0 + 10, (180, 140, 60))
    rect(d, x0 + 4, y0 + 20, x0 + 52, y0 + 21, (150, 158, 170))


def clock(d, cx, cy):
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(250, 251, 252), outline=INK)
    rect(d, cx, cy - 4, cx, cy, INK)
    rect(d, cx, cy, cx + 3, cy, (230, 90, 90))


def mailbox(d, x0, y0):
    rect(d, x0, y0, x0 + 15, y0 + 15, (232, 92, 92))
    rect(d, x0, y0, x0 + 15, y0 + 1, (255, 140, 140))
    rect(d, x0 + 3, y0 + 5, x0 + 12, y0 + 6, INK)
    rect(d, x0 + 6, y0 + 9, x0 + 9, y0 + 12, (255, 245, 210))
    rect(d, x0 + 6, y0 + 16, x0 + 9, y0 + 21, (120, 128, 140))


def door(d, x0, y0):
    rect(d, x0 - 2, y0 - 2, x0 + 25, 47, (91, 70, 54))
    rect(d, x0, y0, x0 + 23, 47, (255, 236, 179))
    rect(d, x0, y0, x0 + 9, 47, (168, 116, 79))
    rect(d, x0 + 7, y0 + 18, x0 + 8, y0 + 19, (255, 214, 102))
    rect(d, x0 + 2, y0 - 9, x0 + 21, y0 - 4, (63, 160, 110))
    for i, x in enumerate(range(x0 + 4, x0 + 20, 4)):
        rect(d, x, y0 - 8, x + 2, y0 - 5, (230, 255, 240))
    rect(d, x0 - 6, 48, x0 + 29, 53, (176, 131, 88))


def bookshelf(d, x0, y0):
    rect(d, x0, y0, x0 + 31, y0 + 37, (120, 82, 54))
    rect(d, x0 + 2, y0 + 2, x0 + 29, y0 + 35, (92, 62, 40))
    books = [(230, 90, 90), (64, 132, 222), (255, 200, 90), (110, 190, 140), (190, 120, 220), (240, 150, 90)]
    for row, yy in enumerate((y0 + 3, y0 + 15, y0 + 27)):
        x = x0 + 3
        i = row
        while x < x0 + 28:
            bw = 2 + (i % 3)
            bh = 8 + (i % 2)
            rect(d, x, yy + (9 - bh), x + bw - 1, yy + 8, books[i % len(books)])
            x += bw + 1
            i += 1
        rect(d, x0 + 2, yy + 9, x0 + 29, yy + 10, (120, 82, 54))


def coffee(d, x0, y0):
    rect(d, x0, y0 + 10, x0 + 33, y0 + 31, (140, 106, 80))
    rect(d, x0, y0 + 8, x0 + 33, y0 + 12, (230, 224, 214))
    rect(d, x0 + 2, y0 + 14, x0 + 31, y0 + 14, (120, 90, 66))
    rect(d, x0 + 3, y0 - 8, x0 + 16, y0 + 8, (58, 63, 75))
    rect(d, x0 + 5, y0 - 6, x0 + 14, y0 - 1, (91, 98, 114))
    rect(d, x0 + 12, y0 - 5, x0 + 13, y0 - 4, (255, 90, 90))
    rect(d, x0 + 8, y0 + 3, x0 + 11, y0 + 7, (250, 251, 252))
    for i, c in enumerate([(250, 251, 252), (255, 200, 210), (190, 220, 255)]):
        rect(d, x0 + 20 + i * 4, y0 + 3, x0 + 22 + i * 4, y0 + 7, c)


def plant(d, cx, by, big=False):
    s = 2 if big else 1
    rect(d, cx - 4 * s, by - 6 * s, cx + 3 * s, by, (214, 120, 78))
    rect(d, cx - 4 * s, by - 6 * s, cx + 3 * s, by - 5 * s, (236, 150, 104))
    leaves = (78, 168, 120)
    leaves2 = (110, 200, 150)
    d.ellipse([cx - 8 * s, by - 18 * s, cx - 1, by - 5 * s], fill=leaves)
    d.ellipse([cx, by - 20 * s, cx + 7 * s, by - 6 * s], fill=leaves2)
    d.ellipse([cx - 4 * s, by - 24 * s, cx + 3 * s, by - 9 * s], fill=leaves)


def rug(d, x0, y0, x1, y1):
    rect(d, x0, y0, x1, y1, (184, 107, 107))
    rect(d, x0 + 2, y0 + 2, x1 - 2, y1 - 2, (217, 140, 140))
    for y in range(y0 + 8, y1 - 4, 12):
        for x in range(x0 + 8 + ((y // 12) % 2) * 6, x1 - 4, 12):
            d.point((x, y), fill=(255, 214, 200))
            d.point((x + 1, y), fill=(255, 214, 200))
            d.point((x, y + 1), fill=(255, 214, 200))
            d.point((x + 1, y + 1), fill=(255, 214, 200))


def call_mat(d, x0, y0, x1, y1):
    rect(d, x0, y0, x1, y1, (201, 150, 46))
    rect(d, x0 + 2, y0 + 2, x1 - 2, y1 - 2, (242, 193, 78))
    for x in range(x0 + 4, x1 - 2, 6):
        rect(d, x, y0 + 2, x + 2, y0 + 3, (255, 226, 140))
        rect(d, x, y1 - 3, x + 2, y1 - 2, (255, 226, 140))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    d.ellipse([cx - 6, cy - 7, cx + 6, cy + 5], fill=(255, 250, 235), outline=(150, 100, 20))
    rect(d, cx - 8, cy + 4, cx + 8, cy + 6, (150, 100, 20))
    rect(d, cx - 1, cy - 10, cx + 1, cy - 8, (150, 100, 20))


def chair(d, cx, foot):
    d.rounded_rectangle([cx - 10, foot - 23, cx + 9, foot - 8], radius=4, fill=(75, 85, 104))
    rect(d, cx - 8, foot - 22, cx + 7, foot - 22, (107, 117, 138))
    rect(d, cx - 10, foot - 8, cx + 9, foot - 5, (60, 68, 84))


def round_table(d, x0, y0):
    d.ellipse([x0, y0, x0 + 24, y0 + 14], fill=(160, 112, 72))
    d.ellipse([x0, y0 - 2, x0 + 24, y0 + 11], fill=(232, 215, 183))
    rect(d, x0 + 6, y0 + 1, x0 + 9, y0 + 4, (250, 251, 252))
    plant(d, x0 + 16, y0 + 6)


def sofa_back(d, x0, y0):
    rect(d, x0, y0, x0 + 55, y0 + 17, (79, 91, 184))
    rect(d, x0 + 2, y0 + 2, x0 + 53, y0 + 15, (108, 123, 217))
    rect(d, x0 + 27, y0 + 3, x0 + 28, y0 + 15, (79, 91, 184))


def make_bg():
    img = Image.new("RGBA", (W, H))
    d = ImageDraw.Draw(img)
    floor(d)
    wall(d)
    window(d, 16, 14, 46, 24)
    whiteboard(d, 76, 14)
    clock(d, 146, 24)
    mailbox(d, 160, 20)
    door(d, 188, 16)
    bookshelf(d, 226, 12)
    coffee(d, 282, 30)
    plant(d, 10, 66, big=True)
    plant(d, 268, 60)
    rug(d, 216, 108, 314, 214)
    round_table(d, 252, 124)
    sofa_back(d, 236, 168)
    call_mat(d, 88, 196, 152, 234)
    plant(d, 308, 236, big=True)
    for cx in DESK_COLS:
        for foot in SEAT_ROWS:
            chair(d, cx, foot)
    return img


def make_desk():
    img = Image.new("RGBA", (44, 28), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rect(d, 0, 0, 43, 11, (107, 74, 47))
    rect(d, 1, 1, 42, 10, (234, 215, 183))
    rect(d, 1, 1, 42, 1, (245, 233, 211))
    rect(d, 2, 11, 41, 27, (107, 74, 47))
    rect(d, 3, 11, 40, 26, (185, 138, 94))
    rect(d, 3, 24, 40, 26, (156, 112, 73))
    rect(d, 4, 3, 10, 7, (250, 251, 252))
    rect(d, 5, 4, 9, 4, (190, 196, 206))
    rect(d, 36, 3, 39, 7, (250, 251, 252))
    rect(d, 37, 4, 38, 4, (120, 80, 60))
    return img


def make_sofa_front():
    img = Image.new("RGBA", (60, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rect(d, 0, 0, 7, 15, (79, 91, 184))
    rect(d, 52, 0, 59, 15, (79, 91, 184))
    rect(d, 1, 1, 6, 3, (128, 142, 230))
    rect(d, 53, 1, 58, 3, (128, 142, 230))
    rect(d, 6, 6, 53, 15, (79, 91, 184))
    rect(d, 7, 6, 52, 9, (128, 142, 230))
    rect(d, 7, 10, 52, 14, (108, 123, 217))
    return img


def main():
    out = os.path.dirname(os.path.abspath(__file__))
    make_bg().save(os.path.join(out, "office_bg.png"))
    make_desk().save(os.path.join(out, "desk.png"))
    make_sofa_front().save(os.path.join(out, "sofa_front.png"))


if __name__ == "__main__":
    main()
