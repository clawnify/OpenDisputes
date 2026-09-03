// Escalation to the org's agent.
//
// The split, same as elsewhere in this codebase: the app does the bounded,
// mechanical work in a Worker; the agent does what needs a real browser, a real
// login and minutes of runtime. Here that boundary is unusually sharp, because
// there are exactly two jobs an HTTP client cannot do and a browser can:
//
//   1. Retrieve proof of delivery a carrier will not serve over its API — a
//      merchant with no shipper account number, a USPS scan, a regional carrier.
//   2. Finish a Shopify submission the GraphQL mutation claimed to complete and
//      did not. Clicking the button in Shopify admin is, today, the only
//      reliable way to land that evidence.
//
// Both are one-way dispatches. Nothing polls: the agent reports back through
// this app's own API, so the dispute row stays the record of progress. That
// keeps a wedged agent visible as a stalled dispute instead of a silent one.

const DEFAULT_AGENTS_URL = "https://provision.clawnify.com/v1/agents";

export interface AgentEnv {
  CLAWNIFY_TOKEN?: string;
  CLAWNIFY_AGENTS_URL?: string;
}

export interface AgentServer {
  id: string;
  name: string | null;
  status: string | null;
}

export type DispatchResult =
  | { ok: true; taskId: string; serverId: string | null; duplicate: boolean }
  | { ok: false; error: string; servers?: AgentServer[] };

function base(env: AgentEnv): string {
  return (env.CLAWNIFY_AGENTS_URL ?? DEFAULT_AGENTS_URL).replace(/\/+$/, "");
}

export function dispatchAvailable(env: AgentEnv): boolean {
  return Boolean(env.CLAWNIFY_TOKEN);
}

async function call(
  env: AgentEnv,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLAWNIFY_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

export async function listAgentServers(env: AgentEnv): Promise<AgentServer[] | null> {
  if (!dispatchAvailable(env)) return null;
  try {
    const { status, body } = await call(env, "/servers");
    if (status !== 200) return null;
    return (body.servers as AgentServer[]) ?? [];
  } catch {
    return null;
  }
}

export async function dispatchTask(
  env: AgentEnv,
  opts: { instruction: string; serverId?: string | null; idempotencyKey: string },
): Promise<DispatchResult> {
  if (!dispatchAvailable(env)) {
    return {
      ok: false,
      error: "This app can't reach your agent — hand the instruction over in chat instead.",
    };
  }

  let status: number;
  let body: Record<string, unknown>;
  try {
    ({ status, body } = await call(env, "/tasks", {
      method: "POST",
      body: JSON.stringify({
        instruction: opts.instruction,
        ...(opts.serverId ? { server_id: opts.serverId } : {}),
        idempotency_key: opts.idempotencyKey,
      }),
    }));
  } catch (err) {
    return { ok: false, error: `Could not reach your agent: ${(err as Error).message}` };
  }

  if (status === 202 || status === 200) {
    return {
      ok: true,
      taskId: String(body.task_id ?? ""),
      serverId: (body.server_id as string | null) ?? null,
      duplicate: body.status === "duplicate",
    };
  }

  if (body.error === "multiple_servers") {
    return {
      ok: false,
      error: "You have more than one agent — choose which one handles disputes in Settings.",
      servers: (body.servers as AgentServer[]) ?? [],
    };
  }

  return { ok: false, error: String(body.error ?? `Agent dispatch failed (${status})`) };
}

// ── Briefs ──────────────────────────────────────────────────────────
//
// Each brief is one text with two audiences: what the platform delivers to the
// agent, and what a user copies into chat when dispatch is unavailable. Kept
// here so those cannot drift apart.

export function carrierPODBrief(opts: {
  disputeId: string;
  carrier: string;
  tracking: string;
  orderAddress: string;
  whyEscalated: string;
  appUrl: string;
}): string {
  return [
    `Retrieve proof of delivery for a disputed order and file it in OpenDisputes (${opts.appUrl}).`,
    ``,
    `Carrier: ${opts.carrier}`,
    `Tracking: ${opts.tracking}`,
    `Order shipped to: ${opts.orderAddress}`,
    ``,
    `Why this reached you: ${opts.whyEscalated}`,
    ``,
    `Sign in to the carrier's own portal with the merchant's credentials and get`,
    `the delivery record. The public tracking page is NOT enough — an issuer`,
    `discounts a screenshot of it. What is worth having, in order:`,
    ``,
    `  1. The signed proof-of-delivery letter or delivery receipt as a PDF.`,
    `  2. The delivery photograph, if the carrier took one.`,
    `  3. The full scan history showing the parcel moving to the delivery address.`,
    ``,
    `Record the delivery ADDRESS exactly as the carrier states it, including the`,
    `postal code. The app compares it against the order's shipping address, and a`,
    `mismatch changes the recommendation — so an approximate address is worse`,
    `than none.`,
    ``,
    `Do not sign anything, do not open a carrier claim, and do not contact the`,
    `recipient. This is retrieval only.`,
    ``,
    `Report back: POST /api/disputes/${opts.disputeId}/carrier-result with`,
    `{ "outcome": "delivered_with_pod" | "delivered_no_pod" | "not_delivered" | "error",`,
    `  "delivered_at": "YYYY-MM-DD", "delivery_address": "…", "detail": "…" }`,
    `and attach any document to POST /api/disputes/${opts.disputeId}/evidence.`,
    ``,
    `If the portal will not show the record, say so with outcome "error" and one`,
    `line on what blocked you. A silent failure looks identical to a dead task.`,
  ].join("\n");
}

export function shopifySubmitBrief(opts: {
  disputeId: string;
  shopDomain: string;
  orderRef: string;
  appUrl: string;
}): string {
  return [
    `Finish a Shopify dispute submission that the API could not complete.`,
    ``,
    `Shop: ${opts.shopDomain}`,
    `Order: ${opts.orderRef}`,
    ``,
    `What happened: OpenDisputes wrote the evidence through the Shopify Admin`,
    `API. The mutation returned success with no errors, but re-reading the`,
    `dispute shows the evidence is still NOT submitted — a known Shopify`,
    `behaviour. The evidence is already saved as a draft; it just has to be sent.`,
    ``,
    `Open the Shopify admin, go to the dispute on order ${opts.orderRef}, and`,
    `check the evidence that is already there against the dossier in OpenDisputes`,
    `(${opts.appUrl}/disputes/${opts.disputeId}). If the draft is complete, submit it.`,
    ``,
    `IMPORTANT — this submission is one-way. Shopify accepts evidence once, and`,
    `there is no second attempt. If anything is missing or looks wrong, STOP and`,
    `tell the user rather than submitting a weak packet to meet the deadline.`,
    ``,
    `Report back: POST /api/disputes/${opts.disputeId}/submission-result with`,
    `{ "submitted": true | false, "detail": "…" }.`,
  ].join("\n");
}
