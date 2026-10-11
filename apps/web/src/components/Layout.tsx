import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { BrandLogo } from "./BrandLogo.tsx";

const link =
  "nav-link flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white";
const active = "active-nav bg-white/10 text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)]";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 opacity-90" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Layout() {
  const { session, logout, has } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [dryRun, setDryRun] = useState<boolean | null>(null);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    api<{ whatsappDryRun: boolean }>("/api/settings/workspace")
      .then((w) => setDryRun(w.whatsappDryRun))
      .catch(() => setDryRun(null));
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [navOpen]);

  const nav = (
    <>
      <NavLink to="/" end className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
        <Icon d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-8.5Z" />
        Dashboard
      </NavLink>
      {has("customer:read") && (
        <NavLink to="/customers" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
          <Icon d="M16 19v-1.2A3.8 3.8 0 0 0 12.2 14H7.8A3.8 3.8 0 0 0 4 17.8V19M20 19v-1.1A3.4 3.4 0 0 0 17.4 14.7M12 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 12 11Zm6.2-1.2a2.6 2.6 0 1 0-1.3-4.8" />
          Customers
        </NavLink>
      )}
      {has("package:read") && (
        <NavLink to="/packages" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
          <Icon d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Zm0 9 7.5-4.2M12 12v9M12 12 4.5 7.8" />
          Packages
        </NavLink>
      )}
      {(has("area:write") || has("customer:read")) && (
        <NavLink to="/areas" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
          <Icon d="M12 21s7-5.4 7-11.2A7 7 0 0 0 5 9.8C5 15.6 12 21 12 21Zm0-8.2a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z" />
          Areas
        </NavLink>
      )}
      <NavLink to="/settings" className={({ isActive }) => `${link} ${isActive ? active : ""}`}>
        <Icon d="M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4ZM19.4 13a7.6 7.6 0 0 0 .1-2l1.7-1.3-1.6-2.8-2 .8a7.7 7.7 0 0 0-1.7-1L15.6 4h-3.2l-.3 2.7a7.7 7.7 0 0 0-1.7 1l-2-.8-1.6 2.8L8.5 11a7.6 7.6 0 0 0 .1 2l-1.7 1.3 1.6 2.8 2-.8a7.7 7.7 0 0 0 1.7 1l.3 2.7h3.2l.3-2.7a7.7 7.7 0 0 0 1.7-1l2 .8 1.6-2.8L19.4 13Z" />
        Settings
      </NavLink>
    </>
  );

  const brand = (
    <div className="flex items-center gap-3">
      <BrandLogo className="h-11 w-11" />
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan">Super Storm Fiber</p>
        <h1 className="text-base font-semibold tracking-tight text-white">Bismillah CRM</h1>
      </div>
    </div>
  );

  const account = (
    <div className="relative border-t border-white/10 px-5 py-5 text-xs text-slate-400">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 animate-[pulse-dot_1.8s_ease-in-out_infinite] rounded-full bg-emerald shadow-[0_0_10px_rgb(18_196_138)]" />
        <span>Online · Karachi</span>
      </div>
      <p className="mt-3 truncate text-sm font-medium text-slate-100">{session?.fullName ?? session?.email}</p>
      <p className="mt-0.5 uppercase tracking-wide text-slate-500">{session?.role?.replaceAll("_", " ")}</p>
      <button
        type="button"
        onClick={logout}
        className="mt-3 text-slate-400 underline-offset-2 transition hover:text-white hover:underline"
      >
        Sign out
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-ink lg:flex">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/10 bg-navy px-4 py-3 lg:hidden">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
          className="rounded-xl p-2 text-white hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          </svg>
        </button>
        <BrandLogo className="h-9 w-9" />
        <span className="font-semibold text-white">Bismillah CRM</span>
      </header>

      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-ink/60 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 flex-col overflow-hidden border-white/10 bg-navy shadow-2xl transition-transform duration-200 lg:static lg:z-0 lg:flex lg:min-h-screen lg:w-64 lg:translate-x-0 lg:border-r lg:shadow-none ${
          navOpen ? "flex translate-x-0" : "hidden -translate-x-full lg:flex"
        }`}
      >
        <div className="pointer-events-none absolute -left-16 top-0 h-48 w-48 rounded-full bg-cyan/20 blur-3xl" />
        <div className="pointer-events-none absolute -right-10 bottom-24 h-40 w-40 rounded-full bg-electric/25 blur-3xl" />

        <div className="relative flex items-center justify-between px-5 py-6">
          {brand}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setNavOpen(false)}
            className="rounded-xl p-2 text-slate-300 hover:bg-white/10 lg:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <nav className="relative flex-1 space-y-1 px-3 pb-4">{nav}</nav>
        {account}
      </aside>

      <main className="main-canvas min-w-0 flex-1 text-slate-900 lg:min-h-screen">
        {dryRun === true && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 lg:px-8">
            WhatsApp is in <span className="font-semibold">dry run</span> — reminders are logged, not sent.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
