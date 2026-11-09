// The app's icons: inline SVG line drawings, so nothing loads from anywhere
// else and each one takes its colour from the CSS around it. Every icon is
// aria-hidden, because the words beside it always say what it means.

export function Spinner() {
  return (
    <svg className="spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" strokeOpacity=".3" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </svg>
  )
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5V3.7c0-.7-.5-1.2-1.2-1.2H3.7c-.7 0-1.2.5-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2h1.8" />
    </svg>
  )
}

export function CheckIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.8 2.8 6.2-6.4" /></svg>
}

export function PrintIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6V2.5h7V6" />
      <rect x="2" y="6" width="12" height="5.5" rx="1.2" />
      <path d="M4.5 9.5h7v4h-7z" />
    </svg>
  )
}

export function DownloadIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.8 7.6L8 10.8l3.2-3.2M3 13.5h10" /></svg>
}

export function UploadIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.8v-8M4.8 5.7L8 2.5l3.2 3.2M3 13.5h10" /></svg>
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 5V3.5c0-.6.4-1 1-1h3l1.5 1.5h4.5c.6 0 1 .4 1 1V12.5c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V5z" />
    </svg>
  )
}

export function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5z" />
      <path d="M11.5 2.5V6H15" />
    </svg>
  )
}

export function ClockIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="6.5" />
      <path d="M9 5.5V9l2.5 1.5" />
    </svg>
  )
}

export function KeyIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="6" cy="12" r="3.5" />
      <path d="M8.5 9.5l6.5-6.5M12.5 5.5l2 2" />
    </svg>
  )
}

// Navigation icons, 18px.
export function DashboardIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1" />
      <rect x="10" y="2.5" width="5.5" height="5.5" rx="1" />
      <rect x="2.5" y="10" width="5.5" height="5.5" rx="1" />
      <rect x="10" y="10" width="5.5" height="5.5" rx="1" />
    </svg>
  )
}

export function ListIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4.5h10M4 9h10M4 13.5h6" /></svg>
}

export function ChartIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 15V9M7.5 15V4M12 15v-4M15.5 15H2.5" /></svg>
}

export function SlidersIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3 5h7M13 5h2M3 13h2M8 13h7" />
      <circle cx="11.5" cy="5" r="1.6" />
      <circle cx="6.5" cy="13" r="1.6" />
    </svg>
  )
}

// The round status icons: a tick, a cross, an equals sign for a leg lost to
// a draw, or a dash for "nothing to do".
export function StatusIcon({ kind }: { kind: 'good' | 'bad' | 'warn' | 'none' }) {
  return (
    <span className={`dot-icon ${kind}`} aria-hidden="true">
      <svg viewBox="0 0 10 10">
        {kind === 'good' && <path d="M2.5 5.2l1.8 1.8 3.4-3.6" />}
        {kind === 'bad' && <path d="M3 3l4 4M7 3l-4 4" />}
        {kind === 'warn' && <path d="M2.8 3.9h4.4M2.8 6.1h4.4" />}
        {kind === 'none' && <path d="M3 5h4" />}
      </svg>
    </span>
  )
}

// Step 10's icons, 16px unless the CSS says otherwise.
export function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  )
}

export function OpenLockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" />
    </svg>
  )
}

export function BackIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
}

export function NextIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
}

export function CrossIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
}

export function ChangedIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M14.5 6.5A6 6 0 0 0 3.6 6M3.5 11.5A6 6 0 0 0 14.4 12" />
      <path d="M14.8 3.2v3.5h-3.5M3.2 14.8v-3.5h3.5" />
    </svg>
  )
}
