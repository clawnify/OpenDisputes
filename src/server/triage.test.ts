import { describe, expect, it } from "vitest";
import {
  MIN_DECIDED_FOR_ECONOMICS, breakEvenWinRate, shouldAutoSubmit, triage,
  type CarrierSignal,
} from "./triage.js";
import type { Dispute, EvidenceItem, EvidenceKind } from "./types.js";

function dispute(over: Partial<Dispute> = {}): Dispute {
  return {
    id: "d1", processor: "stripe", external_id: "du_1", reason: "product_not_received",
    status: "needs_response", amount_cents: 12_000, currency: "usd", is_physical: 1,
    customer_email: "a@b.com", customer_name: "A B", order_ref: "#1001", charge_ref: "ch_1",
    issuer_country: "US", due_by: null, opened_at: "2026-09-01", charged_at: null,
    recommendation: "pending",
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
  const strong = () => ({ items: [] as EvidenceItem[], carrier: [pod()] });

  it("does not concede on the amount alone when the counter is free", () => {
    // Mexico, Japan, or a Smart Disputes response: nothing is at stake on the
    // losing branch, so no dispute is too small to contest.
    const t = triage({
      dispute: dispute({ amount_cents: 300 }), ...strong(),
      counterFeeCents: 0, history: { decided: 50, won: 0 },
    });
    expect(t.recommendation).toBe("fight");
    expect(t.breakEvenWinRate).toBe(0);
  });

  it("still contests a dispute smaller than the fee when the win rate carries it", () => {
    // The rule this replaced conceded here outright, reasoning that winning
    // could not repay the attempt. A win RETURNS the fee, so it always repays:
    // 10 USD against a 15 USD fee breaks even at 60%, and 70% clears it.
    const t = triage({
      dispute: dispute({ amount_cents: 1_000 }), ...strong(),
      counterFeeCents: 1_500, history: { decided: 100, won: 70 },
    });
    expect(t.recommendation).toBe("fight");
    expect(t.breakEvenWinRate).toBeCloseTo(0.6, 5);
  });

  it("concedes when the merchant's own record is below break-even", () => {
    // Same 10 USD dispute and 15 USD fee, break-even 60%, measured 20%.
    const t = triage({
      dispute: dispute({ amount_cents: 1_000 }), ...strong(),
      counterFeeCents: 1_500, history: { decided: 100, won: 20 },
    });
    expect(t.recommendation).toBe("do_not_fight");
    expect(t.reason).toMatch(/60%/);
    expect(t.reason).toMatch(/20 of 100/);
  });

  it("will not concede on a sample too small to mean anything", () => {
    // Nine losses out of nine is 0%, far below break-even, and still not enough
    // to price a decision on. MIN_DECIDED_FOR_ECONOMICS is the whole guard.
    const t = triage({
      dispute: dispute({ amount_cents: 1_000 }), ...strong(),
      counterFeeCents: 1_500,
      history: { decided: MIN_DECIDED_FOR_ECONOMICS - 1, won: 0 },
    });
    expect(t.recommendation).toBe("fight");
  });

  it("treats an unknown fee as unknown, never as free", () => {
    // The bug this replaced: counterFeeCents was never supplied in production
    // and defaulted to 0, so every dispute was priced as if countering cost
    // nothing. Absent now means absent, and it is reported as a gap.
    const t = triage({
      dispute: dispute({ amount_cents: 1_000 }), ...strong(),
      history: { decided: 100, won: 0 },
    });
    expect(t.recommendation).toBe("fight");
    expect(t.breakEvenWinRate).toBeNull();
    expect(t.gaps.join(" ")).toMatch(/what your processor charges/i);
  });

  it("keeps a configuration prompt below missing evidence in the gap order", () => {
    // gaps is read strongest-first. A settings prompt must never displace a
    // missing proof of delivery at the top of that list.
    const t = triage({ dispute: dispute(), items: [], carrier: [] });
    expect(t.gaps[0]).toMatch(/proof of delivery/i);
    expect(t.gaps[t.gaps.length - 1]).toMatch(/what your processor charges/i);
  });

  it("does not price a dispute the evidence already concedes", () => {
    // A break-even on a case you cannot win is not a decision, so the economic
    // path is never reached and the threshold stays null.
    const t = triage({
      dispute: dispute({ reason: "product_not_received" }),
      items: [],
      carrier: [{ outcome: "not_delivered", address_match: null, delivered_at: null, detail: "" }],
      counterFeeCents: 1_500,
      history: { decided: 100, won: 99 },
    });
    expect(t.recommendation).toBe("accept");
    expect(t.breakEvenWinRate).toBeNull();
  });
});

describe("breakEvenWinRate", () => {
  it("is the fee's share of what is at stake", () => {
    // p*(A) = F / (A + F): the fee is risked to recover the amount.
    expect(breakEvenWinRate(1_000, 1_500)).toBeCloseTo(0.6, 5);
    expect(breakEvenWinRate(50_000, 1_500)).toBeCloseTo(0.0291, 3);
    expect(breakEvenWinRate(1_000, 0)).toBe(0);
  });

  it("has no answer for a dispute with nothing at stake", () => {
    expect(breakEvenWinRate(0, 0)).toBeNull();
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
