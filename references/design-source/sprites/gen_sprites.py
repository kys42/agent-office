"""Agent Office — 도트 펫 스프라이트 시트 생성기.

시트 규격 (pet.json 과 동일):
  - 프레임 32x32 px, 4 프레임(열) x 8 상태(행) = 128x256 PNG
  - 행 순서: idle, work, think, call, done, error, sleep, leave
  - 발 기준점(anchor) = (16, 30), 말풍선 기준점 = (16, 2)

새 캐릭터를 넣고 싶으면 같은 규격의 PNG 를 만들어 pet.json 만 바꿔 끼우면 된다.
"""
from __future__ import annotations

import json
import os
from PIL import Image

W = H = 32
FRAMES = 4
STATES = ["idle", "work", "think", "call", "done", "error", "sleep", "leave"]
# 돌아다니기용 보조 시트 (탑뷰 오피스): 아래로 / 위로(뒷모습) / 옆으로(왼쪽은 좌우 반전)
WALKS = ["walk_down", "walk_up", "walk_side"]
CX = 15.5

EYE = (34, 25, 42)
WHITE = (255, 255, 255)
PROP_INK = (43, 47, 58)

SPECIES = {
    "claude": dict(
        label="Claude Code", shape="bean", ink=(74, 36, 24), body=(240, 138, 93),
        shade=(201, 99, 59), light=(255, 194, 160), cheek=(226, 84, 107),
        hat=(46, 111, 115), hat2=(95, 168, 166), pom=(244, 235, 217),
    ),
    "codex": dict(
        label="Codex", shape="box", ink=(17, 19, 24), body=(59, 65, 80),
        shade=(42, 46, 57), light=(94, 102, 120), cheek=None,
        plate=(26, 29, 36), led=(143, 245, 210),
    ),
    "openclaw": dict(
        label="OpenClaw", shape="crab", ink=(74, 20, 18), body=(233, 86, 77),
        shade=(184, 60, 54), light=(255, 156, 136), cheek=(255, 184, 192),
        inner=(255, 210, 196),
    ),
    "gemini": dict(
        label="Gemini CLI", shape="ghost", ink=(30, 36, 104), body=(135, 150, 255),
        shade=(93, 105, 216), light=(196, 204, 255), cheek=(255, 158, 200),
        star=(255, 216, 74), star_ink=(138, 90, 0),
    ),
}


AGENT_IDS = {"claude": "claude-code", "codex": "codex", "openclaw": "openclaw", "gemini": "gemini-cli"}
NAME_POOL = {
    "claude": ["코코", "당근", "모모"],
    "codex": ["네모", "삑삑", "큐브"],
    "openclaw": ["집게", "꽃게", "가재"],
    "gemini": ["별이", "반짝", "쌍둥"],
}


class Canvas:
    def __init__(self):
        self.px: dict[tuple[int, int], tuple] = {}

    def put(self, x, y, c):
        if 0 <= x < W and 0 <= y < H and c is not None:
            self.px[(x, y)] = c

    def rect(self, x, y, w, h, c):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.put(xx, yy, c)

    def pattern(self, x, y, rows, cmap):
        for dy, row in enumerate(rows):
            for dx, ch in enumerate(row):
                if ch in cmap:
                    self.put(x + dx, y + dy, cmap[ch])

    def outline(self, region: set, c):
        for (x, y) in region:
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if (nx, ny) not in region:
                    self.put(nx, ny, c)

    def image(self):
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        for (x, y), c in self.px.items():
            img.putpixel((x, y), tuple(c) + (255,) if len(c) == 3 else c)
        return img


def superellipse(cx, cy, a, b, n):
    s = set()
    for y in range(H):
        for x in range(W):
            if abs((x - cx) / a) ** n + abs((y - cy) / b) ** n <= 1.0:
                s.add((x, y))
    return s


def body_mask(shape, dx, dy, f, state):
    if shape == "bean":
        return superellipse(CX + dx, 19.5 + dy, 8.6, 8.2, 2.3)
    if shape == "box":
        return superellipse(CX + dx, 19.5 + dy, 8.3, 7.8, 5.0)
    if shape == "crab":
        return superellipse(CX + dx, 20.5 + dy, 8.8, 6.9, 2.2)
    if shape == "ghost":
        s = superellipse(CX + dx, 18 + dy, 8.2, 8.2, 2.0)
        top = {(x, y) for (x, y) in s if y <= 18 + dy}
        xs = range(int(CX + dx - 8), int(CX + dx + 9))
        for x in xs:
            for y in range(int(18 + dy), int(26 + dy)):
                top.add((x, y))
            if (x + f) % 4 in (0, 1):
                top.add((x, int(26 + dy)))
        return top
    raise ValueError(shape)


def shade_body(cv, mask, sp):
    for (x, y) in mask:
        c = sp["body"]
        if (x + 1, y + 1) not in mask or (x, y + 2) not in mask:
            c = sp["shade"]
        cv.put(x, y, c)
    ys = [y for _, y in mask]
    top = min(ys)
    xs = [x for x, y in mask if y == top + 2]
    if xs:
        lx = min(xs) + 2
        for p in ((lx, top + 2), (lx + 1, top + 2), (lx, top + 3)):
            if p in mask:
                cv.put(*p, sp["light"])


def eyes(cv, sp, kind, dx, dy, look=(0, 0)):
    ey = 18 + dy + (1 if sp["shape"] == "crab" else 0)
    lx, rx = 12 + dx, 18 + dx
    led = sp.get("led")
    ink = led or EYE
    ox, oy = look
    if kind == "open":
        for x in (lx, rx):
            cv.rect(x + ox, ey + oy, 2, 2, ink)
            if not led:
                cv.put(x + ox, ey + oy, WHITE)
        if led:
            for x in (lx, rx):
                cv.rect(x + ox, ey + oy - 1, 2, 3, ink)
    elif kind == "big":
        for x in (lx, rx):
            cv.rect(x, ey - 1, 2, 3, ink)
            if not led:
                cv.put(x, ey - 1, WHITE)
    elif kind == "focus":
        for x in (lx, rx):
            cv.rect(x, ey + 1, 2, 1, ink)
    elif kind == "blink":
        for x in (lx, rx):
            cv.rect(x, ey + 1, 2, 1, ink)
    elif kind == "happy":
        for x in (lx, rx):
            cv.put(x - 1 + 1, ey, ink) if False else None
            cv.pattern(x - 1, ey, [".x.", "x.x"], {"x": ink})
    elif kind == "closed":
        for x in (lx, rx):
            cv.pattern(x - 1, ey + 1, ["x.x", ".x."], {"x": ink})
    elif kind == "dizzy":
        for x in (lx, rx):
            cv.pattern(x - 1, ey - 1, ["x.x", ".x.", "x.x"], {"x": ink})


def mouth(cv, sp, kind, dx, dy):
    my = 21 + dy + (1 if sp["shape"] == "crab" else 0)
    ink = sp.get("led") or EYE
    if kind == "smile":
        cv.pattern(14 + dx, my, ["x..x", ".xx."], {"x": ink})
    elif kind == "o":
        cv.rect(15 + dx, my, 2, 2, ink)
    elif kind == "flat":
        cv.rect(15 + dx, my + 1, 2, 1, ink)
    elif kind == "wave":
        cv.pattern(14 + dx, my, ["x.x.", ".x.x"], {"x": ink})
    elif kind == "small":
        cv.put(15 + dx, my + 1, ink)
        cv.put(16 + dx, my + 1, ink)
    if sp.get("cheek"):
        cy = my - 1
        cv.rect(9 + dx, cy, 2, 1, sp["cheek"])
        cv.rect(21 + dx, cy, 2, 1, sp["cheek"])


def build(sp, state, f):
    cv = Canvas()
    shape = sp["shape"]
    floats = shape == "ghost"

    dx, dy = 0, 0
    eye_kind, mouth_kind, look = "open", "smile", (0, 0)
    arm_l, arm_r = "side", "side"
    feet_phase = None

    if state == "idle":
        dy = [0, 0, 1, 1][f] if not floats else [0, -1, -1, 0][f]
        eye_kind = "blink" if f == 3 else "open"
    elif state == "work":
        dy = [0, 1, 0, 1][f]
        eye_kind, mouth_kind = "focus", "small"
        arm_l, arm_r = ("type_up", "type_dn") if f % 2 == 0 else ("type_dn", "type_up")
    elif state == "think":
        dy = [0, 0, -1, -1][f] if floats else [0, 0, 0, 0][f]
        eye_kind, mouth_kind, look = "open", "flat", (1, -1)
        arm_l = "chin"
    elif state == "call":
        dy = [0, -2, -3, -1][f]
        eye_kind, mouth_kind = "big", "o"
        arm_r = "wave_a" if f % 2 == 0 else "wave_b"
    elif state == "done":
        dy = [0, 0, 1, 0][f] if not floats else [0, -1, 0, -1][f]
        eye_kind, mouth_kind = "happy", "smile"
        arm_r = "mug"
    elif state == "error":
        dx = [0, 1, 0, -1][f]
        eye_kind, mouth_kind = "dizzy", "wave"
    elif state == "sleep":
        dy = [0, 0, 1, 1][f]
        eye_kind, mouth_kind = "closed", "small"
    elif state == "leave":
        dy = [0, -1, 0, -1][f]
        eye_kind, look = "open", (1, 0)
        arm_l = "bag"
        feet_phase = f
    elif state in WALKS:
        dy = [0, -1, -1, 0][f] if floats else [0, -1, 0, -1][f]
        feet_phase = f
        if state == "walk_side":
            look = (2, 0)

    side = 2 if state == "walk_side" else 0
    back = state == "walk_up"

    body = body_mask(shape, dx, dy, f, state)
    region = set(body)

    # 발 / 다리
    feet = set()
    if not floats and state != "work":
        by = max(y for _, y in body) + 1
        if shape == "crab":
            legs = [10, 12, 19, 21]
            for i, lx in enumerate(legs):
                lift = 1 if feet_phase is not None and (i + feet_phase) % 2 else 0
                feet.add((lx + dx, by - lift))
                feet.add((lx + dx, by + 1 - lift))
        else:
            fl, fr = (11, 18)
            ol = or_ = 0
            if feet_phase is not None:
                ol, or_ = [(0, 1), (1, 0), (0, -1), (-1, 0)][feet_phase][0], [(0, 1), (1, 0), (0, -1), (-1, 0)][feet_phase][1]
            for x in range(3):
                feet.add((fl + x + dx + ol, by))
                feet.add((fr + x + dx + or_, by))
    region |= feet

    # 팔 (게는 집게)
    arms = set()
    def arm_pts(kind, side):
        sx = 6 if side == "l" else 24
        s = 1 if side == "r" else -1
        base_y = 21 + dy
        if shape == "crab":
            return set()
        if kind == "side":
            return {(sx + dx, base_y), (sx + 1 + dx, base_y), (sx + dx, base_y + 1), (sx + 1 + dx, base_y + 1)}
        if kind in ("type_up", "type_dn"):
            yy = 20 + dy - (1 if kind == "type_up" else 0)
            x0 = 8 if side == "l" else 22
            return {(x0, yy), (x0 + 1, yy), (x0, yy + 1), (x0 + 1, yy + 1)}
        if kind == "chin":
            return {(10 + dx, 22 + dy), (11 + dx, 22 + dy), (10 + dx, 23 + dy), (11 + dx, 23 + dy)}
        if kind in ("wave_a", "wave_b"):
            off = 0 if kind == "wave_a" else 1
            pts = set()
            for yy in range(13 + dy, 20 + dy):
                pts.add((24 + dx + (off if yy < 16 + dy else 0), yy))
                pts.add((25 + dx + (off if yy < 16 + dy else 0), yy))
            for xx in range(3):
                for yy in range(2):
                    pts.add((24 + dx + off + xx - 1 + 1, 11 + dy + yy))
            return pts
        if kind == "mug":
            return {(24 + dx, 21 + dy), (25 + dx, 21 + dy), (24 + dx, 22 + dy), (25 + dx, 22 + dy)}
        if kind == "bag":
            return {(6 + dx, 21 + dy), (7 + dx, 21 + dy), (6 + dx, 22 + dy), (7 + dx, 22 + dy)}
        return set()

    if shape != "crab":
        arms |= arm_pts(arm_l, "l") | arm_pts(arm_r, "r")
    region |= arms

    # 집게 (OpenClaw)
    claws = {}
    if shape == "crab":
        def claw(cx0, cy0, mirror, open_=True):
            pts = set()
            rows = [".xxx.", "xxxxx", "xx.xx" if open_ else "xxxxx", "xx..." if not mirror else "...xx"]
            rows = ["xxxx.", "xxxxx", "xx...", "xxxx."] if not mirror else [".xxxx", "xxxxx", "...xx", ".xxxx"]
            for yy, row in enumerate(rows):
                for xx, ch in enumerate(row):
                    if ch == "x":
                        pts.add((cx0 + xx, cy0 + yy))
            return pts
        ly = 17 + dy
        lpos = (2 + dx, ly)
        rpos = (25 + dx, ly)
        if state == "work":
            lpos, rpos = (5, 19 + dy - (f % 2)), (22, 19 + dy - ((f + 1) % 2))
        if state == "call":
            rpos = (25 + dx + (f % 2), 9 + dy)
        if state == "think":
            lpos = (7 + dx, 21 + dy)
        lc = claw(*lpos, False)
        rc = claw(*rpos, True)
        claws = lc | rc
        # 집게 팔 연결
        conn = set()
        if state not in ("work", "think"):
            conn |= {(7 + dx, 21 + dy), (6 + dx, 21 + dy)}
        if state == "call":
            for yy in range(13 + dy, 20 + dy):
                conn.add((25 + dx, yy))
        elif state != "work":
            conn |= {(24 + dx, 21 + dy), (25 + dx, 21 + dy)}
        region |= claws | conn
        arms |= conn

    # 모자 / 안테나 / 별
    hat = set()
    antenna = set()
    stars = []
    if shape == "bean":
        big = superellipse(CX + dx, 19.5 + dy, 9.1, 8.7, 2.3)
        top = min(y for _, y in body)
        hat = {(x, y) for (x, y) in big if y <= top + 3}
        pom = {(15 + dx, top - 2), (16 + dx, top - 2), (15 + dx, top - 1), (16 + dx, top - 1)}
        hat |= pom
        region |= hat
    if shape == "box":
        top = min(y for _, y in body)
        for yy in range(top - 4, top):
            antenna.add((16 + dx, yy))
        antenna |= {(15 + dx, top - 6), (16 + dx, top - 6), (15 + dx, top - 5), (16 + dx, top - 5)}
        region |= antenna
    if shape == "crab":
        top = min(y for _, y in body)
        for (ax, ay) in ((11, top - 1), (11, top - 2), (20, top - 1), (20, top - 2)):
            antenna.add((ax + dx, ay))
        antenna |= {(10 + dx, top - 3), (21 + dx, top - 3)}
        region |= antenna
    if shape == "ghost":
        top = min(y for _, y in body)
        for (ax, ay) in ((12, top - 1), (12, top - 2), (19, top - 1), (19, top - 2)):
            antenna.add((ax + dx, ay))
        region |= antenna
        stars = [(11 + dx, top - 5), (18 + dx, top - 5)]

    # 노트북은 몸 앞에 그려지므로 외곽선 계산 전에 영역 분리
    cv.outline(region, sp["ink"])
    shade_body(cv, body, sp)
    for p in feet:
        cv.put(*p, sp["shade"])
    for p in arms:
        cv.put(*p, sp["body"])
    for p in claws:
        cv.put(*p, sp["body"])
    if claws:
        # 집게 안쪽 하이라이트
        for (x, y) in claws:
            if (x, y - 1) not in claws:
                cv.put(x, y, sp["light"])
    if shape == "bean":
        top = min(y for _, y in body)
        for (x, y) in hat:
            c = sp["hat"]
            if y == top + 3:
                c = sp["hat2"]
            if y <= top - 1:
                c = sp["pom"]
            cv.put(x, y, c)
        for (x, y) in hat:
            if y == top + 1 and (x % 2 == 0) and y > top - 1:
                cv.put(x, y, sp["hat2"])
    if shape == "box":
        top = min(y for _, y in body)
        for (x, y) in antenna:
            cv.put(x, y, sp["light"])
        tip_on = state in ("work", "call", "think") and f % 2 == 0 or state in ("idle", "done")
        tip = sp["led"] if tip_on else sp["light"]
        if state == "error":
            tip = (255, 110, 110) if f % 2 == 0 else sp["light"]
        if state in ("sleep", "leave"):
            tip = sp["light"]
        cv.rect(15 + dx, top - 6, 2, 2, tip)
        # 얼굴 화면
        if back:
            cv.rect(12 + dx, 19 + dy, 8, 1, sp["shade"])
            cv.rect(12 + dx, 21 + dy, 8, 1, sp["shade"])
        else:
            cv.rect(10 + dx + side, 16 + dy, 12, 8, sp["plate"])
    if shape in ("crab", "ghost"):
        for (x, y) in antenna:
            cv.put(x, y, sp["shade"] if shape == "crab" else sp["light"])
    for (sx_, sy_) in stars:
        twinkle = (f % 2 == 0)
        rows = [".x.", "xxx", ".x."] if twinkle else ["x.x", ".x.", "x.x"]
        cv.pattern(sx_, sy_, rows, {"x": sp["star"]})

    if not back:
        eyes(cv, sp, eye_kind, dx, dy, look)
        mouth(cv, sp, mouth_kind, dx + side, dy)

    # 소품
    if state == "work":
        lid = set()
        for yy in range(23, 29):
            for xx in range(9, 23):
                lid.add((xx, yy))
        base = {(xx, 29) for xx in range(7, 25)}
        cv.outline(lid | base, PROP_INK)
        for (x, y) in lid:
            cv.put(x, y, (215, 220, 228) if y < 27 else (174, 181, 194))
        for (x, y) in base:
            cv.put(x, y, (120, 128, 142))
        cv.rect(15, 25, 2, 2, sp["light"] if f % 2 == 0 else sp["body"])
        # 손 (뚜껑 위로 살짝)
        for side_x, up in ((8, f % 2 == 0), (22, f % 2 == 1)):
            yy = 21 + dy - (1 if up else 0)
            if shape == "crab":
                continue
            cv.rect(side_x, yy, 2, 2, sp["body"])
            cv.put(side_x, yy - 1, sp["ink"])
            cv.put(side_x + 1, yy - 1, sp["ink"])
    if state == "done":
        mx, my = 25 + dx, 19 + dy
        mug = {(mx + i, my + j) for i in range(4) for j in range(4)}
        handle = {(mx + 4, my + 1), (mx + 4, my + 2)}
        cv.outline(mug | handle, PROP_INK)
        for p in mug:
            cv.put(*p, WHITE)
        cv.rect(mx, my, 4, 1, (107, 62, 38))
        for p in handle:
            cv.put(*p, WHITE)
        steam = [(mx + 1, my - 2), (mx + 2, my - 4)] if f % 2 == 0 else [(mx + 2, my - 2), (mx + 1, my - 4)]
        for p in steam:
            cv.put(*p, (230, 233, 240))
    if state == "leave":
        bx, by = 3 + dx, 22 + dy
        bag = {(bx + i, by + j) for i in range(5) for j in range(4)}
        cv.outline(bag, (58, 36, 18))
        for p in bag:
            cv.put(*p, (139, 90, 43))
        cv.put(bx + 2, by + 1, (242, 193, 78))
        cv.put(bx + 1, by - 2, (58, 36, 18))
        cv.put(bx + 3, by - 2, (58, 36, 18))
        cv.put(bx + 2, by - 2, (58, 36, 18))
    # 효과
    if state == "call":
        bx, by = 27, 1 + max(0, dy + 1)
        bang = {(bx, by + i) for i in range(4)} | {(bx + 1, by + i) for i in range(4)} | {(bx, by + 5), (bx + 1, by + 5)}
        cv.outline(bang, (58, 42, 0))
        for p in bang:
            cv.put(*p, (255, 216, 74))
    if state == "think":
        dots = [(23, 10), (26, 6), (29, 2)][: [1, 2, 3, 3][f]]
        for (x, y) in dots:
            d = {(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)}
            cv.outline(d, PROP_INK)
            for p in d:
                cv.put(*p, WHITE)
    if state == "sleep":
        zs = [(22, 9), (23, 7), (24, 5), (25, 3)]
        zx, zy = zs[f]
        z = ["xxxx", "..x.", ".x..", "xxxx"]
        zz = set()
        for j, row in enumerate(z):
            for i, ch in enumerate(row):
                if ch == "x":
                    zz.add((zx + i, zy + j))
        cv.outline(zz, PROP_INK)
        for p in zz:
            cv.put(*p, WHITE)
        if f >= 2:
            cv.put(21, 11, WHITE)
    if state == "error":
        top = 6
        puffs = [[(11, top + 2), (19, top)], [(12, top + 1), (18, top - 1)], [(11, top), (19, top + 1)], [(12, top - 1), (18, top + 2)]][f]
        for (x, y) in puffs:
            p = {(x + i, y + j) for i in range(3) for j in range(2)}
            cv.outline(p, (74, 79, 90))
            for q in p:
                cv.put(*q, (201, 205, 212))
        cv.put(24 + dx, 13, (143, 211, 255))
        cv.put(24 + dx, 14, (143, 211, 255))
    return cv.image()


def build_sheet(key):
    sp = SPECIES[key]
    sheet = Image.new("RGBA", (W * FRAMES, H * len(STATES)), (0, 0, 0, 0))
    for r, st in enumerate(STATES):
        for f in range(FRAMES):
            sheet.paste(build(sp, st, f), (f * W, r * H))
    return sheet


def main():
    out = os.path.dirname(os.path.abspath(__file__))
    manifest = {}
    for key, sp in SPECIES.items():
        sheet = build_sheet(key)
        sheet.save(os.path.join(out, f"{key}.png"))
        sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST).save(os.path.join(out, f"{key}@4x.png"))
        walk = Image.new("RGBA", (W * FRAMES, H * len(WALKS)), (0, 0, 0, 0))
        for r, st in enumerate(WALKS):
            for f in range(FRAMES):
                walk.paste(build(sp, st, f), (f * W, r * H))
        walk.save(os.path.join(out, f"{key}_walk.png"))
        manifest[key] = {
            "id": f"dot-{key}",
            "label": sp["label"],
            "match": {"agent": AGENT_IDS[key]},
            "sheet": f"{key}.png",
            "frame": {"w": W, "h": H},
            "scale": 2,
            "fps": 6,
            "anchor": {"x": 16, "y": 30},
            "bubbleAnchor": {"x": 16, "y": 2},
            "states": {st: ({"row": i, "loop": False} if st == "leave" else i) for i, st in enumerate(STATES)},
            "names": NAME_POOL[key],
            "walk": {"sheet": f"{key}_walk.png", "down": 0, "up": 1, "side": 2, "flipLeft": True},
        }
    with open(os.path.join(out, "pets.json"), "w", encoding="utf-8") as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
