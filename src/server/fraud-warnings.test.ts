import { describe, expect, it } from "vitest";
import {
  fraudTypeLabel, hasLiabilityShift, parseTrackingNumbers, readFulfillment, triageWarning,
  type FulfillmentState,
} from "./fraud-warnings.js";

function warn(partial: Partial<{ actionable: number; fraud_type: string; amount_cents: number; currency: string }> = {}) {
  return { actionable: 1, fraud_type: "misc", amount_cents: 5000, currency: "usd", ...partial };
}

function verdict(fulfillment: FulfillmentState, opts: { threeDS?: string; actionable?: number; fraud_type?: string } = {}) {
  return triageWarning({
    warning: warn({ actionable: opts.actionable ?? 1, fraud_type: opts.fraud_type ?? "misc" }),
    fulfillment,
    three_d_secure_result: opts.threeDS ?? "",
  });
}

describe("hasLiabilityShift", () => {
  it("only treats a completed authentication as a shift", () => {
    expect(hasLiabilityShift("authenticated")).toBe(true);
  });

  it("does not treat an acknowledged attempt as a shift", () => {
    // Stripe lists attempt_acknowledged as a distinct result: the attempt was
    // recorded, not completed. Reading it as a shift would tell a merchant to
    // keep a charge they are still liable for.
    expect(hasLiabilityShift("attempt_acknowledged")).toBe(false);
  });

  it("does not treat a missing result as a shift", () => {
    expect(hasLiabilityShift("")).toBe(false);
  });
});

describe("triageWarning", () => {
  it("stops at not-actionable, because the decision is already gone", () => {
    const t = verdict("not_shipped", { actionable: 0 });
    expect(t.recommendation).toBe("no_action");
  });

  it("refuses to refund a 3DS-authenticated payment even when nothing shipped", () => {
    // Ordering test. Recoverability alone would say refund; liability shift has
    // to win, or the app recommends giving away money the issuer would cover.
    const t = verdict("not_shipped", { threeDS: "authenticated" });
    expect(t.recommendation).toBe("do_not_refund");
    expect(t.reason).toMatch(/3D Secure/);
  });

  it("still tells you to hold an unshipped order under liability shift", () => {
    const t = verdict("not_shipped", { threeDS: "authenticated" });
    expect(t.reason).toMatch(/holding the shipment/);
  });

  it("does not add the shipment-hold note once the goods are gone", () => {
    const t = verdict("delivered", { threeDS: "authenticated" });
    expect(t.reason).not.toMatch(/holding the shipment/);
  });

  it("refunds what has not shipped", () => {
    expect(verdict("not_shipped").recommendation).toBe("refund");
  });

  it("refunds a digital product with no recorded use", () => {
    expect(verdict("service_unused").recommendation).toBe("refund");
  });

  it("keeps a delivered parcel", () => {
    const t = verdict("delivered");
    expect(t.recommendation).toBe("do_not_refund");
  });

  it("keeps a service that was already used", () => {
    expect(verdict("service_used").recommendation).toBe("do_not_refund");
  });

  it("will not decide while the parcel is in transit", () => {
    expect(verdict("in_transit").recommendation).toBe("review");
  });

  it("will not decide when nothing on file says whether it was fulfilled", () => {
    // The honesty rule. Silence is not evidence of non-fulfillment, and
    // guessing here is the blanket auto-refund Stripe warns against.
    const t = verdict("unknown");
    expect(t.recommendation).toBe("review");
    expect(t.reason).toMatch(/nothing on file/i);
  });

  it("never claims a refund lowers a fraud ratio", () => {
    for (const f of ["not_shipped", "service_unused", "delivered", "in_transit", "unknown"] as const) {
      expect(verdict(f).reason).not.toMatch(/ratio|VAMP|monitoring program/i);
    }
  });

  it("names a compromised-card label as a factor", () => {
    const t = verdict("not_shipped", { fraud_type: "made_with_stolen_card" });
    expect(t.factors.join(" ")).toMatch(/stolen card/);
  });

  it("does not invent a compromise factor for an unspecified label", () => {
    const t = verdict("not_shipped", { fraud_type: "misc" });
    expect(t.factors.join(" ")).not.toMatch(/compromised card/);
  });
});

describe("readFulfillment", () => {
  const base = {
    is_physical: true, carrier: [] as Array<{ outcome: string }>, shipments: 0,
    knowsShipments: true, activityAfterCharge: 0, recordsActivity: true,
  };

  it("reads a delivered parcel off the carrier record", () => {
    expect(readFulfillment({ ...base, carrier: [{ outcome: "delivered_with_pod" }], shipments: 1 }))
      .toBe("delivered");
    expect(readFulfillment({ ...base, carrier: [{ outcome: "delivered_no_pod" }], shipments: 1 }))
      .toBe("delivered");
  });

  it("treats a shipped-but-unconfirmed parcel as in transit", () => {
    expect(readFulfillment({ ...base, shipments: 1 })).toBe("in_transit");
  });

  it("treats a carrier 'not delivered' as in transit, not as never shipped", () => {
    // Both mean "no delivery confirmation", but only one means the goods are
    // still on the shelf. Collapsing them would recommend refunding a parcel
    // that is already out for delivery.
    expect(readFulfillment({ ...base, shipments: 0, carrier: [{ outcome: "not_delivered" }] }))
      .toBe("in_transit");
  });

  it("calls it not shipped only when fulfillments were actually readable", () => {
    expect(readFulfillment({ ...base, knowsShipments: true })).toBe("not_shipped");
    expect(readFulfillment({ ...base, knowsShipments: false })).toBe("unknown");
  });

  it("ignores a carrier error rather than reading it as a delivery signal", () => {
    expect(readFulfillment({ ...base, carrier: [{ outcome: "error" }], knowsShipments: false }))
      .toBe("unknown");
  });

  it("reads use after the charge as a used service", () => {
    expect(readFulfillment({ ...base, is_physical: false, activityAfterCharge: 3 }))
      .toBe("service_used");
  });

  it("does not read an empty activity table as an unused service", () => {
    // "We record nothing" is not "the customer did nothing". This is the guard
    // that stops an uninstrumented merchant being told to refund everything.
    expect(readFulfillment({ ...base, is_physical: false, recordsActivity: false }))
      .toBe("unknown");
    expect(readFulfillment({ ...base, is_physical: false, recordsActivity: true }))
      .toBe("service_unused");
  });
});

describe("parseTrackingNumbers", () => {
  it("splits Stripe's comma-separated field", () => {
    expect(parseTrackingNumbers("1Z999, 1Z888")).toEqual(["1Z999", "1Z888"]);
  });

  it("returns nothing for an empty field", () => {
    expect(parseTrackingNumbers("")).toEqual([]);
    expect(parseTrackingNumbers(" , ")).toEqual([]);
  });
});

describe("fraudTypeLabel", () => {
  it("labels every fraud_type Stripe documents", () => {
    for (const t of [
      "card_never_received", "fraudulent_card_application", "made_with_counterfeit_card",
      "made_with_lost_card", "made_with_stolen_card", "misc", "unauthorized_use_of_card",
    ]) {
      expect(fraudTypeLabel(t)).not.toMatch(/_/);
    }
  });

  it("falls back readably on a value Stripe adds later", () => {
    expect(fraudTypeLabel("some_new_type")).toBe("some new type");
  });
});
