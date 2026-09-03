import { createApp, createRoute, z } from "@clawnify/app";
import { get, query, run } from "./db.js";
import {
  addEvidence, buildRebuttal, gatherCarrierEvidence, loadDossier, refreshTriage, settings,
  type DossierEnv,
} from "./dossier.js";
import { shouldAutoSubmit } from "./triage.js";
import { dossierHTML, renderDossier } from "./render.js";
import { dispatchTask, listAgentServers, shopifySubmitBrief } from "./agent.js";
import { CARRIERS, matchAddress } from "./carriers/index.js";
import * as stripe from "./adapters/stripe.js";
import * as shopify from "./adapters/shopify.js";
import { normalizeReason, type Dispute, type EvidenceItem } from "./types.js";

type Env = {
  Bindings: DossierEnv & {
    DB: D1Database;
    CLAWNIFY_TOKEN?: string;
    CLAWNIFY_ORG_ID?: string;
    APP_URL?: string;
    MERCHANT_NAME?: string;
    STRIPE_API_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    SHOPIFY_SHOP_DOMAIN?: string;
    SHOPIFY_ADMIN_TOKEN?: string;
  };
};

const app = createApp<Env>({
  title: "OpenDisputes",
  version: "1.0.0",
  description:
    "Chargeback evidence, assembled from Stripe, Shopify and the carriers, then staged for your review before it goes to the bank.",
});

// ── Schemas ─────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const DisputeSchema = z
  .object({
    id: z.string(), processor: z.string(), external_id: z.string(),
    reason: z.string(), status: z.string(),
    amount_cents: z.number(), currency: z.string(), is_physical: z.number(),
    customer_email: z.string(), customer_name: z.string(),
    order_ref: z.string(), charge_ref: z.string(), issuer_country: z.string(),
    due_by: z.string().nullable(), opened_at: z.string(),
    recommendation: z.string(), recommendation_reason: z.string(),
    outcome: z.string().nullable(), outcome_at: z.string().nullable(),
    created_at: z.string(), updated_at: z.string(),
  })
  .openapi("Dispute");

const EvidenceSchema = z
  .object({
    id: z.string(), dispute_id: z.string(), kind: z.string(), source: z.string(),
    title: z.string(), body: z.string(), file_key: z.string(), file_mime: z.string(),
    file_bytes: z.number(), provenance: z.string(), included: z.number(),
    collected_at: z.string(),
  })
  .openapi("Evidence");

const KINDS = [
  "activity_log", "receipt", "invoice", "product_description", "proof_of_delivery",
  "tracking_history", "shipping_label", "customer_communication", "refund_policy",
  "cancellation_policy", "terms_acceptance", "ip_geo_match", "prior_usage_artifact",
  "signature", "delivery_photo", "rebuttal", "other",
] as const;

// ── Disputes ────────────────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "get", path: "/api/disputes",
    summary: "List disputes, newest deadline first",
    request: {
      query: z.object({
        status: z.string().optional().openapi({ description: "Processor status, e.g. needs_response" }),
        recommendation: z.string().optional().openapi({ description: "fight | do_not_fight | accept | pending" }),
        open: z.string().optional().openapi({ description: "true = only disputes with no outcome yet" }),
        page: z.string().optional(), limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Disputes",
        content: { "application/json": { schema: z.object({ disputes: z.array(DisputeSchema), total: z.number() }) } },
      },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const limit = Math.min(Number(q.limit) || 25, 100);
    const page = Math.max(Number(q.page) || 1, 1);

    const where: string[] = [];
    const args: unknown[] = [];
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    if (q.recommendation) { where.push("recommendation = ?"); args.push(q.recommendation); }
    if (q.open === "true") where.push("outcome is null");
    const clause = where.length ? `where ${where.join(" and ")}` : "";

    const total = await get<{ n: number }>(`select count(*) as n from disputes ${clause}`, args);
    // Deadline order, nulls last: what is due soonest is what needs attention.
    const disputes = await query<Dispute>(
      `select * from disputes ${clause}
       order by (due_by is null), due_by asc, created_at desc
       limit ? offset ?`,
      [...args, limit, (page - 1) * limit],
    );
    return c.json({ disputes, total: total?.n ?? 0 }, 200);
  },
);

app.openapi(
  createRoute({
    method: "get", path: "/api/disputes/{id}",
    summary: "One dispute with its full dossier",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Dossier",
        content: {
          "application/json": {
            schema: z.object({
              dispute: DisputeSchema,
              items: z.array(EvidenceSchema),
              carrier: z.array(z.record(z.unknown())),
            }),
          },
        },
      },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const d = await loadDossier(c.req.valid("param").id);
    if (!d) return c.json({ error: "dispute not found" }, 404);
    return c.json(d, 200);
  },
);

// ── Evidence ────────────────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "post", path: "/api/disputes/{id}/evidence",
    summary: "Add a piece of evidence to a dispute",
    description:
      "How the agent files what it retrieved. `source` is not cosmetic: an issuer weighs a carrier's own record above a screenshot of the same fact, and the dossier prints the distinction.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              kind: z.enum(KINDS),
              source: z.enum(["carrier_api", "agent_browser", "merchant_upload", "generated"]),
              title: z.string().min(1),
              body: z.string().optional(),
              file_key: z.string().optional(),
              file_mime: z.string().optional(),
              file_bytes: z.number().optional(),
              provenance: z.record(z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: "Added", content: { "application/json": { schema: z.object({ id: z.string() }) } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const d = await get<Dispute>("select id from disputes where id = ?", [id]);
    if (!d) return c.json({ error: "dispute not found" }, 404);

    const itemId = await addEvidence(id, body);
    // New evidence can flip the verdict, so never leave a stale one on screen.
    await refreshTriage(id);
    return c.json({ id: itemId }, 201);
  },
);

app.openapi(
  createRoute({
    method: "patch", path: "/api/evidence/{id}",
    summary: "Include or exclude a piece of evidence",
    description:
      "Excluded evidence is kept, not deleted. What was gathered and deliberately left out is exactly what you need when reviewing a case you lost.",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ included: z.boolean() }) } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const item = await get<EvidenceItem>("select dispute_id from evidence_items where id = ?", [id]);
    if (!item) return c.json({ error: "evidence not found" }, 404);
    await run("update evidence_items set included = ? where id = ?", [
      c.req.valid("json").included ? 1 : 0, id,
    ]);
    await refreshTriage(item.dispute_id);
    return c.json({ ok: true }, 200);
  },
);

// ── Prepare and submit ──────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "post", path: "/api/disputes/{id}/prepare",
    summary: "Assemble the dossier: carrier lookups, rebuttal, triage",
    description:
      "Safe to call repeatedly. Does not submit anything; it only gathers and re-scores.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Prepared",
        content: {
          "application/json": {
            schema: z.object({
              recommendation: z.string(), reason: z.string(),
              carrier_lookups: z.number(), escalated: z.boolean(),
            }),
          },
        },
      },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await preparePipeline(c.env, id);
    if (!result) return c.json({ error: "dispute not found" }, 404);
    return c.json(result, 200);
  },
);

app.openapi(
  createRoute({
    method: "post", path: "/api/disputes/{id}/submit",
    summary: "Stage evidence, or send it to the bank",
    description:
      "Defaults to staging. Evidence can be submitted once per dispute and cannot be revised afterwards, so `submit: true` is always an explicit choice. On Shopify the result is verified against the server, and a submission the API claimed but did not make escalates to the agent.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              submit: z.boolean().default(false).openapi({ description: "false stages a draft; true sends it to the bank" }),
              override_recommendation: z.boolean().default(false).openapi({
                description: "Submit even when triage recommends conceding. Required for that case.",
              }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Result",
        content: {
          "application/json": {
            schema: z.object({
              mode: z.string(), verified: z.boolean(), escalated: z.boolean(),
              dropped: z.array(z.object({ id: z.string(), title: z.string(), why: z.string() })),
              detail: z.string(),
            }),
          },
        },
      },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Refused", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { submit, override_recommendation } = c.req.valid("json");
    const d = await loadDossier(id);
    if (!d) return c.json({ error: "dispute not found" }, 404);
    const s = await settings();

    // The guard. Conceding is a recommendation, not a lock, but overriding it
    // has to be deliberate — this is the case where an unnecessary submission
    // costs credibility with an issuer the merchant will meet again.
    if (submit && d.dispute.recommendation !== "fight" && !override_recommendation) {
      return c.json(
        {
          error: `Triage recommends "${d.dispute.recommendation}" for this dispute. ${d.dispute.recommendation_reason} Send override_recommendation: true if you still want to submit.`,
        },
        409,
      );
    }

    const submissionId = crypto.randomUUID();

    if (d.dispute.processor === "stripe") {
      // Files must exist in Stripe before the evidence hash can reference them.
      const fileIds: Record<string, string> = {};
      for (const item of d.items.filter((i) => i.included && i.file_key)) {
        const stored = await loadFile(c.env, item);
        if (!stored) continue;
        try {
          fileIds[item.id] = await stripe.uploadFile(c.env, stored);
        } catch {
          // Leave it unmapped; the mapper reports it as dropped rather than
          // silently writing a filename into a file-only field.
        }
      }

      const mapped = stripe.mapDossierToStripe(d.dispute, d.items, s, fileIds);
      let response: Record<string, unknown> = {};
      let error = "";
      try {
        response = await stripe.putEvidence(c.env, d.dispute.external_id, mapped.evidence, { submit });
      } catch (err) {
        error = (err as Error).message;
      }

      const details = (response.evidence_details ?? {}) as { submission_count?: number };
      const verified = !error && (submit ? (details.submission_count ?? 0) > 0 : true);

      await recordSubmission({
        id: submissionId, disputeId: id, mode: submit ? "submitted" : "staged",
        channel: "api", payload: mapped.evidence, itemIds: mapped.usedItemIds,
        response, verified, error,
      });

      if (error) return c.json({ error }, 409);
      return c.json({
        mode: submit ? "submitted" : "staged", verified, escalated: false,
        dropped: mapped.dropped,
        detail: submit
          ? "Evidence sent to the bank. Stripe accepts it once; there is no revision."
          : "Staged on the dispute. Visible in Stripe and still editable until you submit.",
      }, 200);
    }

    // ── Shopify: mutate, re-read, compare ──
    const fileIds: Record<string, string> = {};
    for (const item of d.items.filter((i) => i.included && i.file_key)) {
      const stored = await loadFile(c.env, item);
      if (!stored) continue;
      try {
        fileIds[item.id] = await shopify.uploadFile(c.env, stored);
      } catch { /* reported as dropped by the mapper */ }
    }

    const mapped = shopify.mapDossierToShopify(d.dispute, d.items, s, fileIds);
    const outcome = await shopify
      .putEvidence(c.env, d.dispute.external_id, mapped.input, { submit })
      .catch((err: Error) => ({ ok: false as const, verified: false as const, errors: [err.message] }));

    const verified = outcome.ok && outcome.verified;
    await recordSubmission({
      id: submissionId, disputeId: id, mode: submit ? "submitted" : "staged",
      channel: "api", payload: mapped.input, itemIds: mapped.usedItemIds,
      response: outcome as unknown as Record<string, unknown>, verified,
      error: outcome.ok ? "" : outcome.errors.join("; "),
    });

    if (!outcome.ok) return c.json({ error: outcome.errors.join("; ") }, 409);

    // The documented Shopify failure: success reported, nothing submitted.
    // A browser can finish it; another API call cannot.
    let escalated = false;
    if (submit && !outcome.verified) {
      const dispatch = await dispatchTask(c.env, {
        instruction: shopifySubmitBrief({
          disputeId: id,
          shopDomain: c.env.SHOPIFY_SHOP_DOMAIN ?? "",
          orderRef: d.dispute.order_ref,
          appUrl: c.env.APP_URL ?? "",
        }),
        serverId: s.agent_server_id || null,
        idempotencyKey: `shopify-submit:${id}`,
      });
      escalated = dispatch.ok;
    }

    return c.json({
      mode: submit ? "submitted" : "staged", verified, escalated,
      dropped: mapped.dropped,
      detail: !submit
        ? "Saved as a draft in Shopify admin."
        : verified
          ? "Shopify confirms the evidence is submitted."
          : escalated
            ? "Shopify reported success but the evidence is still not submitted — a known behaviour. Your agent is finishing it in the admin."
            : "Shopify reported success but the evidence is still not submitted, and the agent could not be reached. Submit it by hand in Shopify admin.",
    }, 200);
  },
);

// ── Agent callbacks ─────────────────────────────────────────────────
//
// One-way dispatch means the agent's only way back in is through this API. Both
// of these are written so that a failure the agent reports is as informative as
// a success — a silent abandonment is the failure mode that leaves a merchant
// staring at a dispute that looks alive until the deadline passes.

app.openapi(
  createRoute({
    method: "post", path: "/api/disputes/{id}/carrier-result",
    summary: "Report what a carrier portal showed",
    description: "How the agent closes the loop after retrieving delivery information by browser.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              carrier: z.string(), tracking: z.string(),
              outcome: z.enum(["delivered_with_pod", "delivered_no_pod", "not_delivered", "error"]),
              delivered_at: z.string().optional(),
              delivery_address: z.string().optional().openapi({
                description: "Exactly as the carrier states it, including postal code. Compared against the order address.",
              }),
              detail: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Recorded",
        content: { "application/json": { schema: z.object({ ok: z.boolean(), address_match: z.number().nullable(), recommendation: z.string() }) } },
      },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const d = await loadDossier(id);
    if (!d) return c.json({ error: "dispute not found" }, 404);

    // Address matching happens here rather than in the agent: the comparison
    // rules are the same ones the triage guard trusts, and an agent eyeballing
    // "close enough" is exactly the judgment this must not accept.
    let addressMatch: number | null = null;
    if (b.delivery_address && d.dispute.processor === "shopify") {
      const order = await shopify.getOrderFulfillments(c.env, d.dispute.order_ref).catch(() => null);
      const shipTo = order?.order?.shippingAddress;
      if (shipTo) {
        const parsed = parseAddress(b.delivery_address);
        const m = matchAddressSafe(shipTo, parsed);
        addressMatch = m === null ? null : m ? 1 : 0;
      }
    }

    await run(
      `insert into carrier_lookups
         (id, dispute_id, carrier, tracking, channel, outcome, delivered_at,
          delivery_address, address_match, detail)
       values (?, ?, ?, ?, 'agent_browser', ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), id, b.carrier, b.tracking, b.outcome,
        b.delivered_at ?? null, b.delivery_address ?? "", addressMatch, b.detail ?? "",
      ],
    );

    await refreshTriage(id);
    const after = await get<Dispute>("select recommendation from disputes where id = ?", [id]);
    return c.json({ ok: true, address_match: addressMatch, recommendation: String(after?.recommendation ?? "pending") }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post", path: "/api/disputes/{id}/submission-result",
    summary: "Report whether a browser submission landed",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: z.object({ submitted: z.boolean(), detail: z.string().optional() }) } } },
    },
    responses: {
      200: { description: "Recorded", content: { "application/json": { schema: OkSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    await run(
      `insert into submissions (id, dispute_id, mode, channel, verified_submitted, verified_at, error)
       values (?, ?, 'submitted', 'agent_browser', ?, datetime('now'), ?)`,
      [crypto.randomUUID(), id, b.submitted ? 1 : 0, b.submitted ? "" : (b.detail ?? "agent could not submit")],
    );
    return c.json({ ok: true }, 200);
  },
);

// ── The dossier document ────────────────────────────────────────────

app.get("/api/disputes/:id/dossier.pdf", async (c) => {
  const d = await loadDossier(c.req.param("id"));
  if (!d) return c.json({ error: "dispute not found" }, 404);
  const carrier = await query<Record<string, never>>(
    "select carrier, tracking, outcome, delivered_at, delivery_address, address_match, channel, detail from carrier_lookups where dispute_id = ? order by created_at",
    [d.dispute.id],
  );
  const input = {
    dispute: d.dispute, items: d.items,
    carrier: carrier as unknown as Parameters<typeof dossierHTML>[0]["carrier"],
    merchantName: c.env.MERCHANT_NAME ?? "",
  };

  // Off-platform there is no PDF service, and an HTML dossier the merchant can
  // print beats a 500 that hides the content entirely.
  if (!c.env.CLAWNIFY_TOKEN) {
    return c.html(dossierHTML(input));
  }
  const pdf = await renderDossier(c.env, input);
  return new Response(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="evidence-${d.dispute.order_ref || d.dispute.external_id}.pdf"`,
    },
  });
});

// ── Intake ──────────────────────────────────────────────────────────

/**
 * Stripe webhook. Public by necessity — Stripe cannot carry our auth — so the
 * signature is the only thing standing between this and a forged dispute, and
 * an unset secret refuses rather than trusting the body.
 */
app.post("/api/webhooks/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  const sig = c.req.header("stripe-signature");
  const payload = await c.req.text();

  if (!secret) return c.json({ error: "STRIPE_WEBHOOK_SECRET is not configured" }, 503);
  if (!sig || !(await stripe.verifyWebhook(secret, payload, sig))) {
    return c.json({ error: "signature verification failed" }, 400);
  }

  const event = JSON.parse(payload) as { type: string; data: { object: Record<string, unknown> } };
  if (!event.type?.startsWith("charge.dispute.")) return c.json({ ok: true });

  const id = await upsertStripeDispute(c.env, event.data.object);

  if (event.type === "charge.dispute.created") {
    // Prepare immediately. The deadline starts now, and the merchant should
    // find a scored dossier waiting rather than an empty row.
    await preparePipeline(c.env, id);

    const s = await settings();
    const d = await get<Dispute>("select recommendation, reason from disputes where id = ?", [id]);
    if (d && shouldAutoSubmit(d.recommendation, normalizeReason(d.reason), s)) {
      const dossier = await loadDossier(id);
      if (dossier) {
        const mapped = stripe.mapDossierToStripe(dossier.dispute, dossier.items, s, {});
        await stripe
          .putEvidence(c.env, dossier.dispute.external_id, mapped.evidence, { submit: true })
          .catch(() => undefined);
      }
    }
  }

  if (event.type === "charge.dispute.closed") {
    const status = String(event.data.object.status ?? "");
    const outcome = status === "won" ? "won" : status === "lost" ? "lost" : "warning_closed";
    await run("update disputes set outcome = ?, outcome_at = datetime('now') where id = ?", [outcome, id]);
  }

  return c.json({ ok: true });
});

app.openapi(
  createRoute({
    method: "post", path: "/api/sync",
    summary: "Backfill disputes that opened before this app existed",
    description:
      "A webhook only catches what happens next. This pulls the history from whichever processors are configured, so an existing merchant does not start from an empty table.",
    request: {
      body: { content: { "application/json": { schema: z.object({ prepare: z.boolean().default(true) }) } } },
    },
    responses: {
      200: {
        description: "Synced",
        content: { "application/json": { schema: z.object({ imported: z.number(), prepared: z.number(), sources: z.array(z.string()) }) } },
      },
    },
  }),
  async (c) => {
    const { prepare } = c.req.valid("json");
    const sources: string[] = [];
    const ids: string[] = [];

    if (c.env.STRIPE_API_KEY) {
      sources.push("stripe");
      let after: string | undefined;
      // Bounded: ten pages of a hundred. A merchant with more history than that
      // can run it again, and an unbounded loop in a Worker is a timeout.
      for (let pageNo = 0; pageNo < 10; pageNo++) {
        const page = (await stripe.listDisputes(c.env, after)) as {
          data?: Array<Record<string, unknown>>; has_more?: boolean;
        };
        for (const dd of page.data ?? []) ids.push(await upsertStripeDispute(c.env, dd));
        if (!page.has_more || !page.data?.length) break;
        after = String(page.data[page.data.length - 1].id);
      }
    }

    if (c.env.SHOPIFY_ADMIN_TOKEN) {
      sources.push("shopify");
      const res = (await shopify.listDisputes(c.env)) as {
        shopifyPaymentsAccount?: { disputes?: { edges?: Array<{ node: Record<string, unknown> }> } };
      };
      for (const edge of res.shopifyPaymentsAccount?.disputes?.edges ?? []) {
        ids.push(await upsertShopifyDispute(edge.node));
      }
    }

    let prepared = 0;
    if (prepare) {
      // Only open ones. Re-preparing a closed dispute spends carrier calls on a
      // question nobody can act on any more.
      for (const id of ids) {
        const d = await get<Dispute>("select outcome from disputes where id = ?", [id]);
        if (d && !d.outcome) {
          await preparePipeline(c.env, id).catch(() => undefined);
          prepared++;
        }
      }
    }

    return c.json({ imported: ids.length, prepared, sources }, 200);
  },
);

// ── Settings and the outcome ledger ─────────────────────────────────

app.openapi(
  createRoute({
    method: "get", path: "/api/settings",
    summary: "Merchant policy text and automation posture",
    responses: {
      200: {
        description: "Settings",
        content: {
          "application/json": {
            schema: z.object({
              settings: z.record(z.unknown()),
              agents: z.array(z.record(z.unknown())).nullable(),
              carriers: z.array(z.record(z.unknown())),
              connected: z.object({ stripe: z.boolean(), shopify: z.boolean() }),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const s = await settings();
    return c.json({
      settings: s,
      agents: await listAgentServers(c.env),
      // Surfaced so a merchant can see which secret would move a carrier off
      // the slow path, rather than discovering it in a failure message.
      carriers: Object.values(CARRIERS).map((cap) => {
        const secrets = c.env as unknown as Record<string, unknown>;
        const missing = cap.requires.filter((k) => !secrets[k]);
        return { ...cap, ready: cap.apiPOD && missing.length === 0, missing };
      }),
      connected: {
        stripe: Boolean(c.env.STRIPE_API_KEY),
        shopify: Boolean(c.env.SHOPIFY_ADMIN_TOKEN && c.env.SHOPIFY_SHOP_DOMAIN),
      },
    }, 200);
  },
);

app.openapi(
  createRoute({
    method: "put", path: "/api/settings",
    summary: "Update policy text and automation posture",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              auto_submit: z.boolean().optional(),
              auto_submit_reasons: z.array(z.string()).optional().openapi({
                description: "Reason codes promoted to auto-submit. Auto-submit never fires on a dispute triage would concede.",
              }),
              refund_policy_text: z.string().optional(),
              cancellation_policy_text: z.string().optional(),
              product_description_text: z.string().optional(),
              policy_url: z.string().optional(),
              agent_server_id: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } } },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };

    if (b.auto_submit !== undefined) put("auto_submit", b.auto_submit ? 1 : 0);
    if (b.auto_submit_reasons) put("auto_submit_reasons", JSON.stringify(b.auto_submit_reasons));
    if (b.refund_policy_text !== undefined) put("refund_policy_text", b.refund_policy_text);
    if (b.cancellation_policy_text !== undefined) put("cancellation_policy_text", b.cancellation_policy_text);
    if (b.product_description_text !== undefined) put("product_description_text", b.product_description_text);
    if (b.policy_url !== undefined) put("policy_url", b.policy_url);
    if (b.agent_server_id !== undefined) put("agent_server_id", b.agent_server_id);
    if (!sets.length) return c.json({ ok: true }, 200);

    await run(`update settings set ${sets.join(", ")}, updated_at = datetime('now') where id = 1`, args);
    return c.json({ ok: true }, 200);
  },
);

app.openapi(
  createRoute({
    method: "get", path: "/api/stats",
    summary: "Win rate by reason code, carrier and issuer country",
    description:
      "The number nobody sells back to merchants: which evidence combinations actually convert, on their own traffic. Small samples are reported as small rather than rounded into a percentage that reads like a finding.",
    responses: {
      200: {
        description: "Stats",
        content: {
          "application/json": {
            schema: z.object({
              totals: z.record(z.unknown()),
              by_reason: z.array(z.record(z.unknown())),
              by_country: z.array(z.record(z.unknown())),
              with_pod: z.record(z.unknown()),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const totals = await get<Record<string, number>>(
      `select count(*) as total,
              sum(case when outcome is null then 1 else 0 end) as open,
              sum(case when outcome = 'won' then 1 else 0 end) as won,
              sum(case when outcome = 'lost' then 1 else 0 end) as lost,
              sum(case when outcome = 'won' then amount_cents else 0 end) as recovered_cents,
              sum(case when outcome = 'lost' then amount_cents else 0 end) as lost_cents
         from disputes`,
    );

    const by_reason = await query(
      `select reason,
              count(*) as decided,
              sum(case when outcome = 'won' then 1 else 0 end) as won
         from disputes where outcome in ('won','lost')
         group by reason order by decided desc`,
    );

    const by_country = await query(
      `select issuer_country,
              count(*) as decided,
              sum(case when outcome = 'won' then 1 else 0 end) as won
         from disputes where outcome in ('won','lost') and issuer_country != ''
         group by issuer_country order by decided desc`,
    );

    // The one comparison that justifies the carrier work: does retrieved proof
    // of delivery actually change the outcome on this merchant's traffic?
    const with_pod = await get(
      `select
         sum(case when p.has_pod = 1 and d.outcome = 'won'  then 1 else 0 end) as pod_won,
         sum(case when p.has_pod = 1 and d.outcome = 'lost' then 1 else 0 end) as pod_lost,
         sum(case when p.has_pod = 0 and d.outcome = 'won'  then 1 else 0 end) as nopod_won,
         sum(case when p.has_pod = 0 and d.outcome = 'lost' then 1 else 0 end) as nopod_lost
       from disputes d
       join (
         select dd.id,
                max(case when cl.outcome = 'delivered_with_pod' then 1 else 0 end) as has_pod
           from disputes dd left join carrier_lookups cl on cl.dispute_id = dd.id
          where dd.is_physical = 1
          group by dd.id
       ) p on p.id = d.id
       where d.outcome in ('won','lost')`,
    );

    return c.json({ totals: totals ?? {}, by_reason, by_country, with_pod: with_pod ?? {} }, 200);
  },
);

// ── Helpers ─────────────────────────────────────────────────────────

async function recordSubmission(o: {
  id: string; disputeId: string; mode: "staged" | "submitted";
  channel: "api" | "agent_browser"; payload: unknown; itemIds: string[];
  response: unknown; verified: boolean; error: string;
}): Promise<void> {
  await run(
    `insert into submissions
       (id, dispute_id, mode, channel, payload, item_ids, response, verified_submitted, verified_at, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    [
      o.id, o.disputeId, o.mode, o.channel, JSON.stringify(o.payload),
      JSON.stringify(o.itemIds), JSON.stringify(o.response), o.verified ? 1 : 0, o.error,
    ],
  );
}

async function loadFile(
  env: { UPLOADS?: R2Bucket },
  item: EvidenceItem,
): Promise<{ data: Uint8Array; filename: string; mime: string } | null> {
  if (!env.UPLOADS || !item.file_key) return null;
  const obj = await env.UPLOADS.get(item.file_key);
  if (!obj) return null;
  return {
    data: new Uint8Array(await obj.arrayBuffer()),
    filename: item.file_key.split("/").pop() ?? "evidence",
    mime: item.file_mime || "application/octet-stream",
  };
}

/** Carrier portals give an address as one line; split it back into parts. */
function parseAddress(line: string): { address1?: string; city?: string; zip?: string } {
  const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
  const zip = line.match(/\b[A-Z0-9]{4,10}\b(?!.*\b[A-Z0-9]{4,10}\b)/i)?.[0];
  return { address1: parts[0], city: parts.length > 1 ? parts[1] : undefined, zip };
}

/** Weak comparisons return null so the triage guard never reads them as a mismatch. */
function matchAddressSafe(
  order: { address1?: string | null; city?: string | null; zip?: string | null },
  delivered: { address1?: string; city?: string; zip?: string },
): boolean | null {
  const m = matchAddress(order, delivered);
  return m.confidence === "weak" ? null : m.match;
}

/**
 * Assemble a dossier: find the shipments, establish delivery, regenerate the
 * rebuttal, re-score.
 *
 * A plain function rather than an internal HTTP call, so the webhook and the
 * sync worker reach the same code the route does without a Worker dispatching
 * a request to itself. Returns null when the dispute does not exist.
 */
async function preparePipeline(
  env: Env["Bindings"],
  disputeId: string,
): Promise<{ recommendation: string; reason: string; carrier_lookups: number; escalated: boolean } | null> {
  const d = await loadDossier(disputeId);
  if (!d) return null;
  const s = await settings();

  // Shipments come from the order, not from the dispute. Only Shopify tells us
  // fulfillments directly; a Stripe-only merchant supplies tracking through the
  // evidence endpoint or the agent.
  let shipments: Array<{ carrier: string; tracking: string }> = [];
  let orderAddress: { address1?: string | null; city?: string | null; zip?: string | null } = {};

  if (d.dispute.processor === "shopify" && d.dispute.order_ref && env.SHOPIFY_ADMIN_TOKEN) {
    const order = await shopify.getOrderFulfillments(env, d.dispute.order_ref).catch(() => null);
    if (order?.order) {
      orderAddress = order.order.shippingAddress ?? {};
      shipments = order.order.fulfillments.flatMap((f) =>
        f.trackingInfo
          .filter((t) => t.number)
          .map((t) => ({ carrier: t.company ?? "unknown", tracking: t.number as string })),
      );
    }
  }

  if (shipments.length) {
    await gatherCarrierEvidence(env, d.dispute, shipments, orderAddress, s.agent_server_id);
  }

  // The rebuttal is regenerated from whatever the record now holds, and
  // replaces the previous one rather than accumulating.
  const fresh = await loadDossier(disputeId);
  if (fresh) {
    const text = buildRebuttal(fresh, s);
    await run(
      "delete from evidence_items where dispute_id = ? and kind = 'rebuttal' and source = 'generated'",
      [disputeId],
    );
    if (text) {
      await addEvidence(disputeId, {
        kind: "rebuttal", source: "generated",
        title: "Why this charge stands", body: text,
      });
    }
  }

  await refreshTriage(disputeId);
  const after = await get<Dispute>(
    "select recommendation, recommendation_reason from disputes where id = ?",
    [disputeId],
  );
  const lookups = await query<{ agent_task_id: string }>(
    "select id, agent_task_id from carrier_lookups where dispute_id = ?",
    [disputeId],
  );

  return {
    recommendation: String(after?.recommendation ?? "pending"),
    reason: after?.recommendation_reason ?? "",
    carrier_lookups: lookups.length,
    escalated: lookups.some((l) => Boolean(l.agent_task_id)),
  };
}

async function upsertStripeDispute(
  env: Env["Bindings"],
  d: Record<string, unknown>,
): Promise<string> {
  const externalId = String(d.id);
  const existing = await get<{ id: string }>(
    "select id from disputes where processor = 'stripe' and external_id = ?",
    [externalId],
  );
  const id = existing?.id ?? crypto.randomUUID();

  const charge = typeof d.charge === "string" ? d.charge : "";
  let email = "";
  let name = "";
  let country = "";
  let physical = 0;

  if (charge && env.STRIPE_API_KEY) {
    const ch = (await stripe.getCharge(env, charge).catch(() => null)) as Record<string, unknown> | null;
    if (ch) {
      const bd = (ch.billing_details ?? {}) as { email?: string; name?: string; address?: { country?: string } };
      email = bd.email ?? String(ch.receipt_email ?? "");
      name = bd.name ?? "";
      country = bd.address?.country ?? "";
      // Physical is derived from the shipping block, never from the reason
      // code — a not-received claim on a digital product is common.
      physical = ch.shipping ? 1 : 0;
    }
  }

  const evidenceDetails = (d.evidence_details ?? {}) as { due_by?: number };
  const dueBy = evidenceDetails.due_by ? new Date(evidenceDetails.due_by * 1000).toISOString() : null;

  await run(
    `insert into disputes
       (id, processor, external_id, reason, status, amount_cents, currency, is_physical,
        customer_email, customer_name, order_ref, charge_ref, issuer_country, due_by, opened_at, raw)
     values (?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
     on conflict (processor, external_id) do update set
       status = excluded.status, due_by = excluded.due_by,
       raw = excluded.raw, updated_at = datetime('now')`,
    [
      id, externalId, normalizeReason(String(d.reason ?? "general")), String(d.status ?? ""),
      Number(d.amount ?? 0), String(d.currency ?? "usd"), physical, email, name, charge, country,
      dueBy, new Date(Number(d.created ?? 0) * 1000).toISOString(), JSON.stringify(d),
    ],
  );
  return id;
}

async function upsertShopifyDispute(node: Record<string, unknown>): Promise<string> {
  const externalId = String(node.id);
  const existing = await get<{ id: string }>(
    "select id from disputes where processor = 'shopify' and external_id = ?",
    [externalId],
  );
  const id = existing?.id ?? crypto.randomUUID();

  const amount = (node.amount ?? {}) as { amount?: string; currencyCode?: string };
  const order = (node.order ?? {}) as { id?: string; name?: string; email?: string };
  const reasonDetails = (node.reasonDetails ?? {}) as { reason?: string };

  await run(
    `insert into disputes
       (id, processor, external_id, reason, status, amount_cents, currency, is_physical,
        customer_email, customer_name, order_ref, charge_ref, issuer_country, due_by, opened_at, raw)
     values (?, 'shopify', ?, ?, ?, ?, ?, 1, ?, '', ?, '', '', ?, ?, ?)
     on conflict (processor, external_id) do update set
       status = excluded.status, due_by = excluded.due_by,
       raw = excluded.raw, updated_at = datetime('now')`,
    [
      id, externalId,
      normalizeReason(String(reasonDetails.reason ?? node.type ?? "general")),
      String(node.status ?? ""),
      Math.round(Number(amount.amount ?? 0) * 100),
      String(amount.currencyCode ?? "USD"),
      order.email ?? "",
      order.id ?? "",
      node.evidenceDueBy ? String(node.evidenceDueBy) : null,
      String(node.initiatedAt ?? new Date().toISOString()),
      JSON.stringify(node),
    ],
  );
  return id;
}

export default app;
