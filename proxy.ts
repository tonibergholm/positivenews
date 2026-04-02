import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  const cookieNames = [...request.cookies.getAll().map((c) => c.name)];
  console.error("[proxy:debug] cookies:", cookieNames);
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
  });
  console.error("[proxy:debug] token:", !!token);

  // Use endsWith to handle both "/admin/login" and "/news/admin/login" regardless
  // of whether Next.js includes the basePath in nextUrl.pathname
  const isLoginPage = request.nextUrl.pathname.endsWith("/admin/login");

  if (!token && !isLoginPage) {
    // Construct redirect from raw request.url (always includes origin + basePath)
    return NextResponse.redirect(new URL("/news/admin/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Matchers use paths without the basePath prefix
  matcher: ["/admin/:path*"],
};
