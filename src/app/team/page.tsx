"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Member {
  userId: string;
  role: string;
  departments: string[];
  isYou: boolean;
}
interface Dept {
  key: string;
  name: string;
}
interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  expired: boolean;
}

const ROLE_WORDS: Record<string, string> = {
  owner: "Owner: everything, always",
  admin: "Admin: everything, always",
  staff: "Staff: only what's switched on below",
  bookkeeper: "Bookkeeper: your books person (free seat)",
  viewer: "Viewer: look, don't touch",
};

/** "Content team" → "content-team", matching the server's key rule. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 30);
}

export default function TeamPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Dept[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [newDept, setNewDept] = useState("");
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("staff");
  /** The freshly created link — the only place the raw token ever shows. */
  const [inviteLink, setInviteLink] = useState("");
  const [copied, setCopied] = useState(false);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const [r, inv] = await Promise.all([
        api<{ members: Member[]; departments: Dept[] }>("/api/team"),
        api<{ invites: Invite[] }>("/api/team/invites"),
      ]);
      setMembers(r.members);
      setDepartments(r.departments);
      setInvites(inv.invites);
      setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the team.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(m: Member, deptKey: string) {
    const next = m.departments.includes(deptKey)
      ? m.departments.filter((d) => d !== deptKey)
      : [...m.departments, deptKey];
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/team", {
        method: "POST",
        json: { action: "set-departments", userId: m.userId, departments: next },
      });
      setNote("Saved. Takes effect on their very next click.");
    } catch {
      setError("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function setRole(m: Member, role: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/team", {
        method: "POST",
        json: { action: "set-role", userId: m.userId, role },
      });
      setNote("Role updated.");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "last_owner"
          ? "That's the only owner. Hand ownership to someone else first."
          : e instanceof ApiError && e.status === 403
            ? "Only the owner can change roles."
            : "Couldn't change the role.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  const adminLike = (r: string) => r === "owner" || r === "admin";

  /** One wrapper so every department action shares busy/note/error handling. */
  async function deptAction(json: Record<string, unknown>, okNote: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/team", { method: "POST", json });
      setNote(okNote);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "department_exists"
          ? "There's already a department with that name."
          : e instanceof ApiError && e.code === "department_in_use"
            ? "Remove it from everyone first. Deleting won't strip access silently."
            : e instanceof ApiError && e.code === "aal2_required"
              ? (e.message as string)
              : "Couldn't save that. Try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function addDept() {
    const key = slugify(newDept);
    if (!key || key.length < 2) {
      setError("Give the department a name with at least a couple of letters.");
      return;
    }
    await deptAction(
      { action: "create-department", key, name: newDept.trim() },
      "Added. Now switch it on for the right people above.",
    );
    setNewDept("");
  }

  async function saveRename(key: string) {
    await deptAction(
      { action: "rename-department", key, name: renameVal.trim() },
      "Renamed.",
    );
    setRenameKey(null);
  }

  async function removeDept(key: string) {
    await deptAction({ action: "delete-department", key }, "Deleted.");
  }

  async function createInviteLink() {
    setBusy(true);
    setError("");
    setNote("");
    setInviteLink("");
    setCopied(false);
    try {
      const r = await api<{ token: string; expiresAt: string }>("/api/team/invites", {
        method: "POST",
        json: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteLink(`${window.location.origin}/login?invite=${r.token}`);
      setInviteEmail("");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "seat_limit_reached"
          ? "Every seat on your plan is taken. Upgrade on the Billing page to make room."
          : e instanceof ApiError
            ? (e.message as string)
            : "Couldn't create the invite. Try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it yourself.");
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api(`/api/team/invites/${id}`, { method: "DELETE" });
      setNote("Invite revoked. That link is dead now.");
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "aal2_required"
          ? (e.message as string)
          : "Couldn't revoke it. Try again.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Team & access">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Team & access">
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Who can see what. <strong>Owners and admins always see everything.</strong>{" "}
          Everyone else sees only the areas you switch on. Works the same
          whether you have one person or ten.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Hiding a menu is the polite part; the server refuses the data either
          way. Every switch takes effect on the person&apos;s next click.
        </p>
      </div>

      {/* ------------------------------------------------------ invites */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Invite someone</h2>
        <div className="row" style={{ alignItems: "end" }}>
          <div className="grow">
            <label htmlFor="inv-email">Their email</label>
            <input
              id="inv-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="person1@example.com"
              onKeyDown={(e) =>
                e.key === "Enter" && inviteEmail.trim() && void createInviteLink()
              }
            />
          </div>
          <div>
            <label htmlFor="inv-role">Role</label>
            <select
              id="inv-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              style={{ width: 150 }}
            >
              {["admin", "staff", "bookkeeper", "viewer"].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <button
            disabled={busy || !inviteEmail.trim()}
            onClick={() => void createInviteLink()}
          >
            Create invite link
          </button>
        </div>
        {inviteLink && (
          <div style={{ marginTop: 12 }}>
            <div className="row">
              <input
                aria-label="Invite link"
                readOnly
                value={inviteLink}
                onFocus={(e) => e.target.select()}
                style={{ fontSize: "0.8rem" }}
                className="grow"
              />
              <button
                className="secondary"
                style={{ minHeight: 34, padding: "4px 12px" }}
                onClick={() => void copyInviteLink()}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              Send this link privately. Anyone who opens it can join as that
              role. It works once and expires in 7 days. This is the only time
              it's shown.
            </p>
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          For now you share the link yourself. Emailed invites arrive with the
          mail provider.
        </p>

        {invites.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <strong style={{ fontSize: "0.85rem" }}>Waiting on</strong>
            {invites.map((inv) => (
              <div key={inv.id} className="row" style={{ padding: "6px 0" }}>
                <span className="grow">
                  {inv.email} <span className="pill">{inv.role}</span>{" "}
                  <span className="muted">
                    {inv.expired
                      ? "expired"
                      : `expires ${inv.expiresAt.slice(0, 10)}`}
                  </span>
                </span>
                <button
                  className="secondary"
                  style={{ minHeight: 34, padding: "4px 12px" }}
                  disabled={busy}
                  onClick={() => void revoke(inv.id)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {members.map((m) => (
        <div key={m.userId} className="card">
          <div className="row" style={{ marginBottom: adminLike(m.role) ? 0 : 10 }}>
            <div className="grow">
              <strong>{m.userId.replace(/^dev:/, "")}</strong>{" "}
              {m.isYou && <span className="pill">you</span>}
              <div className="muted">{ROLE_WORDS[m.role] ?? m.role}</div>
            </div>
            <select
              aria-label={`Role for ${m.userId}`}
              value={m.role}
              disabled={busy || m.isYou}
              style={{ width: 150 }}
              onChange={(e) => void setRole(m, e.target.value)}
            >
              {Object.keys(ROLE_WORDS).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          {!adminLike(m.role) && departments.length > 0 && (
            <div className="row" role="group" aria-label={`Access for ${m.userId}`}>
              {departments.map((d) => {
                const on = m.departments.includes(d.key);
                return (
                  <button
                    key={d.key}
                    className="chip"
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => void toggle(m, d.key)}
                  >
                    {on ? "✓" : "+"} {d.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {/* ---------------------------------------------- department manager */}
      <h2>Departments</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Make this match how <em>your</em> company actually runs: content,
          clients, finance, whatever you call them. Give anyone any mix. You
          start with none; add the walls your org actually needs.
        </p>

        {departments.map((d) => {
          const granted = members.filter((m) => m.departments.includes(d.key)).length;
          return (
            <div key={d.key} className="row" style={{ padding: "6px 0", alignItems: "center" }}>
              {renameKey === d.key ? (
                <>
                  <input
                    aria-label={`New name for ${d.name}`}
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value.slice(0, 60))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename(d.key);
                      if (e.key === "Escape") setRenameKey(null);
                    }}
                    autoFocus
                    style={{ maxWidth: 240 }}
                  />
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    disabled={busy || !renameVal.trim()}
                    onClick={() => void saveRename(d.key)}
                  >
                    Save
                  </button>
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    onClick={() => setRenameKey(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="grow">
                    <strong>{d.name}</strong>{" "}
                    <span className="muted">
                      · {granted} {granted === 1 ? "person" : "people"}
                    </span>
                  </span>
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    disabled={busy}
                    onClick={() => {
                      setRenameKey(d.key);
                      setRenameVal(d.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="secondary"
                    style={{ minHeight: 34, padding: "4px 12px" }}
                    disabled={busy || granted > 0}
                    title={
                      granted > 0
                        ? "Remove it from everyone first. Deleting won't strip access silently"
                        : undefined
                    }
                    onClick={() => void removeDept(d.key)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}

        <div className="row" style={{ marginTop: 12, alignItems: "end" }}>
          <div className="grow">
            <label htmlFor="new-dept">Add a department</label>
            <input
              id="new-dept"
              value={newDept}
              onChange={(e) => setNewDept(e.target.value.slice(0, 60))}
              placeholder="Content team"
              onKeyDown={(e) => {
                if (e.key === "Enter") void addDept();
              }}
            />
          </div>
          <button disabled={busy || !newDept.trim()} onClick={() => void addDept()}>
            Add
          </button>
        </div>
        {newDept.trim() && (
          <p className="muted" style={{ marginBottom: 0, fontSize: "0.85rem" }}>
            Will be created as <code>{slugify(newDept)}</code>. You can then
            switch it on for anyone above.
          </p>
        )}
      </div>

      <div role="status" aria-live="polite">
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </AppShell>
  );
}
