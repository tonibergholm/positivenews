// middleware.ts
import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isLoginPage = req.nextUrl.pathname === "/admin/login";
  if (!req.auth && !isLoginPage) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/admin/login";
    return NextResponse.redirect(loginUrl);
  }
});

export const config = {
  // Middleware matchers use paths without the basePath prefix
  matcher: ["/admin/:path*"],
};
