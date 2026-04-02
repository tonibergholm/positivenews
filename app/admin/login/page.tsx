// app/admin/login/page.tsx
import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="max-w-sm mx-auto py-16">
      <h1 className="font-heading text-2xl font-semibold text-foreground mb-2">
        Admin
      </h1>
      <p className="text-sm text-muted-foreground mb-8">
        Sign in to manage the pipeline.
      </p>

      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400 mb-4">
          Invalid email or password.
        </p>
      )}

      <form
        action={async (formData: FormData) => {
          "use server";
          let success = false;
          try {
            await signIn("credentials", {
              email: formData.get("email"),
              password: formData.get("password"),
              redirect: false,
            });
            success = true;
          } catch (e) {
            if (e instanceof AuthError) {
              redirect(`/admin/login?error=1`);
            }
            throw e;
          }
          if (success) redirect("/admin");
        }}
        className="space-y-4"
      >
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
