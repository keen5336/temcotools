import RecoveryClient from "./RecoveryClient";

export default function RecoveryPage() {
  return <main className="min-h-screen bg-base-200 p-4 grid place-items-center"><div className="card bg-base-100 border border-base-300 w-full max-w-lg"><div className="card-body"><h1 className="text-2xl font-bold">Enroll or recover your account</h1><p>Existing PIN accounts need a one-use enrollment code from an authorized administrator. A PIN is no longer a public sign-in credential.</p><RecoveryClient /></div></div></main>;
}
