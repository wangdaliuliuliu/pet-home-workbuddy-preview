"""Remove an edge-connected chroma screen, including uneven illumination.

Green stays on the original, well-tested code path. Other key colours are only
used when the pet itself is green, and the real screen colour is re-detected if
a generated image ignores the requested colour.
"""
import argparse
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

DEFAULT_KEY = '00FF00'
CANDIDATES = [('00FF00', 85), ('0000FF', 170), ('FF00FF', 213)]
HUE_TOLERANCE = 34
MIN_SATURATION = 60
MIN_VALUE = 55
DETECT_DISTANCE = 110


def normalize_key(value):
    key = (value or DEFAULT_KEY).strip().lstrip('#').upper()
    if len(key) != 6 or any(c not in '0123456789ABCDEF' for c in key):
        return DEFAULT_KEY
    return key


def green_pixels(image):
    r, g, b, _ = image.convert('RGBA').split()
    return ImageChops.multiply(
        ImageChops.subtract(g, ImageChops.lighter(r, b)).point(lambda n: 255 if n >= 24 else 0),
        g.point(lambda n: 255 if n >= 125 else 0),
    )


def key_pixels(image, key):
    """Pixels close to the requested key colour in hue, saturated and bright."""
    key = normalize_key(key)
    hue_key = next((hue for value, hue in CANDIDATES if value == key), None)
    if hue_key is None:
        red, green, blue = (int(key[i:i + 2], 16) for i in (0, 2, 4))
        import colorsys
        hue_key = round(colorsys.rgb_to_hsv(red / 255, green / 255, blue / 255)[0] * 255) % 256
    hue, saturation, value = image.convert('RGB').convert('HSV').split()
    width, height = hue.size
    center = Image.new('L', (width, height), hue_key)
    delta = ImageChops.lighter(
        ImageChops.subtract(hue, center),
        ImageChops.subtract(center, hue),
    )
    in_range = delta.point(lambda n: 255 if min(n, 256 - n) <= HUE_TOLERANCE else 0)
    saturated = saturation.point(lambda n: 255 if n >= MIN_SATURATION else 0)
    bright = value.point(lambda n: 255 if n >= MIN_VALUE else 0)
    return ImageChops.multiply(ImageChops.multiply(in_range, saturated), bright)


def mask_for(image, key):
    return green_pixels(image) if key == DEFAULT_KEY else key_pixels(image, key)


def edge_points(width, height):
    return (
        [(x, 0) for x in range(width)], [(x, height - 1) for x in range(width)],
        [(0, y) for y in range(height)], [(width - 1, y) for y in range(height)],
    )


def detect_key(image):
    """Return the candidate key colour that actually covers the image border."""
    picture = image.convert('RGB')
    width, height = picture.size
    step = max(1, min(width, height) // 48)
    points = (
        [(x, 0) for x in range(0, width, step)] + [(x, height - 1) for x in range(0, width, step)]
        + [(0, y) for y in range(0, height, step)] + [(width - 1, y) for y in range(0, height, step)]
    )
    if not points:
        return None
    scores = {value: 0 for value, _ in CANDIDATES}
    for point in points:
        red, green, blue = picture.getpixel(point)
        for value, _ in CANDIDATES:
            target = tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
            if sum((a - b) ** 2 for a, b in zip((red, green, blue), target)) ** .5 <= DETECT_DISTANCE:
                scores[value] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] >= .8 * len(points) else None


def extract(image, reference=None, key=DEFAULT_KEY):
    key = normalize_key(key)
    image = image.convert('RGBA')
    r, g, b, alpha = image.split()
    strongest = ImageChops.lighter(r, b)
    screen = mask_for(image, key)
    whole_screen = screen.copy()
    width, height = image.size
    edges = edge_points(width, height)
    if any(sum(screen.getpixel(p) == 255 for p in edge) < .8 * len(edge) for edge in edges):
        raise ValueError('background is not the expected chroma screen')
    for edge in edges:
        for p in edge:
            if screen.getpixel(p) == 255:
                ImageDraw.floodfill(screen, p, 128)
    connected = screen.point(lambda n: 255 if n == 128 else 0)
    removed = connected.histogram()[255] / (width * height)
    if not .10 <= removed <= .98:
        raise ValueError('background removal would leave an invalid subject')
    if reference is not None:
        ref = reference.convert('RGBA')
        solid = ref.getchannel('A').point(lambda n: 255 if n >= 240 else 0)
        # Reclaim islands enclosed by accessories only when the reference shows
        # the character has no meaningful area of the key colour.
        if solid.histogram()[255] and ImageChops.multiply(mask_for(ref, key), solid).histogram()[255] < solid.histogram()[255] * .003:
            if whole_screen.histogram()[255] <= width * height * .98:
                connected = whole_screen
    # Ignore tiny non-screen artifacts along the outermost pixels of an
    # otherwise verified screen. The generated character is required to have padding.
    ImageDraw.Draw(connected).rectangle((0, 0, width - 1, height - 1), outline=255, width=2)
    fringe = connected.filter(ImageFilter.MaxFilter(7))
    g = Image.composite(ImageChops.darker(g, strongest), g, fringe)
    return Image.merge('RGBA', (r, g, b, ImageChops.multiply(alpha, ImageChops.invert(connected))))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('reference', nargs='?')
    parser.add_argument('--key', default=DEFAULT_KEY)
    parser.add_argument('--auto', action='store_true')
    args = parser.parse_args()

    requested = normalize_key(args.key)
    source = Image.open(args.source)
    reference = Image.open(args.reference) if args.reference else None
    try:
        try:
            result = extract(source, reference, requested)
            used = requested
        except ValueError:
            detected = detect_key(source) if args.auto else None
            if not detected or detected == requested:
                raise
            result = extract(source, reference, detected)
            used = detected
        result.save(args.output)
        if used != requested:
            print('CHROMA_KEY ' + used)
    finally:
        source.close()
        if reference is not None:
            reference.close()


if __name__ == '__main__':
    main()
