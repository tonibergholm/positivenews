"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/src/lib/prisma";

async function requireAdmin() {
  const session = await auth();
  if (!session) redirect("/admin/login");
}

export async function unrejectArticle(id: string): Promise<void> {
  await requireAdmin();
  await prisma.article.update({
    where: { id },
    data: {
      isPositive: true,
      rejectionReason: null,
      rejectionPass: null,
      curatedAt: new Date(),
    },
  });
  revalidatePath("/admin/rejections");
  revalidatePath("/");
}
