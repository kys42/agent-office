"""Rebuild index.html from the editable template by embedding sprites and the pixel font.

Run from the repository root after `npm ci`:
    python3 public/design/native-themes-2026-10-08/source/build.py
"""
import base64, pathlib
root = pathlib.Path(__file__).resolve().parents[4]
here = pathlib.Path(__file__).resolve().parent
s = (here / 'native-themes.src.html').read_text()
b64 = lambda p: base64.b64encode(p.read_bytes()).decode()
s = s.replace('%%GALMURI%%', b64(root / 'node_modules/galmuri/dist/Galmuri11.woff2'))
for k in ['claude', 'codex', 'openclaw']:
    s = s.replace(f'%%{k.upper()}%%', b64(root / f'public/sprites/{k}.png'))
(here.parent / 'index.html').write_text(s)
print('wrote', here.parent / 'index.html')
