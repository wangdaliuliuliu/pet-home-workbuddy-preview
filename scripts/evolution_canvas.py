"""Canvas dimensions for finished evolution art and generated source assets."""
from math import ceil

MIN_CANVAS = 512
MIN_CANDIDATE_EDGE = ceil(MIN_CANVAS * .9)


def valid_candidate_size(image):
    return min(image.size) >= MIN_CANDIDATE_EDGE
