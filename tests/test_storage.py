import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from worldatlas.storage import StoreError, WorldStore, markdown_document, parse_document


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / "Тестовый мир"
        self.store = WorldStore()
        self.store.open(str(self.folder), create=True, title="Тестовый мир")

    def test_create_save_reopen_and_index(self):
        created = self.store.create_entry({"kind": "character", "title": "Кэриан", "fields": {"character": "Принц"},
                                           "tags": ["вода"], "body": "## История\nТекст на русском."})
        entry_id = created["entry"]["id"]
        path = self.folder / "characters" / f"{entry_id}.md"
        self.assertTrue(path.is_file())
        self.assertIn("Кэриан", (self.folder / "WORLDATLAS_INDEX.md").read_text(encoding="utf-8"))
        edited = dict(created["entry"])
        edited["title"] = "Кэриан Второй"
        edited["body"] = "Первая строка\n\nВторая строка"
        saved = self.store.save_entry(entry_id, edited, created["revision"])
        self.assertEqual(saved["entry"]["body"], edited["body"])
        reopened = WorldStore()
        data = reopened.open(str(self.folder))
        self.assertEqual(data["entries"][0]["title"], "Кэриан Второй")
        self.assertEqual(reopened.get_entry(entry_id)["entry"]["body"], edited["body"])

    def test_external_edit_conflict_preserves_both_versions(self):
        created = self.store.create_entry({"kind": "place", "title": "Тидхавен", "body": "Причал"})
        entry_id = created["entry"]["id"]
        path = self.folder / "places" / f"{entry_id}.md"
        changed = dict(created["entry"])
        changed["body"] = "Изменено вне приложения"
        path.write_bytes(markdown_document(changed))
        stale = dict(created["entry"])
        stale["body"] = "Несохранённое в приложении"
        with self.assertRaises(StoreError) as result:
            self.store.save_entry(entry_id, stale, created["revision"])
        self.assertEqual(result.exception.status, 409)
        self.assertEqual(parse_document(path.read_bytes())["body"], changed["body"])
        latest = self.store.get_entry(entry_id)
        self.store.save_entry(entry_id, stale, latest["revision"])
        versions = list((self.folder / ".worldatlas" / "history" / "places" / entry_id).glob("*.md"))
        self.assertEqual(len(versions), 1)
        self.assertEqual(parse_document(versions[0].read_bytes())["body"], changed["body"])

    def test_trash_restore_and_backup(self):
        created = self.store.create_entry({"kind": "story", "title": "Пролог"})
        entry_id = created["entry"]["id"]
        trashed = self.store.set_deleted(entry_id, True, created["revision"])
        self.assertTrue(trashed["entry"]["deleted"])
        self.assertNotIn("Пролог", (self.folder / "WORLDATLAS_INDEX.md").read_text(encoding="utf-8"))
        restored = self.store.set_deleted(entry_id, False, trashed["revision"])
        self.assertFalse(restored["entry"]["deleted"])
        backup = self.store.make_backup()
        with zipfile.ZipFile(backup) as archive:
            self.assertIn("worldatlas.json", archive.namelist())
            self.assertIn(f"stories/{entry_id}.md", archive.namelist())
            self.assertIn("WORLDATLAS_INDEX.md", archive.namelist())
            self.assertFalse(any(name.startswith(".worldatlas/") for name in archive.namelist()))

    def test_story_cycle_is_rejected(self):
        first = self.store.create_entry({"kind": "story", "title": "Арка"})
        second = self.store.create_entry({"kind": "story", "title": "Сцена", "parent_id": first["entry"]["id"]})
        edited = dict(first["entry"])
        edited["parent_id"] = second["entry"]["id"]
        with self.assertRaises(StoreError):
            self.store.save_entry(first["entry"]["id"], edited, first["revision"])

    def test_invalid_file_is_reported_without_overwrite(self):
        invalid = self.folder / "characters" / ("a" * 32 + ".md")
        invalid.parent.mkdir(exist_ok=True)
        invalid.write_text("wrong content", encoding="utf-8")
        data = self.store.open(str(self.folder))
        self.assertEqual(len(data["warnings"]), 1)
        self.assertEqual(invalid.read_text(encoding="utf-8"), "wrong content")

    def test_cached_list_tracks_external_edit_and_removal(self):
        created = self.store.create_entry({"kind": "place", "title": "Старое название"})
        entry_id = created["entry"]["id"]
        path = self.folder / "places" / f"{entry_id}.md"
        self.assertEqual(self.store.project_data()["entries"][0]["title"], "Старое название")
        edited = dict(created["entry"])
        edited["title"] = "Новое название снаружи"
        path.write_bytes(markdown_document(edited))
        self.assertEqual(self.store.project_data()["entries"][0]["title"], edited["title"])
        path.unlink()
        self.assertEqual(self.store.project_data()["entries"], [])

    def test_heading_is_readable_and_editable_outside_app(self):
        created = self.store.create_entry({"kind": "lore", "title": "Правило мира", "body": "Старое описание"})
        entry_id = created["entry"]["id"]
        path = self.folder / "lore" / f"{entry_id}.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("# Правило мира\n\nСтарое описание", text)
        path.write_text(text.replace("# Правило мира", "# Новое правило"), encoding="utf-8")
        self.assertEqual(self.store.get_entry(entry_id)["entry"]["title"], "Новое правило")
        self.assertEqual(self.store.project_data()["entries"][0]["title"], "Новое правило")

    def test_image_validation(self):
        with self.assertRaises(StoreError):
            self.store.add_image("bad.svg", b"<svg></svg>")
        image = self.store.add_image("portrait.png", b"\x89PNG\r\n\x1a\n" + b"data")
        self.assertTrue(self.store.asset_path(image["asset"]).is_file())
        with self.assertRaises(StoreError):
            self.store.asset_path("../worldatlas.json")


if __name__ == "__main__":
    unittest.main()
