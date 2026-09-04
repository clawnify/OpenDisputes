import { useEffect, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { api, money, REASON_LABEL } from "../api";
import { Badge, Button, Card, Chip, Stat, Zone } from "./ui";

const AUTO_SUBMIT_CANDIDATES = [
  "product_not_received", "product_unacceptable", "subscription_canceled",
  "fraudulent", "unrecognized", "duplicate",
];

export function SettingsPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.settings>> | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.settings().then((r) => {
      setData(r);
      setForm({
        auto_submit: Boolean(r.settings.auto_submit),
        auto_submit_reasons: JSON.parse(String(r.settings.auto_submit_reasons || "[]")),
        refund_policy_text: r.settings.refund_policy_text ?? "",
        cancellation_policy_text: r.settings.cancellation_policy_text ?? "",
        product_description_text: r.settings.product_description_text ?? "",
        policy_url: r.settings.policy_url ?? "",
        // Held as a string in major units because that is how a merchant reads
        // their own fee schedule. Empty stays empty: it round-trips to null,
        // which means "not told", not "free".
        counter_fee: r.settings.counter_fee_cents === null || r.settings.counter_fee_cents === undefined
          ? ""
          : String(Number(r.settings.counter_fee_cents) / 100),
      });
    });
  }, []);

  if (!data) return <div className="p-6 text-[0.8125rem] text-muted">Loading…</div>;

  const reasons = (form.auto_submit_reasons as string[]) ?? [];
  const field = (k: string, label: string, hint: string, rows = 3) => (
    <label className="block">
      <span className="text-xs font-semibold tracking-wide text-muted">{label}</span>
      <textarea
        rows={rows}
        value={String(form[k] ?? "")}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        className="mt-1.5 w-full rounded-sm border border-border bg-surface px-2.5 py-2 text-[0.8125rem] focus:border-ring focus:outline-none"
      />
      <span className="text-[0.6875rem] text-muted">{hint}</span>
    </label>
  );

  return (
    <div className="max-w-3xl space-y-5 p-6">
      <Card>
        <Zone label="Connections" first>
          <div className="space-y-2">
            {[
              ["Stripe", data.connected.stripe, "STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET"],
              ["Shopify", data.connected.shopify, "SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_TOKEN"],
            ].map(([label, ok, env]) => (
              <div key={String(label)} className="flex items-center justify-between gap-3">
                <span className="text-[0.8125rem]">{String(label)}</span>
                {ok ? (
                  <Badge tone="success">
                    <Check size={11} strokeWidth={2.5} /> Connected
                  </Badge>
                ) : (
                  <span className="text-[0.6875rem] text-muted">Set {String(env)}</span>
                )}
              </div>
            ))}
          </div>
        </Zone>

        <Zone label="Carrier proof of delivery">
          <p className="mb-3 text-[0.8125rem] text-muted">
            Delivery records are pulled from the carrier's own API where one exists. Anything the
            API cannot serve is handed to your agent, which signs into the carrier portal instead.
          </p>
          <div className="space-y-2">
            {data.carriers.map((c) => (
              <div key={c.id} className="rounded-sm border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[0.8125rem] font-medium">{c.label}</span>
                  {c.ready ? (
                    <Badge tone="success">
                      <Check size={11} strokeWidth={2.5} /> API ready
                    </Badge>
                  ) : (
                    <Badge tone="neutral">Agent handles it</Badge>
                  )}
                </div>
                <p className="mt-1.5 text-[0.6875rem] text-muted">{c.note}</p>
                {c.missing.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.missing.map((m) => (
                      <Chip key={m}>{m}</Chip>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Zone>

        <Zone label="Policy text">
          <p className="mb-3 text-[0.8125rem] text-muted">
            Included verbatim in every submission. Write it as the customer saw it at checkout,
            not as a summary.
          </p>
          <div className="space-y-4">
            {field("product_description_text", "What you sell", "One or two sentences an issuer can understand without context.")}
            {field("refund_policy_text", "Refund policy as shown at checkout", "When and where the customer saw it.")}
            {field("cancellation_policy_text", "Cancellation policy as shown at checkout", "Including how a customer cancels.")}
            <label className="block">
              <span className="text-xs font-semibold tracking-wide text-muted">Public policy URL</span>
              <input
                value={String(form.policy_url ?? "")}
                onChange={(e) => setForm({ ...form, policy_url: e.target.value })}
                placeholder="https://example.com/legal"
                className="mt-1.5 h-9 w-full rounded-sm border border-border bg-surface px-2.5 text-[0.8125rem] focus:border-ring focus:outline-none"
              />
            </label>
          </div>
        </Zone>

        <Zone label="Response fee">
          <p className="mb-3 text-[0.8125rem] text-muted">
            What your processor charges to submit a response, returned only if you win. Stripe
            charges this on disputes opened after 17 June 2025: 15 USD in the US, Canada and
            Singapore, 20 EUR across most of Europe, 25 AUD in Australia, and nothing in Mexico
            or Japan. It decides whether a small dispute is worth countering, so leaving it blank
            makes this app say the number is missing rather than assume the counter is free.
          </p>
          <label className="block max-w-[16rem]">
            <span className="text-xs font-semibold tracking-wide text-muted">
              Fee per response
            </span>
            <input
              inputMode="decimal"
              value={String(form.counter_fee ?? "")}
              onChange={(e) => setForm({ ...form, counter_fee: e.target.value })}
              placeholder="Leave blank if you do not know"
              className="mt-1.5 h-9 w-full rounded-sm border border-border bg-surface px-2.5 text-[0.8125rem] focus:border-ring focus:outline-none"
            />
            <span className="mt-1.5 block text-xs text-muted">
              In your settlement currency. Enter 0 if your processor charges nothing.
            </span>
          </label>
        </Zone>

        <Zone label="Automation">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={Boolean(form.auto_submit)}
              onChange={(e) => setForm({ ...form, auto_submit: e.target.checked })}
              className="mt-0.5"
            />
            <span className="text-[0.8125rem]">
              Submit automatically, without waiting for me
              <span className="mt-1 block text-[0.6875rem] text-muted">
                Off by default. Evidence can only be submitted once, so an automatic mistake cannot
                be undone. Auto-submit never fires on a dispute the assessment would concede.
              </span>
            </span>
          </label>

          {Boolean(form.auto_submit) && (
            <div className="mt-4">
              <p className="mb-2 flex items-start gap-1.5 text-[0.6875rem] text-muted">
                <CircleAlert size={12} className="mt-0.5 shrink-0 text-warning" />
                Promote a reason code only once your own win rate justifies it. Check Performance first.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {AUTO_SUBMIT_CANDIDATES.map((r) => {
                  const on = reasons.includes(r);
                  return (
                    <button
                      key={r}
                      onClick={() =>
                        setForm({
                          ...form,
                          auto_submit_reasons: on ? reasons.filter((x) => x !== r) : [...reasons, r],
                        })
                      }
                      className={`rounded-sm border px-2 py-1 text-[0.6875rem] transition-colors ${
                        on
                          ? "border-primary bg-primary text-on-primary"
                          : "border-border bg-sunken text-muted"
                      }`}
                    >
                      {REASON_LABEL[r] ?? r}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </Zone>

        <Zone label="">
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              onClick={async () => {
                const raw = String(form.counter_fee ?? "").trim();
                const parsed = raw === "" ? null : Math.round(Number(raw) * 100);
                const { counter_fee: _omit, ...rest } = form;
                await api.saveSettings({
                  ...rest,
                  // A number that will not parse is not a zero fee. Sending
                  // nothing leaves the stored value alone.
                  ...(parsed !== null && !Number.isFinite(parsed)
                    ? {}
                    : { counter_fee_cents: parsed }),
                });
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
              }}
            >
              Save settings
            </Button>
            <span className="h-4 text-[0.6875rem] text-success">
              {saved ? "Saved." : ""}
            </span>
          </div>
        </Zone>
      </Card>
    </div>
  );
}

export function StatsPanel() {
  const [s, setS] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  useEffect(() => { void api.stats().then(setS); }, []);
  if (!s) return <div className="p-6 text-[0.8125rem] text-muted">Loading…</div>;

  const decided = (s.totals.won ?? 0) + (s.totals.lost ?? 0);
  const rate = decided ? Math.round(((s.totals.won ?? 0) / decided) * 100) : null;

  const podDecided = (s.with_pod.pod_won ?? 0) + (s.with_pod.pod_lost ?? 0);
  const noPodDecided = (s.with_pod.nopod_won ?? 0) + (s.with_pod.nopod_lost ?? 0);

  /** Small samples are reported as small, never rounded into a finding. */
  const pct = (won: number, total: number) =>
    total === 0 ? "—" : total < 5 ? `${won}/${total}` : `${Math.round((won / total) * 100)}%`;

  return (
    <div className="space-y-5 p-6">
      <Card>
        <Zone label="Overall" first>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat
              value={rate === null ? "—" : `${rate}%`}
              label="Win rate"
              meta={decided ? `${decided} decided` : "nothing decided yet"}
            />
            <Stat value={String(s.totals.open ?? 0)} label="Open" meta="awaiting a decision" />
            <Stat
              value={money(s.totals.recovered_cents ?? 0, "usd")}
              label="Recovered"
              meta={`${s.totals.won ?? 0} won`}
            />
            <Stat
              value={money(s.totals.lost_cents ?? 0, "usd")}
              label="Lost"
              meta={`${s.totals.lost ?? 0} lost`}
            />
          </div>
        </Zone>

        <Zone label="Does proof of delivery actually change the outcome">
          <p className="mb-3 text-[0.8125rem] text-muted">
            On your own shipped orders. This is the number that tells you whether chasing carrier
            records is worth it, and nobody else will show it to you.
          </p>
          <div className="grid grid-cols-2 gap-6">
            <Stat
              value={pct(s.with_pod.pod_won ?? 0, podDecided)}
              label="With retrieved proof of delivery"
              meta={podDecided ? `${podDecided} decided` : "no data yet"}
            />
            <Stat
              value={pct(s.with_pod.nopod_won ?? 0, noPodDecided)}
              label="Without it"
              meta={noPodDecided ? `${noPodDecided} decided` : "no data yet"}
            />
          </div>
        </Zone>

        {s.by_reason.length > 0 && (
          <Zone label="By reason code">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-2 text-left text-xs font-semibold text-muted">Reason</th>
                  <th className="pb-2 text-right text-xs font-semibold text-muted">Decided</th>
                  <th className="pb-2 text-right text-xs font-semibold text-muted">Won</th>
                </tr>
              </thead>
              <tbody>
                {s.by_reason.map((r) => (
                  <tr key={r.reason} className="border-b border-border last:border-0">
                    <td className="py-2 text-[0.8125rem]">{REASON_LABEL[r.reason] ?? r.reason}</td>
                    <td className="tnum py-2 text-right text-[0.8125rem]">{r.decided}</td>
                    <td className="tnum py-2 text-right text-[0.8125rem]">{pct(r.won, r.decided)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Zone>
        )}

        {s.by_country.length > 0 && (
          <Zone label="By issuer country">
            <div className="flex flex-wrap gap-2">
              {s.by_country.map((c) => (
                <div key={c.issuer_country} className="rounded-sm border border-border px-2.5 py-1.5">
                  <span className="text-[0.8125rem] font-medium">{c.issuer_country}</span>
                  <span className="tnum ml-2 text-[0.8125rem] text-muted">
                    {pct(c.won, c.decided)} of {c.decided}
                  </span>
                </div>
              ))}
            </div>
          </Zone>
        )}
      </Card>
    </div>
  );
}
