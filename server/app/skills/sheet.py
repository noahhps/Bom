"""Spreadsheets, as a canvas the client draws and calculates.

Like a deck, a sheet is structured data rather than markup: a header row,
the rows under it, a format per column and a theme. The panel draws it as a
grid the reader can edit cell by cell, evaluates `=` formulas live, and exports
CSV -- so a budget the model wrote keeps adding up after the reader changes a
number, which is the difference between a spreadsheet and a table.

Addressed the way every spreadsheet is: column letters from A, and row 1 is the
header, so the first row of data is row 2. That convention is stated in the
description because it is what formulas are written against -- `=SUM(B2:B9)`
has to mean the same cells to the model that wrote it and the grid that runs it.

Formulas are stored as their text and evaluated only in the client. The model
does not need the numbers back to keep a sheet correct; it needs the formulas,
and those are what read_canvas returns.
"""

from __future__ import annotations

import csv
import io
import json
import re

from ..design_presets import clean_theme
from ..store import Store
from .args import as_dict, plain_text
from .skill import Skill
from .slides import THEME_SCHEMA, save_canvas

KIND = "sheet"

FORMATS = ("text", "number", "integer", "currency", "percent", "date")
MAX_ROWS = 1000
MAX_COLUMNS = 40

_NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")
_REF = re.compile(r"^([A-Za-z]{1,2})([0-9]{1,5})$")
_CURRENCY = re.compile(r"^currency(?::([A-Z]{3}))?$")


def column_letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA."""
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def column_index(letters: str) -> int:
    """A -> 0, Z -> 25, AA -> 26."""
    value = 0
    for ch in letters.upper():
        value = value * 26 + (ord(ch) - 64)
    return value - 1


def _format(raw) -> str:
    """A column format the grid knows, or text."""
    text = str(raw or "").strip()
    lowered = text.lower()
    aliases = {"money": "currency", "usd": "currency", "%": "percent", "pct": "percent",
               "int": "integer", "float": "number", "decimal": "number", "string": "text"}
    lowered = aliases.get(lowered, lowered)
    if lowered.startswith("currency"):
        code = text.split(":", 1)[1].strip().upper() if ":" in text else ""
        return f"currency:{code}" if re.fullmatch(r"[A-Z]{3}", code) else "currency"
    return lowered if lowered in FORMATS else "text"


def _coerce(cell, fmt: str = "text"):
    """A cell as stored: a number where it is one, text otherwise.

    Numbers that arrive as strings are turned back into numbers -- "1200" in a
    cost column has to add up -- and so is the everyday dressing a model puts
    on them in a numeric column: "$1,200" and "12%". Formulas stay text.
    """
    if cell is None:
        return ""
    if isinstance(cell, bool):
        return "TRUE" if cell else "FALSE"
    if isinstance(cell, (int, float)):
        return cell
    # A cell wrapped in an object or a list -- {"value": 1200} -- is its value.
    text = plain_text(cell).replace("\n", " ") if isinstance(cell, (dict, list)) else str(cell).strip()
    if isinstance(cell, str):
        text = plain_text(cell) if text[:1] in "{[" else text
    if isinstance(cell, dict):
        inner = next((cell[k] for k in ("value", "v") if k in cell), None)
        if isinstance(inner, (int, float)) and not isinstance(inner, bool):
            return inner
    if not text or text.startswith("="):
        return text
    if _NUMBER.match(text):
        return float(text) if "." in text else int(text)
    if fmt != "text":
        bare = text.replace(",", "").replace(" ", "")
        percent = bare.endswith("%")
        bare = bare.rstrip("%").lstrip("$€£¥")
        if _NUMBER.match(bare):
            number = float(bare)
            if percent:
                number /= 100
            elif number.is_integer() and "." not in bare:
                number = int(number)
            return number
    return text


def _list_arg(value) -> list:
    """A one-dimensional argument: a list, JSON text, or comma-separated text."""
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    text = str(value).strip()
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except ValueError:
            pass
    return next(csv.reader(io.StringIO(text)), [])


def _rows_from(value) -> list[list]:
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                value = json.loads(text)
            except ValueError:
                value = []
        else:
            value = list(csv.reader(io.StringIO(text)))
    if not isinstance(value, list):
        return []
    rows = []
    for row in value:
        if isinstance(row, dict):
            rows.append(list(row.values()))
        elif isinstance(row, list):
            rows.append(row)
        else:
            rows.append([row])
    return rows


def normalize_sheet(columns=None, rows=None, formats=None, theme=None, csv_text=None,
                    defaults: dict | None = None, override: dict | None = None) -> dict:
    """The stored document: columns, a format each, the rows, a theme."""
    header = [plain_text(c).replace("\n", " ") for c in _list_arg(columns)]
    body = _rows_from(rows)
    if not header and csv_text:
        parsed = _rows_from(str(csv_text))
        if parsed:
            header, body = [plain_text(c) for c in parsed[0]], parsed[1:] + body
    if not header and body:
        width = max(len(r) for r in body)
        header = [f"Column {column_letter(i)}" for i in range(width)]

    header = header[:MAX_COLUMNS]
    width = max([len(header)] + [len(r) for r in body[:MAX_ROWS]]) if header else 0
    width = min(width, MAX_COLUMNS)
    header += [f"Column {column_letter(i)}" for i in range(len(header), width)]

    listed = _list_arg(formats)
    fmts = [_format(plain_text(listed[i]) if i < len(listed) else "") for i in range(width)]

    grid = []
    for row in body[:MAX_ROWS]:
        cells = [_coerce(row[i] if i < len(row) else "", fmts[i]) for i in range(width)]
        grid.append(cells)

    merged = {**clean_theme(defaults or {}), **clean_theme(theme), **clean_theme(override or {})}
    return {"version": 1, "columns": header, "formats": fmts, "rows": grid, "theme": merged}


def as_text(sheet: dict, limit: int = 200) -> str:
    """A sheet as a model reads it back: letters, row numbers, raw formulas."""
    columns = sheet.get("columns", [])
    formats = sheet.get("formats", [])
    lines = [
        "Row 1 is the header; data starts at row 2. Formulas are shown as written.",
        "formats: " + ", ".join(
            f"{column_letter(i)} {formats[i] if i < len(formats) else 'text'}"
            for i in range(len(columns))
        ),
        f"theme: {json.dumps(sheet.get('theme') or {})}",
        "1: " + " | ".join(f"{column_letter(i)} {name}" for i, name in enumerate(columns)),
    ]
    rows = sheet.get("rows", [])
    for number, row in enumerate(rows[:limit], start=2):
        lines.append(f"{number}: " + " | ".join("" if c is None else str(c) for c in row))
    if len(rows) > limit:
        lines.append(f"… {len(rows) - limit} more rows in the panel.")
    return "\n".join(lines)


def load(content: str) -> dict | None:
    """A stored sheet, or None if the canvas does not hold one."""
    try:
        data = json.loads(content or "")
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("columns"), list):
        return None
    data.setdefault("rows", [])
    data.setdefault("formats", ["text"] * len(data["columns"]))
    data.setdefault("theme", {})
    return data


def _summary(verb: str, name: str, sheet: dict) -> str:
    cols, rows = len(sheet["columns"]), len(sheet["rows"])
    last = column_letter(max(cols - 1, 0))
    return (
        f"{verb} the sheet {name!r} ({cols} column{'' if cols == 1 else 's'}, A-{last}; "
        f"{rows} row{'' if rows == 1 else 's'} of data, rows 2-{rows + 1}). It is open in "
        "the canvas panel as a live grid the user can edit; formulas recalculate "
        "there. Change a few cells with edit_sheet, or rewrite it whole with "
        "write_sheet and the same title."
    )


class WriteSheet(Skill):
    surfaces = "canvas"
    wants_session = True
    themed = True
    needs_design = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="write_sheet",
            description=(
                "Create or replace a spreadsheet, shown in the canvas panel as a "
                "live grid the user can edit, with formulas that recalculate and "
                "a CSV export. Use this -- not a markdown table -- for budgets, "
                "trackers, schedules, comparisons, price lists, plans with "
                "totals: anything with numbers the user will change. Call "
                "ask_for_design first if no design standard has been chosen in "
                "this conversation, and put its colours and fonts in `theme`. "
                "Cells are addressed like any spreadsheet: columns A, B, C…, and "
                "row 1 is the header, so the first data row is row 2. A cell that "
                "starts with = is a formula: + - * / ^, parentheses, cell "
                "references (B2) and ranges (B2:B9), and SUM, AVERAGE, MIN, MAX, "
                "COUNT, ROUND, ABS, IF. Use formulas for anything derived -- "
                "totals, subtotals, differences, percentages -- so the sheet stays "
                "correct when a number changes. Give every numeric column a "
                "format. Reusing a title replaces that sheet whole."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The sheet's name. Reusing one replaces it.",
                    },
                    "columns": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "The header row: one name per column, A first.",
                    },
                    "rows": {
                        "type": "array",
                        "items": {"type": "array", "items": {"type": ["string", "number"]}},
                        "description": (
                            "The data rows, top to bottom, starting at row 2. Numbers "
                            "as numbers; formulas as text starting with =."
                        ),
                    },
                    "formats": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "One per column: text, number, integer, currency (or "
                            "currency:EUR), percent (0.12 shows as 12%), date."
                        ),
                    },
                    "theme": THEME_SCHEMA,
                },
                "required": ["title", "columns", "rows"],
            },
        )
        self.store = store

    async def use(
        self,
        session: str,
        title=None,
        columns=None,
        rows=None,
        formats=None,
        theme=None,
        csv: str | None = None,
        design_defaults: dict | None = None,
        theme_override: dict | None = None,
        **extra,
    ) -> str:
        # Columns under another name, or the whole table as one object.
        if columns is None:
            columns = next((extra[k] for k in ("headers", "header", "cols") if k in extra), None)
        if rows is None:
            rows = next((extra[k] for k in ("data", "values", "cells") if k in extra), None)
        # A missing title is not worth a failed call; it can be renamed later.
        name = (plain_text(title or extra.get("name")) or "Untitled sheet")[:200]
        sheet = normalize_sheet(columns, rows, formats, theme, csv, design_defaults, theme_override)
        if not sheet["columns"]:
            return "That sheet had no columns. Pass `columns` (the header row) and `rows`."
        content = json.dumps(sheet, ensure_ascii=False)
        verb = save_canvas(self.store, session, name, content, KIND)
        said = _summary(verb, name, sheet)
        numeric = [f for f in sheet["formats"] if f != "text"]
        if sheet["rows"] and not numeric:
            said += (
                " Every column is formatted as text -- if any hold money, counts or "
                "percentages, pass `formats` so they line up and read properly."
            )
        return said


class EditSheet(Skill):
    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="edit_sheet",
            description=(
                "Change some cells of an existing sheet without rewriting it: set "
                "cells by address, append rows, or delete rows. Row 1 is the "
                "header (setting A1 renames column A); data starts at row 2. "
                "Setting a cell past the last row or column grows the sheet. The "
                "user may have edited the sheet, so read_canvas first if you need "
                "to know what is in it."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Which sheet."},
                    "cells": {
                        "type": "object",
                        "description": (
                            'Cells to set, by address: {"B3": 120, "D2": "=B2*C2"}. '
                            "An empty string clears a cell."
                        ),
                        "additionalProperties": {"type": ["string", "number"]},
                    },
                    "append_rows": {
                        "type": "array",
                        "items": {"type": "array", "items": {"type": ["string", "number"]}},
                        "description": "Rows to add at the bottom.",
                    },
                    "delete_rows": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Row numbers to remove (2 or more).",
                    },
                },
                "required": ["title"],
            },
        )
        self.store = store

    async def use(
        self,
        session: str,
        title=None,
        cells=None,
        append_rows=None,
        delete_rows=None,
        **extra,
    ) -> str:
        name = plain_text(title)
        canvas = self.store.find_canvas_by_title(session, name) if name else None
        if canvas is None and not name:
            # No title, and only one sheet it could mean: that one.
            only = [c for c in self.store.session_canvases(session) if c.kind == KIND]
            canvas = only[0] if len(only) == 1 else None
        if canvas is None:
            sheets = [c.title for c in self.store.session_canvases(session) if c.kind == KIND]
            listed = ", ".join(repr(t) for t in sheets) or "none yet"
            return f"There is no sheet called {name!r}. Sheets here: {listed}."
        sheet = load(canvas.content) if canvas.kind == KIND else None
        if sheet is None:
            return f"{canvas.title!r} is not a sheet, so it cannot be edited cell by cell."

        cells = as_dict(cells) if cells is not None else None
        # A list of {"cell": "B3", "value": 5} is the other shape models use.
        if cells is None and isinstance(extra.get("updates"), list):
            cells = {plain_text(u.get("cell") or u.get("ref")): u.get("value")
                     for u in extra["updates"] if isinstance(u, dict)}
        changed = 0
        problems: list[str] = []
        columns, formats, rows = sheet["columns"], sheet["formats"], sheet["rows"]

        for ref, value in (cells or {}).items():
            hit = _REF.match(str(ref).strip())
            if not hit:
                problems.append(f"{ref!r} is not a cell address")
                continue
            col = column_index(hit.group(1))
            row = int(hit.group(2))
            if col >= MAX_COLUMNS or row < 1 or row > MAX_ROWS + 1:
                problems.append(f"{ref} is outside the sheet")
                continue
            while len(columns) <= col:
                columns.append(f"Column {column_letter(len(columns))}")
                formats.append("text")
                for r in rows:
                    r.append("")
            if row == 1:
                columns[col] = str(value).strip() or columns[col]
            else:
                while len(rows) < row - 1:
                    rows.append([""] * len(columns))
                rows[row - 2][col] = _coerce(value, formats[col])
            changed += 1

        for extra in _rows_from(append_rows)[: MAX_ROWS - len(rows)]:
            padded = [_coerce(extra[i] if i < len(extra) else "", formats[i])
                      for i in range(len(columns))]
            rows.append(padded)
            changed += 1

        doomed = sorted({int(n) for n in (delete_rows or []) if str(n).lstrip("-").isdigit()},
                        reverse=True)
        for number in doomed:
            if 2 <= number <= len(rows) + 1:
                del rows[number - 2]
                changed += 1
            else:
                problems.append(f"row {number} does not exist")

        if not changed:
            return "Nothing changed. " + ("; ".join(problems) + "." if problems else "")
        self.store.update_canvas(canvas.id, content=json.dumps(sheet, ensure_ascii=False))
        said = _summary("Edited", canvas.title, sheet)
        if problems:
            said += " Skipped: " + "; ".join(problems) + "."
        return said
