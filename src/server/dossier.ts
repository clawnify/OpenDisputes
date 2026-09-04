// Dossier assembly — the layer between "a dispute arrived" and "here is a
// packet a bank can read".
//
// Everything here is processor-agnostic on purpose. The adapters know about
// Stripe and Shopify; this file knows only about disputes, evidence and
// carriers, which is what lets a merchant on both processors keep one mental
// model and one set of outcome statistics.

import { get, query, run } from "./db.js";
import { triage, type CarrierSignal } from "./triage.js";
import { CARRIERS, matchAddress, normalizeCarrier, retrievePOD } from "./carriers/index.js";
import type { CarrierEnv } from "./carriers/types.js";
import { carrierPODBrief, dispatchTask, type AgentEnv } from "./agent.js";
import type { Dispute, EvidenceItem, EvidenceKind, EvidenceSource, Settings } from "./types.js";

/** A merchant's decided record on one reason code, as triage reads it. */
type TriageHistory = { decided: number; won: number };

export interface DossierEnv extends CarrierEnv, AgentEnv {
  APP_URL?: string;
  /** R2 bucket the platform binds when `app.storage` is set in clawnify.json. */
  UPLOADS?: R2Bucket;
}

export interface Dossier {
  dispute: Dispute;
  items: EvidenceItem[];
  carrier: CarrierSignal[];
}

export async function settings(): Promise<Settings> {
  const s = await get<Settings>("select * from settings where id = 1");
  if (!s) throw new Error("settings row missing — schema.sql was not applied");
  return s;
}

export async function loadDossier(disputeId: string): Promise<Dossier | null> {
  const dispute = await get<Dispute>("select * from disputes where id = ?", [disputeId]);
  if (!dispute) return null;

  const items = await query<EvidenceItem>(
    "select * from evidence_items where dispute_id = ? order by collected_at asc",
    [disputeId],
  );
  const carrier = await query<CarrierSignal & { carrier: string; tracking: string }>(
    "select outcome, address_match, delivered_at, detail, carrier, tracking from carrier_lookups where dispute_id = ? order by created_at asc",
    [disputeId],
  );
  return { dispute, items, carrier };
}

export async function addEvidence(
  disputeId: string,
  item: {
    kind: EvidenceKind;
    source: EvidenceSource;
    title: string;
    body?: string;
    file_key?: string;
    file_mime?: string;
    file_bytes?: number;
    provenance?: Record<string, unknown>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await run(
    `insert into evidence_items
       (id, dispute_id, kind, source, title, body, file_key, file_mime, file_bytes, provenance)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      disputeId,
      item.kind,
      item.source,
      item.title,
      item.body ?? "",
      item.file_key ?? "",
      item.file_mime ?? "",
      item.file_bytes ?? 0,
      JSON.stringify(item.provenance ?? {}),
    ],
  );
  return id;
}

/**
 * Re-run triage and persist the verdict.
 *
 * Called on intake and again whenever evidence lands, because the answer
 * genuinely changes: a dispute with no delivery record is a concession until
 * the moment a signed POD arrives, and a merchant who saw the first verdict
 * must see the second.
 */
export async function refreshTriage(disputeId: string): Promise<void> {
  const d = await loadDossier(disputeId);
  if (!d) return;
  const s = await settings();
  const history = await winRateByReason(d.dispute.reason);
  await persistVerdict(d, s, history);
}

/**
 * The merchant's decided record per reason code.
 *
 * Open disputes are excluded by the outcome filter, so a dispute being scored
 * never votes on itself. One row per reason so the bulk path can load the whole
 * table in a single query instead of once per dispute.
 */
async function winRateHistory(reason?: string): Promise<Map<string, TriageHistory>> {
  const rows = await query<{ reason: string; decided: number; won: number }>(
    `select reason,
            count(*) as decided,
            sum(case when outcome = 'won' then 1 else 0 end) as won
       from disputes
      where outcome in ('won', 'lost') ${reason ? "and reason = ?" : ""}
      group by reason`,
    reason ? [reason] : [],
  );
  return new Map(
    rows.map((r) => [r.reason, { decided: Number(r.decided), won: Number(r.won ?? 0) }]),
  );
}

async function winRateByReason(reason: string): Promise<TriageHistory | undefined> {
  return (await winRateHistory(reason)).get(reason);
}

/** Score one dossier and write the verdict. The ONLY place a verdict is made. */
async function persistVerdict(
  d: Dossier,
  s: Settings,
  history: TriageHistory | undefined,
): Promise<void> {
  const t = triage({
    ...d,
    // Null in settings means "not told", and undefined is how triage reads
    // that. Coercing it to 0 here would restore the bug this replaced.
    counterFeeCents: s.counter_fee_cents ?? undefined,
    history,
  });
  await run(
    "update disputes set recommendation = ?, recommendation_reason = ?, updated_at = datetime('now') where id = ?",
    [t.recommendation, [t.reason, ...t.gaps.map((g) => `Missing: ${g}`)].join("\n"), d.dispute.id],
  );
}

/**
 * Re-score every open dispute, for a settings change that moves the verdict.
 *
 * Bulk because the per-dispute path costs six D1 round trips and D1 calls count
 * against the Worker's 10,000-subrequest budget, which put the naive loop's
 * ceiling at ~1,666 open disputes. That is not a hypothetical: a merchant doing
 * 100k orders a month at a 0.5% dispute rate carries ~1,500 open at once, since
 * a dispute stays open until the bank rules and that takes up to three months.
 * Worse than the ceiling was the shape of the failure — the loop died partway,
 * leaving some disputes scored on the new fee and some on the old, with nothing
 * recording which.
 *
 * So the reads are hoisted out: three joins over the open set plus settings and
 * the history table, regardless of how many disputes there are. The joins carry
 * no bound parameters on purpose, which sidesteps D1's ~100-parameter limit
 * without chunking the reads.
 *
 * shortcut: the WRITES are still one statement per dispute, so the ceiling is
 * now ~10,000 open disputes rather than unbounded. Collapse them into chunked
 * CASE updates if a merchant ever approaches that.
 */
export async function rescoreOpenDisputes(): Promise<number> {
  const open = await query<Dispute>("select * from disputes where outcome is null");
  if (!open.length) return 0;

  const s = await settings();
  const history = await winRateHistory();

  // No bound params: join against the open set rather than listing its ids.
  const items = await query<EvidenceItem>(
    `select e.* from evidence_items e
       join disputes d on d.id = e.dispute_id
      where d.outcome is null order by e.collected_at asc`,
  );
  const carrier = await query<CarrierSignal & { dispute_id: string }>(
    `select c.dispute_id, c.outcome, c.address_match, c.delivered_at, c.detail
       from carrier_lookups c
       join disputes d on d.id = c.dispute_id
      where d.outcome is null order by c.created_at asc`,
  );

  const byDispute = <T extends { dispute_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.dispute_id);
      if (list) list.push(r);
      else m.set(r.dispute_id, [r]);
    }
    return m;
  };
  const itemsBy = byDispute(items);
  const carrierBy = byDispute(carrier);

  for (const dispute of open) {
    await persistVerdict(
      {
        dispute,
        items: itemsBy.get(dispute.id) ?? [],
        carrier: carrierBy.get(dispute.id) ?? [],
      },
      s,
      history.get(dispute.reason),
    );
  }
  return open.length;
}

/**
 * Try to establish delivery for every tracked shipment on a dispute.
 *
 * API first. Anything the API structurally cannot serve — no shipper account,
 * no POD API for that carrier — is handed to the browser agent rather than
 * retried, because retrying a missing account number never succeeds.
 */
export async function gatherCarrierEvidence(
  env: DossierEnv,
  dispute: Dispute,
  shipments: Array<{ carrier: string; tracking: string }>,
  orderAddress: { address1?: string | null; city?: string | null; zip?: string | null },
  agentServerId?: string,
): Promise<void> {
  for (const s of shipments) {
    const carrier = normalizeCarrier(s.carrier);
    const result = await retrievePOD(env, carrier, s.tracking);

    let addressMatch: number | null = null;
    let deliveryAddress = "";
    if (result.deliveryAddress) {
      deliveryAddress = [
        result.deliveryAddress.address1,
        result.deliveryAddress.city,
        result.deliveryAddress.zip,
      ]
        .filter(Boolean)
        .join(", ");
      const m = matchAddress(orderAddress, result.deliveryAddress);
      // A weak comparison is recorded as "not evaluated" rather than a failed
      // match: the triage guard treats 0 as evidence for the cardholder, and a
      // carrier that simply returned no street must not trigger that.
      addressMatch = m.confidence === "weak" ? null : m.match ? 1 : 0;
    }

    let evidenceItemId: string | null = null;
    if (result.document) {
      // Stored once, uploaded to whichever processor needs it at submission
      // time. Keeping the bytes ours means a POD survives being submitted to
      // one processor and re-used if the merchant later moves.
      const key = `pod/${dispute.id}/${carrier}-${s.tracking}.pdf`;
      if (env.UPLOADS) {
        await env.UPLOADS.put(key, result.document.data as unknown as ArrayBuffer, {
          httpMetadata: { contentType: result.document.mime },
        });
      }
      evidenceItemId = await addEvidence(dispute.id, {
        kind: "proof_of_delivery",
        source: "carrier_api",
        title: `${CARRIERS[carrier]?.label ?? carrier.toUpperCase()} proof of delivery — ${s.tracking}`,
        file_key: key,
        file_mime: result.document.mime,
        file_bytes: result.document.data.byteLength,
        provenance: { carrier, tracking: s.tracking, signedBy: result.signedBy ?? null },
      });
    }

    await run(
      `insert into carrier_lookups
         (id, dispute_id, carrier, tracking, channel, outcome, delivered_at,
          delivery_address, address_match, evidence_item_id, detail)
       values (?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), dispute.id, carrier, s.tracking, result.outcome,
        result.deliveredAt ?? null, deliveryAddress, addressMatch, evidenceItemId, result.detail,
      ],
    );

    // The escalation. Only for the two outcomes a browser can actually fix —
    // an API that says "not delivered" is an answer, not a failure.
    if (result.outcome === "no_account" || result.outcome === "unsupported") {
      const dispatch = await dispatchTask(env, {
        instruction: carrierPODBrief({
          disputeId: dispute.id,
          carrier: CARRIERS[carrier]?.label ?? s.carrier,
          tracking: s.tracking,
          orderAddress: [orderAddress.address1, orderAddress.city, orderAddress.zip]
            .filter(Boolean)
            .join(", "),
          whyEscalated: result.detail,
          appUrl: env.APP_URL ?? "",
        }),
        serverId: agentServerId || null,
        idempotencyKey: `pod:${dispute.id}:${carrier}:${s.tracking}`,
      });
      if (dispatch.ok) {
        await run(
          "update carrier_lookups set agent_task_id = ? where dispute_id = ? and tracking = ? and channel = 'api'",
          [dispatch.taskId, dispute.id, s.tracking],
        );
      }
    }
  }
}

/**
 * The narrative paragraph.
 *
 * Written from the record rather than from a template with blanks, because a
 * rebuttal that asserts facts the dossier does not contain is worse than none:
 * an issuer that catches one unsupported claim discounts the whole packet.
 */
export function buildRebuttal(d: Dossier, s: Settings): string {
  const { dispute, items, carrier } = d;
  const lines: string[] = [];

  const delivered = carrier.find(
    (c) => c.outcome === "delivered_with_pod" || c.outcome === "delivered_no_pod",
  );

  if (dispute.is_physical && delivered) {
    lines.push(
      `The order was shipped and the carrier's own record confirms delivery${
        delivered.delivered_at ? ` on ${delivered.delivered_at}` : ""
      }${delivered.address_match === 1 ? " to the address on the order" : ""}.`,
    );
    if (carrier.some((c) => c.outcome === "delivered_with_pod")) {
      lines.push("A signed or photographed proof of delivery is attached.");
    }
  }

  const activity = items.find((i) => i.kind === "activity_log" && i.included);
  if (activity) {
    lines.push(
      "The account shows use after the charge. The activity record is included in full rather than summarized.",
    );
  }

  if (!items.some((i) => i.kind === "customer_communication" && i.included)) {
    // The single most repeated winning argument, and it is only honest when
    // there genuinely is no correspondence on file.
    lines.push(
      "The cardholder did not contact us to request a refund or raise a problem before filing this dispute.",
    );
  }

  if (s.refund_policy_text) {
    lines.push(
      `The refund policy was presented at checkout${s.policy_url ? ` and is published at ${s.policy_url}` : ""}.`,
    );
  }

  return lines.join(" ");
}
