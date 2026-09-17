export type LogEvent = {
  ts: string;
  level: "info" | "warn" | "error";
  type: string;
  dryRun: boolean;
  details: Record<string, unknown>;
};

const RING: LogEvent[] = [];
const MAX = 200;

export function logEvent(
  type: string,
  details: Record<string, unknown>,
  opts?: { level?: LogEvent["level"]; dryRun?: boolean }
): LogEvent {
  const event: LogEvent = {
    ts: new Date().toISOString(),
    level: opts?.level || "info",
    type,
    dryRun: opts?.dryRun ?? true,
    details,
  };
  RING.unshift(event);
  if (RING.length > MAX) RING.pop();
  const line = JSON.stringify({ source: "fna-app", ...event });
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else console.log(line);
  return event;
}

export function recentEvents(limit = 50): LogEvent[] {
  return RING.slice(0, limit);
}
