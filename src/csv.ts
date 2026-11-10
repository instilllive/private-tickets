export const MAX_CSV_CHARS = 200_000;
export const MAX_IMPORT_ROWS = 500;
export const NAME_MAX = 120;

const NAME_KEYS = new Set(['name', 'guest', 'guest_name', 'guest name']);
const EMAIL_KEYS = new Set(['email', 'e-mail', 'email address']);
const HANDLE_KEYS = new Set(['handle', 'twitter', 'social']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE_RE = /^@?[A-Za-z0-9._]{1,40}$/;

export type GuestDraft = {
  line: number;
  name: string;
  email: string | null;
  handle: string | null;
};

export type CsvRowError = {
  line: number;
  reason: string;
};

export type CsvRead =
  | { ok: true; guests: GuestDraft[]; errors: CsvRowError[] }
  | { ok: false; error: 'too_large' | 'missing_name_column' | 'duplicate_column' | 'too_many_rows' };

type CsvRecord = { line: number; cells: string[] };

function normHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isHeaderAlias(value: string): boolean {
  const key = normHeader(value);
  return NAME_KEYS.has(key) || EMAIL_KEYS.has(key) || HANDLE_KEYS.has(key);
}

export function cleanGuestName(value: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = value.trim();
  if (name.length < 1) return { ok: false, reason: 'Name is required' };
  if (name.length > NAME_MAX) return { ok: false, reason: 'Name is too long' };
  if (/[\u0000-\u001F\u007F]/.test(name)) return { ok: false, reason: 'Name has invalid characters' };
  return { ok: true, name };
}

export function cleanGuestEmail(value: string): { ok: true; email: string | null } | { ok: false; reason: string } {
  const email = value.trim();
  if (email === '') return { ok: true, email: null };
  if (email.length > 200 || /[\u0000-\u001F\u007F]/.test(email) || !EMAIL_RE.test(email)) {
    return { ok: false, reason: 'Email is not valid' };
  }
  return { ok: true, email };
}

export function cleanGuestHandle(value: string): { ok: true; handle: string | null } | { ok: false; reason: string } {
  const handle = value.trim();
  if (handle === '') return { ok: true, handle: null };
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: 'Handle is not valid' };
  return { ok: true, handle };
}

export function parseCsvRecords(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;

  const finish = () => {
    cells.push(field);
    field = '';
    if (cells.some((cell) => cell.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
    startLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += char;
      if (char === '\n') line += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      cells.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      finish();
      continue;
    }
    field += char;
  }
  finish();
  return records;
}

type ColumnMap = { name: number; email: number | null; handle: number | null };

function headerMap(cells: string[]): ColumnMap | 'missing_name_column' | 'duplicate_column' | null {
  const keys = cells.map(normHeader);
  const hasName = keys.some((key) => NAME_KEYS.has(key));
  const onlyAliases = keys.every((key) => key === '' || isHeaderAlias(key));
  if (!hasName && keys.length > 0 && onlyAliases) return 'missing_name_column';
  if (!hasName) return null;
  const map: ColumnMap = { name: -1, email: null, handle: null };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] ?? '';
    if (NAME_KEYS.has(key)) {
      if (map.name !== -1) return 'duplicate_column';
      map.name = index;
    } else if (EMAIL_KEYS.has(key)) {
      if (map.email !== null) return 'duplicate_column';
      map.email = index;
    } else if (HANDLE_KEYS.has(key)) {
      if (map.handle !== null) return 'duplicate_column';
      map.handle = index;
    }
  }
  if (map.name === -1) return 'missing_name_column';
  return map;
}

function cell(cells: string[], index: number | null): string {
  if (index === null || index < 0) return '';
  return cells[index] ?? '';
}

/**
 * Read a guest-list CSV. A header row is optional.
 * With a header, `name` is required and `email` and `handle` are optional.
 * Without one, columns are name, email, handle. Blank lines are skipped.
 * Valid rows are returned even when other rows are rejected.
 */
export function readGuestCsv(input: string): CsvRead {
  if (input.length > MAX_CSV_CHARS) return { ok: false, error: 'too_large' };
  const records = parseCsvRecords(input);
  if (records.length === 0) return { ok: true, guests: [], errors: [] };

  const first = records[0];
  if (!first) return { ok: true, guests: [], errors: [] };
  const mapped = headerMap(first.cells);
  if (mapped === 'missing_name_column' || mapped === 'duplicate_column') return { ok: false, error: mapped };

  const data = mapped ? records.slice(1) : records;
  if (data.length > MAX_IMPORT_ROWS) return { ok: false, error: 'too_many_rows' };

  const guests: GuestDraft[] = [];
  const errors: CsvRowError[] = [];
  for (const record of data) {
    const nameRaw = mapped ? cell(record.cells, mapped.name) : (record.cells[0] ?? '');
    const emailRaw = mapped ? cell(record.cells, mapped.email) : (record.cells[1] ?? '');
    const handleRaw = mapped ? cell(record.cells, mapped.handle) : (record.cells[2] ?? '');
    if (!mapped && record.cells.length > 3) {
      errors.push({ line: record.line, reason: 'Too many columns' });
      continue;
    }
    const name = cleanGuestName(nameRaw);
    if (!name.ok) {
      errors.push({ line: record.line, reason: name.reason });
      continue;
    }
    const email = cleanGuestEmail(emailRaw);
    if (!email.ok) {
      errors.push({ line: record.line, reason: email.reason });
      continue;
    }
    const handle = cleanGuestHandle(handleRaw);
    if (!handle.ok) {
      errors.push({ line: record.line, reason: handle.reason });
      continue;
    }
    guests.push({ line: record.line, name: name.name, email: email.email, handle: handle.handle });
  }
  return { ok: true, guests, errors };
}
