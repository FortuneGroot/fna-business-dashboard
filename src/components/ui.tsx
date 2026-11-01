import type { ReactNode } from "react";
import Link from "next/link";

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
          {title ? <h2 className="card-title">{title}</h2> : <span />}
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
  href,
}: {
  label: string;
  value: string;
  note?: string;
  icon?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <div className="metric-tile-top">
        <span className="metric-label">{label}</span>
        {icon ? <span className="metric-tile-icon" aria-hidden="true">{icon}</span> : null}
      </div>
      <div className="metric">{value}</div>
      {note ? <p className="metric-note">{note}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link className="card metric-tile metric-tile-link" href={href} aria-label={`${label}: ${value}`}>
        {body}
      </Link>
    );
  }

  return <article className="card metric-tile">{body}</article>;
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
    <div className="empty" role="status">
      <strong>{title}</strong>
      {note ? <span>{note}</span> : null}
      {action}
    </div>
  );
}

function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

export function Button({
  children,
  variant = "primary",
  size,
  href,
  onClick,
  type = "button",
  disabled,
  "aria-pressed": ariaPressed,
}: {
  children: ReactNode;
  variant?: "primary" | "gold" | "secondary" | "ghost";
  size?: "sm";
  href?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  "aria-pressed"?: boolean;
}) {
  const cls = ["btn", variant === "primary" ? "" : variant, size ?? ""].filter(Boolean).join(" ");
  if (href && !disabled) {
    if (isInternalHref(href)) {
      return (
        <Link className={cls} href={href}>
          {children}
        </Link>
      );
    }
    return (
      <a className={cls} href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  }
  return (
    <button
      className={cls}
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={ariaPressed}
    >
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
              <th key={c} scope="col">
                {c}
              </th>
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

export { Modal } from "./Modal";

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

export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner error" role="alert">
      <strong>Couldn’t load this view.</strong> {message}
      {onRetry ? (
        <div style={{ marginTop: "0.6rem" }}>
          <button type="button" className="btn secondary sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
