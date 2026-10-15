from pathlib import Path
from PIL import Image, ImageDraw
out=Path(__file__).resolve().parents[1]/'public'
out.mkdir(exist_ok=True)
for name,size in [('icon-192.png',192),('icon-512.png',512),('icon-maskable.png',512),('apple-touch-icon.png',180)]:
    im=Image.new('RGB',(512,512)); d=ImageDraw.Draw(im)
    for y in range(512):
        a=y/511; d.line((0,y,512,y),fill=tuple(round(p*(1-a)+q*a) for p,q in zip((255,214,231),(207,232,255))))
    d.ellipse((145,150,267,272),fill='#b75b87'); d.ellipse((245,150,367,272),fill='#b75b87'); d.polygon([(149,231),(256,350),(363,231)],fill='#b75b87')
    im.resize((size,size),Image.Resampling.LANCZOS).save(out/name)
