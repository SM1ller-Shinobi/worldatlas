"""Small localhost HTTP server for the browser-based desktop interface."""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import secrets
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .storage import StoreError, WorldStore, atomic_write


WEB_DIR = Path(__file__).resolve().parent / "web"
APP_DATA = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share")) / "WorldAtlas"
RECENTS = APP_DATA / "recent.json"
SETTINGS = APP_DATA / "settings.json"
MAX_REQUEST = 20 * 1024 * 1024
LOG = logging.getLogger("worldatlas")


def read_recents() -> list[str]:
    try:
        data = json.loads(RECENTS.read_text(encoding="utf-8"))
        return [x for x in data if isinstance(x, str) and Path(x).is_dir()][:12]
    except (OSError, ValueError, TypeError):
        return []


def add_recent(path: str) -> None:
    current = [p for p in read_recents() if p != path]
    atomic_write(RECENTS, (json.dumps([path, *current][:12], ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def read_settings() -> dict:
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("theme") in ("modern", "fantasy"):
            return {"theme": data["theme"], "avatars_enabled": data.get("avatars_enabled") is True}
    except (OSError, ValueError, TypeError):
        pass
    return {"theme": "modern", "avatars_enabled": False}


def update_settings(data: dict) -> dict:
    if not isinstance(data, dict):
        raise StoreError("Неверные настройки приложения")
    current = read_settings()
    theme = data.get("theme", current["theme"])
    if theme not in ("modern", "fantasy"):
        raise StoreError("Неизвестная тема оформления")
    avatars_enabled = data.get("avatars_enabled", current["avatars_enabled"])
    if not isinstance(avatars_enabled, bool):
        raise StoreError("Настройка аватаров должна быть включена или выключена")
    settings = {"theme": theme, "avatars_enabled": avatars_enabled}
    atomic_write(SETTINGS, (json.dumps(settings, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return settings


def pick_folder() -> str:
    script = (
        "import tkinter as tk; from tkinter import filedialog; "
        "root=tk.Tk(); root.withdraw(); root.attributes('-topmost', True); "
        "print(filedialog.askdirectory(title='Выберите папку мира')); root.destroy()"
    )
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                            timeout=180, creationflags=flags, check=False)
    if result.returncode != 0:
        raise StoreError("Не удалось открыть выбор папки. Можно ввести путь вручную.")
    return result.stdout.strip()


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, Handler)
        self.store = WorldStore()
        self.token = secrets.token_urlsafe(32)


class Handler(BaseHTTPRequestHandler):
    server: AppServer

    def log_message(self, format_string, *args):
        LOG.info("%s %s", self.address_string(), format_string % args)

    def _headers(self, status: int, mime: str, length: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()

    def _bytes(self, data: bytes, mime: str, status: int = 200) -> None:
        self._headers(status, mime, len(data))
        self.wfile.write(data)

    def _json(self, value: object, status: int = 200) -> None:
        self._bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def _authorized(self, url) -> bool:
        token = self.headers.get("X-WorldAtlas-Token")
        if url.path.startswith("/asset/"):
            token = parse_qs(url.query).get("token", [None])[0]
        return token == self.server.token

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise StoreError("Неверная длина запроса") from exc
        if length <= 0 or length > MAX_REQUEST:
            raise StoreError("Запрос слишком большой или пустой")
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError) as exc:
            raise StoreError("Неверный JSON") from exc
        if not isinstance(data, dict):
            raise StoreError("Ожидается JSON-объект")
        return data

    def _handle(self, method: str) -> None:
        url = urlparse(self.path)
        try:
            if method == "GET" and url.path == "/":
                template = (WEB_DIR / "index.html").read_text(encoding="utf-8")
                html = template.replace("__SESSION_TOKEN__", self.server.token).replace("__THEME__", read_settings()["theme"])
                self._bytes(html.encode("utf-8"), "text/html; charset=utf-8")
                return
            if method == "GET" and url.path in ("/app.js", "/style.css", "/project-settings.css", "/fantasy.css", "/avatars.css", "/editor-controls.css", "/lightbox.css", "/project-cover.css"):
                mime = "text/javascript" if url.path.endswith(".js") else "text/css"
                self._bytes((WEB_DIR / url.path[1:]).read_bytes(), f"{mime}; charset=utf-8")
                return
            if not self._authorized(url):
                raise StoreError("Доступ запрещён", 403)
            if method == "GET" and url.path == "/api/state":
                project = self.server.store.project_data() if self.server.store.root else None
                self._json({"project_data": project, "recents": read_recents(), "settings": read_settings()})
                return
            if method == "PUT" and url.path == "/api/settings":
                self._json(update_settings(self._body()))
                return
            if method == "GET" and url.path == "/api/project":
                self._json(self.server.store.project_data())
                return
            if method == "GET" and url.path.startswith("/api/entry/"):
                self._json(self.server.store.get_entry(url.path.split("/")[-1]))
                return
            if method == "GET" and url.path.startswith("/asset/"):
                path = self.server.store.asset_path(url.path.split("/")[-1])
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                self._bytes(path.read_bytes(), mime)
                return
            if method == "POST" and url.path == "/api/pick-folder":
                self._json({"path": pick_folder()})
                return
            if method == "POST" and url.path == "/api/project/inspect":
                data = self._body()
                self._json(WorldStore.inspect(data.get("path", "")))
                return
            if method == "POST" and url.path == "/api/project/open":
                data = self._body()
                result = self.server.store.open(data.get("path", ""), bool(data.get("create")), data.get("title", ""))
                add_recent(result["path"])
                self._json(result)
                return
            if method == "PUT" and url.path == "/api/project":
                data = self._body()
                self._json(self.server.store.update_project(data.get("project", {}), data.get("revision", "")))
                return
            if method == "POST" and url.path == "/api/project/image":
                data = self._body()
                try:
                    image = base64.b64decode(data.get("data", ""), validate=True)
                except (ValueError, TypeError) as exc:
                    raise StoreError("Неверное изображение") from exc
                self._json(self.server.store.add_project_image(str(data.get("name", "image")), image), 201)
                return
            if method == "POST" and url.path == "/api/entry":
                self._json(self.server.store.create_entry(self._body()), 201)
                return
            if url.path.startswith("/api/entry/") and method in ("PUT", "POST"):
                parts = url.path.split("/")
                entry_id = parts[3] if len(parts) > 3 else ""
                data = self._body()
                if method == "PUT" and len(parts) == 4:
                    self._json(self.server.store.save_entry(entry_id, data.get("entry", {}), data.get("revision", "")))
                    return
                if method == "POST" and len(parts) == 5 and parts[4] in ("trash", "restore"):
                    self._json(self.server.store.set_deleted(entry_id, parts[4] == "trash", data.get("revision", "")))
                    return
            if method == "POST" and url.path == "/api/image":
                data = self._body()
                try:
                    image = base64.b64decode(data.get("data", ""), validate=True)
                except (ValueError, TypeError) as exc:
                    raise StoreError("Неверное изображение") from exc
                self._json(self.server.store.add_image(str(data.get("name", "image")), image), 201)
                return
            if method == "POST" and url.path == "/api/backup":
                path = self.server.store.make_backup()
                self._json({"path": str(path)})
                return
            if method == "POST" and url.path == "/api/quit":
                self._json({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            raise StoreError("Адрес не найден", 404)
        except StoreError as exc:
            self._json({"error": str(exc)}, exc.status)
        except (OSError, KeyError, TypeError, ValueError) as exc:
            LOG.exception("Request failed")
            self._json({"error": f"Ошибка чтения или записи: {exc}"}, 500)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="WorldAtlas: локальный редактор вымышленных миров")
    parser.add_argument("--project", help="Открыть папку существующего проекта")
    parser.add_argument("--no-browser", action="store_true", help="Не открывать браузер автоматически")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    server = AppServer(("127.0.0.1", 0))
    if args.project:
        server.store.open(args.project)
    address = f"http://127.0.0.1:{server.server_port}/"
    print(f"WorldAtlas открыт: {address}", flush=True)
    if not args.no_browser:
        webbrowser.open(address)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
