"""A project folder, opened for the Code view and the code tools.

A code conversation works on one folder the reader opened -- the way a folder
is opened in VS Code -- and everything here keeps it to that folder:

* **the root is the reader's choice, and a narrow one.** `validate_root`
  refuses the filesystem root, the home folder and anything above it, a
  folder that is itself one of WORKSPACE_ROOTS, and anything inside a folder
  of keys (~/.ssh and friends). "Open my home directory" is how an assistant
  ends up one command from every credential on the machine, so it is not an
  option: the reader opens a project.
* **every path goes through `inside`,** which resolves first and checks second,
  so a symlink out of the project fails the same way `../..` does.
* **writes are atomic and checked.** A file is written to a temporary name
  beside itself and renamed over the original, so a crash mid-write never
  leaves half a file; and a save from the editor says which version it was
  edited from, so an agent's change made in the meantime is not silently
  written over (`Conflict`).

The editor API and the code tools share all of this, so what the reader can
open and what the model can touch are the same set of files.
"""

from __future__ import annotations

import fnmatch
import os
import re
import tempfile
import unicodedata
from pathlib import Path

#: Folders nothing here walks into: dependencies, build output, caches, VCS
#: internals. Listed in the editor's tree (dimmed) but never searched, globbed
#: or summarised -- a grep that descends into node_modules answers with noise.
IGNORED = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", "dist", "build", ".next", ".nuxt",
    ".turbo", ".svelte-kit", ".parcel-cache", ".cache", "target", ".gradle",
    "Pods", "DerivedData", "coverage", ".idea", ".egg-info",
}
#: Never shown at all.
HIDDEN = {".git", ".DS_Store", "Thumbs.db"}
#: Folders of keys. A project root may not be one of these or inside one.
SENSITIVE = {".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", "Keychains"}
#: Folders that are the system rather than a project.
SYSTEM = {
    "/", "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private",
    "/var", "/opt", "/Applications", "/Volumes", "/Users", "/home", "/root",
    "/proc", "/sys", "/dev", "/tmp",
}
#: Markers that make a folder look like a project in the picker.
PROJECT_MARKERS = (
    ".git", "package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod",
    "Gemfile", "pom.xml", "build.gradle", "Makefile", "CMakeLists.txt",
    "requirements.txt", "composer.json", "Package.swift", "deno.json",
)

MAX_EDITOR_BYTES = 2_000_000
MAX_LIST = 2_000


class WorkspaceError(ValueError):
    """Refused. The message is written to be shown as it is."""


class Conflict(WorkspaceError):
    """The file changed since the version the save was made from."""

    def __init__(self, message: str, mtime: float) -> None:
        super().__init__(message)
        self.mtime = mtime


def validate_root(given: str, allowed: tuple[Path, ...]) -> Path:
    """The project folder `given` names, or WorkspaceError saying why not."""
    text = (given or "").strip()
    if not text:
        raise WorkspaceError("Choose a project folder.")
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        raise WorkspaceError("Give the folder's full path.")
    try:
        root = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise WorkspaceError(f"There is no folder at {text}.") from None
    if not root.is_dir():
        raise WorkspaceError(f"{text} is a file, not a folder.")

    home = Path.home().resolve()
    if str(root) in SYSTEM or root == home or root in home.parents or root.parent == root:
        raise WorkspaceError(
            f"{root} is too broad to open -- open a project folder inside it instead."
        )
    for part in root.parts:
        if part in SENSITIVE:
            raise WorkspaceError(f"{root} is inside a folder of keys, which is never opened.")
    if allowed:
        if any(root == base for base in allowed):
            raise WorkspaceError(
                f"{root} is too broad to open -- open a project folder inside it instead."
            )
        if not any(base in root.parents for base in allowed):
            listed = ", ".join(str(base) for base in allowed)
            raise WorkspaceError(f"{root} is outside the folders projects can be opened from ({listed}).")
    return root


def inside(root: Path, given: str) -> Path:
    """`given` -- relative to the project, or absolute within it -- as a real
    path inside `root`, or WorkspaceError."""
    text = (given or "").strip() or "."
    if text.startswith("~"):
        raise WorkspaceError(f"{given!r} is outside the project ({root}).")
    candidate = Path(text)
    target = candidate if candidate.is_absolute() else root / candidate
    try:
        target = target.resolve()
    except (OSError, RuntimeError) as exc:
        raise WorkspaceError(f"{given!r} is not a usable path: {exc}") from None
    if target != root and root not in target.parents:
        raise WorkspaceError(f"{given!r} is outside the project ({root}).")
    return target


def in_git_dir(root: Path, path: Path) -> bool:
    """Whether `path` is inside the project's .git -- read freely, but never
    written by the file tools. Git itself, through the shell, is the way in."""
    return path != root and path.relative_to(root).parts[:1] == (".git",)


def relative(root: Path, path: Path) -> str:
    """A path as the project sees it: forward slashes, relative to the root."""
    if path == root:
        return "."
    return path.relative_to(root).as_posix()


def ignored(name: str) -> bool:
    return name in IGNORED or name.endswith(".egg-info")


def list_dir(root: Path, given: str = ".") -> list[dict]:
    """One folder's entries for the editor's tree: folders first, then files."""
    folder = inside(root, given)
    if not folder.is_dir():
        raise WorkspaceError(f"{given} is not a folder.")
    entries = []
    try:
        children = list(os.scandir(folder))
    except OSError as exc:
        raise WorkspaceError(f"{given} could not be listed: {exc.strerror or exc}") from None
    for entry in children:
        if entry.name in HIDDEN:
            continue
        try:
            is_dir = entry.is_dir()
            size = None if is_dir else entry.stat().st_size
        except OSError:
            continue
        entries.append({
            "name": entry.name,
            "path": relative(root, Path(entry.path)),
            "kind": "dir" if is_dir else "file",
            "size": size,
            # Shown, but dimmed and never searched -- see IGNORED.
            "ignored": ignored(entry.name),
        })
    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower()))
    return entries[:MAX_LIST]


def walk_files(root: Path, start: Path | None = None, limit: int = 20_000):
    """Every file under `start` (default the root), skipping IGNORED folders.
    Yields absolute paths, depth-first, in name order."""
    count = 0
    stack = [start or root]
    while stack:
        folder = stack.pop()
        try:
            children = sorted(os.scandir(folder), key=lambda e: e.name.lower(), reverse=True)
        except OSError:
            continue
        for entry in children:
            if entry.name in HIDDEN or ignored(entry.name):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                    continue
                if not entry.is_file():
                    continue
            except OSError:
                continue
            yield Path(entry.path)
            count += 1
            if count >= limit:
                return


def glob(root: Path, pattern: str, start: Path | None = None) -> list[Path]:
    """Files matching a glob like `**/*.py` or `src/*.ts`, relative to `start`."""
    base = start or root
    pattern = (pattern or "").strip().lstrip("./") or "**/*"
    matches = []
    for path in walk_files(root, base):
        rel = path.relative_to(base).as_posix()
        if fnmatch.fnmatch(rel, pattern) or (
            pattern.startswith("**/") and fnmatch.fnmatch(rel, pattern[3:])
        ) or ("/" not in pattern and fnmatch.fnmatch(path.name, pattern)):
            matches.append(path)
    return matches


def is_binary(data: bytes) -> bool:
    return b"\0" in data[:8192]


def read_text(path: Path, max_bytes: int = MAX_EDITOR_BYTES) -> str:
    """A text file's contents, or WorkspaceError for a folder, a binary or a
    file too large to open."""
    if not path.exists():
        raise WorkspaceError(f"{path.name} does not exist.")
    if path.is_dir():
        raise WorkspaceError(f"{path.name} is a folder.")
    size = path.stat().st_size
    if size > max_bytes:
        raise WorkspaceError(f"{path.name} is {size // 1024} KB, too large to open here.")
    data = path.read_bytes()
    if is_binary(data):
        raise WorkspaceError(f"{path.name} is a binary file.")
    return data.decode("utf-8", errors="replace")


def mtime(path: Path) -> float:
    return path.stat().st_mtime


def write_text(path: Path, content: str, expected: float | None = None) -> float:
    """Write `content` to `path` atomically. With `expected`, refuse if the file
    has changed since that modification time. Returns the new mtime."""
    if path.exists():
        if path.is_dir():
            raise WorkspaceError(f"{path.name} is a folder.")
        current = mtime(path)
        if expected is not None and abs(current - expected) > 1e-3:
            raise Conflict(f"{path.name} changed since it was opened.", current)
        mode = path.stat().st_mode
    else:
        mode = None
        path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as out:
            out.write(content)
        if mode is not None:
            os.chmod(temp, mode & 0o7777)
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
    return mtime(path)


def write_bytes(path: Path, data: bytes) -> None:
    """Write `data` to `path` atomically -- a picture, where write_text is for
    source. No conflict check: nothing binary is edited in the editor."""
    if path.is_dir():
        raise WorkspaceError(f"{path.name} is a folder.")
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def slug(text: str, fallback: str = "untitled") -> str:
    """A name safe for a file or a folder on every system: lower case ASCII
    letters, digits and single hyphens."""
    plain = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    cleaned = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")
    return cleaned[:60].rstrip("-") or fallback


def new_folder(base: Path, name: str) -> Path:
    """A fresh, empty folder for a new project under `base`: the name as a
    slug, with -2, -3 ... when that is taken. Never reuses a folder."""
    base.mkdir(parents=True, exist_ok=True)
    stem = slug(name, "project")
    for n in range(1, 1000):
        candidate = base / (stem if n == 1 else f"{stem}-{n}")
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        return candidate
    raise WorkspaceError(f"Could not find a free folder name for {name!r} in {base}.")


def create(root: Path, given: str, kind: str = "file") -> Path:
    """Make an empty file or a folder inside the project."""
    target = inside(root, given)
    if target.exists():
        raise WorkspaceError(f"{relative(root, target)} already exists.")
    if kind == "folder":
        target.mkdir(parents=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()
    return target


def git_branch(root: Path) -> str | None:
    """The checked-out branch, read from .git/HEAD without running git."""
    for folder in (root, *root.parents):
        head = folder / ".git" / "HEAD"
        if head.is_file():
            try:
                text = head.read_text("utf-8").strip()
            except OSError:
                return None
            if text.startswith("ref: refs/heads/"):
                return text[len("ref: refs/heads/"):]
            return text[:10] if text else None
        if (folder / ".git").is_file():
            return None  # a worktree or submodule: git can say, this will not guess
        if folder == Path.home():
            break
    return None


def is_project(path: Path) -> bool:
    return any((path / marker).exists() for marker in PROJECT_MARKERS)


def summary(root: Path, entries: int = 60) -> str:
    """The project as the model is told about it at the top of each turn."""
    branch = git_branch(root)
    lines = [f"Project folder: {root}"]
    if branch:
        lines.append(f"Git branch: {branch}")
    try:
        listed = list_dir(root)
    except WorkspaceError:
        listed = []
    shown = [
        e["name"] + ("/" if e["kind"] == "dir" else "")
        for e in listed if not e["ignored"]
    ][:entries]
    if shown:
        more = len([e for e in listed if not e["ignored"]]) - len(shown)
        lines.append("Top level: " + ", ".join(shown) + (f" and {more} more" if more > 0 else ""))
    for name in ("CLAUDE.md", "AGENTS.md", ".cursorrules"):
        guide = root / name
        if guide.is_file():
            try:
                text = guide.read_text("utf-8", errors="replace").strip()
            except OSError:
                continue
            if text:
                lines.append(f"\n{name} (the project's own instructions -- follow them):\n{text[:6000]}")
            break
    return "\n".join(lines)
