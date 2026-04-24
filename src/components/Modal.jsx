import { useEffect } from 'react';

export default function Modal({ open, title, children, onClose, zIndex = 50 }) {
  useEffect(() => {
    if (!open) return undefined;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow || '';
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 overflow-y-auto bg-slate-950/80 p-4"
      style={{ zIndex }}
      onClick={onClose}
    >
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-[2rem] border border-slate-700 bg-slate-900 shadow-2xl max-h-[calc(100vh-4rem)]"
           onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <h2 className="text-xl font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-3xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
          >
            Закрити
          </button>
        </div>
        <div className="max-h-[calc(100vh-11rem)] overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}
