export interface CarrierEnv {
  FEDEX_CLIENT_ID?: string;
  FEDEX_CLIENT_SECRET?: string;
  FEDEX_ACCOUNT_NUMBER?: string;
  UPS_CLIENT_ID?: string;
  UPS_CLIENT_SECRET?: string;
}

export type PODOutcome =
  | "delivered_with_pod"
  | "delivered_no_pod"
  | "not_delivered"
  | "unsupported"
  | "no_account"
  | "error";

export interface PODResult {
  outcome: PODOutcome;
  detail: string;
  deliveredAt?: string;
  deliveryAddress?: {
    address1?: string | null;
    city?: string | null;
    zip?: string | null;
    country?: string | null;
  };
  /** The POD document itself, when the carrier returned one. */
  document?: { data: Uint8Array; filename: string; mime: string };
  /** Whether the carrier recorded a signature, independent of the document. */
  signedBy?: string;
}
