import { useState, type FormEvent } from "react";
import { ApiError } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { usePageTitle } from "../usePageTitle.ts";
import { BrandLogo } from "../components/BrandLogo.tsx";

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle("Sign in");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink px-4">
      <div className="login-orb -left-24 -top-16 h-72 w-72 bg-electric/40" />
      <div className="login-orb -right-16 top-1/3 h-80 w-80 bg-cyan/25" style={{ animationDelay: "-3s" }} />
      <div className="login-orb bottom-0 left-1/3 h-64 w-64 bg-emerald/20" style={{ animationDelay: "-5s" }} />
      <div className="pointer-events-none absolute inset-0 bg-[length:22px_22px] bg-[radial-gradient(circle_at_1px_1px,rgb(255_255_255_/_0.06)_1px,transparent_0)]" />

      <form
        onSubmit={onSubmit}
        className="relative w-full max-w-md rounded-3xl border border-white/15 bg-navy/70 p-8 shadow-[0_30px_80px_-20px_rgb(0_0_0_/_0.65)] backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <BrandLogo className="h-12 w-12" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan">
            Bismillah Super Storm Fiber
          </p>
        </div>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-white">Welcome back</h1>
        <p className="mt-1.5 text-sm text-slate-400">Staff access only. English UI.</p>

        <label className="mt-8 block text-sm text-slate-300">
          Email
          <input
            type="text"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="staff@bismillah"
            className="input-field mt-1.5 w-full rounded-xl border border-white/10 bg-ink/80 px-3.5 py-2.5 text-white outline-none placeholder:text-slate-500"
          />
        </label>
        <label className="mt-4 block text-sm text-slate-300">
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input-field mt-1.5 w-full rounded-xl border border-white/10 bg-ink/80 px-3.5 py-2.5 text-white outline-none"
          />
        </label>

        {error && (
          <p className="mt-4 rounded-xl border border-warn/30 bg-warn/15 px-3 py-2 text-sm text-orange-200">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn-primary mt-7 w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
