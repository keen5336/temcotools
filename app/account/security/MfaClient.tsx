"use client";

import { useCallback, useEffect, useState } from "react";

type Status = { enabled: boolean; remainingRecoveryCodes: number; mfaVerifiedAt: number | null };
type Setup = { secret: string; uri: string; expiresAt: string };

export default function MfaClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const response = await fetch("/api/account/security/mfa", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load authenticator status.");
    setStatus(data);
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void reload().catch((error) => setMessage(error.message)); }, 0); return () => clearTimeout(timer); }, [reload]);
  const run = async (action: string) => {
    setBusy(true); setMessage("");
    try {
      const input = action === "begin" ? { password } : action === "confirm" ? { token }
        : { password, ...(useRecovery ? { recoveryCode } : { token }) };
      const response = await fetch("/api/account/security/mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, input }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Authenticator action failed.");
      setPassword(""); setToken(""); setRecoveryCode("");
      if (action === "begin") { setSetup(data); setRecoveryCodes([]); setMessage("Add this key to your authenticator, then confirm its current code."); }
      else { setSetup(null); if (data.recoveryCodes) setRecoveryCodes(data.recoveryCodes); setMessage(data.message || (action === "confirm" ? "Authenticator enabled. Save your one-use recovery codes privately." : "Password and second factor confirmed for this session.")); }
      await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Authenticator action failed."); }
    finally { setBusy(false); }
  };
  return <section className="card bg-base-100 border border-base-300"><div className="card-body space-y-3"><h2 className="card-title">Authenticator and privileged access</h2><p>Account administration, access changes and payload publication require your password plus a recently verified authenticator or recovery code. Ordinary warehouse sign-in can continue with your individual password.</p><p className="font-semibold">{status?.enabled ? `Authenticator enabled · ${status.remainingRecoveryCodes} recovery codes remaining` : "Authenticator not enrolled"}</p>
    {status?.mfaVerifiedAt && <p className="text-sm">Last second-factor confirmation {new Date(status.mfaVerifiedAt).toLocaleString()}. Privileged confirmation lasts 10 minutes.</p>}
    <label className="block">Current password<input className="input input-bordered w-full mt-1" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    {!status?.enabled && !setup && <button className="btn btn-primary w-full" disabled={busy || !password} onClick={() => void run("begin")}>Set up authenticator</button>}
    {setup && <div className="rounded-box border border-primary p-3 space-y-3"><p>Add a time-based account in a compatible authenticator: issuer TemcoTools, SHA-1, 6 digits, 30 seconds. Setup expires {new Date(setup.expiresAt).toLocaleTimeString()}.</p><label className="block">Manual setup key<textarea className="textarea textarea-bordered w-full font-mono break-all" readOnly value={setup.secret} /></label><button type="button" className="btn btn-outline w-full" onClick={() => { void navigator.clipboard.writeText(setup.secret).then(() => setMessage("Setup key copied. Keep it private.")).catch(() => setMessage("Select and copy the setup key.")); }}>Copy setup key</button><a href={setup.uri} className="btn btn-outline w-full">Open authenticator setup</a><details><summary className="cursor-pointer">Manual otpauth setup URI</summary><textarea className="textarea textarea-bordered w-full font-mono break-all mt-2" readOnly value={setup.uri} /></details><p className="text-sm">Opening an authenticator depends on the apps installed on this phone. Manual entry is available above.</p></div>}
    {(status?.enabled || setup) && <>
      {status?.enabled && <label className="flex gap-2 items-center"><input className="checkbox" type="checkbox" checked={useRecovery} onChange={(event) => setUseRecovery(event.target.checked)} />Use a one-use recovery code</label>}
      {status?.enabled && useRecovery ? <label className="block">Recovery code<input className="input input-bordered w-full mt-1 font-mono" autoComplete="off" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} /></label> : <label className="block">Authenticator code<input className="input input-bordered w-full mt-1 font-mono" inputMode="numeric" autoComplete="one-time-code" value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} /></label>}
      <button className="btn btn-primary w-full" disabled={busy || (setup ? token.length !== 6 : !password || (useRecovery ? !recoveryCode : token.length !== 6))} onClick={() => void run(setup ? "confirm" : "verify")}>{setup ? "Confirm enrollment" : "Confirm password and second factor"}</button>
      {status?.enabled && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><button className="btn btn-outline" disabled={busy || !password} onClick={() => void run("recovery-codes")}>Replace recovery codes</button><button className="btn btn-warning" disabled={busy || !password} onClick={() => { if (window.confirm("Disable this authenticator? Privileged actions will require enrolling one again. Other sessions will be revoked.")) void run("disable"); }}>Disable authenticator</button></div>}
      <p className="text-sm">Each authenticator code can be used once across sessions. Wait for a new code before another verification, replacement or disable action. Recovery codes also work once.</p>
    </>}
    {recoveryCodes.length > 0 && <div className="rounded-box border border-warning p-3 space-y-2"><strong>Save these recovery codes now</strong><p>They are shown once and are not stored on this phone. Each code plus your password can restore second-factor access. Keep them privately, separate from the scanner.</p><textarea className="textarea textarea-bordered w-full min-h-64 font-mono" readOnly aria-label="One-use authenticator recovery codes" value={recoveryCodes.join("\n")} /><button className="btn btn-outline w-full" onClick={() => { void navigator.clipboard.writeText(recoveryCodes.join("\n")).then(() => setMessage("Recovery codes copied. Store them privately.")).catch(() => setMessage("Select and copy the recovery codes.")); }}>Copy recovery codes</button><button className="btn w-full" onClick={() => setRecoveryCodes([])}>I saved them · clear this display</button></div>}
    {message && <p role="status" className="alert break-words">{message}</p>}
  </div></section>;
}
