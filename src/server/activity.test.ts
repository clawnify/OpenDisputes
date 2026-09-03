import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeTimestamp, summarizeActivity } from "./activity.js";
import type { CustomerActivity } from "./types.js";

function ev(partial: Partial<CustomerActivity> & { occurred_at: string }): CustomerActivity {
  return {
    id: crypto.randomUUID(),
    external_id: "",
    customer_email: "a@b.com",
    customer_ref: "",
    charge_ref: "",
    event_type: "login",
    detail: "",
    artifact_url: "",
    artifact_label: "",
    ip: "",
    metadata: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const CHARGED = "2026-03-03T00:00:00.000Z";
const OPENED = "2026-03-20T00:00:00.000Z";

describe("normalizeEmail", () => {
  it("lowercases and trims, because it is the join key", () => {
    expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
  });
});

describe("normalizeTimestamp", () => {
  it("normalizes a parseable date to ISO", () => {
    expect(normalizeTimestamp("2026-03-04")).toBe("2026-03-04T00:00:00.000Z");
  });

  // A row that cannot be compared is worse than a missing row: it drops out of
  // one side of a comparison and moves the verdict without saying so.
  it("rejects an unparseable date rather than storing it", () => {
    expect(normalizeTimestamp("last tuesday")).toBeNull();
    expect(normalizeTimestamp("")).toBeNull();
  });
});

describe("summarizeActivity", () => {
  it("says nothing at all when there is no activity", () => {
    const s = summarizeActivity([], { charged_at: CHARGED, opened_at: OPENED });
    expect(s.body).toBe("");
    expect(s.total).toBe(0);
    expect(s.boundary).toBe("none");
  });

  it("counts actions after the payment and names the payment date", () => {
    const s = summarizeActivity(
      [
        ev({ occurred_at: "2026-03-01T00:00:00.000Z", event_type: "signup" }),
        ev({ occurred_at: "2026-03-04T00:00:00.000Z" }),
        ev({ occurred_at: "2026-03-09T00:00:00.000Z" }),
      ],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.boundary).toBe("charge");
    expect(s.total).toBe(3);
    expect(s.after).toBe(2);
    expect(s.body).toContain("account was created on 2026-03-01");
    expect(s.body).toContain("2 of those actions occurred after the payment on 2026-03-03");
  });

  it("is explicit when nothing happened after the payment", () => {
    const s = summarizeActivity(
      [ev({ occurred_at: "2026-02-01T00:00:00.000Z" })],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.after).toBe(0);
    expect(s.body).toContain("does not show use of the product after purchase");
  });

  // The honesty rule. Without a payment date the strong sentence is unavailable,
  // and the fallback must be labelled rather than passed off as the strong one.
  it("falls back to the dispute date and SAYS the payment date was missing", () => {
    const s = summarizeActivity(
      [ev({ occurred_at: "2026-03-25T00:00:00.000Z" })],
      { charged_at: null, opened_at: OPENED },
    );
    expect(s.boundary).toBe("dispute");
    expect(s.after).toBe(1);
    expect(s.body).toContain("after this dispute was filed on 2026-03-20");
    expect(s.body).toContain("payment date was not available");
    // It must never claim the post-payment fact it cannot support.
    expect(s.body).not.toContain("after the payment");
  });

  it("admits it cannot establish post-purchase use when only pre-dispute activity exists", () => {
    const s = summarizeActivity(
      [ev({ occurred_at: "2026-03-01T00:00:00.000Z" })],
      { charged_at: null, opened_at: OPENED },
    );
    expect(s.after).toBe(0);
    expect(s.body).toContain("cannot be established from this record alone");
  });

  it("treats the boundary as strict, so an event at the payment instant is not 'after'", () => {
    const s = summarizeActivity(
      [ev({ occurred_at: CHARGED })],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.after).toBe(0);
  });

  it("breaks activity down by the merchant's own verbs, commonest first", () => {
    const s = summarizeActivity(
      [
        ev({ occurred_at: "2026-03-04T00:00:00.000Z", event_type: "render" }),
        ev({ occurred_at: "2026-03-05T00:00:00.000Z", event_type: "render" }),
        ev({ occurred_at: "2026-03-06T00:00:00.000Z", event_type: "export" }),
      ],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.body).toContain("By type: render (2), export (1).");
  });

  it("omits the breakdown when there is only one verb to break down", () => {
    const s = summarizeActivity(
      [ev({ occurred_at: "2026-03-04T00:00:00.000Z", event_type: "login" })],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.body).not.toContain("By type:");
  });

  it("surfaces delivered artifacts separately from the log", () => {
    const s = summarizeActivity(
      [
        ev({ occurred_at: "2026-03-04T00:00:00.000Z", event_type: "render", artifact_url: "https://x/1.png" }),
        ev({ occurred_at: "2026-03-05T00:00:00.000Z", event_type: "render", artifact_url: "https://x/2.png" }),
        ev({ occurred_at: "2026-03-06T00:00:00.000Z" }),
      ],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.artifacts).toHaveLength(2);
    expect(s.body).toContain("2 items were delivered to the customer");
  });

  it("reports counts and dates only, never a rate or a score", () => {
    const s = summarizeActivity(
      [
        ev({ occurred_at: "2026-03-04T00:00:00.000Z" }),
        ev({ occurred_at: "2026-03-05T00:00:00.000Z" }),
      ],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.body).not.toMatch(/%|score|likelihood|confiden/i);
  });

  it("orders an unsorted batch before reading first and last dates", () => {
    const s = summarizeActivity(
      [
        ev({ occurred_at: "2026-03-09T00:00:00.000Z" }),
        ev({ occurred_at: "2026-03-04T00:00:00.000Z" }),
      ],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.body).toContain("from 2026-03-04 to 2026-03-09");
  });

  it("uses the singular for a single action", () => {
    const s = summarizeActivity(
      [ev({ occurred_at: "2026-03-04T00:00:00.000Z" })],
      { charged_at: CHARGED, opened_at: OPENED },
    );
    expect(s.body).toContain("1 logged action, on 2026-03-04");
    expect(s.body).toContain("1 of those actions occurred after the payment");
  });
});
