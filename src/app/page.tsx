import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getAuthSecret, verifySessionToken } from "@/lib/auth";

export default async function HomePage() {
  const secret = getAuthSecret();
  if (!secret) {
    redirect("/login");
  }
  const jar = await cookies();
  const token = jar.get(AUTH_COOKIE)?.value;
  if (token && verifySessionToken(token, secret)) {
    redirect("/dashboard");
  }
  redirect("/login");
}
