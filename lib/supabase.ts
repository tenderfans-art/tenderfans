import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const hybridStorage = {
  getItem(key: string) {
    if (typeof window === "undefined") return null;

    return (
      window.localStorage.getItem(key) ??
      window.sessionStorage.getItem(key)
    );
  },

  setItem(key: string, value: string) {
    if (typeof window === "undefined") return;

    const remember =
      window.localStorage.getItem("tf_remember_me") === "1";

    if (remember) {
      window.sessionStorage.removeItem(key);
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
      window.sessionStorage.setItem(key, value);
    }
  },

  removeItem(key: string) {
    if (typeof window === "undefined") return;

    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    storage: hybridStorage,
  },
});
