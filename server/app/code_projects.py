"""Making a code project: a folder on disk, a row in `projects`, and -- when it
is built from designs -- those designs written into it.

One function, shared by the Projects page (the reader's click) and the
create_code_project skill (the model's call, behind the approval prompt), so
the two cannot drift: a project made either way is the same project.
"""

from __future__ import annotations

from pathlib import Path

from . import design_export
from . import workspace as project
from .store import Store


def _within(path: Path, roots) -> bool:
    return any(path == root or root in path.parents for root in roots)


def make(
    store: Store,
    settings,
    name: str,
    *,
    folder: str | None = None,
    source_id: str | None = None,
    canvas_ids: list[str] | None = None,
    source_name: str | None = None,
) -> tuple[dict, Path, list[str]]:
    """A code project named `name`, in `folder` if given (an existing folder,
    checked like any project folder) or else in a new folder under the
    projects folder. Returns (the project, its folder, the files written).

    A folder that is already a project is that project -- one folder, one
    project -- with the designs written into it all the same.
    """
    name = " ".join(str(name or "").split())[:120] or "Untitled project"
    roots = tuple(Path(r).resolve() for r in (settings.workspace_roots or (Path.home(),)))
    made_here = False
    if folder:
        root = project.validate_root(folder, roots)
    else:
        base = Path(settings.projects_dir).expanduser().resolve()
        if not _within(base, roots):
            raise project.WorkspaceError(
                f"The projects folder {base} is outside the folders projects may "
                "live in. Set PROJECTS_DIR to a folder under WORKSPACE_ROOTS."
            )
        root = project.new_folder(base, name)
        made_here = True
        try:
            root = project.validate_root(str(root), roots)
        except project.WorkspaceError:
            root.rmdir()
            raise

    record = store.ensure_code_project(str(root), name=name, source_id=source_id)
    written: list[str] = []
    if made_here:
        intro = f"# {name}\n"
        if canvas_ids:
            intro += (
                "\nBuilt from "
                + (f"the design project \"{source_name}\"" if source_name else "designs made in Bom")
                + ". The designs are in `design/` -- start with `design/README.md`.\n"
            )
        project.write_text(root / "README.md", intro)
        written.append("README.md")
    if canvas_ids:
        written += design_export.export(store, canvas_ids, root)
    return record, root, written
