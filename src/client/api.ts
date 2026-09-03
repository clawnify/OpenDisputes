// Thin fetch layer. No client-side caching: a dispute deadline is the kind of
// thing a stale read gets wrong expensively.

const base = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export interface Dispute {
  id: string; processor: string; external_id: string; reason: string; status: string;
  amount_cents: number; currency: string; is_physical: number;
  customer_email: string; customer_name: string; order_ref: string;
  issuer_country: string; due_by: string | null; opened_at: string;
  recommendation: string; recommendation_reason: string;
  outcome: string | null; outcome_at: string | null;
}

export interface EvidenceItem {
  id: string; kind: string; source: string; title: string; body: string;
  file_key: string; file_bytes: number; included: number; collected_at: string;
}

export interface CarrierLookup {
  carrier: string; tracking: string; outcome: string;
  delivered_at: string | null; delivery_address: string;
  address_match: number | null; detail: string;
}

export const api = {
  disputes: (q: Record<string, string> = {}) =>
    req<{ disputes: Dispute[]; total: number }>(`/api/disputes?${new URLSearchParams(q)}`),

  dispute: (id: string) =>
    req<{ dispute: Dispute; items: EvidenceItem[]; carrier: CarrierLookup[] }>(`/api/disputes/${id}`),

  prepare: (id: string) =>
    req<{ recommendation: string; reason: string; carrier_lookups: number; escalated: boolean }>(
      `/api/disputes/${id}/prepare`, { method: "POST" },
    ),

  submit: (id: string, submit: boolean, override = false) =>
    req<{
      mode: string; verified: boolean; escalated: boolean;
      dropped: Array<{ id: string; title: string; why: string }>; detail: string;
    }>(`/api/disputes/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ submit, override_recommendation: override }),
    }),

  toggleEvidence: (id: string, included: boolean) =>
    req<{ ok: boolean }>(`/api/evidence/${id}`, {
      method: "PATCH", body: JSON.stringify({ included }),
    }),

  sync: () =>
    req<{ imported: number; prepared: number; sources: string[] }>(`/api/sync`, {
      method: "POST", body: JSON.stringify({ prepare: true }),
    }),

  settings: () =>
    req<{
      settings: Record<string, unknown>;
      agents: Array<{ id: string; name: string | null }> | null;
      carriers: Array<{ id: string; label: string; apiPOD: boolean; ready: boolean; missing: string[]; note: string }>;
      connected: { stripe: boolean; shopify: boolean };
    }>(`/api/settings`),

  saveSettings: (body: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/api/settings`, { method: "PUT", body: JSON.stringify(body) }),

  stats: () =>
    req<{
      totals: Record<string, number>;
      by_reason: Array<{ reason: string; decided: number; won: number }>;
      by_country: Array<{ issuer_country: string; decided: number; won: number }>;
      with_pod: Record<string, number>;
    }>(`/api/stats`),
};

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency: (currency || "USD").toUpperCase(),
  }).format(cents / 100);
}

/**
 * Deadlines are the organising fact of this app, so they are phrased as time
 * remaining rather than a date the reader has to subtract from today.
 */
export function daysLeft(dueBy: string | null): { label: string; urgent: boolean } | null {
  if (!dueBy) return null;
  const ms = new Date(dueBy).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return { label: "Past due", urgent: true };
  if (days === 0) return { label: "Due today", urgent: true };
  if (days === 1) return { label: "1 day left", urgent: true };
  return { label: `${days} days left`, urgent: days <= 3 };
}

export const REASON_LABEL: Record<string, string> = {
  fraudulent: "Fraudulent",
  unrecognized: "Unrecognized",
  duplicate: "Duplicate",
  subscription_canceled: "Subscription canceled",
  product_unacceptable: "Product unacceptable",
  product_not_received: "Not received",
  credit_not_processed: "Credit not processed",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  bank_cannot_process: "Bank cannot process",
  debit_not_authorized: "Debit not authorized",
  customer_initiated: "Customer initiated",
  general: "General",
};

export const SOURCE_LABEL: Record<string, string> = {
  processor_api: "Processor",
  carrier_api: "Carrier API",
  agent_browser: "Agent (portal)",
  merchant_upload: "You",
  generated: "Compiled",
};

export const KIND_LABEL: Record<string, string> = {
  activity_log: "Account activity",
  receipt: "Receipt",
  invoice: "Invoice",
  product_description: "Product description",
  proof_of_delivery: "Proof of delivery",
  tracking_history: "Tracking history",
  shipping_label: "Shipping record",
  customer_communication: "Customer correspondence",
  refund_policy: "Refund policy",
  cancellation_policy: "Cancellation policy",
  terms_acceptance: "Terms acceptance",
  ip_geo_match: "Purchase IP",
  prior_usage_artifact: "Delivered work",
  signature: "Signature",
  delivery_photo: "Delivery photo",
  rebuttal: "Statement",
  other: "Other",
};
