// Shopify Payments adapter.
//
// The reason this file is not a thin mirror of the Stripe one:
// `disputeEvidenceUpdate` has a documented failure mode where it returns
// success with an empty `userErrors` array while the evidence never reaches
// the bank — `disputeEvidence.submitted` stays false and the dispute sits in
// NEEDS_RESPONSE. Merchants read the success and assume they are covered.
//
// So submission here is never one call. It is: mutate, re-read, compare. The
// `submitted` flag the SERVER reports is the only thing this module treats as
// truth, and a disagreement between "the mutation said ok" and "the server says
// submitted" is a first-class outcome that escalates to the browser agent
// rather than an error to retry.
//
// Shopify's evidence surface is also narrower than Stripe's: there is no
// tracking-number or service-date field, and fulfillments are read off the
// order rather than supplied. Facts with no home slot go into uncategorizedText
// as a written record instead of being dropped.

import type { Dispute, EvidenceItem, Settings } from "../types.js";

const API_VERSION = "2026-07";

export interface ShopifyEnv {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_TOKEN?: string;
}

export class ShopifyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ShopifyError";
  }
}

/** Shopify file slots. Same trap as Stripe: these never take prose. */
export const SHOPIFY_FILE_FIELDS: ReadonlySet<string> = new Set([
  "shippingDocumentationFile",
  "serviceDocumentationFile",
  "customerCommunicationFile",
  "refundPolicyFile",
  "cancellationPolicyFile",
  "uncategorizedFile",
]);

async function gql<T = Record<string, unknown>>(
  env: ShopifyEnv,
  q: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  if (!env.SHOPIFY_SHOP_DOMAIN || !env.SHOPIFY_ADMIN_TOKEN) {
    throw new ShopifyError("SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN must both be set");
  }
  const res = await fetch(
    `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q, variables }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (!res.ok) throw new ShopifyError(`Shopify ${res.status}`, res.status);
  if (body.errors?.length) throw new ShopifyError(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new ShopifyError("Shopify returned no data");
  return body.data;
}

// ── Evidence mapping ────────────────────────────────────────────────

const TEXT_FIELD_FOR: Partial<Record<EvidenceItem["kind"], string>> = {
  activity_log: "accessActivityLog",
  product_description: "productDescription",
  rebuttal: "uncategorizedText",
};

const FILE_FIELD_FOR: Partial<Record<EvidenceItem["kind"], string>> = {
  proof_of_delivery: "shippingDocumentationFile",
  shipping_label: "shippingDocumentationFile",
  prior_usage_artifact: "serviceDocumentationFile",
  customer_communication: "customerCommunicationFile",
  refund_policy: "refundPolicyFile",
  cancellation_policy: "cancellationPolicyFile",
  receipt: "uncategorizedFile",
  invoice: "uncategorizedFile",
  delivery_photo: "uncategorizedFile",
  signature: "uncategorizedFile",
};

export interface MappedShopifyEvidence {
  input: Record<string, unknown>;
  usedItemIds: string[];
  dropped: Array<{ id: string; title: string; why: string }>;
}

export function mapDossierToShopify(
  dispute: Dispute,
  items: EvidenceItem[],
  settings: Settings,
  fileIds: Record<string, string>,
): MappedShopifyEvidence {
  const input: Record<string, unknown> = {};
  const usedItemIds: string[] = [];
  const dropped: MappedShopifyEvidence["dropped"] = [];
  const text: Record<string, string> = {};

  if (dispute.customer_email) input.customerEmailAddress = dispute.customer_email;
  if (dispute.customer_name) {
    const [first, ...rest] = dispute.customer_name.split(" ");
    input.customerFirstName = first;
    if (rest.length) input.customerLastName = rest.join(" ");
  }
  if (settings.product_description_text) text.productDescription = settings.product_description_text;
  if (settings.refund_policy_text) text.refundPolicyDisclosure = settings.refund_policy_text;
  if (settings.cancellation_policy_text) {
    text.cancellationPolicyDisclosure = settings.cancellation_policy_text;
  }

  for (const item of items) {
    if (!item.included) continue;
    const isFile = Boolean(item.file_key);

    if (isFile) {
      const field = FILE_FIELD_FOR[item.kind];
      const fileId = fileIds[item.id];
      if (!field) {
        dropped.push({ id: item.id, title: item.title, why: "no Shopify file slot for this kind" });
        continue;
      }
      if (!fileId) {
        dropped.push({ id: item.id, title: item.title, why: "file not uploaded to Shopify yet" });
        continue;
      }
      if (input[field]) {
        dropped.push({ id: item.id, title: item.title, why: `${field} already holds another file` });
        continue;
      }
      input[field] = { id: fileId };
      usedItemIds.push(item.id);
      continue;
    }

    // Shopify has fewer text slots than Stripe. Anything without a home is
    // still true and still worth saying, so it goes into the narrative rather
    // than being discarded — but it is recorded as folded, not as a clean map.
    const field = TEXT_FIELD_FOR[item.kind];
    if (field && !SHOPIFY_FILE_FIELDS.has(field)) {
      text[field] = text[field] ? `${text[field]}\n\n${item.body}` : item.body;
    } else if (item.body) {
      text.uncategorizedText = [text.uncategorizedText, `${item.title}\n${item.body}`]
        .filter(Boolean)
        .join("\n\n");
    } else {
      dropped.push({ id: item.id, title: item.title, why: "empty text item" });
      continue;
    }
    usedItemIds.push(item.id);
  }

  return { input: { ...input, ...text }, usedItemIds, dropped };
}

// ── Reads ───────────────────────────────────────────────────────────

const DISPUTE_FIELDS = `
  id
  status
  reasonDetails { reason networkReasonCode }
  amount { amount currencyCode }
  evidenceDueBy
  initiatedAt
  type
  order { id name email shippingAddress { address1 address2 city zip province country } }
`;

export async function listDisputes(env: ShopifyEnv, first = 50, after?: string) {
  return gql(
    env,
    `query($first: Int!, $after: String) {
      shopifyPaymentsAccount {
        disputes(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { ${DISPUTE_FIELDS} } }
        }
      }
    }`,
    { first, after },
  );
}

export async function getDispute(env: ShopifyEnv, id: string) {
  return gql(
    env,
    `query($id: ID!) { dispute(id: $id) { ${DISPUTE_FIELDS} } }`,
    { id },
  );
}

/**
 * Read the evidence record, including the `submitted` flag. This is the only
 * source of truth about whether a submission actually landed.
 */
export async function getEvidence(env: ShopifyEnv, disputeId: string) {
  return gql<{
    dispute: { evidence: { id: string; submitted: boolean } | null } | null;
  }>(
    env,
    `query($id: ID!) {
      dispute(id: $id) {
        evidence { id submitted }
      }
    }`,
    { id: disputeId },
  );
}

/** Fulfillments carry the tracking that a delivery dispute lives or dies on. */
export async function getOrderFulfillments(env: ShopifyEnv, orderId: string) {
  return gql<{
    order: {
      id: string;
      name: string;
      shippingAddress: Record<string, string> | null;
      fulfillments: Array<{
        id: string;
        status: string;
        trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
      }>;
    } | null;
  }>(
    env,
    `query($id: ID!) {
      order(id: $id) {
        id
        name
        shippingAddress { address1 address2 city zip province country }
        fulfillments(first: 20) {
          id
          status
          trackingInfo { company number url }
        }
      }
    }`,
    { id: orderId },
  );
}

// ── Submission, and the part that makes it trustworthy ──────────────

export type SubmitOutcome =
  | { ok: true; verified: true; evidenceId: string }
  /**
   * The mutation reported success and the server disagrees. Not an error — a
   * known Shopify behaviour, and the signal to escalate to the browser agent.
   */
  | { ok: true; verified: false; evidenceId: string; reason: "not_submitted_after_mutation" }
  | { ok: false; verified: false; errors: string[] };

/**
 * Update evidence, then verify against the server.
 *
 * `submitEvidence: false` writes a draft the merchant can review in Shopify
 * admin. With `true`, the mutation's own success is treated as a claim and
 * checked: a caller that only looks at `userErrors` will believe a submission
 * that never happened.
 */
export async function putEvidence(
  env: ShopifyEnv,
  disputeId: string,
  input: Record<string, unknown>,
  opts: { submit: boolean },
): Promise<SubmitOutcome> {
  const data = await gql<{
    disputeEvidenceUpdate: {
      disputeEvidence: { id: string; submitted: boolean } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    } | null;
  }>(
    env,
    `mutation($id: ID!, $input: ShopifyPaymentsDisputeEvidenceUpdateInput!) {
      disputeEvidenceUpdate(id: $id, input: $input) {
        disputeEvidence { id submitted }
        userErrors { field message }
      }
    }`,
    { id: disputeId, input: { ...input, submitEvidence: opts.submit } },
  );

  const payload = data.disputeEvidenceUpdate;
  const errors = payload?.userErrors?.map((e) => e.message) ?? [];
  if (errors.length || !payload?.disputeEvidence) {
    return { ok: false, verified: false, errors: errors.length ? errors : ["no evidence returned"] };
  }

  const evidenceId = payload.disputeEvidence.id;

  // A draft was only ever meant to be saved, so the mutation's word is enough.
  if (!opts.submit) return { ok: true, verified: true, evidenceId };

  // Submission claims get checked. Re-read rather than trusting the payload's
  // own `submitted`, because that is part of the same response that lies.
  const fresh = await getEvidence(env, disputeId).catch(() => null);
  const submitted = fresh?.dispute?.evidence?.submitted === true;

  return submitted
    ? { ok: true, verified: true, evidenceId }
    : { ok: true, verified: false, evidenceId, reason: "not_submitted_after_mutation" };
}

// ── File upload (staged, three steps) ───────────────────────────────

/**
 * Shopify uploads are staged: ask for a target, PUT the bytes at it, then hand
 * the resourceUrl back. The returned id is what the evidence input references.
 */
export async function uploadFile(
  env: ShopifyEnv,
  file: { data: Uint8Array; filename: string; mime: string },
): Promise<string> {
  const staged = await gql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: Array<{ message: string }>;
    };
  }>(
    env,
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    {
      input: [
        {
          filename: file.filename,
          mimeType: file.mime,
          resource: "FILE",
          httpMethod: "POST",
          fileSize: String(file.data.byteLength),
        },
      ],
    },
  );

  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    const why = staged.stagedUploadsCreate.userErrors.map((e) => e.message).join("; ");
    throw new ShopifyError(`staged upload refused${why ? `: ${why}` : ""}`);
  }

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([file.data as BlobPart], { type: file.mime }), file.filename);

  const put = await fetch(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new ShopifyError(`staged upload PUT failed (${put.status})`, put.status);

  const created = await gql<{
    fileCreate: { files: Array<{ id: string }>; userErrors: Array<{ message: string }> };
  }>(
    env,
    `mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) { files { id } userErrors { message } }
    }`,
    { files: [{ originalSource: target.resourceUrl, contentType: "FILE" }] },
  );

  const id = created.fileCreate.files[0]?.id;
  if (!id) {
    throw new ShopifyError(
      created.fileCreate.userErrors.map((e) => e.message).join("; ") || "fileCreate returned no id",
    );
  }
  return id;
}
