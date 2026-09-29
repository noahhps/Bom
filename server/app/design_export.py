"""Designs, carried out of a design project and into a code project.

A design conversation makes wireframes, pages, decks, sheets and documents,
stored as canvases in the database. A code conversation works on files. This
is the bridge: it finds the designs a person or a model names, and writes them
into a project folder as files a coding agent -- or a person -- can read:

    design/README.md                 what is here and how to read it
    design/DESIGN.md                 the design standard the designs follow
    design/<name>/spec.md            a wireframe: screens, layers, boxes, flow
    design/<name>/wireframe.json     ... and its source
    design/<name>/01-<screen>.html   ... and each screen drawn as static HTML
    design/<name>.html               a page, as written
    design/<name>.slides.md          a deck's outline (and .slides.json)
    design/<name>.csv                a sheet
    design/<name>.md                 a document
    design/images/...                every picture the designs use

Nothing here asks permission: the routes that call it are the reader's own
clicks, and the skills that call it are gated by the approval prompt.
"""

from __future__ import annotations

import csv
import html as html_lib
import io
import json
import re
from pathlib import Path

from . import render
from . import workspace as project
from .skills.canvas import heading, readable
from .skills.design import NO_DESIGN, resolve as resolve_design
from .store import Store

IMAGE_ID = re.compile(r"img_[A-Za-z0-9]+")
PAGE_REF = re.compile(r"bom-image:(img_[A-Za-z0-9]+)")

#: What each kind of design is called where a person reads it.
KIND_LABEL = {
    "wireframe": "Wireframe",
    "html": "Page",
    "slides": "Slides",
    "sheet": "Sheet",
    "markdown": "Document",
    "code": "Code",
}

_EXTENSIONS = {
    "python": "py", "javascript": "js", "typescript": "ts", "jsx": "jsx", "tsx": "tsx",
    "html": "html", "css": "css", "scss": "scss", "json": "json", "yaml": "yml",
    "markdown": "md", "shell": "sh", "bash": "sh", "sql": "sql", "swift": "swift",
    "kotlin": "kt", "java": "java", "go": "go", "rust": "rs", "ruby": "rb", "php": "php",
    "c": "c", "cpp": "cpp", "csharp": "cs", "svg": "svg", "xml": "xml", "toml": "toml",
}

_PICTURE_TYPES = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "image/svg+xml": "svg",
}


# -- finding designs -----------------------------------------------------------


def library(store: Store) -> list[dict]:
    """Design projects, and design conversations filed in none, each with its
    designs. A design project with nothing in it yet is still listed -- it is
    somewhere a design can be made."""
    projects = {p["id"]: p for p in store.list_projects("design")}
    groups: dict[str, dict] = {
        pid: {"project": p, "session_id": None, "name": p["name"], "designs": []}
        for pid, p in projects.items()
    }
    for item in store.design_library():
        pid = item["project_id"] if item["project_id"] in projects else None
        key = pid or f"session:{item['session_id']}"
        if key not in groups:
            groups[key] = {
                "project": None,
                "session_id": item["session_id"],
                "name": item["session_title"] or "Untitled design",
                "designs": [],
            }
        groups[key]["designs"].append(item)
    # Projects first, by name; then the loose conversations, newest first.
    filed = sorted((g for g in groups.values() if g["project"]), key=lambda g: g["name"].lower())
    loose = [g for g in groups.values() if not g["project"]]
    return filed + loose


def describe(groups: list[dict], linked: str | None = None) -> str:
    """The library as a model reads it: one block per project."""
    if not any(g["designs"] for g in groups):
        return (
            "There are no designs yet. Designs are made in design conversations "
            "(Design in the sidebar) and filed into design projects."
        )
    blocks = []
    for group in groups:
        if group["project"]:
            title = f"Design project \"{group['name']}\""
            if linked and group["project"]["id"] == linked:
                title += " -- this code project was built from it"
        else:
            title = f"Design conversation \"{group['name']}\" (in no project)"
        lines = [title + ":"]
        if not group["designs"]:
            lines.append("  (no designs yet)")
        for item in group["designs"]:
            kind = KIND_LABEL.get(item["kind"], item["kind"])
            detail = f", {item['detail']}" if item.get("detail") else ""
            where = (
                f" -- in \"{item['session_title']}\"" if group["project"] and item.get("session_title") else ""
            )
            lines.append(f"  - \"{item['title']}\" ({kind}{detail}){where}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def find(
    store: Store, design: str | None = None, source: str | None = None
) -> tuple[list[dict], str | None]:
    """The designs a model named: `design` by title (or canvas id), `source` by
    design project or design conversation name. Either narrows the other;
    `source` alone is every design in it.

    Returns (designs, None), or ([], what went wrong) -- said so the model can
    correct itself: the names it could have meant.
    """
    groups = library(store)
    wanted_source = (source or "").strip().lower()
    wanted = (design or "").strip()
    if wanted_source:
        chosen = [g for g in groups if g["name"].lower() == wanted_source]
        if not chosen:
            chosen = [g for g in groups if wanted_source in g["name"].lower()]
        if not chosen:
            names = ", ".join(f"\"{g['name']}\"" for g in groups) or "none"
            return [], f"There is no design project called \"{source}\". There is: {names}."
        groups = chosen
    pool = [item for g in groups for item in g["designs"]]
    if not wanted:
        if not pool:
            return [], f"\"{source}\" has no designs yet."
        return pool, None
    # An exact title can still be two designs, in two conversations; both are
    # what was asked for. A partial one that fits several is a question.
    exact = [i for i in pool if i["id"] == wanted or i["title"].lower() == wanted.lower()]
    if exact:
        return exact, None
    matches = [i for i in pool if wanted.lower() in i["title"].lower()]
    if not matches:
        known = ", ".join(f"\"{i['title']}\"" for i in pool[:30]) or "none"
        return [], f"There is no design called \"{design}\". There is: {known}."
    if len(matches) > 1:
        known = ", ".join(f"\"{i['title']}\"" for i in matches[:12])
        return [], f"\"{design}\" could be any of: {known}. Name one exactly."
    return matches, None


def read(store: Store, item: dict) -> tuple[str, str]:
    """(heading, text) for one design, the way read_canvas shows a canvas."""
    canvas = store.get_canvas(item["id"])
    if canvas is None:
        return item["title"], "(this design has been deleted)"
    return heading(canvas), readable(canvas)


# -- writing designs into a folder ---------------------------------------------


#: The folder's own record of what is in it, beside the README made from it:
#: which design each file came from, so a later export of one design updates
#: its entry -- and its files -- without forgetting the others.
INDEX = "index.json"


def _load_index(folder: Path) -> dict:
    try:
        data = json.loads((folder / INDEX).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"designs": [], "standards": {}}
    designs = [d for d in data.get("designs") or [] if isinstance(d, dict) and d.get("id")]
    standards = data.get("standards") if isinstance(data.get("standards"), dict) else {}
    return {"designs": designs, "standards": standards}


def export(store: Store, canvas_ids: list[str], root: Path, into: str = "design") -> list[str]:
    """Write designs into `root`/`into`, and index them. Returns every path
    written, relative to `root`, the README first.

    The folder is a copy of the designs, refreshed on demand, not somewhere to
    edit them: exporting a design again overwrites its files, and removes any
    it no longer has (a screen since deleted). Designs exported earlier and
    not named now are left as they are, and stay in the index.
    """
    folder = project.inside(root, into)
    if project.in_git_dir(root, folder):
        raise project.WorkspaceError("Designs are not written inside .git.")
    index = _load_index(folder)
    previous = {entry["id"]: entry for entry in index["designs"]}
    wanted = set(canvas_ids)
    taken = {entry.get("name") for entry in index["designs"] if entry["id"] not in wanted}
    standards: dict[str, str] = dict(index["standards"])
    written: list[str] = []
    pictures: dict[str, str | None] = {}

    def put(rel: str, text: str) -> None:
        path = folder / rel
        project.write_text(path, text)
        written.append(project.relative(root, path))

    def name_for(canvas) -> str:
        known = previous.get(canvas.id, {}).get("name")
        if known and known not in taken:
            taken.add(known)
            return known
        stem = project.slug(canvas.title, "design")
        name, n = stem, 1
        while name in taken:
            n += 1
            name = f"{stem}-{n}"
        taken.add(name)
        return name

    def picture(image_id: str, session_id: str) -> str | None:
        """The picture's path inside the design folder, written once."""
        if image_id in pictures:
            return pictures[image_id]
        image = store.get_image(image_id, with_data=True)
        if image is None or image.session_id != session_id:
            pictures[image_id] = None
            return None
        ext = _PICTURE_TYPES.get(image.mime, "bin")
        stem = project.slug(Path(image.name).stem, "image")
        rel = f"images/{stem}-{image_id[-6:].lower()}.{ext}"
        project.write_bytes(folder / rel, image.data)
        written.append(project.relative(root, folder / rel))
        pictures[image_id] = rel
        return rel

    def standard_file(standard: str | None) -> str | None:
        """DESIGN.md for the first standard this folder has seen, a named file
        for each after it -- the same file every time for the same one."""
        if not standard or standard == NO_DESIGN:
            return None
        resolved = resolve_design(store, standard)
        if resolved is None:
            return standards.get(standard)
        used = set(standards.values())
        filename = standards.get(standard) or (
            "DESIGN.md" if "DESIGN.md" not in used else f"DESIGN-{project.slug(resolved[0])}.md"
        )
        if filename not in written_names:
            put(filename, resolved[1].rstrip() + "\n")
            written_names.add(filename)
        standards[standard] = filename
        return filename

    written_names: set[str] = set()
    entries = {entry["id"]: entry for entry in index["designs"]}
    for canvas_id in canvas_ids:
        canvas = store.get_canvas(canvas_id)
        if canvas is None:
            continue
        session = store.get_session(canvas.session_id) or {}
        owner = store.get_project(session["project_id"]) if session.get("project_id") else None
        name = name_for(canvas)
        files = _write_one(canvas, name, put, lambda i, s=canvas.session_id: picture(i, s))
        # Files this design had last time and has no longer: its own, so its
        # own to remove.
        for stale in set(previous.get(canvas.id, {}).get("files") or []) - set(files):
            try:
                target = project.inside(folder, stale)
                if target.is_file():
                    target.unlink()
            except (project.WorkspaceError, OSError):
                pass
        entries[canvas.id] = {
            "id": canvas.id,
            "name": name,
            "title": canvas.title,
            "kind": canvas.kind,
            "conversation": session.get("title") or "Untitled",
            "project": owner["name"] if owner and owner.get("kind") == "design" else None,
            "files": files,
            "standard": standard_file(session.get("design")),
        }

    ordered = list(entries.values())
    project.write_text(
        folder / INDEX,
        json.dumps({"designs": ordered, "standards": standards}, indent=2) + "\n",
    )
    project.write_text(folder / "README.md", _index(ordered))
    return [
        project.relative(root, folder / "README.md"),
        project.relative(root, folder / INDEX),
        *written,
    ]


def _write_one(canvas, name: str, put, picture) -> list[str]:
    """One design's files, relative to the design folder."""
    content = canvas.content or ""
    kind = canvas.kind

    if kind == "wireframe":
        try:
            doc = json.loads(content or "{}")
        except ValueError:
            doc = {}
        frames = [f for f in (doc.get("frames") or []) if isinstance(f, dict)]
        shown = {i: picture(i) for i in set(IMAGE_ID.findall(content))}
        drawn = {i: f"../{rel}" for i, rel in shown.items() if rel}
        P = render.palette(doc)
        files = []
        screens = []
        for number, frame in enumerate(frames, start=1):
            screen = f"{name}/{number:02d}-{project.slug(frame.get('name') or '', 'screen')}.html"
            put(screen, _mockup(frame, P, drawn, f"{canvas.title} · {frame.get('name', '')}"))
            files.append(screen)
            screens.append((frame, screen.split("/", 1)[1]))
        put(f"{name}/spec.md", _wireframe_spec(canvas.title, doc, screens))
        put(f"{name}/wireframe.json", json.dumps(doc, indent=2) + "\n")
        return [f"{name}/spec.md", f"{name}/wireframe.json", *files]

    if kind == "slides":
        for image_id in set(IMAGE_ID.findall(content)):
            picture(image_id)
        try:
            deck = json.loads(content or "{}")
        except ValueError:
            deck = {}
        put(f"{name}.slides.md", f"# {canvas.title}\n\n" + readable(canvas).rstrip() + "\n")
        put(f"{name}.slides.json", json.dumps(deck, indent=2) + "\n")
        return [f"{name}.slides.md", f"{name}.slides.json"]

    if kind == "sheet":
        from .skills import sheet as sheets

        loaded = sheets.load(content) or {"columns": [], "rows": []}
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(loaded.get("columns") or [])
        for row in loaded.get("rows") or []:
            writer.writerow(["" if cell is None else cell for cell in row])
        put(f"{name}.csv", out.getvalue())
        return [f"{name}.csv"]

    def relink(text: str) -> str:
        def swap(match: re.Match) -> str:
            rel = picture(match.group(1))
            return rel or match.group(0)

        return PAGE_REF.sub(swap, text)

    if kind == "html":
        put(f"{name}.html", relink(content))
        return [f"{name}.html"]
    if kind == "code":
        ext = _EXTENSIONS.get((canvas.language or "").lower(), "txt")
        put(f"{name}.{ext}", content)
        return [f"{name}.{ext}"]
    put(f"{name}.md", relink(content))
    return [f"{name}.md"]


def _mockup(frame: dict, P: dict, pictures: dict[str, str], title: str) -> str:
    body = render.frame_html(frame, P, pictures)
    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        f"<title>{html_lib.escape(title)}</title>\n"
        "<!-- An approximate drawing of one wireframe screen, made from its layers.\n"
        "     spec.md beside it is the source of truth: sizes, text and links. -->\n"
        "<style>html,body{margin:0}body{padding:32px;background:#e9ecf2;"
        "display:flex;justify-content:center;align-items:flex-start}</style>\n"
        f"</head>\n<body>\n{body}\n</body>\n</html>\n"
    )


def _wireframe_spec(title: str, doc: dict, screens: list[tuple[dict, str]]) -> str:
    from .skills.wireframe import outline

    names = {f.get("id"): f.get("name") or f.get("id") for f, _ in screens}
    lines = [
        f"# {title}",
        "",
        f"A wireframe of {len(screens)} screen{'s' if len(screens) != 1 else ''}"
        f" ({doc.get('fidelity', 'wireframe')} fidelity).",
        "",
        "## Screens",
        "",
    ]
    for frame, file in screens:
        lines.append(
            f"- **{frame.get('name') or frame.get('id')}** "
            f"({int(frame.get('w') or 0)}×{int(frame.get('h') or 0)}) -- `{file}`"
        )
    flow = []
    for frame, _ in screens:
        for layer in frame.get("layers") or []:
            target = layer.get("link")
            if target:
                label = (layer.get("text") or layer.get("type") or "").strip()[:60]
                flow.append(
                    f"- {frame.get('name')}: \"{label}\" ({layer.get('id')}) → "
                    f"{names.get(target, target)}"
                )
    if flow:
        lines += ["", "## Flow", "", "What each tappable element leads to.", "", *flow]
    lines += [
        "",
        "## Layers",
        "",
        "Every screen and its layers, in drawing order. A box is `x,y w×h` in",
        "pixels from the screen's top-left corner. `→` is where a tap goes.",
        "",
        "```text",
        outline(doc),
        "```",
        "",
    ]
    return "\n".join(lines)


def _index(entries: list[dict]) -> str:
    projects = {entry.get("project") for entry in entries}
    conversations = {entry.get("conversation") for entry in entries}
    if len(projects) == 1 and None not in projects:
        origin = f"the design project \"{projects.pop()}\""
    elif projects == {None} and len(conversations) == 1:
        origin = f"the design conversation \"{conversations.pop()}\""
    else:
        origin = "designs made"
    lines = ["# Designs", ""]
    lines.append(
        f"Exported from {origin} in Bom. "
        + "These files are a copy: change the designs in Bom and export them "
        "again to refresh them -- exporting a design overwrites its files here. "
        f"`{INDEX}` is this index for tools."
    )
    lines.append("")
    standards = sorted({entry["standard"] for entry in entries if entry.get("standard")})
    if standards:
        lines.append(
            "The design standard -- type, colour, spacing, voice -- is in "
            + ", ".join(f"`{s}`" for s in standards)
            + ". Follow it for anything the designs do not show."
        )
        lines.append("")
    lines += ["| Design | Kind | From | Files |", "| --- | --- | --- | --- |"]
    for entry in entries:
        files = ", ".join(f"`{f}`" for f in entry["files"][:4])
        if len(entry["files"]) > 4:
            files += f" and {len(entry['files']) - 4} more"
        kind = KIND_LABEL.get(entry["kind"], entry["kind"])
        where = entry.get("project") or entry.get("conversation") or ""
        if entry.get("project") and entry.get("conversation"):
            where = f"{entry['project']} / {entry['conversation']}"
        if entry.get("standard"):
            kind += f" ({entry['standard']})"
        lines.append(f"| {entry['title']} | {kind} | {where} | {files} |")
    lines += [
        "",
        "## Reading them",
        "",
        "- **Wireframes**: `spec.md` lists every screen, what each element says,",
        "  where it sits and where it links. The numbered `.html` files beside it",
        "  are approximate drawings of each screen -- open them to see the layout.",
        "- **Pages** are complete HTML, as designed. Pictures are in `images/`.",
        "- **Slides** are outlined in `.slides.md`; **sheets** are CSV, with any",
        "  formulas as written.",
        "",
    ]
    return "\n".join(lines)
