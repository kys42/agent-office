"""Reproducible 32px office sprites. Requires Pillow: uv run --with pillow scripts/generate-pets.py.

Native contract: four frames, eight mood rows, three walk rows, anchor (16, 30).
The original generator stays untouched. Body palettes and wardrobe are separate layers.
"""
from pathlib import Path
import importlib.util
import json
import sys
from PIL import Image, ImageDraw

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'sprites'
spec = importlib.util.spec_from_file_location('original', ROOT / 'references/design-source/sprites/gen_sprites.py')
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
Canvas, ellipse = original.Canvas, original.superellipse
STATES = original.STATES
WALKS = original.WALKS
COLORS = {
    'mint': ((139, 214, 189), (86, 162, 144), (208, 248, 226)),
    'peach': ((242, 172, 147), (196, 119, 107), (255, 223, 195)),
    'lavender': ((184, 161, 227), (130, 112, 178), (230, 216, 255)),
    'sky': ((145, 197, 237), (94, 145, 193), (216, 238, 255)),
    'butter': ((234, 210, 142), (184, 154, 91), (255, 242, 195)),
}
NATIVE = {
    'devcat': ((221, 188, 156), (164, 129, 110), (255, 224, 191)),
    'pebble': ((162, 176, 190), (110, 126, 149), (213, 226, 231)),
    'retrobot': ((138, 195, 179), (88, 143, 135), (208, 238, 209)),
    'cloud': ((218, 216, 241), (156, 161, 198), (255, 250, 255)),
}
INK = (53, 48, 69)
CREAM = (255, 237, 213)
EYE = (43, 44, 62)
PINK = (237, 143, 162)
SLIME_SOURCE = ROOT / 'references/pets/banryeojusik'
SLIME_META = json.loads((SLIME_SOURCE / 'slime-ai-atlas.json').read_text())
SLIME_FRAMES = {
    'idle': [0, 1, 2, 1], 'work': [11, 11, 2, 11], 'think': [11, 0, 1, 0],
    'call': [8, 9, 10, 9], 'done': [3, 8, 9, 3], 'error': [12, 13, 12, 13],
    'sleep': [14, 15, 14, 15], 'leave': [4, 5, 6, 7],
    'walk_down': [4, 5, 6, 7], 'walk_up': [4, 5, 6, 7], 'walk_side': [4, 5, 6, 7],
}
SLIME_PALETTES = {'original': '', 'mint': '-mint', 'peach': '-apricot',
                  'lavender': '-violet', 'sky': '-sky', 'butter': '-honey'}
SLIME_ATLASES = {color: Image.open(SLIME_SOURCE / f'slime-ai-atlas{suffix}.png').convert('RGBA')
                 for color, suffix in SLIME_PALETTES.items()}

def slime_frame(state, frame, color):
    """Repack existing artwork, retaining its authored expression and original pixels."""
    index = SLIME_FRAMES[state][frame]
    authored = SLIME_ATLASES[color].crop((index * 128, 0, (index + 1) * 128, 128))
    # One global scale leaves seven logical pixels for hats, with ground at y=30.
    result = Image.new('RGBA', (128, 128))
    result.paste(authored.resize((104, 104), Image.Resampling.NEAREST), (12, 26))
    props = Canvas()
    if state == 'work':
        props.rect(8, 23, 16, 6, (49, 54, 71))
        props.rect(9, 24, 14, 4, (212, 224, 228))
        props.rect(7, 29, 18, 1, (116, 132, 145))
        props.rect(15, 25, 2, 2, (120, 162, 169))
    elif state == 'think':
        for x, y in [(26, 8), (28, 5), (29, 2)][:min(frame + 1, 3)]:
            props.rect(x, y, 2, 2, INK); props.put(x, y, CREAM)
    elif state == 'call':
        props.rect(29, 1, 2, 4, (242, 198, 102)); props.rect(29, 6, 2, 1, (242, 198, 102))
    elif state == 'sleep':
        props.pattern(26, 3 + frame % 2, ['xxx', '..x', '.x.', 'xxx'], {'x': CREAM})
    elif state == 'leave':
        props.rect(2, 25, 5, 4, (153, 113, 89)); props.rect(3, 23, 3, 1, INK)
    result.alpha_composite(props.image().resize((128, 128), Image.Resampling.NEAREST))
    return result

def polygon(points):
    image = Image.new('1', (32, 32))
    ImageDraw.Draw(image).polygon(points, fill=1)
    return {(x, y) for y in range(32) for x in range(32) if image.getpixel((x, y))}

def pose(state, frame, shape):
    dx = [0, 1, 0, -1][frame] if state == 'error' else 0
    dy = {
        'idle': [0, 0, 1, 1], 'work': [0, 1, 0, 1], 'think': [0, 0, -1, 0],
        'call': [0, -1, -2, -1], 'done': [0, -1, 0, 1], 'sleep': [0, 0, 1, 1],
        'leave': [0, -1, 0, -1], 'walk_down': [0, -1, 0, -1],
        'walk_up': [0, -1, 0, -1], 'walk_side': [0, -1, 0, -1],
    }.get(state, [0] * 4)[frame]
    if shape == 'cloud' and state == 'idle': dy = [0, -1, -1, 0][frame]
    return dx, dy

def body(shape, frame, state):
    if shape == 'devcat':
        return ellipse(15.5, 20, 8.3, 8, 2.7) | polygon([(7, 15), (7, 7), (13, 12)]) | polygon([(18, 12), (24, 7), (24, 16)])
    if shape == 'pebble':
        return polygon([(7, 17), (11, 11), (20, 10), (25, 15), (26, 23), (22, 28), (10, 28), (6, 24)])
    if shape == 'retrobot':
        return polygon([(9, 11), (22, 11), (25, 14), (25, 25), (22, 28), (9, 28), (6, 25), (6, 14)])
    if shape == 'cloud':
        return (ellipse(15.5, 21, 9.5, 6.5, 3) | ellipse(8.5, 18, 4.5, 5, 2)
                | ellipse(14, 14.5, 5, 5, 2) | ellipse(21, 17, 5, 5, 2))
    raise ValueError(shape)

def draw_character(shape, state, frame, palette):
    cv = Canvas()
    fill, shade, light = palette
    dx, dy = pose(state, frame, shape)
    back, side = state == 'walk_up', state == 'walk_side'
    mask = {(x + dx, y + dy) for x, y in body(shape, frame, state)}
    cv.outline(mask, INK)
    for x, y in mask:
        cv.put(x, y, shade if (x + 2, y + 1) not in mask or (x, y + 2) not in mask else fill)
    # Small, controlled highlights preserve silhouettes at 24px as well as 80px.
    cv.rect(11 + dx, 14 + dy, 3, 1, light)
    cv.put(10 + dx, 15 + dy, light)
    if shape == 'devcat':
        cv.pattern(8 + dx, 9 + dy, ['x..', 'xx.', 'xxx'], {'x': PINK})
        cv.pattern(21 + dx, 9 + dy, ['..x', '.xx', 'xxx'], {'x': PINK})
        cv.rect(14 + dx, 12 + dy, 1, 3, shade)
        cv.rect(17 + dx, 12 + dy, 1, 2, shade)
        # Sweater hem and little paws.
        cv.rect(10 + dx, 25 + dy, 12, 2, (91, 118, 130))
        cv.rect(15 + dx, 26 + dy, 2, 1, (182, 218, 219))
        cv.pattern(25 + dx, 23 + dy, ['..x', '.xx', 'xxx'], {'x': shade})
    if shape == 'pebble':
        cv.pattern(19 + dx, 12 + dy, ['x..', '.x.', '.xx'], {'x': shade})
        cv.put(10 + dx, 23 + dy, light)
        cv.rect(20 + dx, 25 + dy, 2, 1, light)
    if shape == 'retrobot':
        cv.rect(15 + dx, 7 + dy, 2, 4, INK)
        cv.rect(15 + dx, 6 + dy, 2, 2, (244, 190, 108))
        cv.rect(9 + dx, 15 + dy, 14, 10, INK)
        cv.rect(10 + dx, 16 + dy, 12, 8, (41, 76, 78))
        cv.rect(10 + dx, 16 + dy, 3, 1, (72, 108, 109))
        cv.rect(11 + dx, 26 + dy, 6, 1, shade)
        cv.put(20 + dx, 26 + dy, (244, 190, 108))
        cv.rect(5 + dx, 18 + dy, 1, 5, INK)
        cv.rect(26 + dx, 18 + dy, 1, 5, INK)
    if shape == 'cloud':
        cv.rect(6 + dx, 18 + dy, 3, 1, light)
        cv.rect(12 + dx, 12 + dy, 3, 1, light)
        cv.put(22 + dx, 15 + dy, light)
    if state != 'work' and shape != 'cloud':
        for i, x in enumerate((11, 19)):
            offset = (frame + i) % 2 if state in WALKS + ['leave'] else 0
            cv.rect(x + dx, 29 - offset, 3, 1, INK)
    if not back:
        face_ink = (192, 244, 214) if shape == 'retrobot' else EYE
        for x in (12, 19):
            if state == 'sleep' or (state == 'idle' and frame == 3):
                cv.rect(x + dx, 20 + dy, 2, 1, face_ink)
            elif state == 'done':
                cv.pattern(x - 1 + dx, 18 + dy, ['.x.', 'x.x'], {'x': face_ink})
            elif state == 'error':
                cv.pattern(x - 1 + dx, 18 + dy, ['x.x', '.x.', 'x.x'], {'x': face_ink})
            else:
                ox = 1 if side or state == 'think' else 0
                cv.rect(x + dx + ox, 18 + dy, 2, 3 if state == 'call' else 2, face_ink)
                if shape != 'retrobot': cv.put(x + dx + ox, 18 + dy, CREAM)
        if shape != 'retrobot':
            cv.rect(9 + dx, 21 + dy, 2, 1, PINK)
            cv.rect(22 + dx, 21 + dy, 2, 1, PINK)
        cv.pattern(15 + dx, 22 + dy, ['x.x', '.x.'] if state not in ('work', 'sleep', 'call') else ['xxx'], {'x': face_ink})
        if shape == 'devcat':
            cv.pattern(10 + dx, 17 + dy, ['xxxx.xx.xxxx', 'x..x.xx.x..x', 'x..xxxxxx..x', 'xxxx....xxxx'], {'x': (60, 70, 92)})
            cv.put(11 + dx, 18 + dy, CREAM)
    elif shape == 'retrobot':
        cv.rect(11 + dx, 18 + dy, 10, 1, shade)
        cv.rect(11 + dx, 21 + dy, 10, 1, shade)
    else:
        cv.rect(14 + dx, 23 + dy, 3, 1, shade)
    # Hands alternate during typing; wave, cup and satchel have their own silhouettes.
    hand_y = 20 + dy
    cv.rect(5 + dx, hand_y + (frame % 2 if state == 'work' else 0), 3, 2, fill)
    cv.rect(25 + dx, hand_y + ((frame + 1) % 2 if state == 'work' else 0), 2, 2, fill)
    if state == 'work':
        cv.rect(8, 23, 16, 6, (49, 54, 71))
        cv.rect(9, 24, 14, 4, (212, 224, 228))
        cv.rect(7, 29, 18, 1, (116, 132, 145))
        cv.rect(15, 25, 2, 2, (120, 162, 169))
    if state == 'think':
        for x, y in [(24, 9), (27, 6), (29, 3)][:min(frame + 1, 3)]:
            cv.rect(x, y, 2, 2, INK); cv.put(x, y, CREAM)
    if state == 'call':
        cv.rect(25 + dx, 13 + dy, 2, 8, fill)
        cv.rect(25 + dx, 12 + dy - frame % 2, 3, 2, light)
        cv.rect(28, 2, 2, 4, (242, 198, 102)); cv.rect(28, 7, 2, 1, (242, 198, 102))
    if state == 'done':
        cv.rect(25 + dx, 19 + dy, 4, 4, CREAM)
        cv.rect(25 + dx, 19 + dy, 4, 1, (112, 72, 66))
        cv.rect(29 + dx, 20 + dy, 1, 2, CREAM)
        cv.put(26 + dx + frame % 2, 16 + dy, CREAM)
    if state == 'error':
        cv.put(25, 13 + frame % 2, (137, 206, 243))
        cv.rect(11 + frame % 2, 5, 2, 2, (189, 189, 203))
    if state == 'sleep':
        cv.pattern(25, 4 + frame % 2, ['xxx', '..x', '.x.', 'xxx'], {'x': CREAM})
    if state == 'leave':
        cv.rect(3, 23 + dy, 5, 4, (153, 113, 89))
        cv.rect(4, 21 + dy, 3, 1, INK)
        cv.put(5, 24 + dy, (241, 201, 121))
    return cv.image()

def wardrobe(shape, state, frame, accessory):
    cv = Canvas()
    if shape == 'slime':
        index = SLIME_FRAMES[state][frame]
        key = SLIME_META['atlas']['frameOrder'][index]
        dx, dy = 0, 0
        top = round((SLIME_META['frames'][key]['content']['y'] * 104 / 128 + 26) / 4)
    elif shape in original.SPECIES:
        native = original.SPECIES[shape]
        dx = [0, 1, 0, -1][frame] if state == 'error' else 0
        dy = {'idle': [0, 0, 1, 1], 'work': [0, 1, 0, 1], 'call': [0, -2, -3, -1],
              'done': [0, 0, 1, 0], 'sleep': [0, 0, 1, 1], 'leave': [0, -1, 0, -1],
              'walk_down': [0, -1, 0, -1], 'walk_up': [0, -1, 0, -1], 'walk_side': [0, -1, 0, -1]}.get(state, [0]*4)[frame]
        top = 12
    else:
        dx, dy = pose(state, frame, shape)
        top = 11 if shape != 'cloud' else 10
    back = state == 'walk_up'
    y = top + dy
    if accessory == 'beret':
        cv.pattern(8 + dx, y - 4, ['.....xx.........', '...xxxxxxxxxx...', '.xxxxxxxxxxxxxx.', 'xxxxxxxxxxxxxxxx', '..xxxxxxxxxxxx..'],
                   {'x': (96, 72, 113)})
        cv.rect(11 + dx, y - 2, 7, 1, (155, 122, 170))
    elif accessory == 'crown':
        cv.pattern(10 + dx, y - 5, ['x....x....x', 'xx..xxx..xx', 'xxxxxxxxxxx', '.xxxxxxxxx.', '.xxxxxxxxx.'], {'x': (237, 191, 87)})
        cv.rect(11 + dx, y - 1, 9, 1, (174, 117, 53))
        cv.put(15 + dx, y - 2, (242, 136, 153))
    elif accessory == 'sprout':
        cv.pattern(10 + dx, y - 7, ['xxx.....xxx', 'xxxx...xxxx', '.xxxx.xxxx.', '...xxxxx...', '.....x.....', '.....x.....', '.....x.....'], {'x': (103, 172, 122)})
        cv.rect(11 + dx, y - 6, 2, 1, (171, 221, 151))
    elif accessory == 'ribbon':
        cv.pattern(18 + dx, y - 2, ['xx....xx', 'xxx..xxx', 'xxxxxxxx', 'xxx..xxx', 'xx....xx'], {'x': (213, 121, 147)})
        cv.rect(21 + dx, y, 2, 2, (255, 199, 203))
    elif accessory == 'glasses' and (not back or shape == 'slime'):
        gy = 17 + dy if shape != 'slime' else top + 7
        cv.pattern(9 + dx, gy, ['xxxxx...xxxxx', 'x...xxxxx...x', 'x...x...x...x', 'xxxxx...xxxxx'], {'x': (50, 61, 83)})
        cv.put(10 + dx, gy + 1, (229, 249, 255))
        cv.put(18 + dx, gy + 1, (229, 249, 255))
    return cv.image()

def sheet(render, states, size=32):
    result = Image.new('RGBA', (4 * size, size * len(states)))
    for row, state in enumerate(states):
        for frame in range(4):
            result.paste(render(state, frame), (frame * size, row * size))
    return result

def main():
    OUT.mkdir(exist_ok=True)
    (OUT / 'wardrobe').mkdir(exist_ok=True)
    # Regenerate alternate palettes from drawing instructions, never hue-shift props or eyes.
    for name, native in original.SPECIES.items():
        if name == 'gemini': continue
        for color, palette in COLORS.items():
            sp = {**native, 'body': palette[0], 'shade': palette[1], 'light': palette[2]}
            for suffix, states in [('', STATES), ('_walk', WALKS)]:
                sheet(lambda state, frame: original.build(sp, state, frame), states).save(OUT / f'{name}-{color}{suffix}.png')
    for name, native in NATIVE.items():
        for color, palette in {'original': native, **COLORS}.items():
            stem = name if color == 'original' else f'{name}-{color}'
            for suffix, states in [('', STATES), ('_walk', WALKS)]:
                sheet(lambda state, frame: draw_character(name, state, frame, palette), states).save(OUT / f'{stem}{suffix}.png')
    for color in SLIME_PALETTES:
        stem = 'slime' if color == 'original' else f'slime-{color}'
        for suffix, states in [('', STATES), ('_walk', WALKS)]:
            sheet(lambda state, frame: slime_frame(state, frame, color), states, 128).save(OUT / f'{stem}{suffix}.png')
    for name in ['claude', 'codex', 'openclaw', 'slime', *NATIVE]:
        for accessory in ['beret', 'crown', 'sprout', 'ribbon', 'glasses']:
            for suffix, states in [('', STATES), ('_walk', WALKS)]:
                sheet(lambda state, frame: wardrobe(name, state, frame, accessory), states).save(OUT / 'wardrobe' / f'{name}-{accessory}{suffix}.png')
    # Contact sheet is a source-controlled review artifact with synthetic characters only.
    preview = Image.new('RGB', (5 * 160, 4 * 160), (24, 27, 35))
    for row, state in enumerate(['idle', 'work', 'call', 'sleep']):
        for col, name in enumerate(['slime', *NATIVE]):
            frame = (slime_frame(state, 0, 'original') if name == 'slime' else
                     draw_character(name, state, 0, NATIVE[name]).resize((128, 128), Image.Resampling.NEAREST))
            preview.paste(frame, (col * 160 + 16, row * 160 + 16), frame)
    preview.save(OUT / 'character-preview.png')

if __name__ == '__main__':
    main()
