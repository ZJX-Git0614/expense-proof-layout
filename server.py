"""Local static server plus first-page PDF raster previews."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import re
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MAX_BODY = 25 * 1024 * 1024


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


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):  # noqa: N802 - stdlib handler API
        if self.path != "/api/preview":
            self.send_error(404)
            return
        try:
            body = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), MAX_BODY + 1))
            if len(body) > MAX_BODY:
                raise ValueError("file too large")
            content_type = self.headers.get("Content-Type", "")
            message = BytesParser(policy=policy.default).parsebytes(
                f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
            )
            attachment = next((part for part in message.iter_attachments() if part.get_filename()), None)
            if attachment is None:
                raise ValueError("missing file")
            filename = attachment.get_filename() or "upload.pdf"
            source = attachment.get_payload(decode=True) or b""
            suffix = Path(filename).suffix.lower() or ".pdf"
            with tempfile.TemporaryDirectory(prefix="expense-preview-") as temp_dir:
                input_path = Path(temp_dir) / f"source{suffix}"
                output_prefix = Path(temp_dir) / "page"
                input_path.write_bytes(source)
                command = shutil.which("pdftoppm")
                if not command:
                    raise RuntimeError("pdftoppm not installed")
                subprocess.run(
                    [command, "-f", "1", "-l", "1", "-singlefile", "-png", "-r", "120", str(input_path), str(output_prefix)],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=20,
                )
                image_path = output_prefix.with_suffix(".png")
                image = image_path.read_bytes()
                metadata = pdf_metadata(input_path)
            payload = {
                "dataUrl": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
                "pages": metadata.get("pages", 1),
                "dimensions": metadata.get("dimensions", "PDF 预览"),
            }
            self.send_response(200)
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
            payload = {"error": str(error)}
            self.send_response(422)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        encoded = json_bytes(payload)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


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
