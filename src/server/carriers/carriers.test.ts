import { describe, expect, it } from "vitest";
import { matchAddress, normalizeCarrier, retrievePOD } from "./index.js";

describe("normalizeCarrier", () => {
  it("folds the free-text carrier names Shopify actually emits", () => {
    expect(normalizeCarrier("FedEx")).toBe("fedex");
    expect(normalizeCarrier("FEDEX GROUND")).toBe("fedex");
    expect(normalizeCarrier("United States Postal Service")).toBe("usps");
    expect(normalizeCarrier("UPS®")).toBe("ups");
    expect(normalizeCarrier("DHL Express")).toBe("dhl");
  });

  it("keeps an unknown carrier distinguishable from an empty one", () => {
    expect(normalizeCarrier("Evri")).toBe("evri");
    expect(normalizeCarrier("")).toBe("unknown");
  });
});

describe("matchAddress", () => {
  it("matches through formatting differences", () => {
    const r = matchAddress(
      { address1: "123 North Main Street, Apt 4", city: "Austin", zip: "78701" },
      { address1: "123 N Main St #4", city: "Austin", zip: "78701-1234" },
    );
    expect(r.match).toBe(true);
    expect(r.confidence).toBe("exact");
  });

  it("flags a different postal code as a mismatch", () => {
    const r = matchAddress(
      { address1: "123 Main St", city: "Austin", zip: "78701" },
      { address1: "123 Main St", city: "Dallas", zip: "75201" },
    );
    expect(r.match).toBe(false);
    expect(r.confidence).toBe("mismatch");
  });

  it("does not claim a match when the street differs inside one postal code", () => {
    // Same block, different door. Asserting a match here would push a merchant
    // into a dispute the issuer can puncture.
    const r = matchAddress(
      { address1: "123 Main St", zip: "78701" },
      { address1: "987 Elm Rd", zip: "78701" },
    );
    expect(r.match).toBe(false);
    expect(r.confidence).toBe("weak");
  });

  it("is only strong, not exact, when the carrier gives no street", () => {
    const r = matchAddress({ address1: "123 Main St", zip: "78701" }, { zip: "78701" });
    expect(r.match).toBe(true);
    expect(r.confidence).toBe("strong");
  });

  it("refuses to guess when there is nothing comparable", () => {
    const r = matchAddress({ address1: "123 Main St" }, {});
    expect(r.match).toBe(false);
    expect(r.confidence).toBe("weak");
  });
});

describe("retrievePOD — routing before any network call", () => {
  it("reports carriers with no POD API as unsupported, not as an error", () => {
    return retrievePOD({}, "USPS", "9400111").then((r) => {
      expect(r.outcome).toBe("unsupported");
      expect(r.detail).toMatch(/portal/i);
    });
  });

  it("distinguishes a missing shipper account from an outage", async () => {
    // The 3PL case: FedEx has the API, this merchant cannot use it.
    const r = await retrievePOD({ FEDEX_CLIENT_ID: "x", FEDEX_CLIENT_SECRET: "y" }, "FedEx", "7712");
    expect(r.outcome).toBe("no_account");
    expect(r.detail).toMatch(/FEDEX_ACCOUNT_NUMBER/);
  });

  it("treats an unknown carrier as unsupported", async () => {
    const r = await retrievePOD({}, "Evri", "H001");
    expect(r.outcome).toBe("unsupported");
  });
});
