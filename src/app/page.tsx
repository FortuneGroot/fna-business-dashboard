import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getAuthSecret, mustProtectRoutes, verifySessionToken } from "@/lib/auth";

export default async function HomePage() {
  const secret = getAuthSecret();
  if (!secret) {
    if (mustProtectRoutes()) {
      redirect("/login?error=auth_misconfigured");
    }
    redirect("/login");
  }
  const jar = await cookies();
  const token = jar.get(AUTH_COOKIE)?.value;
  if (token && (await verifySessionToken(token, secret))) {
    redirect("/dashboard");
  }
  redirect("/login");
}
