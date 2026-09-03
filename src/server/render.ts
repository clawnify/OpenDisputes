// The dossier document.
//
// This is the artifact a human at an issuing bank actually reads, and it is
// rendered rather than assembled from a PDF library for one reason: the people
// who win disputes describe evidence that is legible and specific, and HTML is
// the only way to keep a dense evidence table readable without hand-placing
// every glyph.
//
// Rendering goes through the platform's PDF service (headless Chrome) rather
// than a bundled PDF library — a Worker has no room for one, and the service is
// already the house primitive for this.
//
// Tone is deliberate: flat, factual, no advocacy adjectives. The argument is
// made by the record, and an issuer skimming fifty of these has no patience for
// a merchant insisting how obvious it all is.

import type { Dispute, EvidenceItem } from "./types.js";

const SERVICE_URL = "https://services.clawnify.com/pdf/render";

export interface RenderEnv {
  CLAWNIFY_TOKEN?: string;
  CLAWNIFY_PDF_URL?: string;
}

export class RenderError extends Error {}

export interface CarrierRow {
  carrier: string;
  tracking: string;
  outcome: string;
  delivered_at: string | null;
  delivery_address: string;
  address_match: number | null;
  channel: string;
  detail: string;
}

export interface DossierInput {
  dispute: Dispute;
  items: EvidenceItem[];
  carrier: CarrierRow[];
  merchantName: string;
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function date(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? esc(s) : d.toISOString().slice(0, 10);
}

/** Plain-language labels. An issuer should not have to read our enum names. */
const SOURCE_LABEL: Record<EvidenceItem["source"], string> = {
  processor_api: "Payment processor record",
  carrier_api: "Carrier system of record",
  agent_browser: "Retrieved from carrier portal",
  merchant_upload: "Supplied by merchant",
  generated: "Compiled from merchant records",
};

const KIND_LABEL: Record<string, string> = {
  activity_log: "Account activity",
  receipt: "Receipt",
  invoice: "Invoice",
  product_description: "Product description",
  proof_of_delivery: "Proof of delivery",
  tracking_history: "Tracking history",
  shipping_label: "Shipping record",
  customer_communication: "Customer correspondence",
  refund_policy: "Refund policy",
  cancellation_policy: "Cancellation policy",
  terms_acceptance: "Terms acceptance",
  ip_geo_match: "Purchase IP and location",
  prior_usage_artifact: "Delivered work product",
  signature: "Signature record",
  delivery_photo: "Delivery photograph",
  rebuttal: "Merchant statement",
  other: "Supporting record",
};

const OUTCOME_LABEL: Record<string, string> = {
  delivered_with_pod: "Delivered, signed or photographed",
  delivered_no_pod: "Delivered, no signature on file",
  not_delivered: "No delivery recorded",
  unsupported: "Carrier provides no retrievable record",
  no_account: "Carrier record not accessible to this merchant",
  error: "Retrieval failed",
};

export function dossierHTML(input: DossierInput): string {
  const { dispute: d, items, carrier, merchantName } = input;
  const included = items.filter((i) => i.included);

  const facts: Array<[string, string]> = [
    ["Merchant", merchantName],
    ["Order", d.order_ref || "—"],
    ["Cardholder", d.customer_name || "—"],
    ["Email on account", d.customer_email || "—"],
    ["Disputed amount", money(d.amount_cents, d.currency)],
    ["Reason given", KIND_LABEL[d.reason] ?? d.reason.replace(/_/g, " ")],
    ["Dispute opened", date(d.opened_at)],
    ["Response due", date(d.due_by)],
  ];

  const carrierSection = carrier.length
    ? `
    <h2>Delivery record</h2>
    <table>
      <thead><tr><th>Carrier</th><th>Tracking</th><th>Outcome</th><th>Delivered</th><th>Delivered to</th><th>Matches order address</th></tr></thead>
      <tbody>
        ${carrier
          .map(
            (c) => `<tr>
              <td>${esc(c.carrier.toUpperCase())}</td>
              <td class="mono">${esc(c.tracking)}</td>
              <td>${esc(OUTCOME_LABEL[c.outcome] ?? c.outcome)}</td>
              <td>${date(c.delivered_at)}</td>
              <td>${esc(c.delivery_address || "—")}</td>
              <td>${c.address_match === 1 ? "Yes" : c.address_match === 0 ? "<strong>No</strong>" : "Not comparable"}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
    <p class="note">Delivery outcomes marked as retrieved from a carrier portal were obtained from the carrier's own authenticated interface, not from a public tracking page.</p>`
    : "";

  const textItems = included.filter((i) => !i.file_key && i.body);
  const fileItems = included.filter((i) => i.file_key);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Evidence — ${esc(d.order_ref || d.external_id)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font: 10.5pt/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #16181d; margin: 0;
  }
  header { border-bottom: 2px solid #16181d; padding-bottom: 10px; margin-bottom: 22px; }
  h1 { font-size: 15pt; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { color: #5b6270; font-size: 9pt; }
  h2 {
    font-size: 10pt; text-transform: uppercase; letter-spacing: 0.07em;
    color: #5b6270; margin: 26px 0 8px; font-weight: 600;
  }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  th {
    text-align: left; font-size: 8.5pt; text-transform: uppercase;
    letter-spacing: 0.05em; color: #5b6270; font-weight: 600;
    border-bottom: 1px solid #d4d8e0; padding: 5px 8px 5px 0;
  }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  .facts td:first-child { color: #5b6270; width: 34%; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 9pt; }
  .note { color: #5b6270; font-size: 8.5pt; margin: 6px 0 0; }
  .item { margin-bottom: 16px; break-inside: avoid; }
  .item h3 { font-size: 10.5pt; margin: 0 0 1px; font-weight: 600; }
  .item .src { color: #5b6270; font-size: 8.5pt; margin: 0 0 5px; }
  .item pre {
    white-space: pre-wrap; word-break: break-word; margin: 0;
    font: 9.5pt/1.5 ui-monospace, "SF Mono", Menlo, monospace;
    background: #f7f8fa; border-left: 2px solid #d4d8e0; padding: 8px 10px;
  }
  footer {
    margin-top: 28px; padding-top: 10px; border-top: 1px solid #d4d8e0;
    color: #5b6270; font-size: 8pt;
  }
</style></head>
<body>
  <header>
    <h1>Evidence in response to a payment dispute</h1>
    <div class="sub">${esc(merchantName)} · Order ${esc(d.order_ref || "—")} · Compiled ${new Date().toISOString().slice(0, 10)}</div>
  </header>

  <h2>Transaction</h2>
  <table class="facts"><tbody>
    ${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
  </tbody></table>

  ${carrierSection}

  ${
    textItems.length
      ? `<h2>Record</h2>${textItems
          .map(
            (i) => `<div class="item">
              <h3>${esc(KIND_LABEL[i.kind] ?? i.title)}</h3>
              <p class="src">${esc(SOURCE_LABEL[i.source])}${i.collected_at ? ` · ${date(i.collected_at)}` : ""}</p>
              <pre>${esc(i.body)}</pre>
            </div>`,
          )
          .join("")}`
      : ""
  }

  ${
    fileItems.length
      ? `<h2>Attached documents</h2>
        <table>
          <thead><tr><th>Document</th><th>Origin</th><th>Obtained</th></tr></thead>
          <tbody>${fileItems
            .map(
              (i) => `<tr><td>${esc(i.title)}</td><td>${esc(SOURCE_LABEL[i.source])}</td><td>${date(i.collected_at)}</td></tr>`,
            )
            .join("")}</tbody>
        </table>
        <p class="note">Listed documents are submitted alongside this summary as separate files.</p>`
      : ""
  }

  <footer>
    Compiled automatically from the merchant's payment, order and carrier records.
    Each entry states where it came from. Nothing in this document has been edited by hand.
  </footer>
</body></html>`;
}

export async function renderDossier(env: RenderEnv, input: DossierInput): Promise<Uint8Array> {
  if (!env.CLAWNIFY_TOKEN) {
    throw new RenderError(
      "PDF rendering needs CLAWNIFY_TOKEN. On the platform it is injected automatically; off-platform the dossier can still be read as HTML.",
    );
  }
  const res = await fetch(env.CLAWNIFY_PDF_URL ?? SERVICE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLAWNIFY_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/pdf",
    },
    body: JSON.stringify({ html: dossierHTML(input), format: "A4", print_background: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new RenderError(`PDF service returned ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
