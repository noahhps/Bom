import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  FORMATS,
  cellName,
  coerceInput,
  colLetter,
  display,
  evaluator,
  isError,
  isNumeric,
  shiftFormulas,
} from "../lib/sheet";
import { resolveTheme, themeVars } from "../lib/slides";

const FORMAT_NAMES = {
  text: "Text",
  number: "Number",
  integer: "Whole number",
  currency: "Currency",
  percent: "Percent",
  date: "Date",
};

// The first cell of a totals row, so it can be set apart the way a ledger does.
const TOTAL = /^(grand\s+)?(sub)?total\b|^sum\b/i;

const rawOf = (sheet, row, col) =>
  row === 1 ? sheet.columns[col] ?? "" : String(sheet.rows[row - 2]?.[col] ?? "");

/**
 * A spreadsheet in the canvas panel.
 *
 * The grid shows calculated values; the bar above it shows what is actually in
 * the selected cell, which for a formula is the formula. Click to select,
 * double-click or start typing to edit, Enter to go down, Tab to go across --
 * the keys every spreadsheet has taught. Row 1 is the header, as it is to the
 * model, so the addresses on screen are the ones its formulas use.
 *
 * Every change goes back up as a whole new sheet through `onChange`; the panel
 * owns saving.
 */
export function SheetView({ sheet, fallbackTheme, onChange }) {
  const [sel, setSel] = useState({ row: 2, col: 0 });
  // The cell being typed into, and what it holds so far. `from` is where the
  // typing is happening: in the cell itself, or in the bar above the grid.
  //
  // Mirrored in a ref, because a blur arrives *after* Enter or Escape has
  // already ended the edit but before React has re-rendered -- and a blur
  // handler reading state would see the edit still open and commit it again,
  // which is how Escape used to save what it was meant to throw away.
  const [editing, setEditingState] = useState(null);
  const editRef = useRef(null);
  const setEditing = useCallback((next) => {
    editRef.current = typeof next === "function" ? next(editRef.current) : next;
    setEditingState(editRef.current);
  }, []);
  const grid = useRef(null);

  const width = sheet.columns.length;
  const height = sheet.rows.length + 1;
  const row = Math.min(sel.row, height);
  const col = Math.min(sel.col, Math.max(0, width - 1));

  const value = useMemo(() => evaluator(sheet), [sheet]);
  const style = useMemo(
    () => themeVars(resolveTheme(sheet.theme, fallbackTheme)),
    [sheet.theme, fallbackTheme],
  );

  // Keep the selection on screen as the keyboard moves it.
  useEffect(() => {
    grid.current
      ?.querySelector(`[data-cell="${row}:${col}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [row, col]);

  const commit = useCallback(
    (r, c, raw) => {
      if (rawOf(sheet, r, c) === String(raw)) return;
      const next = { ...sheet, columns: [...sheet.columns], rows: sheet.rows.map((x) => [...x]) };
      if (r === 1) {
        next.columns[c] = String(raw).trim() || next.columns[c];
      } else {
        next.rows[r - 2][c] = coerceInput(raw, sheet.formats[c]);
      }
      onChange(next);
    },
    [sheet, onChange],
  );

  // End an edit, keeping what was typed. `settle` leaves focus where it went
  // (a blur to somewhere else); `finish` brings it back to the grid.
  const settle = () => {
    const open = editRef.current;
    if (!open) return;
    setEditing(null);
    commit(open.row, open.col, open.value);
  };
  const finish = (move) => {
    settle();
    if (move) setSel(move);
    grid.current?.focus();
  };

  const go = (r, c) =>
    setSel({ row: Math.max(1, Math.min(height, r)), col: Math.max(0, Math.min(width - 1, c)) });

  // -- structure ----------------------------------------------------------

  const addRow = () => {
    // Below the selection, or at the foot when the header is selected.
    const at = Math.max(2, row + 1);
    const shifted = shiftFormulas(sheet, (ref) =>
      ref.row >= at ? { ...ref, row: ref.row + 1 } : null,
    );
    const rows = shifted.rows.map((x) => [...x]);
    rows.splice(at - 2, 0, Array(width).fill(""));
    onChange({ ...shifted, rows });
    setSel({ row: at, col });
  };

  const deleteRow = () => {
    if (row < 2 || sheet.rows.length <= 1) return;
    const shifted = shiftFormulas(sheet, (ref) =>
      ref.row > row ? { ...ref, row: ref.row - 1 } : null,
    );
    onChange({ ...shifted, rows: shifted.rows.filter((_, i) => i !== row - 2) });
    setSel({ row: Math.min(row, height - 1), col });
  };

  const addColumn = () => {
    onChange({
      ...sheet,
      columns: [...sheet.columns, `Column ${colLetter(width)}`],
      formats: [...sheet.formats, "text"],
      rows: sheet.rows.map((x) => [...x, ""]),
    });
    setSel({ row: 1, col: width });
  };

  const deleteColumn = () => {
    if (width <= 1) return;
    const shifted = shiftFormulas(sheet, (ref) =>
      ref.col > col ? { ...ref, col: ref.col - 1 } : null,
    );
    onChange({
      ...shifted,
      columns: sheet.columns.filter((_, i) => i !== col),
      formats: sheet.formats.filter((_, i) => i !== col),
      rows: shifted.rows.map((x) => x.filter((_, i) => i !== col)),
    });
    setSel({ row, col: Math.max(0, col - 1) });
  };

  const setFormat = (format) =>
    onChange({ ...sheet, formats: sheet.formats.map((f, i) => (i === col ? format : f)) });

  // -- keys ----------------------------------------------------------------

  const onGridKey = (event) => {
    if (editing) return;
    const { key } = event;
    const moves = {
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      Tab: [row, col + (event.shiftKey ? -1 : 1)],
      Home: [row, 0],
      End: [row, width - 1],
    };
    if (moves[key]) {
      event.preventDefault();
      go(...moves[key]);
    } else if (key === "Enter" || key === "F2") {
      event.preventDefault();
      setEditing({ row, col, value: rawOf(sheet, row, col), from: "cell" });
    } else if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      if (row > 1) commit(row, col, "");
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Typing over a cell replaces it, as it does everywhere else.
      event.preventDefault();
      setEditing({ row, col, value: key, from: "cell" });
    }
  };

  const onEditKey = (event) => {
    event.stopPropagation();
    const open = editRef.current;
    if (!open) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish({ row: Math.min(height, open.row + 1), col: open.col });
    } else if (event.key === "Tab") {
      event.preventDefault();
      finish({ row: open.row, col: Math.max(0, Math.min(width - 1, open.col + (event.shiftKey ? -1 : 1))) });
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
      grid.current?.focus();
    }
  };

  const barValue =
    editing && editing.row === row && editing.col === col ? editing.value : rawOf(sheet, row, col);

  // -- render ----------------------------------------------------------------

  const cell = (r, c) => {
    const live = editing && editing.from === "cell" && editing.row === r && editing.col === c;
    const format = sheet.formats[c] || "text";
    const v = r === 1 ? sheet.columns[c] : value(r, c);
    const numeric = r > 1 && (typeof v === "number" || (isNumeric(format) && v !== ""));
    return (
      <td
        key={c}
        className="sheet-cell"
        data-cell={`${r}:${c}`}
        data-sel={r === row && c === col ? "" : undefined}
        data-num={numeric ? "" : undefined}
        data-error={isError(v) ? "" : undefined}
        data-formula={r > 1 && String(rawOf(sheet, r, c)).startsWith("=") ? "" : undefined}
        onMouseDown={() => setSel({ row: r, col: c })}
        onDoubleClick={() => setEditing({ row: r, col: c, value: rawOf(sheet, r, c), from: "cell" })}
      >
        {live ? (
          <input
            className="sheet-input"
            autoFocus
            // Caret at the end, so typing over a cell carries on from the key
            // that started the edit rather than landing in front of it.
            onFocus={(event) => {
              const end = event.target.value.length;
              event.target.setSelectionRange(end, end);
            }}
            value={editing.value}
            onChange={(event) => {
              const typed = event.target.value;
              setEditing((was) => ({ ...was, value: typed }));
            }}
            onKeyDown={onEditKey}
            onBlur={settle}
          />
        ) : r === 1 ? (
          v
        ) : (
          display(v, format)
        )}
      </td>
    );
  };

  return (
    <div className="sheet-view">
      <div className="sheet-bar">
        <span className="sheet-addr mi">{cellName(row, col)}</span>
        <input
          className="sheet-formula"
          aria-label={`Contents of ${cellName(row, col)}`}
          value={barValue}
          placeholder={row === 1 ? "Column name" : "Value, or = for a formula"}
          onFocus={() =>
            setEditing((was) =>
              was && was.row === row && was.col === col
                ? { ...was, from: "bar" }
                : { row, col, value: rawOf(sheet, row, col), from: "bar" },
            )
          }
          onChange={(event) => setEditing({ row, col, value: event.target.value, from: "bar" })}
          onKeyDown={onEditKey}
          onBlur={() => {
            if (editRef.current?.from === "bar") settle();
          }}
        />
      </div>

      <div className="sheet-tools">
        <label className="sheet-format">
          <span className="mi">{colLetter(col)}</span>
          <select
            aria-label={`Format of column ${colLetter(col)}`}
            value={FORMATS.includes(sheet.formats[col]) ? sheet.formats[col] : sheet.formats[col]?.startsWith("currency") ? sheet.formats[col] : "text"}
            onChange={(event) => setFormat(event.target.value)}
          >
            {sheet.formats[col]?.includes(":") ? (
              <option value={sheet.formats[col]}>{sheet.formats[col].replace("currency:", "Currency · ")}</option>
            ) : null}
            {FORMATS.map((f) => (
              <option key={f} value={f}>{FORMAT_NAMES[f]}</option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button type="button" className="deck-tool sheet-tool" onClick={addRow}>+ Row</button>
        <button type="button" className="deck-tool sheet-tool" onClick={addColumn}>+ Column</button>
        <button type="button" className="deck-tool sheet-tool" disabled={row < 2 || sheet.rows.length <= 1}
          onClick={deleteRow} title={`Delete row ${row}`}>− Row</button>
        <button type="button" className="deck-tool sheet-tool" disabled={width <= 1}
          onClick={deleteColumn} title={`Delete column ${colLetter(col)}`}>− Column</button>
      </div>

      <div
        className="sheet-scroll"
        ref={grid}
        tabIndex={0}
        role="grid"
        aria-label="Sheet"
        style={style}
        onKeyDown={onGridKey}
      >
        <table className="sheet-grid">
          <thead>
            <tr>
              <th className="sheet-corner" aria-hidden="true" />
              {sheet.columns.map((_, c) => (
                <th key={c} className="sheet-letter" data-sel={c === col ? "" : undefined}
                  onMouseDown={() => setSel({ row, col: c })}>
                  {colLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="sheet-head">
              <th className="sheet-rownum" data-sel={row === 1 ? "" : undefined}>1</th>
              {sheet.columns.map((_, c) => cell(1, c))}
            </tr>
            {sheet.rows.map((cells, i) => (
              <tr key={i} data-total={TOTAL.test(String(cells[0] ?? "")) ? "" : undefined}>
                <th className="sheet-rownum" data-sel={row === i + 2 ? "" : undefined}
                  onMouseDown={() => setSel({ row: i + 2, col })}>
                  {i + 2}
                </th>
                {cells.map((_, c) => cell(i + 2, c))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
