'use client';
import { useState } from 'react';
import Modal from './Modal';
import OrderButtons from './OrderButtons';
import {
  RESEARCH_COLUMNS,
  defaultResearchTable,
  type ResearchColumnId,
} from '@/lib/researchColumns';

export default function ResearchColumns({
  columns,
  onSave,
  onClose,
}: {
  columns: ResearchColumnId[];
  onSave: (columns: ResearchColumnId[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(columns);
  const options = [
    ...draft,
    ...RESEARCH_COLUMNS.map((c) => c.id).filter((id) => !draft.includes(id)),
  ];
  return (
    <Modal open title="自定义表头" onClose={onClose}>
      <div className="space-y-1">
        {options.map((id) => {
          const column = RESEARCH_COLUMNS.find((c) => c.id === id)!;
          const index = draft.indexOf(id);
          return (
            <div
              key={id}
              className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-slate-50"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={index >= 0}
                  onChange={(e) =>
                    setDraft((prev) =>
                      e.target.checked
                        ? [...prev, id]
                        : prev.filter((key) => key !== id),
                    )
                  }
                  className="accent-blue-600"
                />
                {column.label}
              </label>
              {index >= 0 && (
                <OrderButtons
                  name={`列${column.label}`}
                  first={index === 0}
                  last={index === draft.length - 1}
                  onMove={(delta) =>
                    setDraft((prev) => {
                      const next = [...prev];
                      next.splice(index + delta, 0, next.splice(index, 1)[0]);
                      return next;
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          className="mr-auto text-xs text-slate-500 hover:text-brand-700"
          onClick={() => setDraft(defaultResearchTable().columns)}
        >
          恢复默认
        </button>
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}
