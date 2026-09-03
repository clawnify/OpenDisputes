import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api, daysLeft, money, REASON_LABEL, type Dispute } from "../api";
import { Badge, Button, Chip, Empty } from "./ui";

const VERDICT: Record<string, { tone: "success" | "warning" | "danger" | "neutral"; label: string }> = {
  fight: { tone: "success", label: "Worth fighting" },
  do_not_fight: { tone: "warning", label: "Weak case" },
  accept: { tone: "danger", label: "Concede" },
  pending: { tone: "neutral", label: "Not scored" },
};

export function DisputeList() {
  const [rows, setRows] = useState<Dispute[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await api.disputes(filter === "open" ? { open: "true" } : {});
      setRows(res.disputes);
      setTotal(res.total);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { void load(); }, [filter]);

  async function sync() {
    setBusy(true);
    try {
      await api.sync();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="eyebrow">Disputes · {total}</span>
          <div className="inline-flex rounded-lg bg-sunken p-0.5">
            {(["open", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-sm px-2.5 py-1 text-sm font-medium capitalize transition-colors ${
                  filter === f
                    ? "border border-border bg-surface text-foreground"
                    : "border border-transparent text-muted"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <Button onClick={sync} disabled={busy}>
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
          {busy ? "Syncing" : "Sync processors"}
        </Button>
      </div>

      {error && (
        <p className="mb-4 rounded-sm border border-danger/30 bg-danger-tint px-3 py-2 text-[0.8125rem] text-danger">
          {error}
        </p>
      )}

      {/* Full-bleed: the table sits on the canvas, not inside a second frame. */}
      <div className="-mx-6 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-border bg-sunken">
              {["Due", "Order", "Customer", "Reason", "Assessment", "Amount"].map((h, i) => (
                <th
                  key={h}
                  className={`px-3 py-2.5 text-xs font-semibold tracking-wide text-muted ${
                    i === 5 ? "text-right" : "text-left"
                  } ${i === 0 ? "pl-6" : ""} ${i === 5 ? "pr-6" : ""}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const due = daysLeft(d.due_by);
              const verdict = VERDICT[d.recommendation] ?? VERDICT.pending;
              return (
                <tr key={d.id} className="border-b border-border hover:bg-sunken">
                  <td className="py-2.5 pr-3 pl-6 whitespace-nowrap">
                    {d.outcome ? (
                      <Badge tone={d.outcome === "won" ? "success" : "neutral"}>
                        {d.outcome === "won" ? "Won" : d.outcome === "lost" ? "Lost" : "Closed"}
                      </Badge>
                    ) : due ? (
                      <span
                        className={`text-[0.8125rem] ${due.urgent ? "font-semibold text-danger" : "text-muted"}`}
                      >
                        {due.urgent && <AlertTriangle size={12} className="mr-1 inline align-[-1px]" />}
                        {due.label}
                      </span>
                    ) : (
                      <span className="text-[0.8125rem] text-faint">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Link to={`/disputes/${d.id}`} className="text-[0.8125rem] font-medium">
                      {d.order_ref || d.external_id.slice(0, 18)}
                    </Link>
                    <div className="mt-0.5 flex gap-1">
                      <Chip>{d.processor}</Chip>
                      {d.is_physical === 1 && <Chip>shipped</Chip>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[0.8125rem] text-muted">
                    {d.customer_email || d.customer_name || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-[0.8125rem]">
                    {REASON_LABEL[d.reason] ?? d.reason}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={verdict.tone}>{verdict.label}</Badge>
                  </td>
                  <td className="tnum py-2.5 pr-6 pl-3 text-right text-[0.8125rem]">
                    {money(d.amount_cents, d.currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-b border-border">
                <td colSpan={5} className="py-2.5 pr-3 pl-6 text-xs font-semibold text-muted">
                  {rows.length} shown
                </td>
                <td className="tnum py-2.5 pr-6 pl-3 text-right text-[0.8125rem] font-semibold">
                  {money(
                    rows.reduce((sum, r) => sum + r.amount_cents, 0),
                    rows[0]?.currency ?? "usd",
                  )}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {rows.length === 0 && !error && (
        <Empty
          title={filter === "open" ? "No open disputes" : "Nothing here yet"}
          detail="New disputes arrive by webhook. If you connected a processor that already had history, run Sync to pull it in."
        />
      )}
    </div>
  );
}
