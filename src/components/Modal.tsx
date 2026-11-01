"use client";

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog with keyboard support: focus moves into it on open (first field, else first control),
 * Tab stays inside, Escape closes from anywhere, and focus returns to the opener on close.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(card.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const fields = focusables().filter((el) => !el.classList.contains("modal-close"));
    (fields.find((el) => el.matches("input, select, textarea")) ?? fields[0] ?? focusables()[0] ?? card.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = card.current?.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    // A message shown at the top of a scrolled dialog (small screens) is brought into view.
    const alerts = new MutationObserver(() => {
      card.current?.querySelector<HTMLElement>('[role="alert"]')?.scrollIntoView({ block: "nearest" });
    });
    if (card.current) alerts.observe(card.current, { childList: true, subtree: true, characterData: true });
    return () => {
      alerts.disconnect();
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        ref={card}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close dialog" type="button">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
