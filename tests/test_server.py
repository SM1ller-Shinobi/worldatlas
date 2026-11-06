import json
import tempfile
import threading
import unittest
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
