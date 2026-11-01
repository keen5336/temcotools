"use client";

import Link from "next/link";
import { useState } from "react";

export default function RecoveryClient() {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (action: string, input: unknown) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, input }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Recovery failed.");
      setMessage(data.message); if (action === "redeem") { setToken(""); setPassword(""); setConfirmation(""); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recovery failed."); }
    finally { setBusy(false); }
  };
  return <div className="space-y-5">
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send("request", { username }); }}><label className="block">Username<input className="input input-bordered w-full mt-1" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label><button className="btn btn-outline w-full" disabled={busy}>Request assisted recovery</button></form>
    <form className="space-y-3 border-t border-base-300 pt-4" onSubmit={(event) => { event.preventDefault(); if (password !== confirmation) { setMessage("Passwords must match."); return; } void send("redeem", { token, password }); }}><h2 className="font-bold">Have a one-use code?</h2><label className="block">Enrollment or recovery code<input className="input input-bordered font-mono w-full mt-1" autoComplete="off" autoCapitalize="none" value={token} onChange={(event) => setToken(event.target.value.trim())} required /></label><label className="block">New password or passphrase<input className="input input-bordered w-full mt-1" type="password" minLength={15} maxLength={512} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="block">Confirm password<input className="input input-bordered w-full mt-1" type="password" minLength={15} maxLength={512} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label><p className="text-sm">Use 15–256 characters. Codes expire after 30 minutes and work once. No code or password is saved on this device.</p><button className="btn btn-primary w-full" disabled={busy}>Set password</button></form>
    {message && <p role="status" className="alert">{message}</p>}<Link className="link" href="/signin">Back to sign in</Link>
  </div>;
}
