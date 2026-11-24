"""Remove a connected light backdrop without erasing white details inside the pet."""
import sys
from collections import deque
from PIL import Image, ImageOps, ImageFilter, ImageChops
try:
    from pillow_heif import register_heif_opener
    register_heif_opener(thumbnails=False)
except ImportError:
    pass
Image.MAX_IMAGE_PIXELS = 50000000
try:
    source = Image.open(sys.argv[1])
except (OSError, ValueError):
    sys.exit(21)
if source.width*source.height>50000000: raise ValueError('image dimensions too large')
source.draft('RGB',(1600,1600))
source.thumbnail((1600,1600))
im = ImageOps.exif_transpose(source).convert('RGBA')
w,h=im.size
if min(w,h)<80: raise ValueError('image too small')
alpha=im.getchannel('A')
if alpha.getextrema()[0]<20:
    im.save(sys.argv[2]); sys.exit(0)
# Compute the light/neutral test in Pillow's native code, not four RGB calls per pixel.
r,g,b,_=im.split()
low=ImageChops.darker(ImageChops.darker(r,g),b)
high=ImageChops.lighter(ImageChops.lighter(r,g),b)
neutral=ImageChops.subtract(high,low).point(lambda v:255 if v<42 else 0)
light=low.point(lambda v:255 if v>205 else 0)
eligible=ImageChops.multiply(neutral,light).tobytes()
visited=bytearray(w*h);queue=deque()
def add(i):
    if not visited[i] and eligible[i]:visited[i]=1;queue.append(i)
for x in range(w):add(x);add((h-1)*w+x)
for y in range(h):add(y*w);add(y*w+w-1)
while queue:
    i=queue.popleft();x=i%w
    if x:add(i-1)
    if x+1<w:add(i+1)
    if i>=w:add(i-w)
    if i+w<w*h:add(i+w)
removed=sum(visited)
if removed<w*h*.05 or removed>w*h*.96: sys.exit(22)
mask=Image.frombytes('L',(w,h),bytes(0 if v else 255 for v in visited)).filter(ImageFilter.GaussianBlur(.45))
im.putalpha(mask)
box=mask.getbbox()
if not box: raise ValueError('no visible pet')
im=im.crop(box)
canvas=Image.new('RGBA',(max(im.width,im.height)+80,)*2)
canvas.alpha_composite(im,((canvas.width-im.width)//2,canvas.height-im.height-40))
canvas.save(sys.argv[2])
