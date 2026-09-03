<img src="screenshot.jpg" alt="OpenDisputes — a dispute with proof of delivery retrieved from the carrier portal" width="100%">

# OpenDisputes

Chargeback evidence for Stripe and Shopify, assembled from your own records.

An open-source app template provided by [Clawnify.com](https://clawnify.com).

Most chargeback tools take a percentage of what they recover for you: 25% to
30% of your own money, uncapped, for evidence assembled out of records you
already hold. This is that software, except you run it and keep the recovery.

## What it does

**Assembles the dossier.** A dispute arrives by webhook. The app pulls the
order, the payment, the customer's activity, and the carrier's delivery record
into one evidence file, then renders it as a PDF an issuer can actually read.

**Gets proof of delivery, including where an API cannot.** FedEx and UPS serve
proof of delivery through their own APIs, and the app uses them. But FedEx only
returns a signature POD to a request carrying the shipper's own billing account
number, which a merchant fulfilling through a 3PL does not have; USPS delivery
scans are not reliably available by API at all. Those cases are handed to your
Clawnify agent, which signs into the carrier portal with a real browser and
retrieves the document. Every item is tagged with how it was obtained.

**Tells you which disputes not to fight.** A parcel delivered to an address that
does not match the order argues for the cardholder. So does a not-received claim
with no delivery record, and a subscription that kept billing after a
cancellation request. The app says so, plainly, instead of packaging a loss.

**Stages by default.** Evidence can be submitted once per dispute and cannot be
revised. So the app prepares the packet and stops. You review it and press the
button. Automatic submission is available per reason code, off until you turn it
on, and never fires on a dispute the app would concede.

**Verifies that submissions actually landed.** Shopify's evidence mutation can
report success while the evidence never reaches the bank. The app re-reads the
dispute afterwards and compares; when they disagree it says so and asks your
agent to finish the job in the admin, rather than showing you a green tick.

**Shows you whether any of it works.** Win rate by reason code, by issuer
country, and — the one nobody sells back to you — whether retrieved proof of
delivery actually changes outcomes on your own traffic. Small samples are shown
as `1/3`, not as `33%`.

## Deploy

[![Deploy with Clawnify](https://app.clawnify.com/deploy/badge.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenDisputes)

Or run it yourself:

```bash
pnpm install
cp .dev.vars.example .dev.vars   # add your processor keys
pnpm dev                          # UI on :5173, API on :8789
pnpm seed                         # optional demo data
```

## Connecting a processor

**Stripe.** Create a restricted API key with read on charges, invoices and
customers, and write on disputes and files. Add a webhook endpoint pointing at
`/api/webhooks/stripe` subscribed to `charge.dispute.created`,
`charge.dispute.updated` and `charge.dispute.closed`, and put its signing secret
in `STRIPE_WEBHOOK_SECRET`. Unsigned requests are refused.

**Shopify.** Create a custom app with `read_orders`, `read_fulfillments`,
`read_shopify_payments_disputes` and `write_shopify_payments_dispute_evidences`.

Either works alone. With both, one queue covers both stores.

Already have dispute history? Run **Sync processors** once; a webhook only
catches what happens next.

## Carrier credentials

Optional. Without them the agent retrieves delivery records from the portal
instead, which works and is slower.

| Carrier | API proof of delivery | Needs |
|---|---|---|
| FedEx | Yes | `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`, `FEDEX_ACCOUNT_NUMBER` |
| UPS | Yes, as a POD letter | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET` |
| USPS | No — portal only | — |
| DHL | Varies by division | — |

UPS terms allow the electronic signature image only as part of a POD letter, so
the app retrieves and stores the letter and never the bare signature.

## What it deliberately does not do

- **No chargeback alerts.** Deflection networks are a paid subscription to a
  card-network feed, not something software can synthesise.
- **No guarantee.** Products that reimburse you still leave the chargeback
  counting against your ratio. Know which one you are buying.
- **No auto-refunding.** Refunding every alert to keep a dispute rate down is
  a decision about your revenue, not a default worth shipping.

## Licence

MIT.
