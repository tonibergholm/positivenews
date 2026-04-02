// auth.ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
        console.error("[auth:debug] email:", credentials?.email, "adminEmail:", adminEmail, "hash:", adminPasswordHash);
        if (!adminEmail || !adminPasswordHash) { console.error("[auth:debug] missing env vars"); return null; }
        if (credentials.email !== adminEmail) { console.error("[auth:debug] email mismatch"); return null; }
        const valid = await bcrypt.compare(
          credentials.password as string,
          adminPasswordHash
        );
        console.error("[auth:debug] bcrypt valid:", valid);
        if (!valid) return null;
        return { id: "admin", email: adminEmail, name: "Admin" };
      },
    }),
  ],
  pages: {
    signIn: "/admin/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
});
