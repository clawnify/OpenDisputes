// Should this dispute be fought at all?
//
// The evidence half of that question is the bulk of this module, and it has not
// changed: a not-received claim with no delivery record, a POD whose address
// does not match the order, and a subscription that kept billing after a
// cancellation request are all conceded on the facts. Submitting those wastes
// the merchant's credibility with an issuer they will face again.
//
// The money half of the question changed under everyone on 2025-06-17, and the
// old answer is worth stating so nobody restores it from memory. It used to be
// true that Stripe charged one fee, when the dispute opened, returned only on a
// win — which made accepting cost exactly what fighting-and-losing cost, and
// made fighting never financially worse than accepting. Stripe now also charges
// a DISPUTE COUNTERED FEE when you submit evidence, on disputes initiated after
// 2025-06-17, returned only if you win: 15 USD in the US, Canada and Singapore,
// 20 EUR across most of Europe, 25 AUD in Australia, nothing in Mexico or Japan,
// and waived when the response goes through Stripe's own Smart Disputes.
//
// So the arithmetic now:
//
//   accept            lose the amount
//   counter and win   keep the amount, countered fee returned
//   counter and lose  lose the amount AND the countered fee
//
// The received fee is charged the moment the dispute opens and is sunk on both
// branches, so it correctly drops out of the decision. What is left is that
// countering risks the countered fee F to win the amount A, which breaks even
// at a win rate of
//
//   p* = F / (A + F)
//
// One trap, because the obvious rule is wrong and this module used to encode
// it: "the amount is smaller than the fee, so winning does not repay the
// attempt" is false. A WIN returns the countered fee, so a win always repays in
// full. The fee is only ever lost on the losing branch. A 10 USD dispute against
// a 15 USD fee is still worth countering at a 60% win rate.
//
// Which leaves the honest question: what IS this merchant's win rate on this
// reason code? That is measured, not assumed, and it is the one number this app
// already keeps (see /api/stats). Where the sample is too thin to mean anything
// the verdict is left alone and the threshold is merely reported, because a
// concession justified by four coin flips is worse than no concession at all.

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
  /**
   * What the processor charges to submit a response, in the dispute's currency.
   *
   * `undefined` means the merchant has not told us, which is NOT zero. An
   * unknown fee suppresses the economic verdict entirely rather than pricing
   * the decision at nothing, and says so in `gaps`.
   */
  counterFeeCents?: number;
  /**
   * This merchant's decided disputes on this reason code, from their own
   * outcome ledger. Used only to compare against the break-even win rate.
   */
  history?: { decided: number; won: number };
}

export type Verdict = "fight" | "do_not_fight" | "accept" | "pending";

export interface Triage {
  recommendation: Verdict;
  reason: string;
  /** Ordered, so the UI can show the merchant what is missing, strongest first. */
  gaps: string[];
  /**
   * The win rate at which countering stops being worth the fee, as a fraction.
   * Null when the fee is unknown, and null for a dispute the evidence concedes
   * outright, because a break-even on a case you cannot win is not a decision.
   */
  breakEvenWinRate: number | null;
}

/**
 * Below this many decided disputes on a reason code, a measured win rate is
 * noise and the module refuses to concede on it.
 *
 * Ours, not Stripe's, and stated rather than buried: ten is the point at which
 * a single outcome stops moving the rate by more than ten points. It is a
 * judgement about sample size, so it is named, exported and arguable.
 */
export const MIN_DECIDED_FOR_ECONOMICS = 10;

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
        breakEvenWinRate: null,
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
        breakEvenWinRate: null,
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
        breakEvenWinRate: null,
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
        breakEvenWinRate: null,
      };
    }
  }

  // ── Economics, only where a counter actually costs money ──────────
  //
  // Reached only by disputes the evidence has NOT already conceded, which is
  // the right order: a case that loses on the facts is not rescued by
  // arithmetic, and a case that wins on the facts should not be priced out of
  // being fought.

  const fee = input.counterFeeCents;
  const breakEven = fee === undefined ? null : breakEvenWinRate(dispute.amount_cents, fee);

  if (fee !== undefined && breakEven !== null && input.history) {
    const { decided, won } = input.history;
    const measured = decided > 0 ? won / decided : 0;
    if (decided >= MIN_DECIDED_FOR_ECONOMICS && measured < breakEven) {
      return {
        recommendation: "do_not_fight",
        reason:
          `Countering costs ${money(fee, dispute.currency)}, returned only if you win, ` +
          `so a ${money(dispute.amount_cents, dispute.currency)} dispute needs a ` +
          `${pct(breakEven)} win rate to be worth the attempt. You have won ${won} of ` +
          `${decided} ${dispute.reason} disputes (${pct(measured)}). On your own record ` +
          `this one loses money on average. The evidence does not concede it, so submit ` +
          `it anyway if you want the issuer to see you contest this reason code.`,
        gaps,
        breakEvenWinRate: breakEven,
      };
    }
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

  // Last, deliberately. `gaps` is ordered strongest-first and is read as "what
  // is missing from this packet"; a configuration prompt is neither, so it must
  // never displace a missing proof of delivery at the top of the list.
  if (fee === undefined) {
    gaps.push(
      "What your processor charges to submit a response (Settings), so this recommendation can weigh the fee",
    );
  }

  return {
    recommendation: "fight",
    reason: gaps.length
      ? "Worth contesting. The packet is submittable but incomplete — the gaps below are what issuers ask for on this reason code."
      : "Worth contesting, and the packet covers what issuers ask for on this reason code.",
    gaps,
    breakEvenWinRate: breakEven,
  };
}

/**
 * The win rate at which countering stops paying for itself.
 *
 * Countering risks the fee `F` on the losing branch to recover the amount `A`
 * on the winning one, because a win returns the fee. Break-even is therefore
 * `p·A = (1 − p)·F`, i.e. `p = F / (A + F)`.
 *
 * A zero fee (Mexico, Japan, a Smart Disputes response) breaks even at zero:
 * with nothing at stake on the losing branch there is no rate below which
 * countering is a mistake, which is the pre-2025 world this app used to assume
 * everywhere.
 */
export function breakEvenWinRate(amountCents: number, feeCents: number): number | null {
  const total = amountCents + feeCents;
  if (total <= 0) return null;
  return feeCents / total;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
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
