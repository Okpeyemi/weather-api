"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const onClick = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    setLoading(false);
    router.push("/login");
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="border rounded px-3 py-2"
    >
      {loading ? "Déconnexion..." : "Se déconnecter"}
    </button>
  );
}
