// app/admin/keywords/actions.ts
"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/src/lib/prisma";
import redis from "@/src/lib/redis";

async function requireAdmin() {
  const session = await auth();
  if (!session) redirect("/admin/login");
}

async function invalidateKeywordCaches() {
  await Promise.allSettled([
    redis.del("learned:keywords:en"),
    redis.del("learned:keywords:fi"),
  ]);
}

export async function activateKeyword(id: string) {
  await requireAdmin();
  await prisma.learnedKeyword.update({
    where: { id },
    data: { active: true },
  });
  await invalidateKeywordCaches();
  revalidatePath("/admin/keywords");
}

export async function deactivateKeyword(id: string) {
  await requireAdmin();
  await prisma.learnedKeyword.update({
    where: { id },
    data: { active: false },
  });
  await invalidateKeywordCaches();
  revalidatePath("/admin/keywords");
}

export async function deleteKeyword(id: string) {
  await requireAdmin();
  const kw = await prisma.learnedKeyword.findUnique({ where: { id } });
  if (!kw) return;
  await prisma.$transaction([
    prisma.learnedKeywordFlag.deleteMany({
      where: { keyword: kw.keyword, language: kw.language },
    }),
    prisma.learnedKeyword.delete({ where: { id } }),
  ]);
  await invalidateKeywordCaches();
  revalidatePath("/admin/keywords");
}

export async function addKeyword(
  keyword: string,
  language: string
): Promise<{ error: string } | undefined> {
  await requireAdmin();
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) return { error: "Keyword cannot be empty" };
  if (language !== "en" && language !== "fi") return { error: "Invalid language" };

  try {
    await prisma.learnedKeyword.create({
      data: { keyword: trimmed, language, active: true, hits: 0, uniqueIps: 0 },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return { error: "Keyword already exists" };
    }
    throw e;
  }

  await invalidateKeywordCaches();
  revalidatePath("/admin/keywords");
}
