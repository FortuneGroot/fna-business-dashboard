import type { ReactNode } from "react";

/** Shared presentational components for the F&A Business Dashboard.
 * Keep these dumb/reusable — pages compose them, they never fetch data
 * themselves. Never fabricate values here; callers pass "—" or an
 * EmptyState when data isn't connected. */

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`card ${className}`.trim()}>
      {(title || action) && (
        <div className="card-head">
          {title ? <h3>{title}</h3> : <span />}
          {action}
        </div>
      )}
      {children}
    </article>
  );
}

export function MetricTile({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string;
  note?: string;
  icon?: ReactNode;
}) {
  return (
    <article className="card metric-tile">
      <div className="metric-tile-top">
        <span className="metric-label">{label}</span>
        {icon ? <span className="metric-tile-icon">{icon}</span> : null}
      </div>
      <div className="metric">{value}</div>
      {note ? <p className="metric-note">{note}</p> : null}
    </article>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "gold";
}) {
  const cls = tone === "gold" ? "" : tone;
  return <span className={`badge ${cls}`.trim()}>{children}</span>;
}

export function EmptyState({
  title,
  note,
  action,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {note ? <span>{note}</span> : null}
      {action}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  size,
  href,
  onClick,
  type = "button",
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "gold" | "secondary" | "ghost";
  size?: "sm";
  href?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const cls = ["btn", variant === "primary" ? "" : variant, size ?? ""].filter(Boolean).join(" ");
  if (href) {
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    return (
      <a className={cls} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function QuickActions({ children }: { children: ReactNode }) {
  return <div className="quick-actions">{children}</div>;
}

export function DataTable({
  columns,
  rows,
  emptyTitle = "Nothing here yet",
  emptyNote,
}: {
  columns: string[];
  rows: ReactNode[][];
  emptyTitle?: string;
  emptyNote?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} note={emptyNote} />;
  }
  return (
    <div className="table-wrap">
      <table className="dtable">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i}>
              {row.map((cell, j) => (
                // eslint-disable-next-line react/no-array-index-key
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PageHead({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
