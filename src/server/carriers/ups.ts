// UPS proof of delivery.
//
// UNVERIFIED AGAINST A LIVE ACCOUNT — same caveat as the FedEx client.
//
// One rule here is legal rather than technical, and it is why this returns a
// POD *letter* and never a bare signature image: UPS terms permit the
// electronic signature image only as part of a POD Letter, and forbid storing,
// copying or passing it to a third party otherwise. Submitting evidence to a
// card issuer is exactly the third-party disclosure that restriction covers, so
// the raw signature is read for its presence and then discarded.

import type { CarrierEnv, PODResult } from "./types.js";

const OAUTH = "https://onlinetools.ups.com/security/v1/oauth/token";
const TRACK = "https://onlinetools.ups.com/api/track/v1/details";

async function token(env: CarrierEnv): Promise<string> {
  const basic = btoa(`${env.UPS_CLIENT_ID}:${env.UPS_CLIENT_SECRET}`);
  const res = await fetch(OAUTH, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`UPS OAuth failed (${res.status})`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("UPS OAuth returned no token");
  return body.access_token;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function upsPOD(env: CarrierEnv, tracking: string): Promise<PODResult> {
  const auth = await token(env);
  const res = await fetch(
    `${TRACK}/${encodeURIComponent(tracking)}?locale=en_US&returnSignature=true&returnPOD=true`,
    {
      headers: {
        Authorization: `Bearer ${auth}`,
        transId: crypto.randomUUID(),
        transactionSrc: "open-disputes",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`UPS track failed (${res.status})`);

  const body = (await res.json()) as {
    trackResponse?: {
      shipment?: Array<{
        package?: Array<{
          currentStatus?: { code?: string; description?: string };
          deliveryDate?: Array<{ type?: string; date?: string }>;
          deliveryTime?: { endTime?: string };
          deliveryInformation?: {
            location?: string;
            receivedBy?: string;
            signature?: { image?: string };
            pod?: { content?: string };
          };
          packageAddress?: Array<{ type?: string; address?: Record<string, string> }>;
        }>;
      }>;
    };
  };

  const pkg = body.trackResponse?.shipment?.[0]?.package?.[0];
  const status = pkg?.currentStatus?.code;
  const info = pkg?.deliveryInformation;

  const destination = pkg?.packageAddress?.find((a) => a.type === "DESTINATION")?.address ?? {};
  const deliveryAddress = {
    address1: destination.addressLine1 ?? null,
    city: destination.city ?? null,
    zip: destination.postalCode ?? null,
    country: destination.countryCode ?? null,
  };

  // UPS uses status "011"/"D" for delivered depending on the response variant.
  const delivered = status === "011" || status === "D" || /delivered/i.test(pkg?.currentStatus?.description ?? "");
  if (!delivered) {
    return {
      outcome: "not_delivered",
      detail: pkg?.currentStatus?.description ?? "UPS does not show this parcel as delivered",
      deliveryAddress,
    };
  }

  const deliveredAt = pkg?.deliveryDate?.find((d) => d.type === "DEL")?.date;

  // The letter, and only the letter.
  if (info?.pod?.content) {
    return {
      outcome: "delivered_with_pod",
      detail: "UPS POD letter retrieved",
      deliveredAt,
      deliveryAddress,
      signedBy: info.receivedBy,
      document: {
        data: b64ToBytes(info.pod.content),
        filename: `ups-pod-${tracking}.pdf`,
        mime: "application/pdf",
      },
    };
  }

  return {
    outcome: "delivered_no_pod",
    detail: info?.signature?.image
      ? "UPS recorded a signature but returned no POD letter; the bare signature image cannot be redistributed under UPS terms"
      : "UPS confirms delivery with no signature on file",
    deliveredAt,
    deliveryAddress,
    signedBy: info?.receivedBy,
  };
}
