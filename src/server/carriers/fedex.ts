// FedEx proof of delivery.
//
// UNVERIFIED AGAINST A LIVE ACCOUNT. The request shapes below follow FedEx's
// published Track API, but nobody here has run them with real credentials, and
// FedEx's OAuth + document endpoints have moved before. Treat the first live
// call as the test: `retrievePOD` returns `error` rather than throwing, so a
// wrong shape degrades to agent escalation instead of losing the dispute.
//
// The constraint that shapes this file: SPOD is only returned when the request
// carries the SHIPPER's billing account number. That is checked upstream in
// carriers/index.ts, because a merchant on a 3PL will never satisfy it and
// deserves to be told which secret is missing rather than watching a retry loop.

import type { CarrierEnv, PODResult } from "./types.js";

const OAUTH = "https://apis.fedex.com/oauth/token";
const TRACK = "https://apis.fedex.com/track/v1/trackingnumbers";
const DOCS = "https://apis.fedex.com/track/v1/trackingdocuments";

async function token(env: CarrierEnv): Promise<string> {
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.FEDEX_CLIENT_ID ?? "",
      client_secret: env.FEDEX_CLIENT_SECRET ?? "",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`FedEx OAuth failed (${res.status})`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("FedEx OAuth returned no token");
  return body.access_token;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function fedexPOD(env: CarrierEnv, tracking: string): Promise<PODResult> {
  const auth = await token(env);
  const headers = {
    Authorization: `Bearer ${auth}`,
    "Content-Type": "application/json",
    "X-locale": "en_US",
  };

  // Status first. A parcel that FedEx does not show as delivered has no POD,
  // and asking for the document would just produce a confusing error.
  const trackRes = await fetch(TRACK, {
    method: "POST",
    headers,
    body: JSON.stringify({
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: tracking } }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!trackRes.ok) throw new Error(`FedEx track failed (${trackRes.status})`);

  const track = (await trackRes.json()) as {
    output?: {
      completeTrackResults?: Array<{
        trackResults?: Array<{
          latestStatusDetail?: { code?: string; description?: string; scanLocation?: Record<string, string> };
          deliveryDetails?: { actualDeliveryAddress?: Record<string, unknown>; receivedByName?: string };
          dateAndTimes?: Array<{ type?: string; dateTime?: string }>;
        }>;
      }>;
    };
  };

  const result = track.output?.completeTrackResults?.[0]?.trackResults?.[0];
  const delivered = result?.latestStatusDetail?.code === "DL";
  const deliveredAt = result?.dateAndTimes?.find((d) => d.type === "ACTUAL_DELIVERY")?.dateTime;

  const addr = (result?.deliveryDetails?.actualDeliveryAddress ?? result?.latestStatusDetail?.scanLocation ?? {}) as Record<string, unknown>;
  const deliveryAddress = {
    address1: Array.isArray(addr.streetLines) ? String(addr.streetLines[0] ?? "") : null,
    city: addr.city ? String(addr.city) : null,
    zip: addr.postalCode ? String(addr.postalCode) : null,
    country: addr.countryCode ? String(addr.countryCode) : null,
  };

  if (!delivered) {
    return {
      outcome: "not_delivered",
      detail: result?.latestStatusDetail?.description ?? "FedEx does not show this parcel as delivered",
      deliveryAddress,
    };
  }

  // The signature letter. Requires the shipper account; a refusal here is not
  // fatal because delivery itself is already established above.
  try {
    const docRes = await fetch(`${DOCS}/retrieve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        trackDocumentDetail: { documentType: "SIGNATURE_PROOF_OF_DELIVERY", documentFormat: "PDF" },
        trackDocumentSpecification: [
          {
            trackingNumberInfo: { trackingNumber: tracking },
            accountNumber: { value: env.FEDEX_ACCOUNT_NUMBER },
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (docRes.ok) {
      const doc = (await docRes.json()) as { output?: { documents?: Array<{ image?: string }> } };
      const image = doc.output?.documents?.[0]?.image;
      if (image) {
        return {
          outcome: "delivered_with_pod",
          detail: "FedEx signature proof of delivery retrieved",
          deliveredAt,
          deliveryAddress,
          signedBy: result?.deliveryDetails?.receivedByName,
          document: { data: b64ToBytes(image), filename: `fedex-pod-${tracking}.pdf`, mime: "application/pdf" },
        };
      }
    }
  } catch {
    // Fall through — delivery is confirmed even when the letter is not.
  }

  return {
    outcome: "delivered_no_pod",
    detail: "FedEx confirms delivery but returned no signature document",
    deliveredAt,
    deliveryAddress,
    signedBy: result?.deliveryDetails?.receivedByName,
  };
}
