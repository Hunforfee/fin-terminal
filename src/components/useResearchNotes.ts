'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getStorageAccount,
  personalStorage,
  storageKey,
} from '@/lib/personalStorage';
import {
  RESEARCH_NOTES_KEY,
  ResearchNotesError,
  readResearchNotes,
  removeResearchNote,
  saveResearchNote,
  type ResearchNote,
  type ResearchNoteInput,
} from '@/lib/researchNotes';

export default function useResearchNotes() {
  const [notes, setNotes] = useState<ResearchNote[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const account = useRef(getStorageAccount());

  const clearError = useCallback(() => setError(''), []);
  useEffect(() => {
    function load() {
      if (getStorageAccount() !== account.current) return;
      try {
        setNotes(
          readResearchNotes(personalStorage.getItem(RESEARCH_NOTES_KEY)),
        );
        setError('');
      } catch {
        setError('笔记数据读取失败，原记录已保留');
      } finally {
        setReady(true);
      }
    }
    load();
    const stored = (event: StorageEvent) => {
      if (getStorageAccount() !== account.current) return;
      if (
        event.key !== null &&
        event.key !== storageKey(RESEARCH_NOTES_KEY, account.current)
      )
        return;
      if (event.storageArea && event.storageArea !== window.localStorage)
        return;
      load();
    };
    window.addEventListener('storage', stored);
    return () => window.removeEventListener('storage', stored);
  }, []);

  const storage = useCallback(() => {
    if (getStorageAccount() !== account.current)
      throw new ResearchNotesError('账号已切换，请重新打开笔记');
    return {
      read: () => personalStorage.getItem(RESEARCH_NOTES_KEY),
      write: (raw: string) => personalStorage.setItem(RESEARCH_NOTES_KEY, raw),
    };
  }, []);

  const save = useCallback(
    (
      input: ResearchNoteInput,
      expected?: ResearchNote,
    ): ResearchNote | null => {
      try {
        const saved = saveResearchNote(storage(), input, expected);
        setNotes(saved.notes);
        setError('');
        return saved.note;
      } catch (failure) {
        setError(
          failure instanceof ResearchNotesError
            ? failure.message
            : '笔记未保存，请检查浏览器存储空间',
        );
        return null;
      }
    },
    [storage],
  );
  const remove = useCallback(
    (id: string): boolean => {
      try {
        const next = removeResearchNote(storage(), id);
        setNotes(next);
        setError('');
        return true;
      } catch (failure) {
        setError(
          failure instanceof ResearchNotesError
            ? failure.message
            : '笔记未删除，请检查浏览器存储空间',
        );
        return false;
      }
    },
    [storage],
  );

  return { notes, ready, error, clearError, save, remove };
}
