const MAX_WARNINGS = 50;

// RFC 4180 reader. It never throws: a messy file should still import what it can.
export function parseCsv(text: string): { rows: string[][]; warnings: string[] } {
  // Excel writes a BOM; left in place it would stick to the first header name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
  };

  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A quote only opens a quoted field when it is the first character of the field.
  let atStart = true;

  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    atStart = true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (quoted) {
      if (c !== "\"") {
        field += c;
      } else if (src.charAt(i + 1) === "\"") {
        field += "\"";
        i++;
      } else {
        quoted = false;
      }
    } else if (c === "\"" && atStart) {
      quoted = true;
      atStart = false;
    } else if (c === ",") {
      row.push(field);
      field = "";
      atStart = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src.charAt(i + 1) === "\n") i++;
      endRow();
    } else {
      field += c;
      atStart = false;
    }
  }
  if (quoted) warn("The file ends inside an open quote");
  // Flush the last row when the file has no trailing newline.
  if (!atStart || row.length > 0) endRow();

  // Editors add a final newline; that is not a row.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && last[0] === "") rows.pop();
    else break;
  }

  // Ragged rows are kept (cells read as empty) and reported, with the header as Row 1.
  const width = rows[0]?.length ?? 0;
  for (let r = 1; r < rows.length; r++) {
    const n = rows[r]?.length ?? 0;
    if (n !== width) warn(`Row ${r + 1} has ${n} fields, expected ${width}`);
  }

  return { rows, warnings };
}