"use client";

import { useEffect, useState, useCallback } from "react";

interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export default function AdminUsersClient() {
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users?search=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("Failed to load users");
      setUsers(await res.json());
    } catch {
      setError("Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => fetchUsers(search), 300);
    return () => clearTimeout(timer);
  }, [search, fetchUsers]);

  async function updateUser(id: string, data: Partial<Pick<User, "role" | "isActive">>) {
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error();
      const updated: User = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    } catch {
      alert("Failed to update user.");
    }
  }

  return (
    <div>
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-80 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {loading && <p className="text-sm text-gray-500">Loading...</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}

      {!loading && !error && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Last Login</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                    No users found.
                  </td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900">{user.name}</td>
                  <td className="px-4 py-3 text-gray-600">{user.email}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-medium ${
                        user.role === "admin"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-medium ${
                        user.isActive
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-600"
                      }`}
                    >
                      {user.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          updateUser(user.id, {
                            role: user.role === "admin" ? "user" : "admin",
                          })
                        }
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {user.role === "admin" ? "Demote" : "Promote"}
                      </button>
                      <button
                        onClick={() =>
                          updateUser(user.id, { isActive: !user.isActive })
                        }
                        className={`text-xs hover:underline ${
                          user.isActive ? "text-red-600" : "text-green-600"
                        }`}
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
    </div>
  );
}
