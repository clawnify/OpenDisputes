# Policy analyzer — brief

**Status: not built.** This file is the brief for a later session. Nothing in
`src/` implements it yet.

## What it is

OpenDisputes already captures the merchant's refund, cancellation and terms
pages by URL and keeps every version as a dated snapshot (`policy_snapshots`,
`src/server/policy.ts`). That exists so a dossier can show what a customer was
shown on the date they bought.

The analyzer is the second use of that same data: read the policy the way an
**issuer** reads it, and tell the merchant what is costing them disputes.

## Why it belongs here and not in a policy-review tool

A generic contract reviewer can tell you a policy is vague. It cannot tell you
that **your** `subscription_canceled` disputes lose at 70% while your
`product_not_received` disputes win, that the losing ones all cite a
cancellation route your policy page never states, and that the wording changed
in March. This app already holds the dispute outcomes, the reason codes, the
evidence that was sent, and the policy text as it stood on each service date.
The analysis is only interesting where those meet.

That also fixes the ordering: advice is worth acting on when it is attached to
money already lost, not to a rubric.

## What it should produce

**Alerts**, not a score. A score is a number nobody acts on.

Each alert carries the observation, the evidence behind it, and the edit:

1. **A clause your own outcomes contradict.** Reason codes where the merchant
   loses disproportionately, cross-referenced against whether the policy
   addresses that scenario at all. This is the only category that requires the
   outcome ledger, and it is the reason the analyzer lives in this app.
2. **A disclosure gap an issuer looks for.** Whether the page states the refund
   window, the cancellation route, what happens to shipping costs, and how the
   customer is told at checkout rather than only on a legal page. These map
   directly onto evidence fields that are currently going out empty.
3. **A silent change.** The snapshot history already shows when wording moved.
   A change that narrows customer rights without a dated notice weakens every
   dispute for orders placed before it, and the merchant usually does not know
   they made the trade.
4. **A jurisdiction problem.** EU distance-selling withdrawal rights override a
   shorter stated window. A policy claiming otherwise does not just fail, it
   argues against the merchant when an issuer reads it.

## Shape

- One entry point: analyze the current snapshot of each kind against the
  outcome ledger. Cheap enough to run on every new snapshot, so it fires when
  the policy changes rather than on a schedule.
- Results are rows, not prose, so they can be dismissed individually and so a
  dismissed alert stays dismissed when the policy changes for an unrelated
  reason.
- Model call goes through the platform helper, not a vendor SDK.

## What it must not do

- **Not legal advice, and it must not read like it.** The register is "your own
  disputes say this", not "you are non-compliant". The merchant's lawyer is the
  audience for the second sentence, and we are not it.
- **No auto-editing of the policy page.** The app captures policy pages; it does
  not own them. Proposing wording is useful, changing the merchant's live legal
  text is not a thing software should do on its own.
- **No advice from an empty ledger.** With no decided disputes there is no
  category-1 alert to make, and inventing one from a rubric is exactly the
  generic tool this is supposed to beat. Say the sample is too small.

## Depends on

- `policy_snapshots` and `src/server/policy.ts` (built).
- The outcome ledger: `disputes.outcome`, `disputes.reason`, `submissions`, and
  `GET /api/stats` (built).
