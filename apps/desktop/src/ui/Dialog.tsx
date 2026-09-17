import { useEffect, useRef } from "react";
import { X } from "lucide-react";
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog?.showModal();
    Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not(:disabled),textarea:not(:disabled),select:not(:disabled)',
      ) ?? [],
    )
      .find((element) => element.getClientRects().length > 0)
      ?.focus();
    return () => {
      const focused = document.activeElement;
      const restore =
        !focused || focused === document.body || !!dialog?.contains(focused);
      dialog?.close();
      if (restore && opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (
          e.target === e.currentTarget &&
          (e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom)
        )
          onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
