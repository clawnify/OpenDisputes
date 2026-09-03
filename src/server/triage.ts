// Should this dispute be fought at all?
//
// A correction worth stating, because the intuitive answer is wrong. On Stripe
// the dispute fee is charged when the dispute opens and refunded only on a win.
// Accepting therefore costs the same as fighting and losing: amount + fee.
// Fighting is never financially worse than accepting, so "the amount is too
// small to bother" is not, by itself, a reason to concede.
//
// What IS a reason to concede is evidence pointing the other way, and that is
// what this module looks for. Three of these come straight from merchants who
// learned them expensively: a not-received claim with no delivery record, a POD
// whose address does not match the order, and a subscription that kept billing
// after a cancellation request. Submitting those wastes the merchant's
// credibility with an issuer they will face again.
//
// The one economic lever left is `counterFeeCents`: some processors charge to
// submit a response. Where that is real, a small dispute genuinely can be -EV,
// so it is a configured number rather than a hardcoded assumption.

import type { Dispute, EvidenceItem, Reason } from "./types.js";

export interface CarrierSignal {
  outcome: string;
  address_match: number | null;
  delivered_at: string | null;
  detail: string;
}

export interface TriageInput {
  dispute: Dispute;
  items: EvidenceItem[];
  carrier: CarrierSignal[];
  /** Per-submission fee the processor charges, if any. 0 for Stripe today. */
  counterFeeCents?: number;
}

export type Verdict = "fight" | "do_not_fight" | "accept" | "pending";

export interface Triage {
  recommendation: Verdict;
  reason: string;
  /** Ordered, so the UI can show the merchant what is missing, strongest first. */
  gaps: string[];
}

const has = (items: EvidenceItem[], kind: EvidenceItem["kind"]) =>
  items.some((i) => i.kind === kind && i.included);

export function triage(input: TriageInput): Triage {
  const { dispute, items, carrier } = input;
  const gaps: string[] = [];

  // ── Hard concessions: the evidence argues for the cardholder ──────

  if (dispute.is_physical) {
    const pod = carrier.filter((c) => c.outcome !== "error");

    const mismatch = pod.find((c) => c.address_match === 0);
    if (mismatch) {
      return {
        recommendation: "accept",
        reason: `Carrier delivered to a different address than the order (${mismatch.detail}). This argues for the cardholder; submitting it would hand the issuer the counter-argument.`,
        gaps,
      };
    }

    const notDelivered = pod.some((c) => c.outcome === "not_delivered");
    const anyDelivered = pod.some(
      (c) => c.outcome === "delivered_with_pod" || c.outcome === "delivered_no_pod",
    );
    if (notDelivered && !anyDelivered) {
      return {
        recommendation: "accept",
        reason:
          "The carrier does not show this parcel as delivered. A not-received claim with no delivery record is the clearest losing case there is.",
        gaps,
      };
    }
  }

  // Billing that continued past a cancellation request is not arguable; the
  // customer is right, and an issuer can see the dates as well as we can.
  if (dispute.reason === "subscription_canceled") {
    const rebutted = has(items, "activity_log") || has(items, "customer_communication");
    if (!rebutted) {
      return {
        recommendation: "accept",
        reason:
          "Nothing on file shows use after the cancellation request, or a record of what the customer was told. Without one of those, a canceled-subscription dispute is conceded on the facts.",
        gaps: ["Post-cancellation activity log", "The cancellation conversation"],
      };
    }
  }

  // ── Weak cases: winnable in principle, not with what is here ──────

  if (dispute.reason === "fraudulent" || dispute.reason === "unrecognized") {
    const identity = has(items, "ip_geo_match") || has(items, "terms_acceptance");
    const delivery = carrier.some((c) => c.outcome === "delivered_with_pod");
    const usage = has(items, "activity_log") || has(items, "prior_usage_artifact");

    if (!identity && !delivery && !usage) {
      return {
        recommendation: "do_not_fight",
        reason:
          "A fraud claim needs something tying the cardholder to the purchase — a matching IP or billing geo, signed delivery, or account activity after payment. None of those are on file.",
        gaps: [
          "Checkout IP and whether it matches the billing address",
          "Signed proof of delivery",
          "Account activity after the charge",
        ],
      };
    }
  }

  // ── Economics, only where a counter actually costs money ──────────

  const fee = input.counterFeeCents ?? 0;
  if (fee > 0 && dispute.amount_cents <= fee) {
    return {
      recommendation: "do_not_fight",
      reason: `The disputed amount (${money(dispute.amount_cents, dispute.currency)}) does not exceed the ${money(fee, dispute.currency)} response fee, so winning does not repay the attempt.`,
      gaps,
    };
  }

  // ── Fight, and say what would make it stronger ────────────────────

  if (dispute.is_physical) {
    // Two different failures that look the same in the carrier log: never
    // obtained, versus obtained and then left out of the packet. Only the
    // second is the merchant's own doing, and it is silent unless named —
    // gaps describe what will be SENT, not what was retrieved.
    const podRetrieved = carrier.some((c) => c.outcome === "delivered_with_pod");
    const podIncluded = has(items, "proof_of_delivery");
    if (!podRetrieved) {
      gaps.push("Signed or photographed proof of delivery from the carrier");
    } else if (!podIncluded) {
      gaps.push("A proof of delivery was retrieved but is excluded from this packet");
    }
    if (!has(items, "tracking_history")) gaps.push("Full tracking history, not just the number");
  } else {
    if (!has(items, "activity_log")) gaps.push("Account activity showing use after the charge");
    if (!has(items, "prior_usage_artifact")) {
      gaps.push("Artifacts the customer actually received or produced");
    }
  }
  if (!has(items, "customer_communication")) gaps.push("Any conversation with the customer");
  if (!has(items, "refund_policy")) gaps.push("The refund policy as it was shown at checkout");

  return {
    recommendation: "fight",
    reason: gaps.length
      ? "Worth contesting. The packet is submittable but incomplete — the gaps below are what issuers ask for on this reason code."
      : "Worth contesting, and the packet covers what issuers ask for on this reason code.",
    gaps,
  };
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/**
 * Whether the merchant's auto-submit policy covers this dispute.
 *
 * Auto-submit is deliberately narrow: it never fires on a dispute triage would
 * concede, and never on one the merchant has not explicitly promoted by reason
 * code. Blanket automation is how merchants end up submitting the losing cases
 * too, which costs them nothing in fees and a great deal in issuer credibility.
 */
export function shouldAutoSubmit(
  verdict: Verdict,
  reason: Reason,
  settings: { auto_submit: number; auto_submit_reasons: string },
): boolean {
  if (!settings.auto_submit) return false;
  if (verdict !== "fight") return false;
  let allowed: string[] = [];
  try {
    const parsed: unknown = JSON.parse(settings.auto_submit_reasons || "[]");
    allowed = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return false;
  }
  return allowed.includes(reason);
}
