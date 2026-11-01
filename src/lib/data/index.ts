import "server-only";
import * as React from "react";
import { redirect } from "next/navigation";
import { authProvider } from "@/lib/auth/provider";
import type { DataScope } from "./query";
import type { DataSource } from "./types";

export type { DashboardReader, DataSource, WorkspaceCalendar, WorkspaceView } from "./types";
export { DataUnavailableError } from "./query";

type AnyFn = (...args: never[]) => unknown;
const cache: <T extends AnyFn>(fn: T) => T = (React as { cache?: <T extends AnyFn>(fn: T) => T }).cache ?? ((fn) => fn);

/**
 * Request-scoped data source for server components. With AUTH_PROVIDER=supabase it reads the active
 * workspace's native tables with the signed-in user's JWT (redirecting like requirePageContext when
 * there is no usable workspace); otherwise it is the frozen legacy snapshot and deployment identity.
 */
export const getPageData = cache(async (): Promise<DataSource> => {
  const provider = authProvider();
  if (provider === null) redirect("/login?error=auth_misconfigured");
  if (provider === "legacy") return (await import("./legacy")).legacyDataSource();
  const { getPageSupabase, requirePageContext } = await import("@/lib/authz/context");
  const { nativeDataSource } = await import("./native");
  const ctx = await requirePageContext();
  return nativeDataSource({ supabase: await getPageSupabase(), ctx });
});

/** AUTH_PROVIDER=supabase only: the page's user-JWT client and verified context (redirects like requirePageContext). */
export const getPageScope = cache(async (): Promise<DataScope> => {
  const { getPageSupabase, requirePageContext } = await import("@/lib/authz/context");
  const ctx = await requirePageContext();
  return { supabase: await getPageSupabase(), ctx };
});
