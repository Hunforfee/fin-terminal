import { normalizeStockCode } from './datasource/codes';

export const RESEARCH_NOTES_KEY = 'fin.research.notes.v1';
// Drafts stay on this device, scoped to the same account as saved notes.
export const RESEARCH_NOTE_DRAFT_KEY = 'fin.research.note-draft.v1';
export const DAILY_NOTE_DRAFT_KEY = 'fin.research.daily-draft.v1';

export type NoteKind = 'company' | 'daily';

export interface ResearchNote {
  id: string;
  code: string;
  name: string;
  kind?: NoteKind;
  entryDate?: string;
  title?: string;
  text: string;
  date: string;
  symbol?: string;
  updatedAt?: string;
}

export interface ResearchNoteInput {
  id?: string;
  code?: string;
  name?: string;
  kind?: NoteKind;
  entryDate?: string;
  title?: string;
  text: string;
  symbol?: string;
}

interface NotesStorage {
  read(): string | null;
  write(raw: string): void;
}

export class ResearchNotesError extends Error {}

/** Legacy notes without a kind remain company research, even without a code. */
export function researchNoteKind(note: { kind?: NoteKind }): NoteKind {
  return note.kind === 'daily' ? 'daily' : 'company';
}

export function todayResearchDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/** Date inputs must be real calendar dates, not normalized invalid days. */
export function isResearchDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000-')
  )
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isNote(value: unknown): value is ResearchNote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    !!n.id.trim() &&
    typeof n.text === 'string' &&
    (n.kind === undefined || n.kind === 'company' || n.kind === 'daily') &&
    (n.entryDate === undefined || typeof n.entryDate === 'string') &&
    (n.kind !== 'daily' || isResearchDate(n.entryDate)) &&
    ['code', 'name', 'date', 'symbol', 'updatedAt', 'title'].every(
      (key) => n[key] === undefined || typeof n[key] === 'string',
    )
  );
}

/** Accept older notes without optional metadata; never change saved text or IDs. */
export function parseResearchNotes(value: unknown): ResearchNote[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNote).map((note) => ({
    ...note,
    code: note.code ?? '',
    name: note.name ?? '',
    date: note.date ?? '',
  }));
}

export function researchNoteSymbol(
  note: Pick<ResearchNoteInput, 'code' | 'symbol' | 'kind'>,
): string {
  if (researchNoteKind(note) === 'daily') return '';
  return (
    normalizeStockCode(note.symbol ?? '')?.symbol ??
    normalizeStockCode(note.code ?? '')?.symbol ??
    ''
  );
}

/** Reject unreadable data instead of silently overwriting it with an empty list. */
export function readResearchNotes(raw: string | null): ResearchNote[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResearchNotesError('笔记数据读取失败，原记录已保留');
  }
  if (!Array.isArray(value) || value.some((note) => !isNote(note)))
    throw new ResearchNotesError('笔记数据读取失败，原记录已保留');
  const notes = parseResearchNotes(value);
  if (new Set(notes.map((note) => note.id)).size !== notes.length)
    throw new ResearchNotesError('笔记数据读取失败，原记录已保留');
  return notes;
}

function sameVersion(a: ResearchNote, b: ResearchNote): boolean {
  return (
    a.id === b.id &&
    researchNoteKind(a) === researchNoteKind(b) &&
    a.entryDate === b.entryDate &&
    a.title === b.title &&
    a.text === b.text &&
    a.code === b.code &&
    a.name === b.name &&
    a.date === b.date &&
    a.symbol === b.symbol &&
    a.updatedAt === b.updatedAt
  );
}

/** Read immediately before mutation so unrelated additions in another tab survive. */
export function saveResearchNote(
  storage: NotesStorage,
  input: ResearchNoteInput,
  expected?: ResearchNote,
  options: { now?: Date; createId?: () => string } = {},
): { note: ResearchNote; notes: ResearchNote[] } {
  const latest = readResearchNotes(storage.read());
  const existing = input.id
    ? latest.find((note) => note.id === input.id)
    : undefined;
  if (input.id && !existing)
    throw new ResearchNotesError('这条笔记已被删除，请重新新建');
  if (expected && (!existing || !sameVersion(existing, expected)))
    throw new ResearchNotesError('笔记已在其他页面更新，请重新打开后编辑');
  if (
    input.kind !== undefined &&
    input.kind !== 'company' &&
    input.kind !== 'daily'
  )
    throw new ResearchNotesError('笔记类型无效');
  const kind =
    input.kind ?? (existing ? researchNoteKind(existing) : 'company');
  if (existing && researchNoteKind(existing) !== kind)
    throw new ResearchNotesError('笔记类型不能修改，请重新新建');
  // Renaming a legacy note must not normalize its untouched body.
  const text =
    existing && input.text === existing.text
      ? existing.text
      : input.text.trim();
  if (!text.trim()) throw new ResearchNotesError('请先填写笔记内容');
  const symbol = kind === 'daily' ? '' : researchNoteSymbol(input);
  if (kind === 'company' && (!symbol || !input.name?.trim()))
    throw new ResearchNotesError('请选择所属公司');
  const now = options.now ?? new Date();
  const entryDate =
    kind === 'daily'
      ? input.entryDate !== undefined
        ? input.entryDate
        : (existing?.entryDate ?? todayResearchDate(now))
      : undefined;
  if (kind === 'daily' && !isResearchDate(entryDate))
    throw new ResearchNotesError('请选择有效的心得日期');
  const id =
    existing?.id ?? (options.createId ?? (() => crypto.randomUUID()))();
  if (!existing && latest.some((note) => note.id === id))
    throw new ResearchNotesError('笔记未保存，请重试');
  const note: ResearchNote = {
    ...existing,
    id,
    kind,
    code:
      kind === 'daily'
        ? ''
        : input.code?.trim() || normalizeStockCode(symbol)?.code || '',
    name: kind === 'daily' ? '' : input.name!.trim(),
    text,
    date:
      existing?.date ??
      now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    updatedAt: now.toISOString(),
  };
  if (kind === 'daily') {
    note.entryDate = entryDate;
    delete note.symbol;
  } else note.symbol = symbol;
  // Older callers only edit the body and must preserve an existing title.
  // An explicitly blank title clears it, including from serialized storage.
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title) note.title = title;
    else delete note.title;
  }
  const notes = [note, ...latest.filter((entry) => entry.id !== id)];
  storage.write(JSON.stringify(notes));
  return { note, notes };
}

export function removeResearchNote(
  storage: NotesStorage,
  id: string,
): ResearchNote[] {
  const latest = readResearchNotes(storage.read());
  const notes = latest.filter((note) => note.id !== id);
  if (notes.length !== latest.length) storage.write(JSON.stringify(notes));
  return notes;
}
