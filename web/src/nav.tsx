import type { ReactNode } from "react";

// The Doca mark: a D half-submerged at the waterline. Shared by both views' headers.
export function Mark({ size = 30 }: { size?: number }) {
    return (
        <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
            <defs>
                <clipPath id="mt"><rect x="0" y="0" width="32" height="16" /></clipPath>
                <clipPath id="mb"><rect x="0" y="16" width="32" height="16" /></clipPath>
            </defs>
            <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round">
                <path d="M11 7 H15 A9 9 0 0 1 15 25 H11 Z" clipPath="url(#mt)" />
                <path d="M11 7 H15 A9 9 0 0 1 15 25 H11 Z" clipPath="url(#mb)" opacity="0.45" />
                <line x1="2" y1="16" x2="30" y2="16" />
            </g>
        </svg>
    );
}

export type ViewId = "journey" | "desk";

const TABS: { id: ViewId; label: string; icon: ReactNode }[] = [
    {
        id: "journey",
        label: "Harbor",
        icon: (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 1.8v3M10 15.2v3M1.8 10h3M15.2 10h3" />
                <path d="m12.4 7.6-4.4 1.9 1.9 1.9 2.5-3.8Z" />
            </svg>
        ),
    },
    {
        id: "desk",
        label: "Desk",
        icon: (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2.5" y="4" width="15" height="12" rx="2.2" />
                <path d="M2.5 8.6h15M7.6 8.6V16" />
            </svg>
        ),
    },
];

// Center tab nav, shared verbatim by the Harbor and Desk headers so switching views
// never re-lays the chrome around it.
export function TabNav({ view, onChange }: { view: ViewId; onChange: (v: ViewId) => void }) {
    return (
        <nav className="tab-nav" aria-label="App views">
            {TABS.map((t) => (
                <button
                    key={t.id}
                    type="button"
                    className={view === t.id ? "on" : ""}
                    aria-current={view === t.id ? "page" : undefined}
                    onClick={() => onChange(t.id)}
                >
                    {t.icon}
                    {t.label}
                </button>
            ))}
        </nav>
    );
}
