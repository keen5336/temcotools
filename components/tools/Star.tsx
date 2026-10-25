export default function Star({ filled = false, className = "h-5 w-5" }: { filled?: boolean; className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91L12 3Z" /></svg>;
}
