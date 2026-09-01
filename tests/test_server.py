import unittest

from server import orient_page_for_slot, rotate_clockwise


def solid_pixels(width: int, height: int, color: bytes = b"\x11\x22\x33") -> bytes:
    return color * (width * height)


class PageOrientationTests(unittest.TestCase):
    def test_rotate_clockwise_preserves_rgb_pixels(self):
        source = bytes((255, 0, 0, 0, 255, 0))

        width, height, rotated = rotate_clockwise(2, 1, source)

        self.assertEqual((width, height), (1, 2))
        self.assertEqual(rotated, bytes((255, 0, 0, 0, 255, 0)))

    def test_a4_rotates_portrait_page_when_wider_slot_is_better(self):
        source = (2, 4, solid_pixels(2, 4))

        width, height, _ = orient_page_for_slot(source, 100, 60, "A4")

        self.assertEqual((width, height), (4, 2))

    def test_a4_keeps_landscape_page_in_original_orientation(self):
        source = (4, 2, solid_pixels(4, 2))

        width, height, _ = orient_page_for_slot(source, 100, 60, "A4")

        self.assertEqual((width, height), (4, 2))

    def test_single_page_layouts_keep_portrait_orientation(self):
        source = (2, 4, solid_pixels(2, 4))

        for layout in ("A5", "OA"):
            with self.subTest(layout=layout):
                width, height, _ = orient_page_for_slot(source, 100, 60, layout)
                self.assertEqual((width, height), (2, 4))


if __name__ == "__main__":
    unittest.main()
