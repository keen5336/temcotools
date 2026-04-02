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
    } catch (err) {
      console.error("Login request failed:", err);
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
        <div role="alert" className="alert alert-error text-sm">
          {error}
        </div>
      )}

      <div className="form-control">
        <label htmlFor="username" className="label">
          <span className="label-text font-medium">Username</span>
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
          className="input input-bordered w-full"
          placeholder="Enter username"
          disabled={loading}
        />
      </div>

      <div className="form-control">
        <label htmlFor="pin" className="label">
          <span className="label-text font-medium">PIN</span>
        </label>
        <input
          ref={pinRef}
          id="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          value={pin}
          onChange={handlePinInput}
          className="input input-bordered w-full tracking-widest"
          placeholder="••••"
          disabled={loading}
          maxLength={6}
        />
        <div className="label">
          <span className="label-text-alt text-base-content/50">4 to 6 digits</span>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn btn-primary w-full"
      >
        {loading ? "Signing in…" : "Sign In"}
      </button>
    </form>
  );
}
