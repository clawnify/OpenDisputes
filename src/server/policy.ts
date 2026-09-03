// Policy pages, captured rather than transcribed.
//
// A merchant pasting their refund policy into a settings box is describing what
// they believe it says. An issuer is asking a narrower question: what was this
// customer shown at the moment they bought. Those diverge the day the policy
// changes, and they diverge silently.
//
// So the app holds the URL and captures the page. Two consequences follow, and
// the second is the one that matters:
//
//   1. The evidence maintains itself. Edit the policy on the site and the next
//      capture picks it up.
//   2. Snapshots are a history, not a current value. A dispute over a March
//      order cites the March capture, not today's page. A merchant who
//      tightened their returns window in June can still answer honestly about
//      March, which is exactly the case where pasted text quietly becomes a
//      false claim.
//
// Capture is a plain fetch first and the agent's browser second, the same
// API-first shape the carrier module uses. Most policy pages are server
// rendered and need nothing cleverer.

import { get, query, run } from "./db.js";

export type PolicyKind = "refund_policy" | "cancellation_policy" | "terms";

export interface PolicySnapshot {
  id: string;
  kind: PolicyKind;
  url: string;
  content: string;
  content_hash: string;
  file_key: string;
  channel: "fetch" | "agent_browser";
  captured_at: string;
  superseded_at: string | null;
}

export interface PolicyEnv {
  UPLOADS?: R2Bucket;
}

export type CaptureResult =
  | { outcome: "captured"; id: string; changed: true }
  | { outcome: "unchanged"; id: string; changed: false }
  /** Fetch was refused or the page needs a browser. The caller escalates. */
  | { outcome: "needs_browser"; detail: string }
  | { outcome: "error"; detail: string };

/**
 * Strip a policy page down to its readable text.
 *
 * Deliberately crude. The goal is not a faithful render, it is a stable string
 * that changes when the policy changes and does not change when a nav menu or
 * a cache-busting asset hash does. Over-clever extraction produces false
 * "changed" rows, and every false row is a snapshot a human has to dismiss.
 */
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Capture one policy page.
 *
 * Writes a row only when the text actually differs from the newest snapshot for
 * that kind, so a daily check costs one row per real edit. The previous row is
 * stamped `superseded_at` at that moment, which is what makes "in force on
 * date X" a range lookup instead of an inference.
 */
export async function capturePolicy(
  env: PolicyEnv,
  kind: PolicyKind,
  url: string,
  opts: { channel?: "fetch" | "agent_browser"; html?: string } = {},
): Promise<CaptureResult> {
  let html = opts.html;
  const channel = opts.channel ?? "fetch";

  if (html === undefined) {
    if (!/^https:\/\//i.test(url)) {
      return { outcome: "error", detail: "Policy URL must be https." };
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "text/html", "User-Agent": "OpenDisputes policy capture" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { outcome: "needs_browser", detail: `Could not reach the page: ${(err as Error).message}` };
    }
    // 403/429 is a bot wall, not a broken URL. The agent's browser gets past it
    // and the distinction decides whether escalating is worth doing.
    if (res.status === 403 || res.status === 429) {
      return { outcome: "needs_browser", detail: `The page refused a plain request (${res.status}).` };
    }
    if (!res.ok) return { outcome: "error", detail: `Page returned ${res.status}.` };
    html = await res.text();
  }

  const content = extractText(html);
  if (content.length < 200) {
    // A near-empty extraction usually means the text arrives by script.
    return {
      outcome: "needs_browser",
      detail: "The page returned almost no readable text, so it probably renders its policy with JavaScript.",
    };
  }

  const hash = await sha256(content);
  const latest = await get<PolicySnapshot>(
    "select * from policy_snapshots where kind = ? and superseded_at is null order by captured_at desc limit 1",
    [kind],
  );
  if (latest && latest.content_hash === hash) {
    return { outcome: "unchanged", id: latest.id, changed: false };
  }

  const id = crypto.randomUUID();
  const fileKey = `policy/${kind}/${id}.html`;
  if (env.UPLOADS) {
    // The rendered page is kept as well as the text: an issuer reading a
    // dossier is more convinced by the page as it looked than by a transcript.
    await env.UPLOADS.put(fileKey, html, { httpMetadata: { contentType: "text/html" } });
  }

  if (latest) {
    await run("update policy_snapshots set superseded_at = datetime('now') where id = ?", [latest.id]);
  }
  await run(
    `insert into policy_snapshots (id, kind, url, content, content_hash, file_key, channel)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, kind, url, content, hash, env.UPLOADS ? fileKey : "", channel],
  );

  return { outcome: "captured", id, changed: true };
}

/**
 * The snapshot in force on a given date.
 *
 * Falls back to the earliest capture when the order predates every snapshot,
 * because a merchant who installs this app today still has disputes from last
 * month. That is the honest approximation and the caller labels it as one:
 * the dossier prints the capture date, so nobody can read it as a claim that
 * the page was verified on the service date.
 */
export async function policyInForce(
  kind: PolicyKind,
  serviceDate: string | null,
): Promise<PolicySnapshot | null> {
  if (serviceDate) {
    const atDate = await get<PolicySnapshot>(
      `select * from policy_snapshots
        where kind = ? and captured_at <= ?
        order by captured_at desc limit 1`,
      [kind, serviceDate],
    );
    if (atDate) return atDate;
  }
  return (
    (await get<PolicySnapshot>(
      "select * from policy_snapshots where kind = ? order by captured_at asc limit 1",
      [kind],
    )) ?? null
  );
}

export async function snapshotHistory(kind: PolicyKind, limit = 20): Promise<PolicySnapshot[]> {
  return query<PolicySnapshot>(
    "select * from policy_snapshots where kind = ? order by captured_at desc limit ?",
    [kind, limit],
  );
}

/**
 * How a captured policy is described in evidence.
 *
 * The capture date and the source URL are part of the claim, not metadata. A
 * policy quoted without them is an assertion; quoted with them it is a record.
 */
export function policyEvidenceBody(snap: PolicySnapshot, serviceDate: string | null): string {
  const asOf = snap.captured_at.slice(0, 10);
  const exact = serviceDate ? snap.captured_at <= serviceDate : false;
  const lead = exact
    ? `Captured from ${snap.url} on ${asOf}, the version published at the time of this order.`
    : `Captured from ${snap.url} on ${asOf}. This is the earliest capture on record; the order predates it.`;
  return `${lead}\n\n${snap.content}`;
}
