// Stripe adapter.
//
// Two pieces of Stripe's dispute API decide the shape of everything here, and
// both are easy to get wrong in a way that fails silently:
//
// 1. Nine evidence fields accept ONLY an uploaded file id. Writing a sentence
//    into `service_documentation` does not error loudly at the useful moment —
//    it just means the strongest slot in the packet carries nothing.
// 2. Updating any field submits ALL of them, and evidence can be submitted
//    once. Hence `submit: false` staging, which Stripe supports natively and
//    which this app defaults to.

import type { Dispute, EvidenceItem, Settings } from "../types.js";

const API = "https://api.stripe.com/v1";

/**
 * Evidence fields that take a Stripe file id and nothing else. Text written
 * here is accepted by the API and then worth nothing to the bank, which is why
 * the mapper asserts against this set rather than trusting call sites.
 */
export const STRIPE_FILE_FIELDS: ReadonlySet<string> = new Set([
  "cancellation_policy",
  "customer_communication",
  "customer_signature",
  "duplicate_charge_documentation",
  "receipt",
  "refund_policy",
  "service_documentation",
  "shipping_documentation",
  "uncategorized_file",
]);

/** Stripe caps the combined character count of the evidence hash. */
export const STRIPE_EVIDENCE_CHAR_LIMIT = 150_000;

/** Stripe rejects dispute-evidence uploads above 5MB. */
export const STRIPE_FILE_BYTE_LIMIT = 5 * 1024 * 1024;

export interface StripeEnv {
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export class StripeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "StripeError";
  }
}

/** Stripe wants form-encoded bodies with bracket notation for nested objects. */
function encode(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      out.push(...encode(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

async function call(
  env: StripeEnv,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  if (!env.STRIPE_API_KEY) throw new StripeError("STRIPE_API_KEY is not set");
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_API_KEY}`,
      ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(init.body ? { body: encode(init.body).join("&") } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new StripeError(err?.message ?? `Stripe ${res.status}`, res.status);
  }
  return body;
}

// ── Evidence mapping ────────────────────────────────────────────────
//
// The dossier is neutral; this is where it becomes Stripe's vocabulary.

export interface MappedEvidence {
  evidence: Record<string, string>;
  /** Items that made it in, so the submission row can record exactly what was sent. */
  usedItemIds: string[];
  /** Items dropped, with why — surfaced in the UI rather than swallowed. */
  dropped: Array<{ id: string; title: string; why: string }>;
}

/** Which dossier kind fills which Stripe text field. */
const TEXT_FIELD_FOR: Partial<Record<EvidenceItem["kind"], string>> = {
  activity_log: "access_activity_log",
  product_description: "product_description",
  tracking_history: "shipping_tracking_number",
  rebuttal: "uncategorized_text",
};

/** Which dossier kind fills which Stripe file field. */
const FILE_FIELD_FOR: Partial<Record<EvidenceItem["kind"], string>> = {
  receipt: "receipt",
  invoice: "receipt",
  proof_of_delivery: "shipping_documentation",
  shipping_label: "shipping_documentation",
  delivery_photo: "uncategorized_file",
  signature: "customer_signature",
  customer_communication: "customer_communication",
  refund_policy: "refund_policy",
  cancellation_policy: "cancellation_policy",
  prior_usage_artifact: "service_documentation",
};

/**
 * Build Stripe's evidence hash from the dossier.
 *
 * `fileIds` maps evidence_item id → the Stripe file id it was uploaded as.
 * Items with a file that has not been uploaded yet are dropped rather than
 * silently stringified into a file-only field — the failure mode this whole
 * module exists to prevent.
 */
export function mapDossierToStripe(
  dispute: Dispute,
  items: EvidenceItem[],
  settings: Settings,
  fileIds: Record<string, string>,
): MappedEvidence {
  const evidence: Record<string, string> = {};
  const usedItemIds: string[] = [];
  const dropped: MappedEvidence["dropped"] = [];

  // Facts Stripe wants in their own named slots, straight off the dispute.
  if (dispute.customer_name) evidence.customer_name = dispute.customer_name;
  if (dispute.customer_email) evidence.customer_email_address = dispute.customer_email;
  if (settings.product_description_text) {
    evidence.product_description = settings.product_description_text;
  }
  if (settings.refund_policy_text) {
    evidence.refund_policy_disclosure = settings.refund_policy_text;
  }
  if (settings.cancellation_policy_text) {
    evidence.cancellation_policy_disclosure = settings.cancellation_policy_text;
  }

  for (const item of items) {
    if (!item.included) continue;

    const isFile = Boolean(item.file_key);
    const field = isFile ? FILE_FIELD_FOR[item.kind] : TEXT_FIELD_FOR[item.kind];

    if (!field) {
      // No dedicated slot. Text folds into the rebuttal; a file has nowhere
      // safe to go except the uncategorized slot, and only if it is free.
      if (!isFile && item.body) {
        evidence.uncategorized_text = [evidence.uncategorized_text, item.body]
          .filter(Boolean)
          .join("\n\n");
        usedItemIds.push(item.id);
      } else if (isFile && !evidence.uncategorized_file && fileIds[item.id]) {
        evidence.uncategorized_file = fileIds[item.id];
        usedItemIds.push(item.id);
      } else {
        dropped.push({ id: item.id, title: item.title, why: "no free Stripe field for this item" });
      }
      continue;
    }

    if (isFile) {
      const fileId = fileIds[item.id];
      if (!fileId) {
        dropped.push({ id: item.id, title: item.title, why: "file not uploaded to Stripe yet" });
        continue;
      }
      // One file per field. A second POD is real evidence with nowhere to go,
      // so say so rather than overwrite the first.
      if (evidence[field]) {
        dropped.push({ id: item.id, title: item.title, why: `${field} already holds another file` });
        continue;
      }
      evidence[field] = fileId;
      usedItemIds.push(item.id);
      continue;
    }

    // Text into a text field. The guard is the point of STRIPE_FILE_FIELDS.
    if (STRIPE_FILE_FIELDS.has(field)) {
      dropped.push({ id: item.id, title: item.title, why: `${field} accepts files only` });
      continue;
    }
    evidence[field] = evidence[field] ? `${evidence[field]}\n\n${item.body}` : item.body;
    usedItemIds.push(item.id);
  }

  // Trim to Stripe's combined character budget. Trimming the rebuttal is the
  // right sacrifice: it is prose we generated, while the activity log is
  // retrieved fact.
  let total = Object.values(evidence).join("").length;
  if (total > STRIPE_EVIDENCE_CHAR_LIMIT && evidence.uncategorized_text) {
    const excess = total - STRIPE_EVIDENCE_CHAR_LIMIT;
    evidence.uncategorized_text = evidence.uncategorized_text.slice(0, Math.max(0, evidence.uncategorized_text.length - excess - 20)) + "\n[truncated]";
    total = Object.values(evidence).join("").length;
  }
  if (total > STRIPE_EVIDENCE_CHAR_LIMIT && evidence.access_activity_log) {
    const excess = total - STRIPE_EVIDENCE_CHAR_LIMIT;
    evidence.access_activity_log = evidence.access_activity_log.slice(0, Math.max(0, evidence.access_activity_log.length - excess - 20)) + "\n[truncated]";
  }

  return { evidence, usedItemIds, dropped };
}

// ── Calls ───────────────────────────────────────────────────────────

export async function getDispute(env: StripeEnv, id: string) {
  return call(env, `/disputes/${id}`);
}

export async function listDisputes(env: StripeEnv, startingAfter?: string) {
  const q = new URLSearchParams({ limit: "100" });
  if (startingAfter) q.set("starting_after", startingAfter);
  return call(env, `/disputes?${q}`);
}

export async function getCharge(env: StripeEnv, id: string) {
  return call(env, `/charges/${id}`);
}

/**
 * Upload a file for dispute evidence. Refuses oversize input here rather than
 * letting Stripe reject it mid-submission, when part of the packet has already
 * been built.
 */
export async function uploadFile(
  env: StripeEnv,
  file: { data: Uint8Array; filename: string; mime: string },
): Promise<string> {
  if (!env.STRIPE_API_KEY) throw new StripeError("STRIPE_API_KEY is not set");
  if (file.data.byteLength > STRIPE_FILE_BYTE_LIMIT) {
    throw new StripeError(
      `${file.filename} is ${(file.data.byteLength / 1024 / 1024).toFixed(1)}MB; Stripe caps dispute evidence at 5MB`,
    );
  }
  const form = new FormData();
  form.append("purpose", "dispute_evidence");
  form.append("file", new Blob([file.data as BlobPart], { type: file.mime }), file.filename);

  const res = await fetch("https://files.stripe.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new StripeError(err?.message ?? `Stripe file upload ${res.status}`, res.status);
  }
  return String(body.id);
}

/**
 * Stage or submit evidence.
 *
 * `submit: false` is Stripe's own staging mode — the evidence is visible in the
 * API and the Dashboard but has not gone to the bank, and can still be changed.
 * This app defaults to it, because the submitted path is one-way.
 */
export async function putEvidence(
  env: StripeEnv,
  disputeId: string,
  evidence: Record<string, string>,
  opts: { submit: boolean },
): Promise<Record<string, unknown>> {
  return call(env, `/disputes/${disputeId}`, {
    method: "POST",
    body: { evidence, submit: opts.submit ? "true" : "false" },
  });
}

// ── Webhook verification ────────────────────────────────────────────

/**
 * Verify Stripe's signature header. Constant-time compare, and a timestamp
 * tolerance so a captured payload cannot be replayed indefinitely.
 */
export async function verifyWebhook(
  secret: string,
  payload: string,
  header: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, ...v] = p.split("=");
      return [k.trim(), v.join("=")];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ── Early fraud warnings ────────────────────────────────────────────

/**
 * List early fraud warnings.
 *
 * Note what is NOT a parameter: `actionable`. Stripe's list endpoint filters
 * only by `charge`, `payment_intent` and `created`, so the "is there still a
 * decision to make" flag has to be read off each object rather than asked for.
 * Filtering server-side and paging on the remainder would silently skip pages.
 */
export async function listEarlyFraudWarnings(env: StripeEnv, startingAfter?: string) {
  const q = new URLSearchParams({ limit: "100" });
  if (startingAfter) q.set("starting_after", startingAfter);
  return call(env, `/radar/early_fraud_warnings?${q}`);
}

/**
 * Refund a charge in full.
 *
 * Full-amount only, and that is a correctness constraint rather than a
 * simplification. Stripe: "customers can't dispute fully refunded payments,
 * [but] they can still dispute partially refunded payments. Card network rules
 * even allow for a payment that has been partially refunded to be disputed for
 * the full payment amount." A partial refund therefore buys no protection at
 * all while still costing money, so no `amount` is ever sent.
 *
 * `reason: "fraudulent"` is opt-in because it is not merely a label: Stripe
 * "will add the associated card and email to your block lists". That is
 * usually what a merchant wants for a confirmed-fraud EFW and occasionally
 * very much not, so the caller decides and the UI says what it does.
 */
export async function refundCharge(
  env: StripeEnv,
  chargeId: string,
  opts: { markFraudulent: boolean; metadata?: Record<string, string> },
): Promise<Record<string, unknown>> {
  return call(env, "/refunds", {
    method: "POST",
    body: {
      charge: chargeId,
      ...(opts.markFraudulent ? { reason: "fraudulent" } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    },
  });
}
