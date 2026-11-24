import sys,json,hashlib,pathlib,math
from PIL import Image,ImageChops
from evolution_alpha import extract
mode=sys.argv[1]
def normalized(im):
    im=im.convert('RGBA');box=im.getchannel('A').getbbox()
    if not box:raise ValueError('empty character')
    im=im.crop(box);im.thumbnail((820,820),Image.Resampling.LANCZOS)
    if max(im.size)<800:
        scale=820/max(im.size);im=im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.LANCZOS)
    out=Image.new('RGBA',(1024,1024));out.alpha_composite(im,((1024-im.width)//2,922-im.height));return out
if mode=='check':
    d=pathlib.Path(sys.argv[2]);m=json.loads((d/'manifest.json').read_text());assert m['rig']=='pet-mesh-v1'
    for name in ['body','blink']:
        b=(d/(name+'.png')).read_bytes();assert hashlib.sha256(b).hexdigest()==m['layers'][name]['sha256']
        im=Image.open(d/(name+'.png')).convert('RGBA');assert im.size==(1024,1024);a=im.getchannel('A');assert a.getextrema()==(0,255)
        box=a.point(lambda n: 255 if n>=240 else 0).getbbox();assert box
        width,height=box[2]-box[0],box[3]-box[1]
        assert min(width,height)>=48 and sum(a.histogram()[240:])>=width*height*.10
    assert ImageChops.difference(Image.open(d/'body.png').convert('RGB'),Image.open(d/'blink.png').convert('RGB')).getbbox()
    sys.exit(0)
source=pathlib.Path(sys.argv[2]);d=pathlib.Path(sys.argv[3]);d.mkdir(parents=True,exist_ok=True)
original=Image.open(source).convert('RGBA');body=normalized(original);body.save(d/'body.png')
if mode=='prepare':sys.exit(0)
blink=Image.open(d/'blink-source.png').convert('RGBA')
if blink.getchannel('A').getextrema()[0]>20:
    blink=extract(blink, original)
blink=normalized(blink);blink.save(d/'blink.png')
assert ImageChops.difference(body.convert('RGB'),blink.convert('RGB')).getbbox(),'unchanged blink'
vertices=[]
for y in range(9):
    v=y/8;head=max(0,min(1,(.6-v)/.4));root=max(0,min(1,(v-.6)/.3));spine=max(0,1-head-root);total=head+root+spine
    for x in range(9):vertices.append([x/8,v,root/total,spine/total,head/total])
triangles=[]
for y in range(8):
    for x in range(8):
        i=y*9+x;triangles.extend([[i,i+1,i+10],[i,i+10,i+9]])
m={'version':2,'rig':'pet-mesh-v1','motions':['idle','blink'],'formImage':sys.argv[4],'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'bones':[{'name':'root','parent':None,'pivot':[.5,.9]},{'name':'spine','parent':'root','pivot':[.5,.6]},{'name':'head','parent':'spine','pivot':[.5,.3]}],'vertices':vertices,'triangles':triangles,'layers':{}}
for name in ['body','blink']:m['layers'][name]={'file':name+'.png','width':1024,'height':1024,'sha256':hashlib.sha256((d/(name+'.png')).read_bytes()).hexdigest()}
(d/'manifest.json').write_text(json.dumps(m),encoding='utf-8')
