"""Validate evolution art or prepare a transparent PNG for the same checks."""
import os
from pathlib import Path
import sys
import tempfile

from PIL import Image
from evolution_canvas import MIN_CANVAS, valid_candidate_size


def corners(image):
    width, height = image.size
    return [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]


def valid_alpha(image):
    width, height = image.size
    alpha = image.getchannel('A')
    histogram = alpha.histogram()
    pixels = width * height
    solid = sum(histogram[240:])
    box = alpha.point(lambda value: 255 if value >= 240 else 0).getbbox()
    if not box or histogram[0] < pixels * .10 or solid < pixels * .02:
        return False
    if not all(alpha.getpixel(p) < 10 for p in corners(image)):
        return False
    w, h = box[2] - box[0], box[3] - box[1]
    return min(w / width, h / height) >= .05 and max(w / width, h / height) >= .30 and solid >= w * h * .10


def prepare_alpha(image, source, destination, source_format):
    width, height = image.size
    if not valid_candidate_size(image) or not valid_alpha(image):
        return False
    if min(width, height) < MIN_CANVAS:
        canvas = Image.new('RGBA', (max(width, MIN_CANVAS), max(height, MIN_CANVAS)))
        canvas.paste(image, ((canvas.width - width) // 2, (canvas.height - height) // 2))
        if not valid_alpha(canvas):
            return False
        image = canvas
    elif source == destination and source_format == 'PNG':
        return True
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.png', delete=False) as temp:
        temporary = Path(temp.name)
    try:
        image.save(temporary, 'PNG')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def main():
    source, mode = Path(sys.argv[1]), sys.argv[2]
    with Image.open(source) as original:
        image = original.convert('RGBA')
        source_format = original.format
    if mode == 'prepare-alpha':
        return prepare_alpha(image, source, Path(sys.argv[3]), source_format)
    # Atlases are segmented in their original pixel coordinates. A small
    # canvas shortfall does not change the layout or the quality gates.
    if mode in ('atlas-alpha', 'atlas-green'):
        if not valid_candidate_size(image):
            return False
    elif min(image.size) < MIN_CANVAS:
        return False
    if mode in ('green', 'atlas-green'):
        return all(g > 180 and g > r * 2 and g > b * 2 for r, g, b, _ in (image.getpixel(p) for p in corners(image)))
    return valid_alpha(image)


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
