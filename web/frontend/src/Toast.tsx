import { useCallback, useRef, useState } from "react";

export interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "success" | "error";
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const pushToast = useCallback((message: string, tone: ToastItem["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  return { toasts, pushToast };
}

export function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast tone-${toast.tone}`}>
          <span className="toast-dot" aria-hidden="true" />
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
