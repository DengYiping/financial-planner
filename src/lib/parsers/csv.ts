export function parseCsvRows(csvContent: string): string[][] {
  const sanitized = csvContent.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentCell = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < sanitized.length; i += 1) {
    const char = sanitized[i];

    if (char === '"') {
      const nextChar = sanitized[i + 1];
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && sanitized[i + 1] === "\n") {
        i += 1;
      }
      currentRow.push(currentCell);
      if (!isBlankRow(currentRow)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    if (!isBlankRow(currentRow)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

export function indexHeaders(headers: string[]): Record<string, number> {
  const index: Record<string, number> = {};
  headers.forEach((header, headerIndex) => {
    index[header] = headerIndex;
  });
  return index;
}

export function toRawRecord(headers: string[], row: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  headers.forEach((header, index) => {
    raw[header] = readCell(row, index);
  });
  return raw;
}

export function readCell(row: string[], index: number | undefined): string {
  if (index === undefined || index < 0) {
    return "";
  }

  return normalizeCell(row[index] ?? "");
}

export function normalizeCell(value: string): string {
  return value.trim();
}

function isBlankRow(row: string[]): boolean {
  return row.every((cell) => normalizeCell(cell).length === 0);
}
