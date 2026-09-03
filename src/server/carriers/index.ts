// Carrier proof of delivery.
//
// The premise this module rejects: "log into the carrier portal to get the
// POD". Portal login is the FALLBACK. FedEx and UPS both expose proof of
// delivery through their own APIs, and an API-retrieved POD is faster, cheaper
// and more defensible than a screenshot of the same fact.
//
// What the APIs cannot do is the reason the fallback exists, and it is specific
// rather than hand-wavy:
//
//   - FedEx returns a signature proof of delivery only when the request carries
//     the SHIPPER's billing account number. A merchant fulfilling through a 3PL
//     or a rate-shopping platform does not hold that account, so the API path
//     is closed to them no matter how well it is implemented.
//   - USPS delivery-record scans (PS Form 3811 and friends) are not reliably
//     retrievable by API at all; merchants get them from the portal or a
//     counter.
//   - Regional and freight carriers mostly have no public POD API.
//
// So each carrier declares what it can actually do, `retrievePOD` tries the API
// when one exists, and anything it cannot serve returns a *typed reason* —
// `no_account`, `unsupported` — that the caller escalates to the browser agent.
// "We could not get it" and "we never tried" must never look the same.

import type { CarrierEnv, PODResult } from "./types.js";
import { fedexPOD } from "./fedex.js";
import { upsPOD } from "./ups.js";

export * from "./types.js";

export interface CarrierCapability {
  id: string;
  label: string;
  /** Whether an official API can return a proof-of-delivery document. */
  apiPOD: boolean;
  /**
   * Credentials the API path needs. Stated so the UI can tell a merchant
   * exactly which secret would unlock the fast path instead of failing mutely.
   */
  requires: string[];
  note: string;
}

export const CARRIERS: Record<string, CarrierCapability> = {
  fedex: {
    id: "fedex",
    label: "FedEx",
    apiPOD: true,
    requires: ["FEDEX_CLIENT_ID", "FEDEX_CLIENT_SECRET", "FEDEX_ACCOUNT_NUMBER"],
    note: "Signature POD requires the shipper's own billing account number. Merchants shipping through a 3PL usually do not have it, and fall back to the agent.",
  },
  ups: {
    id: "ups",
    label: "UPS",
    apiPOD: true,
    requires: ["UPS_CLIENT_ID", "UPS_CLIENT_SECRET"],
    note: "Returns a POD Letter. UPS terms forbid storing or passing on the bare signature image outside that letter, so only the letter is retained.",
  },
  usps: {
    id: "usps",
    label: "USPS",
    apiPOD: false,
    requires: [],
    note: "Delivery-record scans are portal- or counter-only in practice. Always escalates to the agent.",
  },
  dhl: {
    id: "dhl",
    label: "DHL",
    apiPOD: false,
    requires: [],
    note: "POD availability varies by DHL division and contract; treated as agent-only until a merchant confirms otherwise.",
  },
};

/** Carrier names arrive from Shopify fulfillments as free text. Normalize. */
export function normalizeCarrier(raw: string): string {
  const v = (raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (v.includes("fedex")) return "fedex";
  if (v.includes("ups")) return "ups";
  if (v.includes("usps") || v.includes("unitedstatespostal")) return "usps";
  if (v.includes("dhl")) return "dhl";
  return v || "unknown";
}

/**
 * Try to get proof of delivery through the carrier's own API.
 *
 * Never throws for an expected condition. A carrier with no API, or one whose
 * credentials are absent, is a normal outcome that routes to the agent.
 */
export async function retrievePOD(
  env: CarrierEnv,
  carrier: string,
  tracking: string,
): Promise<PODResult> {
  const id = normalizeCarrier(carrier);
  const cap = CARRIERS[id];

  if (!cap?.apiPOD) {
    return {
      outcome: "unsupported",
      detail: cap
        ? `${cap.label} has no usable POD API — ${cap.note}`
        : `Unknown carrier "${carrier}" — no API path.`,
    };
  }

  const missing = cap.requires.filter((k) => !env[k as keyof CarrierEnv]);
  if (missing.length) {
    return {
      outcome: "no_account",
      detail: `${cap.label} POD needs ${missing.join(", ")}. ${cap.note}`,
    };
  }

  try {
    return id === "fedex" ? await fedexPOD(env, tracking) : await upsPOD(env, tracking);
  } catch (err) {
    return { outcome: "error", detail: (err as Error).message };
  }
}

// ── Address matching ────────────────────────────────────────────────
//
// The check an issuer actually performs on a not-received claim, and the one
// most merchants skip: did the parcel go to the address the order was sold to?
// A POD showing delivery to a different address is not weak evidence, it is
// evidence for the cardholder — so this runs BEFORE submission and can flip a
// dispute to do-not-fight.

const NOISE = /\b(apt|apartment|unit|ste|suite|fl|floor|no|number|#)\b/g;
const STREET_WORDS: Record<string, string> = {
  street: "st", str: "st", saint: "st",
  avenue: "ave", av: "ave",
  road: "rd", drive: "dr", lane: "ln", court: "ct", place: "pl",
  boulevard: "blvd", highway: "hwy", parkway: "pkwy", terrace: "ter",
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

function canon(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(NOISE, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(" ")
    .trim();
}

/** Postal codes compare on their significant part; formats vary by country. */
function canonPostal(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

export interface AddressParts {
  address1?: string | null;
  city?: string | null;
  zip?: string | null;
  country?: string | null;
}

export type AddressMatch = {
  match: boolean;
  confidence: "exact" | "strong" | "weak" | "mismatch";
  reason: string;
};

/**
 * Compare a carrier's delivery address against the order's shipping address.
 *
 * Deliberately conservative in one direction: when the carrier gives too little
 * to compare (many POD records return only a city), the answer is `weak`, never
 * a confident match. Overstating a match here would send a merchant into a
 * dispute they should have conceded.
 */
export function matchAddress(order: AddressParts, delivered: AddressParts): AddressMatch {
  const oPostal = canonPostal(order.zip ?? "");
  const dPostal = canonPostal(delivered.zip ?? "");
  const oStreet = canon(order.address1 ?? "");
  const dStreet = canon(delivered.address1 ?? "");
  const oCity = canon(order.city ?? "");
  const dCity = canon(delivered.city ?? "");

  if (oStreet && dStreet && oPostal && dPostal) {
    if (oStreet === dStreet && oPostal === dPostal) {
      return { match: true, confidence: "exact", reason: "street and postal code both match" };
    }
    if (oPostal !== dPostal) {
      return {
        match: false,
        confidence: "mismatch",
        reason: `delivered to postal code ${dPostal}, order shipped to ${oPostal}`,
      };
    }
    // Same postal code, different street text. Usually formatting; occasionally
    // a genuinely different address on the same block. Not worth asserting.
    return {
      match: false,
      confidence: "weak",
      reason: `postal code matches but street differs ("${dStreet}" vs "${oStreet}")`,
    };
  }

  if (oPostal && dPostal) {
    return oPostal === dPostal
      ? { match: true, confidence: "strong", reason: "postal code matches; no street on the carrier record" }
      : { match: false, confidence: "mismatch", reason: `postal code ${dPostal} does not match order ${oPostal}` };
  }

  if (oCity && dCity) {
    return oCity === dCity
      ? { match: true, confidence: "weak", reason: "only city available, and it matches" }
      : { match: false, confidence: "mismatch", reason: `delivered to ${dCity}, order shipped to ${oCity}` };
  }

  return { match: false, confidence: "weak", reason: "carrier record carries no comparable address" };
}
