// Shared vocabulary. Nothing here is named after a processor field — that is
// the point of the layer.

/** Normalized dispute reason. Stripe `reason` and Shopify `type` both map here. */
export type Reason =
  | "fraudulent"
  | "unrecognized"
  | "duplicate"
  | "subscription_canceled"
  | "product_unacceptable"
  | "product_not_received"
  | "credit_not_processed"
  | "incorrect_account_details"
  | "insufficient_funds"
  | "bank_cannot_process"
  | "debit_not_authorized"
  | "customer_initiated"
  | "general";

export type Processor = "stripe" | "shopify";

export type EvidenceKind =
  | "activity_log"
  | "receipt"
  | "invoice"
  | "product_description"
  | "proof_of_delivery"
  | "tracking_history"
  | "shipping_label"
  | "customer_communication"
  | "refund_policy"
  | "cancellation_policy"
  | "terms_acceptance"
  | "ip_geo_match"
  | "prior_usage_artifact"
  | "signature"
  | "delivery_photo"
  | "rebuttal"
  | "other";

/**
 * How a piece of evidence was obtained. Ordered by what an issuer weighs it at:
 * a carrier's own API record outranks a screenshot of the same fact, and a
 * generated rebuttal is an assertion rather than a retrieval.
 */
export type EvidenceSource =
  | "processor_api"
  | "carrier_api"
  | "agent_browser"
  | "merchant_upload"
  | "generated";

export interface EvidenceItem {
  id: string;
  dispute_id: string;
  kind: EvidenceKind;
  source: EvidenceSource;
  title: string;
  body: string;
  file_key: string;
  file_mime: string;
  file_bytes: number;
  provenance: string;
  included: number;
  collected_at: string;
}

export interface Dispute {
  id: string;
  processor: Processor;
  external_id: string;
  reason: Reason;
  status: string;
  amount_cents: number;
  currency: string;
  is_physical: number;
  customer_email: string;
  customer_name: string;
  order_ref: string;
  charge_ref: string;
  issuer_country: string;
  due_by: string | null;
  /** When the customer paid. Null when the processor did not give it up. */
  charged_at: string | null;
  opened_at: string;
  recommendation: "pending" | "fight" | "do_not_fight" | "accept";
  recommendation_reason: string;
  outcome: "won" | "lost" | "warning_closed" | null;
  outcome_at: string | null;
  raw: string;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  id: number;
  auto_submit: number;
  auto_submit_reasons: string;
  refund_policy_text: string;
  cancellation_policy_text: string;
  product_description_text: string;
  policy_url: string;
  agent_server_id: string;
  updated_at: string;
}

/** Reasons that are about delivery of a physical thing, not about a charge. */
export const DELIVERY_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  "product_not_received",
  "product_unacceptable",
]);

export function isReason(v: string): v is Reason {
  return [
    "fraudulent", "unrecognized", "duplicate", "subscription_canceled",
    "product_unacceptable", "product_not_received", "credit_not_processed",
    "incorrect_account_details", "insufficient_funds", "bank_cannot_process",
    "debit_not_authorized", "customer_initiated", "general",
  ].includes(v);
}

export function normalizeReason(raw: string): Reason {
  const v = (raw || "").toLowerCase().trim();
  return isReason(v) ? v : "general";
}

/**
 * One thing the customer did in the product, as their own system reported it.
 * Keyed by customer rather than by dispute: see activity.ts.
 */
export interface CustomerActivity {
  id: string;
  external_id: string;
  customer_email: string;
  customer_ref: string;
  charge_ref: string;
  event_type: string;
  occurred_at: string;
  detail: string;
  artifact_url: string;
  artifact_label: string;
  ip: string;
  metadata: string;
  created_at: string;
}
