// Customer activity as evidence.
//
// The argument this module exists to make, in one sentence an issuer will
// actually read: "this account paid on the 3rd and then used the product
// eleven times between the 4th and the 19th."
//
// That sentence is worth more on a digital product than every policy document
// combined, and it is the one thing a merchant cannot assemble after the fact.
// Carrier proof of delivery has an equivalent for physical goods; a SaaS
// merchant has nothing to retrieve unless they were already recording it. So
// activity arrives continuously through `POST /api/activity`, keyed by
// customer, and is joined into the dossier when a dispute lands.
//
// The honesty rule that shapes the whole file: the claim is only ever as strong
// as the boundary we can prove. `disputes.charged_at` is nullable because not
// every processor hands over the payment date, and when it is missing we fall
// back to the dispute date and SAY SO. Substituting one for the other silently
// would manufacture the strongest sentence in the packet out of a weaker fact,
// which is exactly the kind of evidence that loses a case on review.

import { get, query, run } from "./db.js";
import { addEvidence } from "./dossier.js";
import type { CustomerActivity, Dispute } from "./types.js";

/** One event as the merchant's system posts it. */
export interface ActivityInput {
  customer_email: string;
  event_type: string;
  occurred_at: string;
  external_id?: string;
  customer_ref?: string;
  charge_ref?: string;
  detail?: string;
  artifact_url?: string;
  artifact_label?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

/** Email is the join key, so it is normalized on the way in, once. */
export function normalizeEmail(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

/**
 * Reject an unparseable timestamp rather than storing it.
 *
 * Every claim downstream is a date comparison, so a row whose `occurred_at`
 * does not parse is not a slightly-worse row: it is a row that can silently
 * drop out of one side of a comparison and change the verdict.
 */
export function normalizeTimestamp(raw: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface IngestResult {
  written: number;
  duplicates: number;
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Record activity events.
 *
 * Partial success on purpose. A merchant back-filling a year of history in
 * batches should not lose the batch because one row has a bad date, and they
 * need to be told which rows so they can fix them; an all-or-nothing insert
 * turns a typo into a silent gap in the evidence months later.
 */
export async function ingestActivity(events: ActivityInput[]): Promise<IngestResult> {
  const result: IngestResult = { written: 0, duplicates: 0, rejected: [] };

  for (const [index, e] of events.entries()) {
    const email = normalizeEmail(e.customer_email);
    if (!email) {
      result.rejected.push({ index, reason: "customer_email is required" });
      continue;
    }
    const eventType = (e.event_type || "").trim();
    if (!eventType) {
      result.rejected.push({ index, reason: "event_type is required" });
      continue;
    }
    const occurredAt = normalizeTimestamp(e.occurred_at);
    if (!occurredAt) {
      result.rejected.push({ index, reason: `occurred_at is not a parseable date: ${e.occurred_at}` });
      continue;
    }

    // A re-push of an event the merchant already sent is expected traffic, not
    // an error: retries and overlapping back-fill windows both produce it.
    const externalId = (e.external_id || "").trim();
    if (externalId) {
      const seen = await get<{ id: string }>(
        "select id from customer_activity where customer_email = ? and external_id = ?",
        [email, externalId],
      );
      if (seen) {
        result.duplicates += 1;
        continue;
      }
    }

    await run(
      `insert into customer_activity
         (id, external_id, customer_email, customer_ref, charge_ref, event_type,
          occurred_at, detail, artifact_url, artifact_label, ip, metadata)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        externalId,
        email,
        e.customer_ref ?? "",
        e.charge_ref ?? "",
        eventType,
        occurredAt,
        e.detail ?? "",
        e.artifact_url ?? "",
        e.artifact_label ?? "",
        e.ip ?? "",
        JSON.stringify(e.metadata ?? {}),
      ],
    );
    result.written += 1;
  }

  return result;
}

export interface ActivitySummary {
  /** Rendered evidence body. Empty when there is nothing truthful to say. */
  body: string;
  total: number;
  /** Events strictly after the boundary below. */
  after: number;
  /**
   * Which boundary `after` was measured from. `charge` is the strong claim;
   * `dispute` is the fallback when the processor gave us no payment date, and
   * it is named in the rendered body so nobody reads it as the strong one.
   */
  boundary: "charge" | "dispute" | "none";
  signupAt: string | null;
  artifacts: CustomerActivity[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Turn a customer's event history into the paragraph an issuer reads.
 *
 * Deliberately not a template with a slot for a percentage. The numbers are
 * counts and dates, both of which a merchant can be asked to substantiate; a
 * rate or a score would be us asserting a conclusion the record does not carry.
 */
export function summarizeActivity(
  events: CustomerActivity[],
  dispute: Pick<Dispute, "charged_at" | "opened_at">,
): ActivitySummary {
  const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const signup = sorted.find((e) => e.event_type.toLowerCase() === "signup") ?? null;
  const artifacts = sorted.filter((e) => e.artifact_url);

  const empty: ActivitySummary = {
    body: "", total: 0, after: 0, boundary: "none",
    signupAt: signup?.occurred_at ?? null, artifacts,
  };
  if (!sorted.length) return empty;

  const boundaryIso = dispute.charged_at || dispute.opened_at || "";
  const boundary: ActivitySummary["boundary"] = dispute.charged_at
    ? "charge"
    : dispute.opened_at
      ? "dispute"
      : "none";
  const after = boundaryIso
    ? sorted.filter((e) => e.occurred_at > boundaryIso).length
    : 0;

  const lines: string[] = [];
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (signup) {
    lines.push(`The account was created on ${day(signup.occurred_at)}.`);
  }

  lines.push(
    sorted.length === 1
      ? `The record holds 1 logged action, on ${day(first.occurred_at)}.`
      : `The record holds ${sorted.length} logged actions, from ${day(first.occurred_at)} to ${day(last.occurred_at)}.`,
  );

  if (boundary === "charge" && after > 0) {
    lines.push(
      after === 1
        ? `1 of those actions occurred after the payment on ${day(boundaryIso)}.`
        : `${after} of those actions occurred after the payment on ${day(boundaryIso)}.`,
    );
  } else if (boundary === "charge") {
    lines.push(
      `None of those actions occurred after the payment on ${day(boundaryIso)}, so this record does not show use of the product after purchase.`,
    );
  } else if (boundary === "dispute" && after > 0) {
    // The weaker claim, labelled as weaker. Activity after the dispute was
    // filed is still telling, but it is not the after-payment argument.
    lines.push(
      `${after === 1 ? "1 of those actions" : `${after} of those actions`} occurred after this dispute was filed on ${day(boundaryIso)}. The payment date was not available from the processor, so this count is measured from the dispute date, not from the charge.`,
    );
  } else if (boundary === "dispute") {
    lines.push(
      `The payment date was not available from the processor, so use after purchase cannot be established from this record alone.`,
    );
  }

  // A breakdown by verb, because "11 actions" invites the question and the
  // answer is already in the rows.
  const counts = new Map<string, number>();
  for (const e of sorted) counts.set(e.event_type, (counts.get(e.event_type) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${type} (${n})`)
    .join(", ");
  if (counts.size > 1) lines.push(`By type: ${breakdown}.`);

  if (artifacts.length) {
    lines.push(
      artifacts.length === 1
        ? `1 item was delivered to the customer and is listed separately.`
        : `${artifacts.length} items were delivered to the customer and are listed separately.`,
    );
  }

  return {
    body: lines.join("\n"),
    total: sorted.length,
    after,
    boundary,
    signupAt: signup?.occurred_at ?? null,
    artifacts,
  };
}

/**
 * Fold a customer's activity into a dispute's dossier.
 *
 * Regenerates rather than accumulates, exactly like the rebuttal: the merchant
 * keeps pushing events while a dispute is open, and a packet assembled twice
 * must not carry the summary twice.
 */
export async function attachActivityEvidence(disputeId: string): Promise<ActivitySummary | null> {
  const d = await get<Dispute>(
    "select id, customer_email, charged_at, opened_at from disputes where id = ?",
    [disputeId],
  );
  if (!d) return null;

  const email = normalizeEmail(d.customer_email);
  await run(
    `delete from evidence_items
      where dispute_id = ? and source = 'generated'
        and kind in ('activity_log', 'prior_usage_artifact')`,
    [disputeId],
  );
  if (!email) return null;

  const events = await query<CustomerActivity>(
    "select * from customer_activity where customer_email = ? order by occurred_at asc",
    [email],
  );
  const summary = summarizeActivity(events, d);
  if (!summary.body) return summary;

  await addEvidence(disputeId, {
    kind: "activity_log",
    source: "generated",
    title: "Account activity for this customer",
    body: summary.body,
    provenance: {
      events: summary.total,
      after_boundary: summary.after,
      boundary: summary.boundary,
      customer_email: email,
    },
  });

  // Artifacts are their own evidence kind because they are a different sort of
  // proof: not "our logs say so" but "here is the thing they took away".
  for (const a of summary.artifacts) {
    await addEvidence(disputeId, {
      kind: "prior_usage_artifact",
      source: "generated",
      title: a.artifact_label || `Delivered ${a.event_type}`,
      body: `${a.artifact_url}\nProduced ${day(a.occurred_at)}.${a.detail ? `\n${a.detail}` : ""}`,
      provenance: { activity_id: a.id, occurred_at: a.occurred_at, url: a.artifact_url },
    });
  }

  return summary;
}
