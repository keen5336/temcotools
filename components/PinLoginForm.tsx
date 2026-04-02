"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const LAST_USERNAME_KEY = "temco_last_username";

export default function PinLoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_USERNAME_KEY);
    if (saved) {
      setUsername(saved);
      pinRef.current?.focus();
    } else {
      usernameRef.current?.focus();
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!username.trim()) {
      setError("Username is required.");
      return;
    }
    if (!/^\d{4,6}$/.test(pin)) {
      setError("PIN must be 4 to 6 digits.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), pin }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed.");
        setPin("");
        pinRef.current?.focus();
        return;
      }

      localStorage.setItem(LAST_USERNAME_KEY, username.trim());
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handlePinInput(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setPin(value);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
          Username
        </label>
        <input
          ref={usernameRef}
          id="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => {
            if (username.trim()) pinRef.current?.focus();
          }}
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Enter username"
          disabled={loading}
        />
      </div>

      <div>
        <label htmlFor="pin" className="block text-sm font-medium text-gray-700 mb-1">
          PIN
        </label>
        <input
          ref={pinRef}
          id="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          value={pin}
          onChange={handlePinInput}
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-base tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="••••"
          disabled={loading}
          maxLength={6}
        />
        <p className="mt-1 text-xs text-gray-400">4 to 6 digits</p>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-3 px-4 rounded-lg text-base transition"
      >
        {loading ? "Signing in…" : "Sign In"}
      </button>
    </form>
  );
}
