"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { recordAdminDecision } from "@/src/lib/article-decisions";

export async function unrejectArticle(id: string): Promise<void> {
  const session = await auth();
  if (!session) redirect("/admin/login");
  await recordAdminDecision(id, "keep", { bucket: "manual", actor: session.user?.email ?? null });
  revalidatePath("/admin/rejections");
  revalidatePath("/admin/review");
  revalidatePath("/");
}
