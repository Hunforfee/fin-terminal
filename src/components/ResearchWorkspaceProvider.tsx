'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { researchNoteSymbol } from '@/lib/researchNotes';
import { normalizeStockCode } from '@/lib/datasource/codes';
import useResearchNotes from './useResearchNotes';
import ResearchNotesDrawer from './ResearchNotesDrawer';
import type { NoteCompany } from './NoteCompanyPicker';
import { useWatchlist } from './WatchlistProvider';

interface ResearchWorkspaceContext {
  notebook: ReturnType<typeof useResearchNotes>;
  notesOpen: boolean;
  openNotes: (company?: NoteCompany | null) => void;
  setNoteCompanies: Dispatch<SetStateAction<NoteCompany[]>>;
}

const Context = createContext<ResearchWorkspaceContext | null>(null);

/** Kept inside AccountProvider's keyed subtree so notes and drafts remain account scoped. */
export default function ResearchWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const notebook = useResearchNotes();
  const { codes } = useWatchlist();
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteContext, setNoteContext] = useState<NoteCompany | null>(null);
  const [noteCompanies, setNoteCompanies] = useState<NoteCompany[]>([]);
  const openNotes = useCallback((company?: NoteCompany | null) => {
    setNoteContext(company ?? null);
    setNotesOpen(true);
  }, []);
  const closeNotes = useCallback(() => setNotesOpen(false), []);

  const companies = useMemo(() => {
    const bySymbol = new Map<string, NoteCompany>();
    const addCompany = (input: string, name = '') => {
      const stock = normalizeStockCode(input);
      if (!stock) return;
      const existing = bySymbol.get(stock.symbol);
      const knownName = name.trim();
      // A code-only fallback must not hide a name already known on another page.
      if (
        existing &&
        (existing.name !== stock.code ||
          !knownName ||
          knownName === stock.symbol)
      )
        return;
      bySymbol.set(stock.symbol, {
        symbol: stock.symbol,
        code: stock.code,
        name: knownName && knownName !== stock.symbol ? knownName : stock.code,
      });
    };
    for (const company of noteCompanies)
      addCompany(company.symbol || company.code, company.name);
    // Existing notes remain accessible on pages without ResearchDesk's quote list.
    for (const note of notebook.notes) {
      const symbol = researchNoteSymbol(note);
      if (symbol) addCompany(symbol, note.name);
    }
    if (noteContext)
      addCompany(noteContext.symbol || noteContext.code, noteContext.name);
    // Global navigation has no quote registration until the desk is visited.
    // Stock codes still provide local choices without requesting more quotes.
    for (const code of codes) addCompany(code);
    return [...bySymbol.values()];
  }, [noteCompanies, notebook.notes, noteContext, codes]);

  const value = useMemo(
    () => ({ notebook, notesOpen, openNotes, setNoteCompanies }),
    [notebook, notesOpen, openNotes],
  );
  return (
    <Context.Provider value={value}>
      {children}
      <ResearchNotesDrawer
        open={notesOpen}
        initialCompany={noteContext}
        onClose={closeNotes}
        companies={companies}
        notes={notebook.notes}
        ready={notebook.ready}
        error={notebook.error}
        onClearError={notebook.clearError}
        onSave={notebook.save}
        onRemove={notebook.remove}
      />
    </Context.Provider>
  );
}

export function useResearchWorkspace(): ResearchWorkspaceContext {
  const workspace = useContext(Context);
  if (!workspace) throw Error('缺少 ResearchWorkspaceProvider');
  return workspace;
}
