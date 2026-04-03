"use client";

import { useEffect, useState, useCallback } from "react";

interface User {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

type EditFields = Partial<Pick<User, "username" | "displayName" | "role" | "isActive">> & {
  pin?: string;
};

const EMPTY_CREATE: { username: string; displayName: string; pin: string; role: "admin" | "user" } =
  { username: "", displayName: "", pin: "", role: "user" };

export default function AdminUsersClient() {
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create user modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  // Edit user modal state
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<EditFields>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const fetchUsers = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users?search=${encodeURIComponent(q)}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Request failed with status ${res.status}`);
      }
      setUsers(await res.json());
    } catch (err) {
      console.error("Failed to fetch users:", err);
      setError(err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => fetchUsers(search), 300);
    return () => clearTimeout(timer);
  }, [search, fetchUsers]);

  async function quickUpdate(id: string, data: Partial<Pick<User, "role" | "isActive">>) {
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        alert(json.error || "Failed to update user.");
        return;
      }
      const updated: User = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    } catch {
      alert("Failed to update user.");
    }
  }

  // Create user
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreateLoading(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const json = await res.json();
      if (!res.ok) {
        setCreateError(json.error || "Failed to create user.");
        return;
      }
      setUsers((prev) => [json, ...prev]);
      setCreateForm(EMPTY_CREATE);
      setShowCreate(false);
    } catch {
      setCreateError("Network error.");
    } finally {
      setCreateLoading(false);
    }
  }

  // Open edit modal
  function openEdit(user: User) {
    setEditUser(user);
    setEditForm({ username: user.username, displayName: user.displayName, pin: "" });
    setEditError(null);
  }

  // Save edit
  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditError(null);
    setEditLoading(true);
    try {
      const payload: EditFields = {};
      if (editForm.username !== editUser.username) payload.username = editForm.username;
      if (editForm.displayName !== editUser.displayName) payload.displayName = editForm.displayName;
      if (editForm.pin) payload.pin = editForm.pin;

      if (Object.keys(payload).length === 0) {
        setEditUser(null);
        return;
      }

      const res = await fetch(`/api/admin/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setEditError(json.error || "Failed to update user.");
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === editUser.id ? json : u)));
      setEditUser(null);
    } catch {
      setEditError("Network error.");
    } finally {
      setEditLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <input
          type="text"
          placeholder="Search by username or display name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input input-bordered input-sm w-full sm:w-80"
        />
        <button
          onClick={() => { setShowCreate(true); setCreateError(null); }}
          className="btn btn-primary btn-sm ml-auto shrink-0"
        >
          + New User
        </button>
      </div>

      {loading && <p className="text-sm text-base-content/60">Loading…</p>}
      {error && <p className="text-sm text-error">{error}</p>}

      {!loading && !error && (
        <div className="overflow-x-auto rounded-lg border border-base-200">
          <table className="table table-sm w-full">
            <thead>
              <tr>
                <th>Display Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-base-content/40 py-6">
                    No users found.
                  </td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.id} className="hover">
                  <td>{user.displayName}</td>
                  <td className="font-mono text-xs">{user.username}</td>
                  <td>
                    <span
                      className={`badge badge-sm ${
                        user.role === "admin" ? "badge-primary" : "badge-ghost"
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge badge-sm ${
                        user.isActive ? "badge-success" : "badge-error"
                      }`}
                    >
                      {user.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="text-base-content/60">
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleString()
                      : "Never"}
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEdit(user)}
                        className="btn btn-ghost btn-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => quickUpdate(user.id, { role: user.role === "admin" ? "user" : "admin" })}
                        className="btn btn-ghost btn-xs text-primary"
                      >
                        {user.role === "admin" ? "Demote" : "Promote"}
                      </button>
                      <button
                        onClick={() => quickUpdate(user.id, { isActive: !user.isActive })}
                        className={`btn btn-ghost btn-xs ${user.isActive ? "text-error" : "text-success"}`}
                      >
                        {user.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="card bg-base-100 shadow-xl w-full max-w-sm">
            <div className="card-body">
              <h2 className="card-title">Create User</h2>
              <form onSubmit={handleCreate} className="space-y-4">
                {createError && (
                  <div role="alert" className="alert alert-error text-sm">{createError}</div>
                )}
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">Username</span></label>
                  <input
                    type="text"
                    autoCapitalize="none"
                    value={createForm.username}
                    onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                    className="input input-bordered input-sm w-full"
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">Display Name</span></label>
                  <input
                    type="text"
                    value={createForm.displayName}
                    onChange={(e) => setCreateForm((f) => ({ ...f, displayName: e.target.value }))}
                    className="input input-bordered input-sm w-full"
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">PIN (4–6 digits)</span></label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={createForm.pin}
                    onChange={(e) => setCreateForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                    className="input input-bordered input-sm w-full"
                    maxLength={6}
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">Role</span></label>
                  <select
                    value={createForm.role}
                    onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as "admin" | "user" }))}
                    className="select select-bordered select-sm w-full"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={createLoading}
                    className="btn btn-primary btn-sm flex-1"
                  >
                    {createLoading ? "Creating…" : "Create"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setCreateForm(EMPTY_CREATE); }}
                    className="btn btn-ghost btn-sm flex-1"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="card bg-base-100 shadow-xl w-full max-w-sm">
            <div className="card-body">
              <h2 className="card-title">Edit User</h2>
              <form onSubmit={handleEdit} className="space-y-4">
                {editError && (
                  <div role="alert" className="alert alert-error text-sm">{editError}</div>
                )}
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">Username</span></label>
                  <input
                    type="text"
                    autoCapitalize="none"
                    value={editForm.username ?? ""}
                    onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))}
                    className="input input-bordered input-sm w-full"
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">Display Name</span></label>
                  <input
                    type="text"
                    value={editForm.displayName ?? ""}
                    onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))}
                    className="input input-bordered input-sm w-full"
                    required
                  />
                </div>
                <div className="form-control">
                  <label className="label">
                    <span className="label-text font-medium">New PIN</span>
                    <span className="label-text-alt text-base-content/50">(leave blank to keep current)</span>
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={editForm.pin ?? ""}
                    onChange={(e) => setEditForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                    className="input input-bordered input-sm w-full"
                    maxLength={6}
                    placeholder="4–6 digits"
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={editLoading}
                    className="btn btn-primary btn-sm flex-1"
                  >
                    {editLoading ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditUser(null)}
                    className="btn btn-ghost btn-sm flex-1"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

