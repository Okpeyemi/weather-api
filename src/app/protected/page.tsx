import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import SignOutButton from "@/components/SignOutButton";

export default async function ProtectedPage() {
  const supabase = createServerComponentClient({ cookies });
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect("/login");
  }

  const user = session.user;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold">Espace protégé</h1>
        <p className="text-sm text-gray-600">
          Connecté en tant que <span className="font-medium">{user.email}</span>
        </p>
        <SignOutButton />
      </div>
    </div>
  );
}
