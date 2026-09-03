import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft, Check, CircleAlert, FileText, Package, Send, Sparkles, X,
} from "lucide-react";
import {
  api, daysLeft, money, KIND_LABEL, REASON_LABEL, SOURCE_LABEL,
  type CarrierLookup, type Dispute, type EvidenceItem,
} from "../api";
import { Badge, Button, Card, Chip, Empty, Zone } from "./ui";

const CARRIER_OUTCOME: Record<string, { tone: "success" | "warning" | "danger" | "neutral"; label: string }> = {
  delivered_with_pod: { tone: "success", label: "Delivered, signed" },
  delivered_no_pod: { tone: "neutral", label: "Delivered, unsigned" },
  not_delivered: { tone: "danger", label: "No delivery recorded" },
  unsupported: { tone: "warning", label: "Carrier has no API" },
  no_account: { tone: "warning", label: "Needs carrier account" },
  error: { tone: "warning", label: "Retrieval failed" },
};

export function DisputeDetail() {
  const { id = "" } = useParams();
  const [data, setData] = useState<{ dispute: Dispute; items: EvidenceItem[]; carrier: CarrierLookup[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  async function load() {
    try {
      setData(await api.dispute(id));
    } catch (err) {
      setNote({ tone: "err", text: (err as Error).message });
    }
  }
  useEffect(() => { void load(); }, [id]);

  async function act(what: "prepare" | "stage" | "submit", override = false) {
    setBusy(what);
    setNote(null);
    try {
      if (what === "prepare") {
        const r = await api.prepare(id);
        setNote({
          tone: "ok",
          text: r.escalated
            ? `Re-scored. A carrier record was not reachable by API, so your agent is retrieving it from the portal.`
            : `Re-scored from ${r.carrier_lookups} carrier lookup${r.carrier_lookups === 1 ? "" : "s"}.`,
        });
      } else {
        const r = await api.submit(id, what === "submit", override);
        setNote({
          tone: r.verified ? "ok" : "warn",
          text: r.detail + (r.dropped.length ? ` ${r.dropped.length} item(s) could not be mapped.` : ""),
        });
      }
      await load();
    } catch (err) {
      setNote({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy("");
    }
  }

  if (!data) {
    return (
      <div className="p-6">
        <p className="text-[0.8125rem] text-muted">Loading…</p>
      </div>
    );
  }

  const { dispute: d, items, carrier } = data;
  const due = daysLeft(d.due_by);
  const included = items.filter((i) => i.included);
  const conceding = d.recommendation === "accept" || d.recommendation === "do_not_fight";
  const [verdictLine, ...gapLines] = (d.recommendation_reason || "").split("\n");

  return (
    <div className="p-6">
      <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-[0.8125rem] no-underline">
        <ArrowLeft size={14} /> All disputes
      </Link>

      {note && (
        <p
          className={`mb-4 rounded-sm border px-3 py-2 text-[0.8125rem] ${
            note.tone === "ok"
              ? "border-success/30 bg-success-tint text-success"
              : note.tone === "warn"
                ? "border-warning/30 bg-warning-tint text-warning"
                : "border-danger/30 bg-danger-tint text-danger"
          }`}
        >
          {note.text}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Card>
            <Zone label="Dispute" first>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-bold tracking-tight">
                    {d.order_ref || d.external_id}
                  </h1>
                  <p className="mt-1 text-[0.8125rem] text-muted">
                    {REASON_LABEL[d.reason] ?? d.reason} · {d.customer_email || d.customer_name || "no customer on file"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Chip>{d.processor}</Chip>
                    {d.is_physical === 1 && <Chip>physical goods</Chip>}
                    {d.issuer_country && <Chip>issuer {d.issuer_country}</Chip>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="tnum text-2xl leading-none font-bold">
                    {money(d.amount_cents, d.currency)}
                  </div>
                  <div className="h-4 text-[0.6875rem] text-muted">
                    {d.outcome
                      ? `Closed · ${d.outcome}`
                      : due
                        ? due.label
                        : "no deadline on file"}
                  </div>
                </div>
              </div>
            </Zone>

            <Zone label="Delivery record">
              {carrier.length === 0 ? (
                <p className="text-[0.8125rem] text-muted">
                  {d.is_physical
                    ? "No carrier lookup yet. Assemble the dossier to pull delivery information."
                    : "Not a shipped order, so there is nothing to retrieve from a carrier."}
                </p>
              ) : (
                <div className="space-y-2">
                  {carrier.map((c, i) => {
                    const o = CARRIER_OUTCOME[c.outcome] ?? CARRIER_OUTCOME.error;
                    return (
                      <div key={i} className="rounded-sm border border-border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Package size={14} className="text-muted" />
                            <span className="text-[0.8125rem] font-medium uppercase">{c.carrier}</span>
                            <span className="tnum text-[0.8125rem] text-muted">{c.tracking}</span>
                          </div>
                          <Badge tone={o.tone}>{o.label}</Badge>
                        </div>
                        {(c.delivery_address || c.detail) && (
                          <p className="mt-2 text-[0.8125rem] text-muted">
                            {c.delivery_address && (
                              <>
                                Delivered to {c.delivery_address}
                                {c.address_match === 1 && (
                                  <span className="text-success"> · matches the order address</span>
                                )}
                                {c.address_match === 0 && (
                                  <span className="font-semibold text-danger">
                                    {" "}· does NOT match the order address
                                  </span>
                                )}
                                {c.address_match === null && (
                                  <span className="text-faint"> · not comparable</span>
                                )}
                                {c.detail ? ". " : ""}
                              </>
                            )}
                            {c.detail}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Zone>

            <Zone
              label={`Evidence · ${included.length} of ${items.length} included`}
              action={
                <a
                  href={`/api/disputes/${d.id}/dossier.pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-[0.8125rem] no-underline"
                >
                  <FileText size={14} /> Open dossier
                </a>
              }
            >
              {items.length === 0 ? (
                <p className="text-[0.8125rem] text-muted">
                  Nothing gathered yet. Assemble the dossier to collect what the processor and carriers hold.
                </p>
              ) : (
                <ul className="space-y-2">
                  {items.map((it) => (
                    <li
                      key={it.id}
                      className={`rounded-sm border p-3 ${
                        it.included ? "border-border" : "border-dashed border-border opacity-60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[0.8125rem] font-medium">{it.title}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Chip>{KIND_LABEL[it.kind] ?? it.kind}</Chip>
                            <Chip>{SOURCE_LABEL[it.source] ?? it.source}</Chip>
                            {it.file_key && <Chip>{Math.round(it.file_bytes / 1024)} KB file</Chip>}
                          </div>
                          {it.body && (
                            <p className="mt-2 line-clamp-3 text-[0.8125rem] whitespace-pre-wrap text-muted">
                              {it.body}
                            </p>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            await api.toggleEvidence(it.id, !it.included);
                            await load();
                          }}
                        >
                          {it.included ? <X size={14} /> : <Check size={14} strokeWidth={2.5} />}
                          {it.included ? "Exclude" : "Include"}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Zone>
          </Card>
        </div>

        {/* The decision column. One coral action on the screen, and it is here. */}
        <div className="space-y-5">
          <Card>
            <Zone label="Assessment" first>
              <Badge
                tone={
                  d.recommendation === "fight"
                    ? "success"
                    : d.recommendation === "accept"
                      ? "danger"
                      : d.recommendation === "do_not_fight"
                        ? "warning"
                        : "neutral"
                }
              >
                {d.recommendation === "fight"
                  ? "Worth fighting"
                  : d.recommendation === "accept"
                    ? "Concede this one"
                    : d.recommendation === "do_not_fight"
                      ? "Weak case"
                      : "Not scored yet"}
              </Badge>
              {verdictLine && (
                <p className="mt-3 text-[0.8125rem] text-muted">{verdictLine}</p>
              )}
              {gapLines.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {gapLines.map((g, i) => (
                    <li key={i} className="flex gap-1.5 text-[0.8125rem] text-muted">
                      <CircleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
                      {g.replace(/^Missing: /, "")}
                    </li>
                  ))}
                </ul>
              )}
            </Zone>

            <Zone label="Actions">
              <div className="space-y-2">
                <Button onClick={() => act("prepare")} disabled={Boolean(busy)}>
                  <Sparkles size={14} />
                  {busy === "prepare" ? "Assembling…" : "Assemble dossier"}
                </Button>

                <Button onClick={() => act("stage")} disabled={Boolean(busy) || Boolean(d.outcome)}>
                  <FileText size={14} />
                  {busy === "stage" ? "Staging…" : "Save as draft"}
                </Button>

                <div>
                  {/* The single coral action is whatever the assessment
                      recommends. On a dispute we are telling the merchant to
                      concede, a coral Submit would push them toward the thing
                      the panel above just argued against. */}
                  <Button
                    variant={conceding ? "secondary" : "primary"}
                    onClick={() => act("submit", conceding)}
                    disabled={Boolean(busy) || Boolean(d.outcome)}
                  >
                    <Send size={14} />
                    {busy === "submit"
                      ? "Submitting…"
                      : conceding
                        ? "Submit anyway"
                        : "Submit to the bank"}
                  </Button>
                  <p className="mt-2 text-[0.6875rem] text-muted">
                    {conceding
                      ? "This goes against the assessment above. Evidence can only be sent once."
                      : "Evidence can only be sent once, and cannot be revised afterwards."}
                  </p>
                </div>
              </div>
            </Zone>
          </Card>
        </div>
      </div>
    </div>
  );
}
