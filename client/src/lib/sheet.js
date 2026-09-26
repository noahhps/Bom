/* A sheet: parsed, calculated, formatted, exported. No React here.
 *
 * The server stores a sheet as JSON -- a header row, the rows under it, a
 * format per column and a theme -- and never evaluates a formula. That happens
 * here, so the grid stays live as the reader types: change the rent and the
 * total moves.
 *
 * Addressed like every spreadsheet. Columns are letters from A; row 1 is the
 * header, so the first row of data is row 2. The model is told the same thing
 * in write_sheet's description, and that shared convention is the only reason
 * `=SUM(B2:B9)` means the same cells to the model that wrote it and to this.
 *
 * The formula language is the useful core of a spreadsheet's rather than all
 * of it: arithmetic, comparison, `&` for joining text, cell references and
 * ranges, and a short list of functions. An unknown function is `#NAME?`, not
 * a crash, and a formula that refers to itself is `#CYCLE!`.
 */

export const FORMATS = ["text", "number", "integer", "currency", "percent", "date"];

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function colLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A -> 0, AA -> 26. */
export function colIndex(letters) {
  let value = 0;
  for (const ch of letters.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

export const cellName = (row, col) => `${colLetter(col)}${row}`;

/** A stored sheet, or null when the text is not one. Missing parts filled in. */
export function parseSheet(content) {
  let data;
  try {
    data = JSON.parse(content || "");
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.columns)) return null;
  const columns = data.columns.map((c) => String(c ?? ""));
  const width = columns.length;
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => {
    const cells = Array.isArray(row) ? row.slice(0, width) : [];
    while (cells.length < width) cells.push("");
    return cells;
  });
  const formats = columns.map((_, i) => normalizeFormat(data.formats?.[i]));
  const theme = data.theme && typeof data.theme === "object" ? data.theme : {};
  return { version: 1, columns, formats, rows, theme };
}

export function serializeSheet(sheet) {
  return JSON.stringify({
    version: 1,
    columns: sheet.columns,
    formats: sheet.formats,
    rows: sheet.rows,
    theme: sheet.theme || {},
  });
}

function normalizeFormat(raw) {
  const text = String(raw || "").trim();
  if (/^currency(:[A-Z]{3})?$/.test(text)) return text;
  return FORMATS.includes(text) ? text : "text";
}

/** A blank sheet worth starting from: three columns, a few empty rows. */
export function blankSheet() {
  return {
    version: 1,
    columns: ["Item", "Amount", "Notes"],
    formats: ["text", "currency", "text"],
    rows: Array.from({ length: 6 }, () => ["", "", ""]),
    theme: {},
  };
}

/* -- typed input ----------------------------------------------------------- */

/** What a typed value is stored as: a number where it is one, else text. */
export function coerceInput(raw, format = "text") {
  const text = String(raw ?? "").trim();
  if (!text || text.startsWith("=")) return text;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (format !== "text") {
    let bare = text.replace(/[,\s]/g, "");
    const percent = bare.endsWith("%");
    bare = bare.replace(/%$/, "").replace(/^[$€£¥]/, "");
    if (/^-?\d+(\.\d+)?$/.test(bare)) return percent ? Number(bare) / 100 : Number(bare);
  }
  return text;
}

/* -- evaluation ------------------------------------------------------------ */

class SheetError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const isError = (value) => value instanceof SheetError;

const REF = /^\$?([A-Za-z]{1,2})\$?(\d{1,5})$/;

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          text += '"';
          j += 2;
        } else if (src[j] === '"') {
          break;
        } else {
          text += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new SheetError("#ERR!");
      tokens.push({ type: "str", value: text });
      i = j + 1;
      continue;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num) {
      tokens.push({ type: "num", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^\$?[A-Za-z_][A-Za-z0-9_.]*\$?\d*/.exec(src.slice(i));
    if (word) {
      tokens.push({ type: "word", value: word[0] });
      i += word[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<>", "<=", ">="].includes(two)) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>(),:%".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    throw new SheetError("#ERR!");
  }
  return tokens;
}

function toNumber(value) {
  if (isError(value)) throw value;
  if (value === "" || value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (text.toUpperCase() === "TRUE") return 1;
  if (text.toUpperCase() === "FALSE") return 0;
  throw new SheetError("#VALUE!");
}

const toText = (value) => {
  if (isError(value)) throw value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value == null ? "" : String(value);
};

const truthy = (value) =>
  typeof value === "string" ? value !== "" && value.toUpperCase() !== "FALSE" : Boolean(toNumber(value));

/** Numbers in a list of arguments, ranges flattened, text skipped (as Excel). */
function numbersIn(args) {
  const out = [];
  for (const arg of args) {
    const items = Array.isArray(arg) ? arg : [arg];
    for (const item of items) {
      if (isError(item)) throw item;
      if (typeof item === "number") out.push(item);
      else if (!Array.isArray(arg) && item !== "" && item != null) out.push(toNumber(item));
    }
  }
  return out;
}

const FUNCTIONS = {
  SUM: (args) => numbersIn(args).reduce((a, b) => a + b, 0),
  AVERAGE: (args) => {
    const n = numbersIn(args);
    if (!n.length) throw new SheetError("#DIV/0!");
    return n.reduce((a, b) => a + b, 0) / n.length;
  },
  MIN: (args) => {
    const n = numbersIn(args);
    return n.length ? Math.min(...n) : 0;
  },
  MAX: (args) => {
    const n = numbersIn(args);
    return n.length ? Math.max(...n) : 0;
  },
  MEDIAN: (args) => {
    const n = numbersIn(args).sort((a, b) => a - b);
    if (!n.length) throw new SheetError("#NUM!");
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  COUNT: (args) => numbersIn(args).length,
  COUNTA: (args) =>
    args.flat().filter((v) => v !== "" && v != null && !isError(v)).length,
  ROUND: ([value, digits = 0]) => {
    const factor = 10 ** Math.trunc(toNumber(digits));
    return Math.round(toNumber(value) * factor) / factor;
  },
  ABS: ([value]) => Math.abs(toNumber(value)),
  IF: ([test, yes = true, no = false]) => (truthy(test) ? yes : no),
  AND: (args) => args.flat().every(truthy),
  OR: (args) => args.flat().some(truthy),
  NOT: ([value]) => !truthy(value),
  CONCAT: (args) => args.flat().map(toText).join(""),
};
FUNCTIONS.AVG = FUNCTIONS.AVERAGE;
FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT;

/**
 * Every cell's value, calculated. Returned as a function of (row, col) in sheet
 * coordinates -- row 1 is the header -- memoised, so a total that depends on a
 * column is worked out once however many cells read it.
 */
export function evaluator(sheet) {
  const cache = new Map();
  const visiting = new Set();

  const raw = (row, col) => {
    if (row === 1) return sheet.columns[col] ?? "";
    return sheet.rows[row - 2]?.[col] ?? "";
  };

  const value = (row, col) => {
    const key = `${row}:${col}`;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) return new SheetError("#CYCLE!");
    const cell = raw(row, col);
    let result = cell;
    if (typeof cell === "string" && cell.startsWith("=") && row > 1) {
      visiting.add(key);
      try {
        result = evaluate(cell.slice(1));
      } catch (error) {
        result = isError(error) ? error : new SheetError("#ERR!");
      }
      visiting.delete(key);
    }
    cache.set(key, result);
    return result;
  };

  function evaluate(src) {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];
    const isOp = (v) => peek()?.type === "op" && peek().value === v;

    const refAt = (word) => {
      const hit = REF.exec(word);
      if (!hit) return null;
      return { row: Number(hit[2]), col: colIndex(hit[1]) };
    };

    const range = (a, b) => {
      const out = [];
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r += 1) {
        for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c += 1) {
          out.push(value(r, c));
        }
      }
      return out;
    };

    function primary() {
      const token = take();
      if (!token) throw new SheetError("#ERR!");
      if (token.type === "num") return token.value;
      if (token.type === "str") return token.value;
      if (token.type === "op" && token.value === "(") {
        const inner = comparison();
        if (!isOp(")")) throw new SheetError("#ERR!");
        take();
        return inner;
      }
      if (token.type === "word") {
        const upper = token.value.toUpperCase();
        if (isOp("(")) {
          take();
          const args = [];
          if (!isOp(")")) {
            args.push(argument());
            while (isOp(",")) {
              take();
              args.push(argument());
            }
          }
          if (!isOp(")")) throw new SheetError("#ERR!");
          take();
          const fn = FUNCTIONS[upper];
          if (!fn) throw new SheetError("#NAME?");
          return fn(args);
        }
        if (upper === "TRUE") return true;
        if (upper === "FALSE") return false;
        const ref = refAt(token.value);
        if (!ref) throw new SheetError("#NAME?");
        if (ref.row < 1) throw new SheetError("#REF!");
        const v = value(ref.row, ref.col);
        if (isError(v)) throw v;
        return v;
      }
      throw new SheetError("#ERR!");
    }

    // A function argument may be a range; nowhere else may.
    function argument() {
      const token = peek();
      const next = tokens[pos + 1];
      if (token?.type === "word" && next?.type === "op" && next.value === ":") {
        const a = refAt(token.value);
        const b = refAt(tokens[pos + 2]?.value || "");
        if (!a || !b) throw new SheetError("#REF!");
        pos += 3;
        return range(a, b);
      }
      return comparison();
    }

    function postfix() {
      let v = primary();
      while (isOp("%")) {
        take();
        v = toNumber(v) / 100;
      }
      return v;
    }
    function unary() {
      if (isOp("-")) {
        take();
        return -toNumber(unary());
      }
      if (isOp("+")) {
        take();
        return toNumber(unary());
      }
      return postfix();
    }
    function power() {
      let v = unary();
      while (isOp("^")) {
        take();
        v = toNumber(v) ** toNumber(unary());
      }
      return v;
    }
    function term() {
      let v = power();
      while (isOp("*") || isOp("/")) {
        const op = take().value;
        const rhs = toNumber(power());
        if (op === "/" && rhs === 0) throw new SheetError("#DIV/0!");
        v = op === "*" ? toNumber(v) * rhs : toNumber(v) / rhs;
      }
      return v;
    }
    function additive() {
      let v = term();
      while (isOp("+") || isOp("-")) {
        const op = take().value;
        const rhs = toNumber(term());
        v = op === "+" ? toNumber(v) + rhs : toNumber(v) - rhs;
      }
      return v;
    }
    function concat() {
      let v = additive();
      while (isOp("&")) {
        take();
        v = toText(v) + toText(additive());
      }
      return v;
    }
    function comparison() {
      const v = concat();
      const token = peek();
      if (token?.type === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(token.value)) {
        take();
        const rhs = concat();
        const both = typeof v === "number" && typeof rhs === "number";
        const a = both ? v : toText(v).toLowerCase();
        const b = both ? rhs : toText(rhs).toLowerCase();
        switch (token.value) {
          case "=": return a === b;
          case "<>": return a !== b;
          case "<": return a < b;
          case ">": return a > b;
          case "<=": return a <= b;
          default: return a >= b;
        }
      }
      return v;
    }

    const result = comparison();
    if (pos !== tokens.length) throw new SheetError("#ERR!");
    if (Array.isArray(result)) throw new SheetError("#VALUE!");
    return result;
  }

  return value;
}

/* -- display --------------------------------------------------------------- */

const formatters = new Map();
function numberFormat(key, options) {
  if (!formatters.has(key)) {
    try {
      formatters.set(key, new Intl.NumberFormat(undefined, options));
    } catch {
      formatters.set(key, new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }));
    }
  }
  return formatters.get(key);
}

/** A calculated value as the grid shows it, per its column's format. */
export function display(value, format = "text") {
  if (isError(value)) return value.code;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value === "" || value == null) return "";
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "#NUM!";
  if (format.startsWith("currency")) {
    const code = format.split(":")[1] || "USD";
    return numberFormat(`c:${code}`, { style: "currency", currency: code }).format(value);
  }
  if (format === "percent") {
    return numberFormat("p", { style: "percent", maximumFractionDigits: 1 }).format(value);
  }
  if (format === "integer") return numberFormat("i", { maximumFractionDigits: 0 }).format(value);
  if (format === "number") return numberFormat("n", { maximumFractionDigits: 2 }).format(value);
  // Text columns still hold numbers sometimes; strip float noise (0.1 + 0.2).
  return String(Number(value.toPrecision(12)));
}

/** Whether a column reads as numbers, so its cells align right. */
export const isNumeric = (format) => format !== "text" && format !== "date";

/** The calculated sheet as CSV -- values, not formulas, as any export is.
 *  With a tab as the separator it is what a spreadsheet expects on paste. */
export function toCsv(sheet, separator = ",") {
  const value = evaluator(sheet);
  const special = new RegExp(`["\n${separator === "\t" ? "\t" : ","}]`);
  const quote = (text) => (special.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = [sheet.columns.map((c) => quote(String(c))).join(separator)];
  sheet.rows.forEach((row, i) => {
    const cells = row.map((_, c) => {
      const v = value(i + 2, c);
      if (isError(v)) return v.code;
      if (typeof v === "number") return String(Number(v.toPrecision(15)));
      return quote(toText(v));
    });
    lines.push(cells.join(separator));
  });
  return lines.join("\n") + "\n";
}

/**
 * Rewrite every cell reference in a formula, leaving quoted text alone.
 *
 * What keeps `=SUM(B2:B9)` pointing at the same numbers when a row is
 * inserted above them or one is deleted -- the grid shifts the rows, and this
 * shifts the addresses to match, the way any spreadsheet does.
 */
export function rewriteRefs(formula, move) {
  if (typeof formula !== "string" || !formula.startsWith("=")) return formula;
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\b(\$?)([A-Za-z]{1,2})(\$?)(\d{1,5})\b(?!\s*\()/g, (whole, d1, letters, d2, digits) => {
            const moved = move({ row: Number(digits), col: colIndex(letters) });
            if (!moved) return whole;
            return `${d1}${colLetter(moved.col)}${d2}${moved.row}`;
          }),
    )
    .join("");
}

/** A copy of the sheet with every formula's references moved by `move`. */
export function shiftFormulas(sheet, move) {
  return {
    ...sheet,
    rows: sheet.rows.map((row) => row.map((cell) => rewriteRefs(cell, move))),
  };
}
