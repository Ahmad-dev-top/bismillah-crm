import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { PageHeader } from "../components/PageHeader.tsx";

interface Me {
  id: string;
  email: string;
  full_name: string;
  last_login_at: string | null;
  role: string;
  permissions: string[];
}

interface Workspace {
  timezone: string;
  expiryNotice: string;
  whatsappDryRun: boolean;
  businessName: string;
}

export function Settings() {
  const { session, refreshMe, logout } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [profilePassword, setProfilePassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileOk, setProfileOk] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwOk, setPwOk] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then((r) => {
        setMe(r);
        setFullName(r.full_name);
        setEmail(r.email);
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Failed to load profile"));
    api<Workspace>("/api/settings/workspace")
      .then(setWorkspace)
      .catch(() => setWorkspace(null));
  }, []);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileOk(null);
    setProfileBusy(true);
    try {
      const updated = await api<Me>("/api/auth/profile", {
        method: "PATCH",
        body: {
          fullName: fullName.trim(),
          email: email.trim(),
          currentPassword: profilePassword,
        },
      });
      setMe(updated);
      setProfilePassword("");
      refreshMe({ email: updated.email, fullName: updated.full_name });
      setProfileOk("Profile saved.");
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : "Could not save profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwOk(null);
    if (newPassword !== confirmPassword) {
      setPwError("New password and confirmation do not match.");
      return;
    }
    setPwBusy(true);
    try {
      await api("/api/auth/password", {
        method: "PATCH",
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwOk("Password updated. Use it the next time you sign in.");
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : "Could not change password");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="page mx-auto max-w-3xl p-6 lg:p-8">
      <PageHeader
        kicker="Account"
        title="Settings"
        subtitle="Change how you sign in. Workspace rules such as timezone stay the same for every staff member."
      />

      {loadError && (
        <p className="mt-6 rounded-xl border border-rose/20 bg-rose/10 px-3 py-2 text-sm text-rose">{loadError}</p>
      )}

      <form onSubmit={saveProfile} className="card mt-8 space-y-4 rounded-2xl p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Profile</h2>
        <label className="block text-sm text-slate-700">
          Display name
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        <label className="block text-sm text-slate-700">
          Sign-in email
          <input
            required
            type="text"
            inputMode="email"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        <label className="block text-sm text-slate-700">
          Current password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={profilePassword}
            onChange={(e) => setProfilePassword(e.target.value)}
            className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        {profileError && <p className="text-sm text-rose">{profileError}</p>}
        {profileOk && <p className="text-sm font-medium text-emerald">{profileOk}</p>}
        <button
          type="submit"
          disabled={profileBusy}
          className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {profileBusy ? "Saving…" : "Save profile"}
        </button>
      </form>

      <form onSubmit={savePassword} className="card mt-6 space-y-4 rounded-2xl p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Password</h2>
        <p className="text-sm text-slate-500">At least 10 characters. You stay signed in on this device until you sign out.</p>
        <label className="block text-sm text-slate-700">
          Current password
          <input
            required
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        <label className="block text-sm text-slate-700">
          New password
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        <label className="block text-sm text-slate-700">
          Confirm new password
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input-field mt-1 w-full rounded-xl border border-slate-200 bg-paper px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        {pwError && <p className="text-sm text-rose">{pwError}</p>}
        {pwOk && <p className="text-sm font-medium text-emerald">{pwOk}</p>}
        <button
          type="submit"
          disabled={pwBusy}
          className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pwBusy ? "Updating…" : "Update password"}
        </button>
      </form>

      <div className="card mt-6 space-y-3 rounded-2xl p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Workspace</h2>
        <Row label="Business" value={workspace?.businessName ?? "Bismillah Super Storm Fiber"} />
        <Row label="Your role" value={(me?.role ?? session?.role ?? "").replaceAll("_", " ")} />
        <Row
          label="Last sign-in"
          value={me?.last_login_at ? new Date(me.last_login_at).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) : "—"}
        />
        <Row label="Timezone" value={workspace?.timezone ?? "Asia/Karachi"} />
        <Row label="Expiry notice" value={workspace?.expiryNotice ?? "12:00 AM (Midnight)"} />
        <Row
          label="WhatsApp"
          value={workspace?.whatsappDryRun ? "Dry run — no real messages leave the server" : "Live sending"}
        />
        <div className="flex flex-wrap gap-3 pt-2 text-sm">
          <Link to="/packages" className="font-medium text-electric hover:underline">
            Manage packages
          </Link>
          <Link to="/areas" className="font-medium text-electric hover:underline">
            Manage areas
          </Link>
          <button type="button" onClick={logout} className="font-medium text-slate-500 hover:text-navy">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-navy">{value}</dd>
    </div>
  );
}
