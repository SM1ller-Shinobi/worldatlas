"""Persistent project storage. Markdown files are the source of truth."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path


KINDS = {
    "story": ("stories", "Сюжет"),
    "character": ("characters", "Персонажи"),
    "place": ("places", "Места"),
    "item": ("items", "Предметы"),
    "faction": ("factions", "Фракции"),
    "lore": ("lore", "Устройство мира"),
    "event": ("events", "Хронология"),
    "other": ("other", "Другое"),
}
UUID_RE = re.compile(r"^[0-9a-f]{32}$")
ASSET_RE = re.compile(r"^[0-9a-f]{32}\.(png|jpg|webp|gif)$")
MAX_IMAGE_BYTES = 12 * 1024 * 1024


class StoreError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def project_path(value: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise StoreError("Укажите папку проекта")
    return Path(os.path.expandvars(value.strip())).expanduser().resolve()


def atomic_write(path: Path, data: bytes) -> None:
    """Replace a file only after its complete contents reach the filesystem."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".worldatlas-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def markdown_document(entry: dict) -> bytes:
    metadata = {key: value for key, value in entry.items() if key not in ("body", "title")}
    metadata["schema"] = 2
    header = json.dumps(metadata, ensure_ascii=False, indent=2)
    body = entry.get("body", "").strip("\n")
    if body.startswith(f"# {entry['title']}\n"):
        body = body.split("\n", 1)[1].lstrip("\n")
    return f"---\n{header}\n---\n\n# {entry['title']}\n\n{body}\n".encode("utf-8")


def parse_document(data: bytes) -> dict:
    try:
        text = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
        if not text.startswith("---\n"):
            raise ValueError("нет блока метаданных")
        header, body = text[4:].split("\n---\n", 1)
        entry = json.loads(header)
        if not isinstance(entry, dict):
            raise ValueError("метаданные должны быть объектом")
        body = body.lstrip("\n").rstrip("\n")
        if entry.get("schema") == 2:
            heading = re.match(r"^# ([^\n]+)(?:\n|$)", body)
            if heading is None or not heading.group(1).strip():
                raise ValueError("нет заголовка записи")
            entry["title"] = heading.group(1).strip()
            body = body[heading.end():].lstrip("\n")
        if (not isinstance(entry.get("id"), str) or not UUID_RE.fullmatch(entry["id"])
                or not isinstance(entry.get("kind"), str) or entry["kind"] not in KINDS
                or not isinstance(entry.get("title"), str) or not entry["title"].strip()
                or not isinstance(entry.get("fields", {}), dict)
                or not isinstance(entry.get("tags", []), list)
                or not isinstance(entry.get("links", []), list)):
            raise ValueError("неверные или неполные метаданные")
        entry["body"] = body
        return entry
    except (UnicodeError, ValueError) as exc:
        raise StoreError(f"Не удалось прочитать Markdown: {exc}") from exc


def _text(value: object, label: str, limit: int = 10000) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise StoreError(f"Поле «{label}» должно быть текстом до {limit} символов")
    return value


def _clean_entry(entry: dict, original: dict | None = None) -> dict:
    if not isinstance(entry, dict):
        raise StoreError("Неверный формат записи")
    kind = original["kind"] if original else entry.get("kind")
    if kind not in KINDS:
        raise StoreError("Неизвестный раздел")
    title = _text(entry.get("title", ""), "Название", 160).strip()
    if not title:
        raise StoreError("Укажите название")
    if "\n" in title or "\r" in title:
        raise StoreError("Название должно быть одной строкой")
    fields = entry.get("fields", {})
    if not isinstance(fields, dict) or len(fields) > 60:
        raise StoreError("Неверный набор полей")
    clean_fields = {}
    for key, value in fields.items():
        clean_key = _text(key, "Имя поля", 80).strip()
        if not clean_key:
            raise StoreError("Имя поля не может быть пустым")
        clean_fields[clean_key] = _text(value, clean_key, 20000)
    tags = entry.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 30:
        raise StoreError("Слишком много меток")
    tags = list(dict.fromkeys(_text(t, "Метка", 60).strip() for t in tags if t))
    links = entry.get("links", [])
    if not isinstance(links, list) or len(links) > 200 or any(not isinstance(x, str) or not UUID_RE.fullmatch(x) for x in links):
        raise StoreError("Неверные связи")
    parent_id = entry.get("parent_id") or None
    if parent_id is not None and (kind != "story" or not isinstance(parent_id, str) or not UUID_RE.fullmatch(parent_id)):
        raise StoreError("Родитель может быть только у сюжетной записи")
    image = entry.get("image") or None
    if image is not None and (not isinstance(image, str) or not ASSET_RE.fullmatch(image)):
        raise StoreError("Неверный файл изображения")
    order = entry.get("order", 0)
    if isinstance(order, bool) or not isinstance(order, int) or not 0 <= order <= 99999:
        raise StoreError("Порядок должен быть числом от 0 до 99999")
    clean = {
        "id": original["id"] if original else uuid.uuid4().hex,
        "kind": kind,
        "title": title,
        "status": _text(entry.get("status", "Черновик"), "Статус", 60),
        "tags": tags,
        "fields": clean_fields,
        "body": _text(entry.get("body", ""), "Описание", 1_000_000),
        "links": list(dict.fromkeys(x for x in links if x != (original or {}).get("id"))),
        "parent_id": parent_id,
        "order": order,
        "image": image,
        "created_at": original["created_at"] if original else now(),
        "updated_at": now(),
        "deleted": original.get("deleted", False) if original else False,
    }
    if original:
        for key, value in original.items():
            if key not in clean:
                clean[key] = value
    return clean


class WorldStore:
    def __init__(self):
        self.root: Path | None = None
        self.lock = threading.RLock()

    def _root(self) -> Path:
        if self.root is None:
            raise StoreError("Сначала откройте проект", 409)
        return self.root

    def _entry_path(self, kind: str, entry_id: str) -> Path:
        if kind not in KINDS or not UUID_RE.fullmatch(entry_id):
            raise StoreError("Неверный идентификатор")
        return self._root() / KINDS[kind][0] / f"{entry_id}.md"

    def _find_path(self, entry_id: str) -> Path:
        if not UUID_RE.fullmatch(entry_id):
            raise StoreError("Неверный идентификатор")
        for kind in KINDS:
            path = self._entry_path(kind, entry_id)
            if path.is_file():
                return path
        raise StoreError("Запись не найдена", 404)

    @staticmethod
    def inspect(path: str) -> dict:
        folder = project_path(path)
        if folder.is_file():
            raise StoreError("Выберите папку, а не файл")
        manifest = folder / "worldatlas.json"
        title = ""
        if manifest.is_file():
            try:
                title = json.loads(manifest.read_text(encoding="utf-8"))["title"]
            except (ValueError, KeyError) as exc:
                raise StoreError(f"Повреждён паспорт проекта: {exc}") from exc
        return {"path": str(folder), "exists": folder.is_dir(), "is_project": manifest.is_file(), "title": title}

    def open(self, path: str, create: bool = False, title: str = "") -> dict:
        with self.lock:
            folder = project_path(path)
            if folder.is_file():
                raise StoreError("Выберите папку, а не файл")
            manifest = folder / "worldatlas.json"
            if create:
                if manifest.exists():
                    raise StoreError("В этой папке уже есть проект", 409)
                folder.mkdir(parents=True, exist_ok=True)
                project_title = _text(title, "Название проекта", 160).strip() or folder.name
                project = {"format": 1, "id": uuid.uuid4().hex, "title": project_title,
                           "summary": "", "genre": "", "medium": "", "tone": "",
                           "setup_complete": False, "created_at": now(), "updated_at": now()}
                atomic_write(manifest, json.dumps(project, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
            if not manifest.is_file():
                raise StoreError("В папке нет проекта WorldAtlas", 404)
            raw = manifest.read_bytes()
            project = json.loads(raw)
            if project.get("format") != 1:
                raise StoreError("Неподдерживаемая версия проекта")
            self.root = folder
            entries, warnings = self._read_all()
            self._write_index(entries, project)
            return self._project_data(project, raw, entries, warnings)

    def _project_file(self) -> Path:
        return self._root() / "worldatlas.json"

    def project_data(self) -> dict:
        with self.lock:
            manifest = self._project_file()
            raw = manifest.read_bytes()
            project = json.loads(raw)
            entries, warnings = self._read_all()
            return self._project_data(project, raw, entries, warnings)

    def _project_data(self, project: dict, raw: bytes, entries: list[dict], warnings: list[str]) -> dict:
        entries.sort(key=lambda e: e.get("updated_at", ""), reverse=True)
        return {"path": str(self._root()), "project": project, "project_revision": digest(raw),
                "entries": [self._summary(e) for e in entries], "warnings": warnings}

    def update_project(self, data: dict, expected_revision: str) -> dict:
        with self.lock:
            path = self._project_file()
            raw = path.read_bytes()
            if digest(raw) != expected_revision:
                raise StoreError("Проект изменился на диске. Обновите его перед сохранением.", 409)
            project = json.loads(raw)
            project["title"] = _text(data.get("title", ""), "Название", 160).strip() or self._root().name
            project["summary"] = _text(data.get("summary", ""), "Описание", 20000)
            project["genre"] = _text(data.get("genre", ""), "Жанр", 100).strip()
            project["medium"] = _text(data.get("medium", ""), "Формат", 100).strip()
            project["tone"] = _text(data.get("tone", ""), "Тон", 160).strip()
            project["setup_complete"] = True
            project["updated_at"] = now()
            self._history(path, raw)
            atomic_write(path, json.dumps(project, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
            self._write_index()
            return {"project": project, "revision": digest(path.read_bytes())}

    def _read_all(self) -> tuple[list[dict], list[str]]:
        result, warnings = [], []
        cache_path = self._root() / ".worldatlas" / "cache.json"
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            old_files = cached["files"] if cached.get("version") == 1 and isinstance(cached.get("files"), dict) else {}
        except (OSError, ValueError, TypeError):
            old_files = {}
        new_files = {}
        for kind, (directory, _) in KINDS.items():
            for path in sorted((self._root() / directory).glob("*.md")):
                try:
                    key = path.relative_to(self._root()).as_posix()
                    stat = path.stat()
                    previous = old_files.get(key)
                    if (isinstance(previous, dict) and previous.get("mtime_ns") == stat.st_mtime_ns
                            and previous.get("size") == stat.st_size and isinstance(previous.get("entry"), dict)
                            and previous["entry"].get("id") == path.stem and previous["entry"].get("kind") == kind
                            and isinstance(previous["entry"].get("title"), str)):
                        entry = previous["entry"]
                    else:
                        entry = self._summary(parse_document(path.read_bytes()))
                    if entry.get("id") != path.stem or entry.get("kind") != kind:
                        raise StoreError("идентификатор или раздел не совпадает с именем файла")
                    result.append(entry)
                    new_files[key] = {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size, "entry": entry}
                except (OSError, StoreError) as exc:
                    warnings.append(f"{path.relative_to(self._root())}: {exc}")
        if new_files != old_files:
            atomic_write(cache_path, (json.dumps({"version": 1, "files": new_files}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        return result, warnings

    @staticmethod
    def _summary(entry: dict) -> dict:
        return {key: entry.get(key) for key in ("id", "kind", "title", "status", "tags", "parent_id", "links", "image", "order", "updated_at", "deleted")}

    def get_entry(self, entry_id: str) -> dict:
        with self.lock:
            path = self._find_path(entry_id)
            raw = path.read_bytes()
            return {"entry": parse_document(raw), "revision": digest(raw)}

    def create_entry(self, data: dict) -> dict:
        with self.lock:
            entry = _clean_entry(data)
            self._validate_relations(entry)
            path = self._entry_path(entry["kind"], entry["id"])
            atomic_write(path, markdown_document(entry))
            self._write_index()
            return self.get_entry(entry["id"])

    def save_entry(self, entry_id: str, data: dict, expected_revision: str) -> dict:
        with self.lock:
            path = self._find_path(entry_id)
            raw = path.read_bytes()
            if digest(raw) != expected_revision:
                raise StoreError("Запись изменилась на диске. Ваши правки остались в редакторе; обновите запись после их копирования.", 409)
            original = parse_document(raw)
            entry = _clean_entry(data, original)
            self._validate_relations(entry)
            self._history(path, raw)
            atomic_write(path, markdown_document(entry))
            self._write_index()
            return self.get_entry(entry_id)

    def set_deleted(self, entry_id: str, deleted: bool, expected_revision: str) -> dict:
        with self.lock:
            path = self._find_path(entry_id)
            raw = path.read_bytes()
            if digest(raw) != expected_revision:
                raise StoreError("Запись изменилась на диске. Обновите её перед удалением или восстановлением.", 409)
            entry = parse_document(raw)
            entry["deleted"] = deleted
            entry["updated_at"] = now()
            self._history(path, raw)
            atomic_write(path, markdown_document(entry))
            self._write_index()
            return self.get_entry(entry_id)

    def _validate_relations(self, entry: dict) -> None:
        if entry["parent_id"]:
            if entry["parent_id"] == entry["id"]:
                raise StoreError("Запись не может быть своим родителем")
            parent = self.get_entry(entry["parent_id"])["entry"]
            if parent["kind"] != "story" or parent.get("deleted"):
                raise StoreError("Родителем должна быть действующая сюжетная запись")
            seen = {entry["id"]}
            while True:
                if parent["id"] in seen:
                    raise StoreError("Сюжетная иерархия не может содержать цикл")
                seen.add(parent["id"])
                if not parent.get("parent_id"):
                    break
                parent = self.get_entry(parent["parent_id"])["entry"]
        for linked_id in entry["links"]:
            self._find_path(linked_id)
        if entry["image"] and not (self._root() / "assets" / entry["image"]).is_file():
            raise StoreError("Изображение не найдено в проекте")

    def _history(self, path: Path, old_data: bytes) -> None:
        relative = path.relative_to(self._root())
        history = self._root() / ".worldatlas" / "history" / relative.parent / relative.stem
        history.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        atomic_write(history / f"{stamp}-{digest(old_data)[:8]}{path.suffix}", old_data)
        versions = sorted(history.iterdir())
        for stale in versions[:-30]:
            stale.unlink()

    def _write_index(self, entries: list[dict] | None = None, project: dict | None = None) -> None:
        if entries is None:
            entries, _ = self._read_all()
        if project is None:
            project = json.loads(self._project_file().read_text(encoding="utf-8"))
        lines = [f"# {project['title']}", "", project.get("summary", ""), ""]
        for key, label in (("genre", "Жанр"), ("medium", "Формат"), ("tone", "Тон")):
            if project.get(key):
                lines.append(f"**{label}:** {project[key]}")
        lines.extend(["", "Документация мира. Записи в папках — исходные Markdown-файлы проекта.", ""])
        for kind, (directory, label) in KINDS.items():
            current = sorted((e for e in entries if e["kind"] == kind and not e.get("deleted")), key=lambda e: e["title"].casefold())
            lines.extend([f"## {label}", ""])
            if current:
                lines.extend(f"- [{e['title'].replace('[', '').replace(']', '')}]({directory}/{e['id']}.md)" for e in current)
            else:
                lines.append("Пока нет записей.")
            lines.append("")
        atomic_write(self._root() / "WORLDATLAS_INDEX.md", ("\n".join(lines).rstrip() + "\n").encode("utf-8"))

    def add_image(self, filename: str, data: bytes) -> dict:
        with self.lock:
            if not data or len(data) > MAX_IMAGE_BYTES:
                raise StoreError("Изображение должно быть не больше 12 МБ")
            signatures = [(b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"),
                          (b"RIFF", "webp"), (b"GIF87a", "gif"), (b"GIF89a", "gif")]
            extension = next((ext for magic, ext in signatures if data.startswith(magic)), None)
            if extension == "webp" and data[8:12] != b"WEBP":
                extension = None
            if extension is None:
                raise StoreError("Поддерживаются PNG, JPEG, WebP и GIF")
            asset = f"{uuid.uuid4().hex}.{extension}"
            atomic_write(self._root() / "assets" / asset, data)
            return {"asset": asset, "name": filename}

    def asset_path(self, filename: str) -> Path:
        if not ASSET_RE.fullmatch(filename):
            raise StoreError("Неверный файл изображения", 404)
        path = self._root() / "assets" / filename
        if not path.is_file():
            raise StoreError("Изображение не найдено", 404)
        return path

    def make_backup(self) -> Path:
        with self.lock:
            root = self._root()
            backup_dir = root / ".worldatlas" / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            target = backup_dir / f"worldatlas-{stamp}.zip"
            fd, temp_name = tempfile.mkstemp(suffix=".zip", dir=backup_dir)
            os.close(fd)
            try:
                with zipfile.ZipFile(temp_name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    sources = [root / "worldatlas.json", root / "WORLDATLAS_INDEX.md"]
                    for directory in [*(value[0] for value in KINDS.values()), "assets"]:
                        sources.extend((root / directory).rglob("*"))
                    for path in sources:
                        if path.is_file():
                            archive.write(path, path.relative_to(root))
                os.replace(temp_name, target)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
            return target
