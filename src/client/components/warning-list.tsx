import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api, money, type FraudWarning, type WarningLedger } from "../api";
import { Badge, Button, Card, Chip, Empty, Stat } from "./ui";

const VERDICT: Record<string, { tone: "success" | "warning" | "danger" | "neutral"; label: string }> = {
  refund: { tone: "warning", label: "Refund it" },
  do_not_refund: { tone: "success", label: "Keep it" },
  review: { tone: "neutral", label: "Your call" },
  no_action: { tone: "neutral", label: "Closed" },
};

const FULFILLMENT: Record<string, string> = {
  not_shipped: "Not shipped",
  in_transit: "In transit",
  delivered: "Delivered",
  service_used: "Used after payment",
  service_unused: "No recorded use",
  unknown: "Fulfillment unknown",
};

/**
 * The deflection queue.
 *
 * Both actions demand a note before they fire, and that is the design rather
 * than friction for its own sake. A warning's whole long-term value is the pair
 * (what you decided, what happened next), and the second half arrives on its
 * own when a dispute lands. Without the first half there is nothing to learn
 * from: a bare count of dismissals teaches a merchant nothing about their own
 * judgement.
 */
export function WarningList() {
  const [rows, setRows] = useState<FraudWarning[]>([]);
  const [ledger, setLedger] = useState<WarningLedger | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await api.warnings(filter === "open");
      setRows(res.warnings);
      setLedger(res.ledger);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { void load(); }, [filter]);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="eyebrow">Early fraud warnings</span>
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
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {ledger && (
        <Card className="mb-4">
          <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
            <Stat value={String(ledger.open)} label="Undecided" meta="A decision is still available" />
            <Stat value={String(ledger.refunded)} label="Refunded" meta="Deflected before a dispute" />
            <Stat value={String(ledger.dismissed)} label="Kept" meta="You accepted the risk" />
            <Stat
              value={String(ledger.dismissed_then_disputed)}
              label="Kept, then disputed"
              meta="What letting them ride actually cost"
            />
          </div>
        </Card>
      )}

      {/* The one claim about EFWs that merchants most often get backwards, said
          once, at the top, rather than repeated on every row. */}
      <p className="mb-4 text-[0.8125rem] text-muted">
        Refunding avoids the dispute and its fee. It does not retract the warning: the card networks
        count these toward their fraud monitoring programs either way.
      </p>

      {rows.length === 0 ? (
        <Empty
          title="No warnings"
          detail="Issuers send these when they suspect a payment is fraudulent, before any chargeback exists. They arrive here automatically once your Stripe webhook is connected."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((w) => <WarningRow key={w.id} warning={w} onChange={load} />)}
        </div>
      )}
    </div>
  );
}

function WarningRow({ warning: w, onChange }: { warning: FraudWarning; onChange: () => void }) {
  const [note, setNote] = useState("");
  const [markFraud, setMarkFraud] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verdict = VERDICT[w.recommendation] ?? VERDICT.review;
  const decided = Boolean(w.resolution);

  async function act(kind: "refund" | "dismiss") {
    if (!note.trim()) {
      setError("Say why. This note is the only thing that makes the outcome readable later.");
      return;
    }
    setBusy(true);
    try {
      if (kind === "refund") await api.refundWarning(w.id, note, markFraud);
      else await api.dismissWarning(w.id, note);
      setError("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="tnum text-base font-bold">{money(w.amount_cents, w.currency)}</span>
            <Badge tone={verdict.tone}>{verdict.label}</Badge>
            <Chip>{w.fraud_type_label}</Chip>
            <Chip>{FULFILLMENT[w.fulfillment_state] ?? w.fulfillment_state}</Chip>
            {w.three_d_secure_result === "authenticated" && <Chip>3D Secure</Chip>}
          </div>
          <p className="text-[0.8125rem] text-muted">
            {w.customer_email || "no email on the charge"} · warned{" "}
            {new Date(w.warned_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="border-t border-border px-5 py-4">
        <p className="text-[0.8125rem] text-foreground">{w.recommendation_reason}</p>
        {w.factors.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {w.factors.map((f) => (
              <li key={f} className="text-[0.8125rem] text-muted">· {f}</li>
            ))}
          </ul>
        )}
      </div>

      {decided ? (
        <div className="border-t border-border px-5 py-4">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={w.resolution === "became_dispute" ? "danger" : "neutral"}>
              {w.resolution === "refunded" && "Refunded"}
              {w.resolution === "dismissed" && "Kept"}
              {w.resolution === "became_dispute" && "Became a dispute"}
            </Badge>
            {w.resolution_at && (
              <span className="text-[0.6875rem] text-faint">
                {new Date(w.resolution_at).toLocaleDateString()}
              </span>
            )}
          </div>
          {w.resolution_note && (
            <p className="text-[0.8125rem] text-muted">“{w.resolution_note}”</p>
          )}
        </div>
      ) : (
        <div className="border-t border-border px-5 py-4">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why you are deciding this way. Read back to you if it becomes a dispute."
            className="mb-2 w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
          />
          <label className="mb-3 flex items-center gap-2 text-[0.8125rem] text-muted">
            <input
              type="checkbox"
              checked={markFraud}
              onChange={(e) => setMarkFraud(e.target.checked)}
            />
            Report to Stripe as fraud, which also blocks this card and email in Radar
          </label>
          {error && <p className="mb-2 text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || !w.actionable}
              onClick={() => void act("refund")}
            >
              <ShieldAlert size={15} />
              Refund in full
            </Button>
            <Button disabled={busy} onClick={() => void act("dismiss")}>Keep the charge</Button>
            {/* Said next to the button that does it, because a partial refund
                looks like a reasonable compromise and is in fact the one option
                that costs money and protects nothing. */}
            <span className="text-[0.6875rem] text-faint">
              Full amount only. A partially refunded payment can still be disputed for its full value.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
