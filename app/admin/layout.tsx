// app/admin/layout.tsx
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/src/lib/prisma";

async function getPendingKeywordCount(): Promise<number> {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  return prisma.learnedKeyword.count({
    where: { active: false, hits: { gte: minHits }, uniqueIps: { gte: minIps } },
  });
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect("/admin/login");

  const pendingCount = await getPendingKeywordCount().catch(() => 0);

  return (
    <div>
      <div className="border-b border-border/60 bg-secondary/40 mb-6 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-1 text-sm py-2 max-w-7xl mx-auto">
          <nav className="flex items-center gap-1 flex-1">
            <Link
              href="/admin"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Dashboard
            </Link>
            <Link
              href="/admin/keywords"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium flex items-center gap-1.5"
            >
              Keywords
              {pendingCount > 0 && (
                <span className="bg-amber-500 text-white rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold">
                  {pendingCount}
                </span>
              )}
            </Link>
            <Link
              href="/admin/rejections"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Rejections
            </Link>
            <Link
              href="/admin/flagged"
              className="px-3 py-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              Flagged
            </Link>
          </nav>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{session.user?.email}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/admin/login" });
              }}
            >
              <button
                type="submit"
                className="hover:text-foreground transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
