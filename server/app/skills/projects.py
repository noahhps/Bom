"""Projects and designs, as the model reaches them.

Projects come in three kinds -- chat, design and code (see db.py, migration
21) -- and the model can make any of them the way the reader can on the
Projects page:

* create_project        a folder for chats or designs; files this one in it
* create_code_project   a new folder on disk, optionally built from designs
* list_designs          what the design projects hold
* read_design           one design, as text              (code conversations)
* import_design         designs copied into the project  (code conversations)

A code project is a folder on the reader's disk, so making one -- and writing
designs into one -- is asked about first, every time, like the code tools'
own writes.
"""

from __future__ import annotations

from pathlib import Path

from .. import code_projects, design_export
from .. import workspace as ws
from ..store import Store
from .args import plain_text
from .canvas import paged
from .skill import CODE_ONLY, Skill, Touched


def _flag(value, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(plain_text(value)).strip().lower() in ("true", "yes", "1", "on")


def _names(value) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        return [plain_text(v).strip() for v in value if plain_text(v).strip()]
    return [part.strip() for part in plain_text(value).split(",") if part.strip()]


def _linked(store: Store, session: str | None) -> str | None:
    """The design project the conversation's code project was built from."""
    if not session:
        return None
    row = store.get_session(session) or {}
    record = store.get_project(row.get("project_id") or "") if row.get("project_id") else None
    return (record or {}).get("source_id")


def _gather(store: Store, source: str | None, designs) -> tuple[list[dict], str | None]:
    """The designs named by a project and/or titles, without repeats."""
    titles = _names(designs) or [None]
    found: list[dict] = []
    for title in titles:
        items, problem = design_export.find(store, title, source)
        if problem:
            return [], problem
        found += items
    unique = list({item["id"]: item for item in found}.values())
    return unique, None


def _source(store: Store, items: list[dict]) -> tuple[str | None, str | None]:
    """(design project id, name to credit) for designs all from one place."""
    projects = {p["id"]: p for p in store.list_projects("design")}
    owners = {item.get("project_id") for item in items}
    if len(owners) == 1:
        owner = owners.pop()
        if owner in projects:
            return owner, projects[owner]["name"]
    sessions = {item.get("session_title") for item in items}
    if len(sessions) == 1:
        return None, sessions.pop()
    return None, None


class CreateProject(Skill):
    """A folder for conversations: chats or designs."""

    modes = frozenset({"chat", "design"})
    wants_session = True
    surfaces = "projects"

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="create_project",
            description=(
                "Make a project -- a folder on the Projects page that groups "
                "conversations -- and file this conversation into it. kind "
                "'design' is a design project: design conversations and the "
                "wireframes, pages and decks they make, which can later be built "
                "into a code project. kind 'chat' groups ordinary conversations. "
                "It defaults to this conversation's kind. If a project of that "
                "kind and name already exists, this conversation is filed into "
                "it. For a folder of code on disk use create_code_project."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "What to call the project."},
                    "kind": {"type": "string", "enum": ["design", "chat"]},
                    "file_here": {
                        "type": "boolean",
                        "description": "File this conversation into it. Default true.",
                    },
                },
                "required": ["name"],
            },
        )
        self.store = store

    async def use(self, session: str | None = None, name=None, kind=None, file_here=None, **extra) -> str:
        label = " ".join(plain_text(name).split())[:120]
        if not label:
            return "A project needs a name."
        mode = self.store.session_mode(session) if session else "chat"
        wanted = plain_text(kind).strip().lower() or ("design" if mode == "design" else "chat")
        if wanted not in ("chat", "design"):
            return "kind is 'design' or 'chat'. For code, use create_code_project."
        record = self.store.find_project(label, wanted)
        said = (
            f"The {wanted} project \"{record['name']}\" already exists."
            if record
            else f"Made the {wanted} project \"{label}\"."
        )
        record = record or self.store.create_project(label, kind=wanted)
        if session and _flag(file_here):
            if wanted == "design" and mode != "design":
                said += " This is not a design conversation, so it was not filed there."
            else:
                self.store.set_session_project(session, record["id"])
                said += " This conversation is filed in it."
        return said


class CreateCodeProject(Skill):
    """A new folder on disk, registered as a code project, maybe from designs."""

    wants_session = True
    surfaces = "projects"

    def __init__(self, store: Store, settings) -> None:
        super().__init__(
            name="create_code_project",
            description=(
                "Make a new code project: a new, empty folder in the user's "
                "projects folder, listed under Projects → Code and openable in "
                "the Code view. With from_design -- a design project or design "
                "conversation name from list_designs -- its designs are written "
                "into the folder's design/ folder (wireframe specs and screens as "
                "HTML, pages, decks, the design standard as DESIGN.md, pictures, "
                "and a README index) for a coding agent to build from; `designs` "
                "picks some of them by title. The user is asked first. In a code "
                "conversation with no folder open yet, the new folder becomes "
                "this conversation's."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "The project's name; its folder is named after it."},
                    "from_design": {
                        "type": "string",
                        "description": "The design project (or design conversation) to build it from.",
                    },
                    "designs": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Only these designs, by title. Default: every design in from_design.",
                    },
                },
                "required": ["name"],
            },
        )
        self.store = store
        self.settings = settings

    @property
    def must_ask(self) -> bool:
        return True

    async def use(self, session: str | None = None, name=None, from_design=None, designs=None, **extra) -> str:
        label = " ".join(plain_text(name).split())[:120]
        if not label:
            return "A code project needs a name."
        source = plain_text(from_design).strip() or None
        items: list[dict] = []
        if source or _names(designs):
            items, problem = _gather(self.store, source, designs)
            if problem:
                return problem
        source_id, source_name = _source(self.store, items)
        try:
            record, root, written = code_projects.make(
                self.store, self.settings, label,
                source_id=source_id,
                canvas_ids=[item["id"] for item in items],
                source_name=source_name or source,
            )
        except (ws.WorkspaceError, OSError) as exc:
            return f"The project could not be made: {exc}"

        said = f"Created the code project \"{record['name']}\" at {root}."
        if items:
            said += (
                f" {len(items)} design{'s' if len(items) != 1 else ''} "
                f"{'were' if len(items) != 1 else 'was'} written into design/ "
                "-- design/README.md indexes them."
            )
        if session and self.store.session_mode(session) == "code":
            if not self.store.session_workspace(session):
                self.store.set_session_workspace(session, str(root))
                said += " This conversation now works in it: its files are yours to read and edit."
            else:
                said += " This conversation stays on its own folder; the user can open the new one from Projects → Code."
        else:
            said += " The user can open it from Projects → Code to start building."
        if written:
            shown = ", ".join(written[:8]) + (" …" if len(written) > 8 else "")
            said += f"\nFiles: {shown}"
        return said


class ListDesigns(Skill):
    """What the design projects hold."""

    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="list_designs",
            description=(
                "List the designs the user has made -- wireframes, pages, slides, "
                "sheets and documents -- grouped by design project, and by design "
                "conversation for ones filed in no project. In a code "
                "conversation, read one with read_design or copy them into the "
                "project with import_design; anywhere, build a new code project "
                "from them with create_code_project."
            ),
            parameters={"type": "object", "properties": {}},
        )
        self.store = store

    async def use(self, session: str | None = None, **extra) -> str:
        groups = design_export.library(self.store)
        return design_export.describe(groups, _linked(self.store, session))


class ReadDesign(Skill):
    """One design, as text: what to build from."""

    modes = CODE_ONLY

    def __init__(self, store: Store, max_chars: int = 40_000, *, settings=None) -> None:
        super().__init__(
            name="read_design",
            description=(
                "Read one design from a design project: a wireframe as its "
                "screens and layers (boxes in px, text, links), a page as its "
                "HTML, a deck as its outline, a sheet as its grid. Name it by "
                "title; add `project` when two projects have one of that name. "
                "This reads the design as it is now -- files import_design wrote "
                "earlier may be older."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "design": {"type": "string", "description": "The design's title."},
                    "project": {"type": "string", "description": "The design project or design conversation it is in."},
                    "offset": {"type": "integer", "description": "The line to start from, for a long design."},
                },
                "required": ["design"],
            },
        )
        self.store = store
        self._max_chars = max_chars
        # Read live when given, like read_canvas: Enterprise mode's larger
        # pages apply on the next call.
        self._settings = settings

    @property
    def max_chars(self) -> int:
        live = getattr(self._settings, "canvas_read_chars", None) if self._settings is not None else None
        return max(2000, int(live or self._max_chars))

    @property
    def max_result_chars(self) -> int:
        return self.max_chars + 2000

    async def use(self, design=None, project=None, offset=1, **extra) -> str:
        title = plain_text(design).strip()
        if not title:
            return "Name the design to read. list_designs shows them."
        items, problem = design_export.find(self.store, title, plain_text(project).strip() or None)
        if problem:
            return problem
        item = items[0]
        header, body = design_export.read(self.store, item)
        header += f" -- from \"{item.get('session_title') or 'Untitled'}\""
        said = paged(
            header, body, offset, self.max_chars,
            "Call read_design again with offset={next} for the rest.",
        )
        if len(items) > 1:
            said += (
                f"\n\n({len(items)} designs are called \"{item['title']}\"; this is the "
                "newest. Add `project` to pick another.)"
            )
        return said


class ImportDesign(Skill):
    """Designs, written into the open project as files."""

    modes = CODE_ONLY
    wants_session = True
    surfaces = "workspace"

    def __init__(self, store: Store, settings) -> None:
        super().__init__(
            name="import_design",
            description=(
                "Copy designs into this project as files, in design/ unless "
                "`into` says otherwise: each wireframe's spec.md, its source and "
                "each screen drawn as HTML; pages as HTML; decks as outlines; "
                "sheets as CSV; the design standard as DESIGN.md; the pictures "
                "they use; and a README indexing it all. Name a design, a design "
                "project (every design in it), or both. Importing again "
                "refreshes the files. The user is asked first."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "design": {"type": "string", "description": "One design's title."},
                    "project": {"type": "string", "description": "A design project or design conversation: every design in it."},
                    "into": {"type": "string", "description": "The folder to write, relative to the project root. Default design."},
                },
            },
        )
        self.store = store
        self.settings = settings

    @property
    def must_ask(self) -> bool:
        return True

    async def use(self, session: str | None = None, design=None, project=None, into=None, **extra) -> str:
        folder = self.store.session_workspace(session) if session else None
        if not folder:
            return (
                "No project folder is open for this conversation. Ask the user to "
                "open one, or make one from the designs with create_code_project."
            )
        source = plain_text(project).strip() or None
        title = plain_text(design).strip() or None
        if not source and not title:
            return "Name a design, a design project, or both. list_designs shows them."
        items, problem = design_export.find(self.store, title, source)
        if problem:
            return problem
        target = plain_text(into).strip() or "design"
        try:
            root = ws.validate_root(folder, self.settings.workspace_roots)
            written = design_export.export(self.store, [item["id"] for item in items], root, target)
        except (ws.WorkspaceError, OSError) as exc:
            return f"The designs could not be written: {exc}"
        names = ", ".join(f"\"{item['title']}\"" for item in items[:6])
        shown = "\n".join(f"- {path}" for path in written[:30])
        more = f"\n… and {len(written) - 30} more" if len(written) > 30 else ""
        index = Path(target) / "README.md"
        return Touched(
            f"Wrote {names} into {target}/ ({len(written)} files). Start with "
            f"{index.as_posix()}.\n{shown}{more}",
            written,
        )


def project_skills(store: Store, settings) -> list[Skill]:
    return [
        CreateProject(store),
        CreateCodeProject(store, settings),
        ListDesigns(store),
        ReadDesign(store, settings=settings),
        ImportDesign(store, settings),
    ]
