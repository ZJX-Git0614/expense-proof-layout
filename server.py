"""Local static server, PDF previews, and final PDF layout export."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import zlib
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent
MAX_BODY = 25 * 1024 * 1024
PAGE_DPI = 150
POINTS_PER_MM = 72 / 25.4


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def pdf_metadata(pdf_path: Path) -> dict:
    command = shutil.which("pdfinfo")
    if not command:
        return {}
    try:
        result = subprocess.run(
            [command, str(pdf_path)], capture_output=True, text=True, timeout=8, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    pages_match = re.search(r"^Pages:\s+(\d+)", result.stdout, flags=re.MULTILINE)
    size_match = re.search(r"^Page size:\s+([\d.]+) x ([\d.]+) pts", result.stdout, flags=re.MULTILINE)
    metadata = {"pages": int(pages_match.group(1))} if pages_match else {}
    if size_match:
        width = round(float(size_match.group(1)) * 25.4 / 72)
        height = round(float(size_match.group(2)) * 25.4 / 72)
        metadata["dimensions"] = f"{width}×{height}mm"
    return metadata


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], list[tuple[str, bytes]]]:
    message = BytesParser(policy=policy.default).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    fields: dict[str, str] = {}
    uploads: list[tuple[str, bytes]] = []
    for part in message.walk():
        if part.is_multipart():
            continue
        field_name = part.get_param("name", header="Content-Disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename:
            uploads.append((filename, payload))
        elif field_name:
            fields[field_name] = payload.decode("utf-8", errors="replace")
    return fields, uploads


def next_ppm_token(data: bytes, cursor: int) -> tuple[bytes, int]:
    while cursor < len(data):
        while cursor < len(data) and data[cursor] in b" \t\r\n":
            cursor += 1
        if cursor >= len(data):
            break
        if data[cursor] == ord("#"):
            newline = data.find(b"\n", cursor)
            cursor = len(data) if newline < 0 else newline + 1
            continue
        start = cursor
        while cursor < len(data) and data[cursor] not in b" \t\r\n#":
            cursor += 1
        return data[start:cursor], cursor
    raise ValueError("invalid PPM image")


def read_ppm(ppm_path: Path) -> tuple[int, int, bytes]:
    data = ppm_path.read_bytes()
    magic, cursor = next_ppm_token(data, 0)
    width_token, cursor = next_ppm_token(data, cursor)
    height_token, cursor = next_ppm_token(data, cursor)
    max_value_token, cursor = next_ppm_token(data, cursor)
    width = int(width_token)
    height = int(height_token)
    max_value = int(max_value_token)
    if magic != b"P6" or width < 1 or height < 1 or max_value < 1:
        raise ValueError("unsupported PPM image")
    while cursor < len(data) and data[cursor] in b" \t\r\n":
        cursor += 1
    expected = width * height * 3
    pixels = data[cursor : cursor + expected]
    if len(pixels) != expected:
        raise ValueError("truncated PPM image")
    if max_value == 255:
        return width, height, pixels
    normalized = bytes(round(value * 255 / max_value) for value in pixels)
    return width, height, normalized


def render_pdf_page(pdf_path: Path, page_number: int, temp_dir: Path, stem: str) -> tuple[int, int, bytes]:
    command = shutil.which("pdftoppm")
    if not command:
        raise RuntimeError("pdftoppm not installed")
    output_prefix = temp_dir / f"{stem}-{page_number}"
    subprocess.run(
        [
            command,
            "-f",
            str(page_number),
            "-l",
            str(page_number),
            "-singlefile",
            "-r",
            str(PAGE_DPI),
            str(pdf_path),
            str(output_prefix),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    return read_ppm(output_prefix.with_suffix(".ppm"))


def render_png_page(pdf_path: Path, page_number: int, temp_dir: Path, stem: str) -> bytes:
    command = shutil.which("pdftoppm")
    if not command:
        raise RuntimeError("pdftoppm not installed")
    output_prefix = temp_dir / f"{stem}-{page_number}"
    subprocess.run(
        [
            command,
            "-f",
            str(page_number),
            "-l",
            str(page_number),
            "-singlefile",
            "-png",
            "-r",
            "120",
            str(pdf_path),
            str(output_prefix),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    return output_prefix.with_suffix(".png").read_bytes()


def image_to_pdf(image_path: Path, output_path: Path) -> None:
    command = shutil.which("sips")
    if not command:
        raise RuntimeError("图片排版需要 macOS sips 或先转换为 PDF")
    subprocess.run(
        [command, "-s", "format", "pdf", str(image_path), "--out", str(output_path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=20,
    )


def collect_source_pages(uploads: list[tuple[str, bytes]], temp_dir: Path) -> list[tuple[int, int, bytes]]:
    pages: list[tuple[int, int, bytes]] = []
    for upload_index, (filename, payload) in enumerate(uploads):
        suffix = Path(filename).suffix.lower() or ".pdf"
        source_path = temp_dir / f"source-{upload_index}{suffix}"
        source_path.write_bytes(payload)
        pdf_path = source_path
        if suffix != ".pdf":
            pdf_path = temp_dir / f"source-{upload_index}.pdf"
            image_to_pdf(source_path, pdf_path)
        metadata = pdf_metadata(pdf_path)
        page_count = max(1, int(metadata.get("pages", 1)))
        for page_number in range(1, page_count + 1):
            pages.append(render_pdf_page(pdf_path, page_number, temp_dir, f"source-{upload_index}"))
    return pages


def millimeters_to_pixels(value: float) -> int:
    return max(1, round(value / 25.4 * PAGE_DPI))


def layout_size(layout: str) -> tuple[float, float]:
    if layout == "A5":
        return 148, 210
    return 210, 297


def layout_slots(layout: str, page_width: int, page_height: int) -> list[tuple[int, int, int, int]]:
    margin_mm = 6 if layout == "A4" else 8
    margin = millimeters_to_pixels(margin_mm)
    if layout == "A4":
        gap = millimeters_to_pixels(4)
        slot_height = (page_height - margin * 2 - gap) // 2
        return [
            (margin, margin, page_width - margin * 2, slot_height),
            (margin, margin + slot_height + gap, page_width - margin * 2, slot_height),
        ]
    return [(margin, margin, page_width - margin * 2, page_height - margin * 2)]


def resize_nearest(width: int, height: int, pixels: bytes, target_width: int, target_height: int) -> bytes:
    if width == target_width and height == target_height:
        return pixels
    output = bytearray(target_width * target_height * 3)
    for target_y in range(target_height):
        source_y = min(height - 1, target_y * height // target_height)
        source_row = source_y * width * 3
        target_row = target_y * target_width * 3
        for target_x in range(target_width):
            source_x = min(width - 1, target_x * width // target_width)
            source_start = source_row + source_x * 3
            target_start = target_row + target_x * 3
            output[target_start : target_start + 3] = pixels[source_start : source_start + 3]
    return bytes(output)


def compose_layout_pages(
    source_pages: list[tuple[int, int, bytes]], layout: str
) -> tuple[list[tuple[float, float, int, int, bytes]], int]:
    page_width_mm, page_height_mm = layout_size(layout)
    page_width = millimeters_to_pixels(page_width_mm)
    page_height = millimeters_to_pixels(page_height_mm)
    slots = layout_slots(layout, page_width, page_height)
    result: list[tuple[float, float, int, int, bytes]] = []
    for start in range(0, len(source_pages), len(slots)):
        canvas = bytearray([255]) * (page_width * page_height * 3)
        for source, slot in zip(source_pages[start : start + len(slots)], slots):
            source_width, source_height, source_pixels = source
            slot_x, slot_y, slot_width, slot_height = slot
            scale = min(slot_width / source_width, slot_height / source_height)
            target_width = max(1, round(source_width * scale))
            target_height = max(1, round(source_height * scale))
            target_pixels = resize_nearest(
                source_width, source_height, source_pixels, target_width, target_height
            )
            left = slot_x + (slot_width - target_width) // 2
            top = slot_y + (slot_height - target_height) // 2
            for row in range(target_height):
                target_start = ((top + row) * page_width + left) * 3
                source_start = row * target_width * 3
                canvas[target_start : target_start + target_width * 3] = target_pixels[
                    source_start : source_start + target_width * 3
                ]
        result.append((page_width_mm, page_height_mm, page_width, page_height, bytes(canvas)))
    return result, len(result)


def build_pdf(pages: list[tuple[float, float, int, int, bytes]]) -> bytes:
    objects: list[bytes | None] = [b"<< /Type /Catalog /Pages 2 0 R >>", None]
    page_references: list[int] = []
    for page_width_mm, page_height_mm, pixel_width, pixel_height, pixels in pages:
        compressed = zlib.compress(pixels, level=6)
        image_id = len(objects) + 1
        objects.append(
            (
                f"<< /Type /XObject /Subtype /Image /Width {pixel_width} /Height {pixel_height} "
                f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
                f"/Length {len(compressed)} >>\nstream\n"
            ).encode()
            + compressed
            + b"\nendstream"
        )
        content = f"q\n{page_width_mm * POINTS_PER_MM:.4f} 0 0 {page_height_mm * POINTS_PER_MM:.4f} 0 0 cm\n/Im0 Do\nQ\n".encode()
        content_id = len(objects) + 1
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream")
        page_id = len(objects) + 1
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_width_mm * POINTS_PER_MM:.4f} "
                f"{page_height_mm * POINTS_PER_MM:.4f}] /Resources << /XObject << /Im0 {image_id} 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode()
        )
        page_references.append(page_id)
    kids = " ".join(f"{page_id} 0 R" for page_id in page_references)
    objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_references)} >>".encode()

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for object_id, content in enumerate(objects, start=1):
        if content is None:
            raise ValueError("incomplete PDF object")
        offsets.append(len(output))
        output.extend(f"{object_id} 0 obj\n".encode())
        output.extend(content)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode()
    )
    return bytes(output)


def make_merged_pdf(uploads: list[tuple[str, bytes]], layout: str) -> tuple[bytes, int]:
    if layout not in {"A4", "A5", "OA"}:
        raise ValueError("unsupported layout")
    if not uploads:
        raise ValueError("missing files")
    with tempfile.TemporaryDirectory(prefix="expense-merge-") as temp_dir:
        source_pages = collect_source_pages(uploads, Path(temp_dir))
        layout_pages, page_count = compose_layout_pages(source_pages, layout)
        return build_pdf(layout_pages), page_count


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: int, payload: dict) -> None:
        encoded = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):  # noqa: N802 - stdlib handler API
        path = self.path.split("?", 1)[0]
        if path not in {"/api/preview", "/api/merge"}:
            self.send_error(404)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 1 or content_length > MAX_BODY:
                raise ValueError("file too large or missing")
            body = self.rfile.read(content_length)
            if len(body) != content_length:
                raise ValueError("incomplete upload")
            fields, uploads = parse_multipart(self.headers.get("Content-Type", ""), body)
            if path == "/api/preview":
                if not uploads:
                    raise ValueError("missing file")
                filename, source = uploads[0]
                suffix = Path(filename).suffix.lower() or ".pdf"
                with tempfile.TemporaryDirectory(prefix="expense-preview-") as temp_dir:
                    input_path = Path(temp_dir) / f"source{suffix}"
                    input_path.write_bytes(source)
                    if suffix == ".pdf":
                        image = render_png_page(input_path, 1, Path(temp_dir), "preview")
                        metadata = pdf_metadata(input_path)
                    else:
                        pdf_path = Path(temp_dir) / "source.pdf"
                        image_to_pdf(input_path, pdf_path)
                        image = render_png_page(pdf_path, 1, Path(temp_dir), "preview")
                        metadata = pdf_metadata(pdf_path)
                self.send_json(
                    200,
                    {
                        "dataUrl": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
                        "pages": metadata.get("pages", 1),
                        "dimensions": metadata.get("dimensions", "PDF 预览"),
                    },
                )
                return

            layout = fields.get("layout", "A4")
            pdf, page_count = make_merged_pdf(uploads, layout)
            filename = f"报销凭证拼版-{layout}.pdf"
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=expense-layout.pdf; filename*=UTF-8''{quote(filename)}",
            )
            self.send_header("X-PDF-Pages", str(page_count))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(pdf)))
            self.end_headers()
            self.wfile.write(pdf)
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.send_json(422, {"error": str(error)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "4173"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AppHandler)
    print(f"Serving expense-proof-layout on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
