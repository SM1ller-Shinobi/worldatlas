import base64
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from worldatlas.server import AppServer


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = AppServer(("127.0.0.1", 0))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method="GET", body=None, token=True):
        headers = {"X-WorldAtlas-Token": self.server.token} if token else {}
        data = None if body is None else json.dumps(body).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base + path, data=data, headers=headers, method=method)
        with urlopen(request, timeout=5) as response:
            return response.status, json.load(response)

    def test_api_create_update_and_authorization(self):
        with self.assertRaises(HTTPError) as context:
            self.request("/api/state", token=False)
        self.assertEqual(context.exception.code, 403)
        context.exception.close()
        folder = Path(self.temp.name) / "Мир"
        status, project = self.request("/api/project/open", "POST", {"path": str(folder), "create": True, "title": "Мир"})
        self.assertEqual(status, 200)
        self.assertEqual(project["project"]["title"], "Мир")
        status, created = self.request("/api/entry", "POST", {"kind": "character", "title": "Мара"})
        self.assertEqual(status, 201)
        entry_id = created["entry"]["id"]
        changed = dict(created["entry"])
        changed["fields"]["role"] = "Капитан"
        _, saved = self.request(f"/api/entry/{entry_id}", "PUT", {"entry": changed, "revision": created["revision"]})
        self.assertEqual(saved["entry"]["fields"]["role"], "Капитан")
        with self.assertRaises(HTTPError) as context:
            self.request(f"/api/entry/{entry_id}", "PUT", {"entry": changed, "revision": created["revision"]})
        self.assertEqual(context.exception.code, 409)
        context.exception.close()

    def test_app_theme_is_saved_and_loaded(self):
        settings_file = Path(self.temp.name) / "settings.json"
        with patch("worldatlas.server.SETTINGS", settings_file):
            _, state = self.request("/api/state")
            self.assertEqual(state["settings"]["theme"], "modern")
            self.assertFalse(state["settings"]["avatars_enabled"])
            _, saved = self.request("/api/settings", "PUT", {"theme": "fantasy", "avatars_enabled": True})
            self.assertEqual(saved["theme"], "fantasy")
            self.assertTrue(saved["avatars_enabled"])
            self.assertEqual(json.loads(settings_file.read_text(encoding="utf-8"))["theme"], "fantasy")
            _, state = self.request("/api/state")
            self.assertEqual(state["settings"]["theme"], "fantasy")
            self.assertTrue(state["settings"]["avatars_enabled"])
            with urlopen(self.base + "/", timeout=5) as response:
                self.assertIn('data-theme="fantasy"', response.read().decode("utf-8"))
            _, saved = self.request("/api/settings", "PUT", {"theme": "modern"})
            self.assertTrue(saved["avatars_enabled"])
            with self.assertRaises(HTTPError) as context:
                self.request("/api/settings", "PUT", {"avatars_enabled": "yes"})
            self.assertEqual(context.exception.code, 400)
            context.exception.close()
            with self.assertRaises(HTTPError) as context:
                self.request("/api/settings", "PUT", {"theme": "unknown"})
            self.assertEqual(context.exception.code, 400)
            context.exception.close()
            self.assertEqual(json.loads(settings_file.read_text(encoding="utf-8"))["theme"], "modern")
            settings_file.write_text('{"theme":"fantasy"}', encoding="utf-8")
            self.assertFalse(self.request("/api/state")[1]["settings"]["avatars_enabled"])

    def test_project_image_api(self):
        folder = Path(self.temp.name) / "Мир"
        self.request("/api/project/open", "POST", {"path": str(folder), "create": True})
        image = base64.b64encode(b"\x89PNG\r\n\x1a\nimage-data").decode("ascii")
        status, response = self.request("/api/project/image", "POST", {"name": "cover.png", "data": image})
        self.assertEqual(status, 201)
        self.assertTrue(response["asset"].endswith(".png"))
        self.assertEqual((folder / "assets" / response["asset"]).read_bytes(), base64.b64decode(image))
        with self.assertRaises(HTTPError) as context:
            self.request("/api/project/image", "POST", {"name": "bad.svg", "data": base64.b64encode(b"<svg/>").decode("ascii")})
        self.assertEqual(context.exception.code, 400)
        context.exception.close()


if __name__ == "__main__":
    unittest.main()
