import { NavLink, Route, Routes } from "react-router-dom";
import { BarChart3, Inbox, Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { DisputeList } from "./components/dispute-list";
import { DisputeDetail } from "./components/dispute-detail";
import { SettingsPanel, StatsPanel } from "./components/settings-stats";

const NAV = [
  { to: "/", label: "Disputes", icon: Inbox, end: true },
  { to: "/performance", label: "Performance", icon: BarChart3, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false },
];

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[16.25rem] shrink-0 border-r border-border md:block">
        {/* Fixed 56px so this bottom border and the toolbar's form one line. */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <ShieldCheck size={18} className="text-primary" />
          <span className="text-base font-bold tracking-tight">OpenDisputes</span>
        </div>
        <nav className="p-3">
          <div className="mb-2 px-2">
            <span className="eyebrow">Workspace</span>
          </div>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm no-underline transition-colors ${
                  isActive
                    ? "bg-primary/12 font-semibold text-primary"
                    : "text-foreground hover:bg-sunken"
                }`
              }
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <header className="flex h-14 items-center border-b border-border px-6">
          <h1 className="text-xl font-bold tracking-tight">Chargeback evidence</h1>
        </header>
        <Routes>
          <Route path="/" element={<DisputeList />} />
          <Route path="/disputes/:id" element={<DisputeDetail />} />
          <Route path="/performance" element={<StatsPanel />} />
          <Route path="/settings" element={<SettingsPanel />} />
        </Routes>
      </main>
    </div>
  );
}
