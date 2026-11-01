import type { NextRequest } from "next/server";
import { appOrigin, parseBody, parseQuery } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { provisionBody, provisionWorkspace, searchWorkspaces, workspaceQuery } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return platformApi(req, {}, async (scope) => searchWorkspaces(scope, parseQuery(req, workspaceQuery)));
}

export async function POST(req: NextRequest) {
  return platformApi(req, { sensitive: true }, async (scope) =>
    provisionWorkspace(scope, await parseBody(req, provisionBody), appOrigin(req)));
}
