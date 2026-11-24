import sys,json,zipfile,os
manifest=json.load(open(sys.argv[1],encoding='utf-8'))
target=sys.argv[2]+'.tmp'
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as z:
    for entry in manifest['files']:
        name=entry['name']
        if name.startswith('/') or '..' in name.split('/') or '\\' in name: raise ValueError('unsafe archive name')
        # Audio, images and video-free assets are already compressed; store them cheaply.
        method=zipfile.ZIP_STORED if name.lower().endswith(('.png','.webp','.jpg','.mp3','.m4a','.ogg','.webm','.audio','.woff2')) else zipfile.ZIP_DEFLATED
        z.write(entry['source'],name,compress_type=method)
os.replace(target,sys.argv[2])
