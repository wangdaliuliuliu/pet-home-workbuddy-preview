#!/usr/bin/env python3
"""把宠物形象压成一张 72×72 的透明缩略图，串门列表用。

用法：python3 scripts/make-avatar.py <原图> <输出.png> [边长]
只依赖 Pillow；失败时以非 0 退出，调用方会退回原图。
"""
import sys


def main():
    if len(sys.argv) < 3:
        print('usage: make-avatar.py <src> <dst> [size]', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 72

    from PIL import Image

    with Image.open(src) as opened:
        img = opened.convert('RGBA')
    inner = max(8, size - 4)
    scale = min(inner / img.width, inner / img.height)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    canvas.save(dst, 'PNG', optimize=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
