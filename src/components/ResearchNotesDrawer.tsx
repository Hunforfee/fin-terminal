'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { StockLink } from '@/components/StockLink';
import { personalStorage } from '@/lib/personalStorage';
import {
  RESEARCH_NOTE_DRAFT_KEY,
  DAILY_NOTE_DRAFT_KEY,
  researchNoteSymbol,
  researchNoteKind,
  todayResearchDate,
  isResearchDate,
  type NoteKind,
  type ResearchNote,
  type ResearchNoteInput,
  parseResearchNotes,
} from '@/lib/researchNotes';
import NoteCompanyPicker, { type NoteCompany } from './NoteCompanyPicker';
import NoteBody from './NoteBody';

interface Draft {
  id?: string;
  kind?: NoteKind;
  entryDate?: string;
  title?: string;
  company: NoteCompany | null;
  text: string;
  expected?: ResearchNote;
}
export interface ResearchNotesOpenRequest {
  token: number;
  kind?: NoteKind;
  noteId?: string;
  mode?: 'read' | 'create';
  initialText?: string;
  initialTitle?: string;
}
interface Props {
  open: boolean;
  initialCompany: NoteCompany | null;
  openRequest?: ResearchNotesOpenRequest | null;
  onClose: () => void;
  companies: NoteCompany[];
  notes: ResearchNote[];
  ready: boolean;
  error: string;
  onClearError: () => void;
  onSave: (
    input: ResearchNoteInput,
    expected?: ResearchNote,
  ) => ResearchNote | null;
  onRemove: (id: string) => boolean;
}

function noteTime(note: ResearchNote) {
  if (!note.updatedAt || !Number.isFinite(Date.parse(note.updatedAt)))
    return note.date;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(note.updatedAt));
}

function noteTitle(text: string) {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part && !/^```/.test(part)) ?? '';
  const clean = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
  return clean.length > 36 ? clean.slice(0, 36) + '…' : clean || '未命名笔记';
}

function entryDateLabel(value?: string) {
  if (!isResearchDate(value)) return '每日心得';
  const [year, month, day] = value!.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

export default function ResearchNotesDrawer({
  open,
  initialCompany,
  openRequest,
  onClose,
  companies,
  notes,
  ready,
  error,
  onClearError,
  onSave,
  onRemove,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [category, setCategory] = useState<NoteKind>('company');
  const [drafts, setDrafts] = useState<Record<NoteKind, Draft | null>>({
    company: null,
    daily: null,
  });
  const [draftsReady, setDraftsReady] = useState(false);
  const draft = drafts[category];
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [draftError, setDraftError] = useState('');
  const [editing, setEditing] = useState(false);
  const [resumingDraft, setResumingDraft] = useState(false);
  const [preview, setPreview] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [unavailableNote, setUnavailableNote] = useState(false);
  const [renaming, setRenaming] = useState<ResearchNote | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const renamingInput = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLTextAreaElement>(null);
  const creating = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    for (const kind of ['company', 'daily'] as const)
      try {
        const saved = JSON.parse(
          personalStorage.getItem(
            kind === 'daily' ? DAILY_NOTE_DRAFT_KEY : RESEARCH_NOTE_DRAFT_KEY,
          ) ?? 'null',
        );
        if (
          saved &&
          typeof saved.text === 'string' &&
          (saved.kind ?? 'company') === kind &&
          (kind !== 'daily' || isResearchDate(saved.entryDate)) &&
          (saved.title === undefined || typeof saved.title === 'string') &&
          (saved.company === null ||
            (typeof saved.company?.symbol === 'string' &&
              typeof saved.company?.code === 'string' &&
              typeof saved.company?.name === 'string')) &&
          (!saved.id ||
            (typeof saved.id === 'string' &&
              parseResearchNotes([saved.expected])[0]?.id === saved.id))
        )
          setDrafts((previous) => ({
            ...previous,
            [kind]: { ...saved, kind },
          }));
      } catch {}
    setDraftsReady(true);
  }, []);
  useEffect(() => {
    // Do not let a fresh create request overwrite a draft still being restored.
    if (!open || !ready || !draftsReady) return;
    setQuery('');
    setPendingDelete(null);
    setRenaming(null);
    setPreview(false);
    setResumingDraft(false);
    setUnavailableNote(false);
    const requestedNote = openRequest?.noteId
      ? notes.find((note) => note.id === openRequest.noteId)
      : undefined;
    const nextCategory = requestedNote
      ? researchNoteKind(requestedNote)
      : (openRequest?.kind ??
        (initialCompany
          ? 'company'
          : category));
    const targetNote = requestedNote;
    const company = nextCategory === 'company' ? initialCompany : null;
    const targetSymbol = targetNote ? researchNoteSymbol(targetNote) : '';
    setCategory(nextCategory);
    setCompanyFilter(targetSymbol || company?.symbol || 'all');
    if (openRequest?.noteId !== undefined && !targetNote) {
      setActiveNoteId(null);
      setUnavailableNote(true);
      setEditing(false);
      return;
    }
    const latest =
      targetNote ??
      notes.find(
        (note) =>
          researchNoteKind(note) === nextCategory &&
          (!company || researchNoteSymbol(note) === company.symbol),
      );
    setActiveNoteId(latest?.id ?? null);
    const pending = drafts[nextCategory];
    const mode = openRequest?.mode ?? (openRequest?.noteId ? 'read' : undefined);
    if (mode === 'read') {
      // Reading another note never consumes or opens an unrelated draft.
      setEditing(false);
      return;
    }
    if (mode === 'create') {
      if (pending) {
        // Preserve the single draft per category and make its owner explicit.
        setCompanyFilter(pending.company?.symbol ?? 'all');
        setResumingDraft(true);
      } else {
        changeDraft(
          {
            kind: nextCategory,
            entryDate:
              nextCategory === 'daily' ? todayResearchDate() : undefined,
            company,
            text: nextCategory === 'company' ? openRequest?.initialText ?? '' : '',
            title: nextCategory === 'company' ? openRequest?.initialTitle ?? '' : '',
          },
          nextCategory,
        );
      }
      setEditing(true);
      return;
    }
    if (company && !latest && !pending) {
      changeDraft(
        { company, text: '', kind: 'company' },
        'company',
      );
      setEditing(true);
    } else {
      setEditing(
        !!pending &&
          (!company || pending.company?.symbol === company.symbol),
      );
    }
    // Opening from a company changes context without replacing an unsaved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCompany, ready, draftsReady, openRequest]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      setMaximized(false);
      if (element.open) element.close();
      return;
    }
    element.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (element.open) element.close();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (!editing) creating.current?.focus();
    else if (!preview && content.current) {
      if (category === 'daily' || draft?.company) content.current.focus();
      else
        dialog.current
          ?.querySelector<HTMLInputElement>('[role="combobox"]')
          ?.focus();
    }
    // Focus moves only when entering/leaving the editor, not while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, preview, category, openRequest?.token]);
  useEffect(() => {
    if (!open || editing || !activeNoteId) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`${titleId}-${activeNoteId}`)
        ?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, editing, activeNoteId, titleId, openRequest?.token]);
  useEffect(() => {
    if (renaming) {
      renamingInput.current?.focus();
      renamingInput.current?.select();
    }
  }, [renaming]);

  function changeDraft(next: Draft | null, target = category) {
    const saved = next ? { ...next, kind: target } : null;
    setDrafts((previous) => ({ ...previous, [target]: saved }));
    setDraftError('');
    try {
      const key =
        target === 'daily' ? DAILY_NOTE_DRAFT_KEY : RESEARCH_NOTE_DRAFT_KEY;
      if (saved) personalStorage.setItem(key, JSON.stringify(saved));
      else personalStorage.removeItem(key);
    } catch {
      setDraftError('草稿暂未保存到本机');
    }
  }
  const allCompanies = useMemo(() => {
    const map = new Map(companies.map((c) => [c.symbol, c]));
    if (initialCompany) map.set(initialCompany.symbol, initialCompany);
    for (const note of notes) {
      const symbol = researchNoteSymbol(note);
      if (symbol && !map.has(symbol))
        map.set(symbol, { symbol, code: note.code, name: note.name });
    }
    if (draft?.company && !map.has(draft.company.symbol))
      map.set(draft.company.symbol, draft.company);
    return [...map.values()];
  }, [companies, notes, draft?.company, initialCompany]);
  const noteCompanies = allCompanies.filter(
    (c) =>
      c.symbol === initialCompany?.symbol ||
      c.symbol === draft?.company?.symbol ||
      notes.some((note) => researchNoteSymbol(note) === c.symbol),
  );
  const activeFilter =
    companyFilter === 'all' ||
    noteCompanies.some((c) => c.symbol === companyFilter)
      ? companyFilter
      : 'all';
  const search = query.trim().toLowerCase();
  const categoryCounts = {
    company: notes.filter((note) => researchNoteKind(note) === 'company')
      .length,
    daily: notes.filter((note) => researchNoteKind(note) === 'daily').length,
  };
  const filtered = (unavailableNote ? [] : notes)
    .filter(
      (note) =>
        researchNoteKind(note) === category &&
        (category === 'daily' ||
          activeFilter === 'all' ||
          researchNoteSymbol(note) === activeFilter) &&
        `${note.name} ${note.code} ${note.title ?? ''} ${note.entryDate ?? ''} ${category === 'daily' ? entryDateLabel(note.entryDate) : ''} ${note.text}`
          .toLowerCase()
          .includes(search),
    )
    .sort((a, b) =>
      category === 'daily'
        ? (b.entryDate ?? '').localeCompare(a.entryDate ?? '') ||
          (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
        : 0,
    );
  const createLabel = draft
    ? category === 'company' && draft.company
      ? `继续${draft.company.name}草稿`
      : '继续草稿'
    : category === 'daily'
      ? '写心得'
      : '新建笔记';
  function switchCategory(next: NoteKind) {
    setUnavailableNote(false);
    if (next === category) return;
    setCategory(next);
    setQuery('');
    setPreview(false);
    setPendingDelete(null);
    setRenaming(null);
    setDraftError('');
    onClearError();
    setEditing(!!drafts[next]);
    setResumingDraft(!!drafts[next]);
    setActiveNoteId(
      notes.find((note) => researchNoteKind(note) === next)?.id ?? null,
    );
  }
  function newNote() {
    setUnavailableNote(false);
    onClearError();
    setPendingDelete(null);
    setRenaming(null);
    setPreview(false);
    setEditing(true);
    setResumingDraft(!!draft);
    if (draft) {
      if (category === 'company' && draft.company)
        setCompanyFilter(draft.company.symbol);
      return;
    }
    changeDraft({
      kind: category,
      entryDate: category === 'daily' ? todayResearchDate() : undefined,
      company:
        category === 'daily'
          ? null
          : (allCompanies.find((c) => c.symbol === activeFilter) ?? null),
      text: '',
      title: '',
    });
  }
  function edit(note: ResearchNote) {
    setUnavailableNote(false);
    onClearError();
    setPendingDelete(null);
    setRenaming(null);
    setEditing(true);
    setResumingDraft(!!draft);
    setPreview(false);
    if (draft) return;
    changeDraft({
      id: note.id,
      kind: researchNoteKind(note),
      entryDate: note.entryDate,
      company:
        researchNoteKind(note) === 'daily'
          ? null
          : {
              symbol: researchNoteSymbol(note),
              code: note.code,
              name: note.name,
            },
      text: note.text,
      title: note.title ?? '',
      expected: { ...note },
    });
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      !draft?.text.trim() ||
      (category === 'company' && !draft.company) ||
      (category === 'daily' && !isResearchDate(draft.entryDate))
    )
      return;
    const saved = onSave(
      {
        id: draft.id,
        kind: category,
        ...(category === 'daily'
          ? { entryDate: draft.entryDate }
          : draft.company!),
        text: draft.text,
        title: draft.title ?? '',
      },
      draft.expected,
    );
    if (saved) {
      changeDraft(null);
      setEditing(false);
      setPreview(false);
      setQuery('');
      if (category === 'company')
        setCompanyFilter(initialCompany ? researchNoteSymbol(saved) : 'all');
      setActiveNoteId(saved.id);
    }
  }
  function beginRename(note: ResearchNote) {
    if (draft) return;
    onClearError();
    setPendingDelete(null);
    setRenaming({ ...note });
    setRenameTitle(note.title?.trim() || noteTitle(note.text));
  }
  function saveRename(event: React.FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const saved = onSave(
      {
        id: renaming.id,
        kind: researchNoteKind(renaming),
        entryDate: renaming.entryDate,
        symbol: researchNoteSymbol(renaming),
        code: renaming.code,
        name: renaming.name,
        text: renaming.text,
        title: renameTitle,
      },
      renaming,
    );
    if (saved) {
      setRenaming(null);
      setActiveNoteId(saved.id);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="研究笔记"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
      className={`fixed inset-y-0 left-auto right-0 !m-0 h-[100dvh] max-h-none w-full ${maximized ? 'max-w-none' : 'max-w-[860px]'} overflow-hidden border-0 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/25 [&[open]]:flex [&[open]]:flex-col`}
    >
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-3 sm:px-6"
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button, input, select'))
            setMaximized(!maximized);
        }}
      >
        <div className="mr-auto flex min-w-0 items-center gap-3">
          <div
            role="tablist"
            aria-label="笔记分类"
            className="segmented"
          >
            {(['company', 'daily'] as const).map((kind) => (
              <button
                key={kind}
                id={`${titleId}-tab-${kind}`}
                type="button"
                role="tab"
                aria-label={kind === 'daily' ? '每日心得' : '公司笔记'}
                aria-selected={category === kind}
                aria-controls={`${titleId}-panel`}
                tabIndex={category === kind ? 0 : -1}
                className={`segment ${category === kind ? 'segment-active' : ''}`}
                onClick={() => switchCategory(kind)}
                onKeyDown={(event) => {
                  if (
                    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'company'
                      : event.key === 'End'
                        ? 'daily'
                        : kind === 'company'
                          ? 'daily'
                          : 'company';
                  switchCategory(next);
                  document
                    .getElementById(`${titleId}-tab-${next}`)
                    ?.focus();
                }}
              >
                {kind === 'daily' ? '每日心得' : '公司笔记'}
                <span aria-hidden="true" className="ml-1 text-xs text-slate-400">
                  {categoryCounts[kind]}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="contents sm:flex sm:shrink-0 sm:items-center sm:gap-2">
          {!editing && (
            <div className="order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto">
              <input
                aria-label="搜索研究笔记"
                className="input !h-8 !w-auto min-w-0 flex-1 sm:!w-44"
                placeholder={
                  category === 'daily'
                    ? '搜索日期、标题或正文'
                    : '搜索公司、代码或笔记内容'
                }
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setUnavailableNote(false);
                  setPendingDelete(null);
                }}
              />
              {category === 'company' && (
                <select
                  aria-label="笔记公司筛选"
                  className="input !h-8 !w-28"
                  value={activeFilter}
                  onChange={(event) => {
                    setCompanyFilter(event.target.value);
                    setUnavailableNote(false);
                    setPendingDelete(null);
                  }}
                >
                  <option value="all">全部公司</option>
                  {noteCompanies.map((c) => (
                    <option key={c.symbol} value={c.symbol}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {!editing && (
            <button
              ref={creating}
              type="button"
              disabled={!ready}
              aria-label={createLabel}
              title={createLabel}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              onClick={newNote}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <path d="M5 12h14M12 5v14" />
              </svg>
            </button>
          )}
          {!editing && (
            <button
              type="button"
              aria-label={directoryOpen ? '收起目录' : '展开目录'}
              title={directoryOpen ? '收起目录' : '展开目录'}
              className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 sm:inline-flex"
              onClick={() => setDirectoryOpen((open) => !open)}
            >
              {directoryOpen ? (
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                  <path d="M3 6h18M3 12h18M3 18h18" />
                </svg>
              ) : (
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            aria-label="关闭研究笔记"
            title="关闭"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div
        id={`${titleId}-panel`}
        role="tabpanel"
        aria-labelledby={`${titleId}-tab-${category}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {editing && draft ? (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="mx-auto min-h-0 w-full max-w-[944px] flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              <div className="mb-6 flex items-center justify-between gap-3">
                <h3 className="font-medium text-slate-900">
                  {resumingDraft
                    ? category === 'company' && draft.company
                      ? `继续${draft.company.name}草稿`
                      : category === 'daily'
                        ? `继续${entryDateLabel(draft.entryDate)}心得草稿`
                        : '继续草稿'
                    : draft.id
                    ? category === 'daily'
                      ? '编辑心得'
                      : '编辑笔记'
                    : category === 'daily'
                      ? '写心得'
                      : '新建笔记'}
                </h3>
                <div
                  className="flex rounded-md bg-slate-100 p-1 text-sm"
                  role="group"
                  aria-label="笔记编辑模式"
                >
                  <button
                    type="button"
                    aria-pressed={!preview}
                    className={`rounded px-3 py-1 ${!preview ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500'}`}
                    onClick={() => setPreview(false)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    aria-pressed={preview}
                    className={`rounded px-3 py-1 ${preview ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500'}`}
                    onClick={() => setPreview(true)}
                  >
                    预览
                  </button>
                </div>
              </div>
              {category === 'daily' ? (
                <div className="mb-5 flex items-center gap-3">
                  <label
                    className="shrink-0 text-xs text-slate-500"
                    htmlFor={`${titleId}-entry-date`}
                  >
                    心得日期
                  </label>
                  <input
                    id={`${titleId}-entry-date`}
                    type="date"
                    aria-label="心得日期"
                    required
                    className="input !w-44"
                    value={draft.entryDate ?? ''}
                    onChange={(event) =>
                      changeDraft({ ...draft, entryDate: event.target.value })
                    }
                  />
                </div>
              ) : (
                <div className="mb-5 space-y-2">
                  <label className="text-xs text-slate-500">关联公司</label>
                  <NoteCompanyPicker
                    companies={allCompanies}
                    value={draft.company}
                    onChange={(company) => changeDraft({ ...draft, company })}
                  />
                </div>
              )}
              <div className="mb-5 space-y-2">
                <label
                  className="text-xs text-slate-500"
                  htmlFor={`${titleId}-note-title`}
                >
                  标题（可选）
                </label>
                <input
                  id={`${titleId}-note-title`}
                  aria-label="笔记标题（可选）"
                  className="input"
                  placeholder="留空则取正文首行"
                  value={draft.title ?? ''}
                  onChange={(event) =>
                    changeDraft({ ...draft, title: event.target.value })
                  }
                />
              </div>
              <label
                className="mb-2 block text-xs text-slate-500"
                htmlFor={preview ? undefined : `${titleId}-content`}
              >
                笔记内容
              </label>
              {preview ? (
                <div
                  aria-label="笔记内容预览"
                  className="h-[420px] overflow-y-auto rounded-lg border border-slate-200 px-4 py-3"
                >
                  {draft.text.trim() ? (
                    <NoteBody text={draft.text} />
                  ) : (
                    <p className="text-sm text-slate-400">暂无内容</p>
                  )}
                </div>
              ) : (
                <textarea
                  ref={content}
                  id={`${titleId}-content`}
                  aria-label="研究笔记内容"
                  placeholder={
                    category === 'daily'
                      ? '记录今天的思考、复盘与收获'
                      : '记录投资逻辑、估值假设或待验证的问题'
                  }
                  value={draft.text}
                  onChange={(event) =>
                    changeDraft({ ...draft, text: event.target.value })
                  }
                  className="input h-[420px] resize-none overflow-y-auto !px-4 !py-3 !text-sm font-mono leading-7 focus-visible:!outline-none"
                />
              )}
              {(error || draftError) && (
                <p role="alert" className="mt-3 text-sm text-red-600">
                  {error || draftError}
                </p>
              )}
            </div>
            <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3 sm:px-6">
              <div className="mx-auto flex max-w-4xl justify-end gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    changeDraft(null);
                    setEditing(false);
                    setPreview(false);
                    onClearError();
                  }}
                >
                  取消编辑
                </button>
                <button
                  type="submit"
                  disabled={
                    !ready ||
                    (category === 'daily'
                      ? !isResearchDate(draft.entryDate)
                      : !draft.company) ||
                    !draft.text.trim()
                  }
                  className="btn-primary"
                >
                  {draft.id
                    ? '保存修改'
                    : category === 'daily'
                      ? '保存心得'
                      : '保存笔记'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <>
            {error && (
              <p role="alert" className="px-6 pt-3 text-sm text-red-600">
                {error}
              </p>
            )}
            <div className="flex min-h-0 flex-1">
              {directoryOpen && !unavailableNote && (
                <aside
                  id={`${titleId}-directory`}
                  aria-label="笔记目录"
                  className="hidden w-60 shrink-0 overflow-y-auto border-r border-slate-100 p-3 sm:block"
                >
                  {filtered.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      aria-current={
                        activeNoteId === note.id ? 'true' : undefined
                      }
                      className={`mb-1 block w-full rounded-lg px-3 py-3 text-left text-sm ${activeNoteId === note.id ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
                      onDoubleClick={() => beginRename(note)}
                      onClick={() => {
                        setActiveNoteId(note.id);
                        document
                          .getElementById(`${titleId}-${note.id}`)
                          ?.scrollIntoView({ block: 'start' });
                      }}
                    >
                      <span className="mb-1 block truncate font-medium">
                        {category === 'daily'
                          ? entryDateLabel(note.entryDate)
                          : note.name}
                      </span>
                      <span className="block truncate text-xs opacity-75">
                        {note.title?.trim() || noteTitle(note.text)}
                      </span>
                    </button>
                  ))}
                </aside>
              )}
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 sm:px-6">
                {unavailableNote ? (
                  <div className="space-y-3 py-16 text-center text-sm">
                    <p role="status" className="text-slate-500">
                      该笔记已不可用
                    </p>
                    <button
                      type="button"
                      className="text-brand-700 hover:underline"
                      onClick={() => {
                        setUnavailableNote(false);
                        setCompanyFilter('all');
                        setQuery('');
                        setActiveNoteId(null);
                      }}
                    >
                      查看全部笔记
                    </button>
                  </div>
                ) : filtered.length ? (
                  filtered.map((note) => (
                    <article
                      key={note.id}
                      id={`${titleId}-${note.id}`}
                      className="mx-auto max-w-4xl scroll-mt-4 border-b border-slate-100 py-5 last:border-b-0"
                    >
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                        {category === 'daily' ? (
                          <time
                            dateTime={note.entryDate}
                            className="text-sm font-medium text-slate-800"
                          >
                            {entryDateLabel(note.entryDate)}
                          </time>
                        ) : (
                          <StockLink
                            href={`/stock/${researchNoteSymbol(note) || note.code}`}
                            prefetch={false}
                            onClick={onClose}
                            className="font-medium hover:text-brand-700"
                          >
                            {note.name}
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              {note.code}
                            </span>
                          </StockLink>
                        )}
                        <div className="flex items-center gap-3 text-xs">
                          <button
                            type="button"
                            aria-label={
                              category === 'daily'
                                ? '重命名每日心得'
                                : `重命名${note.name}笔记`
                            }
                            disabled={!!draft}
                            className="text-slate-500 hover:text-brand-700 disabled:opacity-40"
                            onClick={() => beginRename(note)}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            aria-label={
                              category === 'daily'
                                ? '编辑每日心得'
                                : `编辑${note.name}笔记`
                            }
                            disabled={!!draft && draft.id !== note.id}
                            title={
                              draft && draft.id !== note.id
                                ? '先保存或取消当前草稿'
                                : undefined
                            }
                            className="text-slate-500 hover:text-brand-700 disabled:opacity-40"
                            onClick={() => edit(note)}
                          >
                            编辑
                          </button>
                          {pendingDelete === note.id ? (
                            <>
                              <button
                                type="button"
                                className="text-slate-500"
                                onClick={() => setPendingDelete(null)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="text-red-600"
                                onClick={() => {
                                  if (onRemove(note.id)) setPendingDelete(null);
                                }}
                              >
                                确认删除
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              aria-label={
                                category === 'daily'
                                  ? '删除每日心得'
                                  : `删除${note.name}笔记`
                              }
                              disabled={draft?.id === note.id}
                              className="text-slate-400 hover:text-red-600 disabled:opacity-40"
                              onClick={() => setPendingDelete(note.id)}
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>
                      {renaming?.id === note.id ? (
                        <form
                          onSubmit={saveRename}
                          aria-label="重命名笔记"
                          className="mb-4 flex flex-wrap items-center gap-2"
                        >
                          <input
                            ref={renamingInput}
                            aria-label="新笔记标题"
                            className="input min-w-0 flex-1"
                            value={renameTitle}
                            onChange={(event) =>
                              setRenameTitle(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                setRenaming(null);
                              }
                            }}
                          />
                          <button type="submit" className="btn-primary">
                            保存标题
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setRenaming(null)}
                          >
                            取消
                          </button>
                        </form>
                      ) : note.title?.trim() ? (
                        <h3 className="mb-3 text-base font-semibold text-slate-900">
                          {note.title}
                        </h3>
                      ) : null}
                      <NoteBody text={note.text} />
                      <time className="mt-3 block text-[11px] text-slate-400">
                        {noteTime(note)}
                      </time>
                    </article>
                  ))
                ) : (
                  <div className="py-16 text-center text-sm text-slate-400">
                    {ready
                      ? query ||
                        (category === 'company' && activeFilter !== 'all')
                        ? category === 'daily'
                          ? '没有匹配的心得'
                          : '没有匹配的笔记'
                        : category === 'daily'
                          ? '暂无每日心得'
                          : '暂无研究笔记'
                      : '正在读取笔记'}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
