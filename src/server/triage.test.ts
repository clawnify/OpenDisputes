import { describe, expect, it } from "vitest";
import { shouldAutoSubmit, triage, type CarrierSignal } from "./triage.js";
import type { Dispute, EvidenceItem, EvidenceKind } from "./types.js";

function dispute(over: Partial<Dispute> = {}): Dispute {
  return {
    id: "d1", processor: "stripe", external_id: "du_1", reason: "product_not_received",
    status: "needs_response", amount_cents: 12_000, currency: "usd", is_physical: 1,
    customer_email: "a@b.com", customer_name: "A B", order_ref: "#1001", charge_ref: "ch_1",
    issuer_country: "US", due_by: null, opened_at: "2026-09-01", recommendation: "pending",
    recommendation_reason: "", outcome: null, outcome_at: null, raw: "{}",
    created_at: "", updated_at: "", ...over,
  };
}

function item(kind: EvidenceKind): EvidenceItem {
  return {
    id: `i-${kind}`, dispute_id: "d1", kind, source: "processor_api", title: kind,
    body: "x", file_key: "", file_mime: "", file_bytes: 0, provenance: "{}",
    included: 1, collected_at: "",
  };
}

function pod(over: Partial<CarrierSignal> = {}): CarrierSignal {
  return { outcome: "delivered_with_pod", address_match: 1, delivered_at: "2026-08-20", detail: "", ...over };
}

describe("triage — hard concessions", () => {
  it("concedes when the carrier delivered to a different address", () => {
    const t = triage({
      dispute: dispute(),
      items: [item("activity_log")],
      carrier: [pod({ address_match: 0, detail: "delivered to 90210, order shipped to 10001" })],
    });
    expect(t.recommendation).toBe("accept");
    expect(t.reason).toContain("different address");
  });

  it("concedes a not-received claim with no delivery record at all", () => {
    const t = triage({
      dispute: dispute(),
      items: [],
      carrier: [pod({ outcome: "not_delivered", address_match: null })],
    });
    expect(t.recommendation).toBe("accept");
  });

  it("still fights when one carrier shows delivery and another does not", () => {
    // Split shipments are normal; one leg missing is not a conceded case.
    const t = triage({
      dispute: dispute(),
      items: [item("tracking_history")],
      carrier: [pod({ outcome: "not_delivered", address_match: null }), pod()],
    });
    expect(t.recommendation).toBe("fight");
  });

  it("concedes a canceled subscription with nothing showing later use", () => {
    const t = triage({
      dispute: dispute({ reason: "subscription_canceled", is_physical: 0 }),
      items: [],
      carrier: [],
    });
    expect(t.recommendation).toBe("accept");
  });

  it("fights a canceled subscription when post-cancellation activity exists", () => {
    const t = triage({
      dispute: dispute({ reason: "subscription_canceled", is_physical: 0 }),
      items: [item("activity_log")],
      carrier: [],
    });
    expect(t.recommendation).toBe("fight");
  });
});

describe("triage — weak fraud claims", () => {
  it("declines a fraud claim with no identity, delivery or usage evidence", () => {
    const t = triage({
      dispute: dispute({ reason: "fraudulent", is_physical: 0 }),
      items: [item("refund_policy")],
      carrier: [],
    });
    expect(t.recommendation).toBe("do_not_fight");
    expect(t.gaps.length).toBeGreaterThan(0);
  });

  it("fights a fraud claim once an IP match is on file", () => {
    const t = triage({
      dispute: dispute({ reason: "fraudulent", is_physical: 0 }),
      items: [item("ip_geo_match")],
      carrier: [],
    });
    expect(t.recommendation).toBe("fight");
  });

  it("fights a fraud claim backed by signed delivery", () => {
    const t = triage({
      dispute: dispute({ reason: "fraudulent" }),
      items: [],
      carrier: [pod()],
    });
    expect(t.recommendation).toBe("fight");
  });
});

describe("triage — economics", () => {
  it("ignores amount when the processor charges nothing to respond", () => {
    // The correction that matters: with no counter fee, accepting and losing
    // cost the same, so a small dispute is still worth contesting.
    const t = triage({ dispute: dispute({ amount_cents: 300 }), items: [], carrier: [pod()] });
    expect(t.recommendation).toBe("fight");
  });

  it("declines only when a real counter fee exceeds the amount", () => {
    const t = triage({
      dispute: dispute({ amount_cents: 1_500 }),
      items: [],
      carrier: [pod()],
      counterFeeCents: 2_000,
    });
    expect(t.recommendation).toBe("do_not_fight");
  });
});

describe("triage — gaps", () => {
  it("names the missing POD on a physical dispute it still wants fought", () => {
    const t = triage({
      dispute: dispute(),
      items: [item("tracking_history")],
      carrier: [pod({ outcome: "delivered_no_pod" })],
    });
    expect(t.recommendation).toBe("fight");
    expect(t.gaps[0]).toMatch(/proof of delivery/i);
  });

  it("names a retrieved POD that has been excluded from the packet", () => {
    // The failure the carrier log alone cannot show: proof exists, and the
    // merchant has switched it off, so the submission would go without it.
    const excluded = { ...item("proof_of_delivery"), included: 0 };
    const t = triage({
      dispute: dispute(),
      items: [item("tracking_history"), excluded],
      carrier: [pod()],
    });
    expect(t.recommendation).toBe("fight");
    expect(t.gaps.join(" ")).toMatch(/excluded from this packet/i);
  });

  it("does not nag about a POD that is retrieved and included", () => {
    const t = triage({
      dispute: dispute(),
      items: [item("tracking_history"), item("proof_of_delivery")],
      carrier: [pod()],
    });
    expect(t.gaps.join(" ")).not.toMatch(/proof of delivery/i);
  });

  it("asks for usage evidence on a digital dispute, not shipping", () => {
    const t = triage({
      dispute: dispute({ is_physical: 0, reason: "product_unacceptable" }),
      items: [],
      carrier: [],
    });
    expect(t.gaps.join(" ")).toMatch(/activity/i);
    expect(t.gaps.join(" ")).not.toMatch(/tracking/i);
  });
});

describe("shouldAutoSubmit", () => {
  const on = { auto_submit: 1, auto_submit_reasons: '["product_not_received"]' };

  it("fires only for a promoted reason code", () => {
    expect(shouldAutoSubmit("fight", "product_not_received", on)).toBe(true);
    expect(shouldAutoSubmit("fight", "fraudulent", on)).toBe(false);
  });

  it("never fires on a dispute triage would concede", () => {
    expect(shouldAutoSubmit("accept", "product_not_received", on)).toBe(false);
    expect(shouldAutoSubmit("do_not_fight", "product_not_received", on)).toBe(false);
  });

  it("stays off when the master switch is off", () => {
    expect(shouldAutoSubmit("fight", "product_not_received", { ...on, auto_submit: 0 })).toBe(false);
  });

  it("fails closed on malformed settings rather than submitting", () => {
    expect(shouldAutoSubmit("fight", "product_not_received", { auto_submit: 1, auto_submit_reasons: "{oops" })).toBe(false);
  });
});
