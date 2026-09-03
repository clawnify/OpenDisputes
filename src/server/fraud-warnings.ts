// Early fraud warnings: the dispute you can still prevent.
//
// An EFW is the issuer telling Visa, Mastercard or JCB that a payment looks
// fraudulent, and Stripe passing that on before any chargeback exists. It is
// the one point in the lifecycle where the merchant still has a choice, and it
// closes the moment a dispute arrives.
//
// Stripe's own guidance is the spine of this module, and it is NOT the rule
// most merchants apply. The instinct is to refund every warning; Stripe's
// stated test is whether the product is still recoverable:
//
//   "Order not yet fulfilled. The loss of your product could be prevented by a
//    refund ... Whereas if your product or service was irretrievable (for
//    example, the product already shipped, or the service has already been
//    used) it might make more sense *not* to refund, and to wait and see if it
//    does turn out to be fraud."
//                     docs.stripe.com/disputes/prevention/best-practices
//
// That question is the one this app is already equipped to answer, which is the
// whole reason the feature belongs here rather than in a dashboard. Carrier
// lookups say whether a parcel was delivered; customer_activity says whether a
// digital product was used. Stripe knows neither. So the same two evidence
// sources that decide whether a dispute is winnable also decide, earlier,
// whether a warning is worth refunding.
//
// Three facts the UI copy must never get wrong, each verified against Stripe's
// documentation rather than assumed:
//
// 1. A refund does NOT retract the warning. Visa counts EFWs toward VAMP
//    whether or not you refund ("they're equally as important when used as a
//    metric by the networks"). Refunding avoids the dispute and its fee. It
//    does not lower a fraud ratio, and this app never claims it does.
// 2. A PARTIAL refund does not protect you at all: "customers can't dispute
//    fully refunded payments, [but] they can still dispute partially refunded
//    payments. Card network rules even allow for a payment that has been
//    partially refunded to be disputed for the full payment amount." So the
//    refund path here is full-amount only, by construction.
// 3. Under 3D Secure liability shift the issuer generally eats a fraud
//    dispute. You still receive the EFW, but refunding gives away money you
//    would most likely not have lost.

import { get, query, run } from "./db.js";
import { normalizeCarrier, retrievePOD, type CarrierEnv } from "./carriers/index.js";
import * as stripe from "./adapters/stripe.js";
import type { FraudWarning } from "./types.js";

/**
 * What we can say about the thing the customer bought, which is the only
 * question Stripe's guidance actually turns on.
 *
 * `unknown` is a real answer and not a failure. A merchant with no carrier
 * credentials and no activity feed genuinely cannot tell recoverable from
 * irretrievable, and guessing on their behalf is how an app talks someone into
 * refunding a delivered parcel.
 */
export type FulfillmentState =
  | "not_shipped"
  | "in_transit"
  | "delivered"
  | "service_used"
  | "service_unused"
  | "unknown";

export type WarningVerdict = "refund" | "do_not_refund" | "review" | "no_action";

export interface WarningTriageInput {
  warning: Pick<FraudWarning, "actionable" | "fraud_type" | "amount_cents" | "currency">;
  fulfillment: FulfillmentState;
  /**
   * The charge's `payment_method_details.card.three_d_secure.result`, verbatim
   * and possibly empty. Stored as the processor said it, never re-interpreted
   * on the way in, because the liability-shift reading of it is a judgement
   * this module makes and the next reader should be able to check.
   */
  three_d_secure_result: string;
}

export interface WarningTriage {
  recommendation: WarningVerdict;
  reason: string;
  /** The specific observations behind the verdict, for the UI to show. */
  factors: string[];
}

/**
 * Stripe's own wording: liability shift "typically applies to payments
 * successfully authenticated using 3DS". `attempt_acknowledged` is a distinct
 * result (the attempt was recorded, not completed) and is deliberately not
 * treated as a shift here.
 */
export function hasLiabilityShift(threeDSecureResult: string): boolean {
  return threeDSecureResult === "authenticated";
}

/** Issuer fraud labels that describe a stolen or counterfeit card in the wild. */
const CARD_COMPROMISE: ReadonlySet<string> = new Set([
  "made_with_lost_card",
  "made_with_stolen_card",
  "made_with_counterfeit_card",
  "card_never_received",
]);

export function triageWarning(input: WarningTriageInput): WarningTriage {
  const { warning, fulfillment, three_d_secure_result } = input;
  const factors: string[] = [];

  if (CARD_COMPROMISE.has(warning.fraud_type)) {
    factors.push(
      `The issuer labelled this ${warning.fraud_type.replace(/_/g, " ")}, which describes a compromised card rather than a disagreement with you.`,
    );
  }

  // ── Nothing left to decide ────────────────────────────────────────
  //
  // Stripe defines `actionable` as "has not received a dispute and has not been
  // fully refunded". Either way the choice this module exists to inform has
  // already been made, and presenting a refund button would be a lie.
  if (!warning.actionable) {
    return {
      recommendation: "no_action",
      reason:
        "Stripe no longer lists this warning as actionable, which means the charge has already been fully refunded or the dispute has already arrived. There is nothing left to deflect.",
      factors,
    };
  }

  // ── Liability shift outranks everything ───────────────────────────
  //
  // Ordered first on purpose. Stripe's instruction to refund payments you are
  // sure are fraud carries the explicit carve-out "unless you're covered by
  // some form of liability shift", so this test has to run before the
  // recoverability test or the app recommends giving away protected money.
  if (hasLiabilityShift(three_d_secure_result)) {
    factors.push("The payment completed 3D Secure authentication.");
    const holdNote =
      fulfillment === "not_shipped"
        ? " The order has not shipped, though, so holding the shipment still costs you nothing and protects the goods."
        : "";
    return {
      recommendation: "do_not_refund",
      reason:
        "This payment was authenticated with 3D Secure, so liability for a fraudulent chargeback typically sits with the issuer rather than with you. Refunding would hand back money you would most likely not have lost. Stripe notes the shift is typical rather than guaranteed, so treat this as strong grounds to wait, not a certainty." +
        holdNote,
      factors,
    };
  }

  // ── Stripe's actual test: is the product still recoverable? ───────

  switch (fulfillment) {
    case "not_shipped":
      factors.push("No fulfillment or tracking is on record for this order.");
      return {
        recommendation: "refund",
        reason:
          "The order has not shipped, so a refund costs you the sale and nothing else. This is the case Stripe singles out for refunding: the product is still recoverable, and refunding in full now removes the dispute and its fee. Cancel the fulfillment as well as refunding, or you pay twice.",
        factors,
      };

    case "service_unused":
      factors.push("No account activity is recorded for this customer after the payment.");
      return {
        recommendation: "refund",
        reason:
          "Nothing on record shows this customer using what they bought, so there is no delivered value to defend and nothing to lose by refunding. A full refund now closes the warning before it becomes a fraud dispute.",
        factors,
      };

    case "delivered":
      factors.push("The carrier confirms this parcel was delivered.");
      return {
        recommendation: "do_not_refund",
        reason:
          "The parcel was delivered, so the goods are gone. Refunding now loses the money as well as the product, while keeping the charge means a fraud dispute is at least contestable with the delivery record. Stripe's guidance is to wait and see whether a dispute actually arrives.",
        factors,
      };

    case "service_used":
      factors.push("This customer used the product after paying for it.");
      return {
        recommendation: "do_not_refund",
        reason:
          "The service was already used, so the value has been delivered and cannot be recovered by refunding. Usage after payment is also the strongest evidence there is against a fraud claim, so this is a charge worth keeping and defending rather than conceding early.",
        factors,
      };

    case "in_transit":
      factors.push("The parcel has shipped but the carrier does not yet show it delivered.");
      return {
        recommendation: "review",
        reason:
          "The parcel is in transit, which is the one genuinely ambiguous case. If the carrier will recall or reroute it you can refund and still keep the goods; if not, refunding loses both. Check whether a recall is possible before deciding.",
        factors,
      };

    case "unknown":
    default:
      factors.push("Nothing on record says whether this order was fulfilled.");
      return {
        recommendation: "review",
        reason:
          "Whether to refund turns on whether the product is still recoverable, and nothing on file answers that. Connect the carrier or start recording customer activity and this decides itself; until then it is a judgement call rather than something this app should make for you.",
        factors,
      };
  }
}

/**
 * Read a fulfillment state out of what the app already knows.
 *
 * Both "nothing found" answers are gated behind a flag saying we could have
 * found something, and that is the whole care in this function. An empty
 * activity table means "this merchant records nothing", not "the customer did
 * nothing"; no tracking on a Stripe-only account means "we cannot see orders",
 * not "it never shipped". Reading either absence as a fact would recommend
 * refunding every warning an uninstrumented merchant ever receives, which is
 * precisely the blanket auto-refund Stripe warns against.
 */
export function readFulfillment(input: {
  is_physical: boolean;
  carrier: Array<{ outcome: string }>;
  /** Tracking numbers found on the order. Meaningful only with `knowsShipments`. */
  shipments: number;
  /** Whether the order's fulfillments were actually readable. */
  knowsShipments: boolean;
  activityAfterCharge: number;
  /** Whether this merchant posts to /api/activity at all. */
  recordsActivity: boolean;
}): FulfillmentState {
  if (input.is_physical) {
    const seen = input.carrier.filter((c) => c.outcome !== "error");
    if (seen.some((c) => c.outcome === "delivered_with_pod" || c.outcome === "delivered_no_pod")) {
      return "delivered";
    }
    if (input.shipments > 0 || seen.some((c) => c.outcome === "not_delivered")) {
      return "in_transit";
    }
    return input.knowsShipments ? "not_shipped" : "unknown";
  }

  if (input.activityAfterCharge > 0) return "service_used";
  return input.recordsActivity ? "service_unused" : "unknown";
}

/** Human label for a Stripe fraud_type, for the UI and the audit note. */
export function fraudTypeLabel(fraudType: string): string {
  const labels: Record<string, string> = {
    card_never_received: "Card never received by the cardholder",
    fraudulent_card_application: "Fraudulent card application",
    made_with_counterfeit_card: "Made with a counterfeit card",
    made_with_lost_card: "Made with a lost card",
    made_with_stolen_card: "Made with a stolen card",
    misc: "Unspecified fraud",
    unauthorized_use_of_card: "Unauthorized use of the card",
  };
  return labels[fraudType] ?? fraudType.replace(/_/g, " ");
}

// ── Persistence ─────────────────────────────────────────────────────
//
// Everything above this line is pure and unit-tested. Below it is the wiring
// that turns a Stripe object into a scored row.

export interface WarningEnv extends CarrierEnv, stripe.StripeEnv {}

/**
 * Split Stripe's tracking field. It holds one number, or several separated by
 * commas: "If multiple tracking numbers were generated for this purchase,
 * please separate them with commas."
 */
export function parseTrackingNumbers(raw: string): string[] {
  return (raw || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Take one early fraud warning from Stripe and score it.
 *
 * The charge is fetched because the warning object itself carries almost
 * nothing: an id, a charge, a fraud label and a boolean. Amount, customer,
 * 3D Secure result and shipping all live on the charge, and without them there
 * is no decision to make.
 */
export async function upsertWarning(
  env: WarningEnv,
  efw: Record<string, unknown>,
): Promise<string> {
  const externalId = String(efw.id);
  const existing = await get<{ id: string; resolution: string | null }>(
    "select id, resolution from fraud_warnings where processor = 'stripe' and external_id = ?",
    [externalId],
  );
  const id = existing?.id ?? crypto.randomUUID();
  const chargeRef = typeof efw.charge === "string" ? efw.charge : "";

  let amount = 0;
  let currency = "usd";
  let email = "";
  let name = "";
  let isPhysical = false;
  let threeDS = "";
  let chargedAt: string | null = null;
  let trackingNumbers: string[] = [];
  let shippingCarrier = "";
  let knowsShipments = false;

  if (chargeRef && env.STRIPE_API_KEY) {
    const ch = (await stripe.getCharge(env, chargeRef).catch(() => null)) as Record<string, unknown> | null;
    if (ch) {
      amount = Number(ch.amount ?? 0);
      currency = String(ch.currency ?? "usd");
      const bd = (ch.billing_details ?? {}) as { email?: string; name?: string };
      email = bd.email ?? String(ch.receipt_email ?? "");
      name = bd.name ?? "";
      if (typeof ch.created === "number") chargedAt = new Date(ch.created * 1000).toISOString();

      const shipping = ch.shipping as
        | { carrier?: string | null; tracking_number?: string | null }
        | null
        | undefined;
      isPhysical = Boolean(shipping);
      if (shipping) {
        // A shipping hash means the merchant populates shipping on charges, so
        // an empty tracking number is a real "not dispatched yet" rather than a
        // blind spot. That distinction is what makes `not_shipped` safe to act on.
        knowsShipments = true;
        shippingCarrier = shipping.carrier ?? "";
        trackingNumbers = parseTrackingNumbers(shipping.tracking_number ?? "");
      }

      const pmd = ch.payment_method_details as { card?: { three_d_secure?: { result?: string } | null } } | null | undefined;
      threeDS = pmd?.card?.three_d_secure?.result ?? "";
    }
  }

  // Is the parcel already out there? Reuses the same carrier retrieval the
  // dispute path uses; nothing is written to the dossier, because there is no
  // dispute to attach evidence to and may never be one.
  const carrierSignals: Array<{ outcome: string }> = [];
  for (const tracking of trackingNumbers) {
    const result = await retrievePOD(env, normalizeCarrier(shippingCarrier), tracking).catch(
      () => null,
    );
    if (result) carrierSignals.push({ outcome: result.outcome });
  }

  // Digital side: did this customer use the thing after paying for it?
  let activityAfterCharge = 0;
  let recordsActivity = false;
  if (!isPhysical) {
    const anyActivity = await get<{ n: number }>("select count(*) as n from customer_activity", []);
    recordsActivity = Number(anyActivity?.n ?? 0) > 0;
    if (recordsActivity && email) {
      const rows = await get<{ n: number }>(
        "select count(*) as n from customer_activity where customer_email = ? and occurred_at > ?",
        [email.trim().toLowerCase(), chargedAt ?? "0000"],
      );
      activityAfterCharge = Number(rows?.n ?? 0);
    }
  }

  const fulfillment = readFulfillment({
    is_physical: isPhysical,
    carrier: carrierSignals,
    shipments: trackingNumbers.length,
    knowsShipments,
    activityAfterCharge,
    recordsActivity,
  });

  const fraudType = String(efw.fraud_type ?? "misc");
  const actionable = efw.actionable === false ? 0 : 1;

  const verdict = triageWarning({
    warning: { actionable, fraud_type: fraudType, amount_cents: amount, currency },
    fulfillment,
    three_d_secure_result: threeDS,
  });

  await run(
    `insert into fraud_warnings
       (id, processor, external_id, charge_ref, fraud_type, actionable, amount_cents, currency,
        customer_email, customer_name, is_physical, three_d_secure_result, fulfillment_state,
        recommendation, recommendation_reason, factors, warned_at, raw)
     values (?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (processor, external_id) do update set
       actionable = excluded.actionable,
       fraud_type = excluded.fraud_type,
       fulfillment_state = excluded.fulfillment_state,
       three_d_secure_result = excluded.three_d_secure_result,
       recommendation = excluded.recommendation,
       recommendation_reason = excluded.recommendation_reason,
       factors = excluded.factors,
       raw = excluded.raw,
       updated_at = datetime('now')`,
    [
      id, externalId, chargeRef, fraudType, actionable, amount, currency,
      email, name, isPhysical ? 1 : 0, threeDS, fulfillment,
      verdict.recommendation, verdict.reason, JSON.stringify(verdict.factors),
      new Date(Number(efw.created ?? 0) * 1000).toISOString(), JSON.stringify(efw),
    ],
  );

  return id;
}

/**
 * A dispute arrived on a charge we had been warned about.
 *
 * This is the only feedback the merchant ever gets on their own judgement, so
 * it overwrites nothing: a warning that was already refunded should not have
 * produced a dispute, and if it somehow did, that is worth seeing rather than
 * tidying away. Only undecided and dismissed warnings are marked.
 */
export async function linkWarningToDispute(chargeRef: string, disputeId: string): Promise<void> {
  if (!chargeRef) return;
  await run(
    `update fraud_warnings
        set dispute_id = ?, resolution = 'became_dispute',
            resolution_at = datetime('now'), actionable = 0, updated_at = datetime('now')
      where charge_ref = ? and (resolution is null or resolution = 'dismissed')`,
    [disputeId, chargeRef],
  );
}

/** How often does letting a warning ride actually cost the merchant? */
export async function warningLedger(): Promise<{
  open: number;
  refunded: number;
  dismissed: number;
  became_dispute: number;
  dismissed_then_disputed: number;
}> {
  const rows = await query<{ resolution: string | null; n: number }>(
    "select resolution, count(*) as n from fraud_warnings group by resolution",
    [],
  );
  const by = (r: string | null) => Number(rows.find((x) => x.resolution === r)?.n ?? 0);
  // A warning that was explicitly dismissed and then came back as a dispute is
  // the number worth putting in front of someone, and it is only knowable
  // because the dismissal note survived the transition.
  const both = await get<{ n: number }>(
    "select count(*) as n from fraud_warnings where resolution = 'became_dispute' and resolution_note != ''",
    [],
  );
  return {
    open: by(null),
    refunded: by("refunded"),
    dismissed: by("dismissed"),
    became_dispute: by("became_dispute"),
    dismissed_then_disputed: Number(both?.n ?? 0),
  };
}
