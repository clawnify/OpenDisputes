-- Demo data: the three shapes this app is built around, so a fresh install has
-- something to look at before a real dispute arrives.

delete from carrier_lookups; delete from evidence_items; delete from disputes;

-- 1. Digital SaaS, not-received, heavy prior use. The winnable classic.
insert into disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, charge_ref, issuer_country,
  due_by, opened_at, recommendation, recommendation_reason)
values ('d-seed-1', 'stripe', 'du_seed1', 'product_not_received', 'needs_response',
  119900, 'usd', 0, 'ada@example.com', 'Ada Lovelace', 'INV-2091', 'ch_seed1', 'US',
  datetime('now', '+6 days'), datetime('now', '-2 days'), 'fight',
  'Worth contesting. The packet is submittable but incomplete — the gaps below are what issuers ask for on this reason code.
Missing: Any conversation with the customer');

insert into evidence_items (id, dispute_id, kind, source, title, body) values
 ('e-1a', 'd-seed-1', 'activity_log', 'processor_api', 'Account activity',
  'Signed up 2026-03-04. 2,140 images generated across 61 sessions. Last active 2026-08-29, four days after the disputed charge. Plan: Pro, 19.00 USD monthly. Total paid to date: 1,199.00 USD across 7 charges, none refunded.'),
 ('e-1b', 'd-seed-1', 'prior_usage_artifact', 'processor_api', 'Work product delivered to the customer',
  ''),
 ('e-1c', 'd-seed-1', 'rebuttal', 'generated', 'Why this charge stands',
  'The account shows use after the charge. The activity record is included in full rather than summarized. The cardholder did not contact us to request a refund or raise a problem before filing this dispute.');

update evidence_items set file_key = 'demo/service-doc.pdf', file_mime = 'application/pdf', file_bytes = 412000 where id = 'e-1b';

-- 2. Physical, not-received, POD retrieved by the agent from the portal
--    because the merchant ships through a 3PL and has no FedEx account.
insert into disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, charge_ref, issuer_country,
  due_by, opened_at, recommendation, recommendation_reason)
values ('d-seed-2', 'shopify', 'gid://shopify/ShopifyPaymentsDispute/seed2',
  'product_not_received', 'needs_response', 24500, 'usd', 1,
  'grace@example.com', 'Grace Hopper', '#1042', '', 'US',
  datetime('now', '+2 days'), datetime('now', '-5 days'), 'fight',
  'Worth contesting, and the packet covers what issuers ask for on this reason code.');

insert into carrier_lookups (id, dispute_id, carrier, tracking, channel, outcome,
  delivered_at, delivery_address, address_match, detail)
values ('c-2a', 'd-seed-2', 'fedex', '771234567890', 'api', 'no_account',
  null, '', null, 'FedEx POD needs FEDEX_ACCOUNT_NUMBER. Signature POD requires the shipper''s own billing account number.'),
 ('c-2b', 'd-seed-2', 'fedex', '771234567890', 'agent_browser', 'delivered_with_pod',
  date('now', '-9 days'), '1600 Amphitheatre Pkwy, Mountain View, 94043', 1,
  'Signed proof of delivery retrieved from the FedEx portal. Received by G HOPPER.');

insert into evidence_items (id, dispute_id, kind, source, title, body, file_key, file_mime, file_bytes, provenance) values
 ('e-2a', 'd-seed-2', 'proof_of_delivery', 'agent_browser',
  'FedEx proof of delivery — 771234567890', '', 'pod/d-seed-2/fedex-771234567890.pdf',
  'application/pdf', 88000, '{"carrier":"fedex","tracking":"771234567890","signedBy":"G HOPPER"}'),
 ('e-2b', 'd-seed-2', 'tracking_history', 'agent_browser', 'Scan history',
  '2026-08-21 09:14 Picked up, Memphis TN. 2026-08-23 04:02 Arrived at facility, San Jose CA. 2026-08-25 11:38 Delivered, Mountain View CA. Signed by G HOPPER.',
  '', '', 0, '{"carrier":"fedex","tracking":"771234567890"}');

-- 3. Physical, POD retrieved and the address does NOT match. The case the app
--    tells you to concede — the one every competitor would have submitted.
insert into disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, charge_ref, issuer_country,
  due_by, opened_at, recommendation, recommendation_reason)
values ('d-seed-3', 'shopify', 'gid://shopify/ShopifyPaymentsDispute/seed3',
  'product_not_received', 'needs_response', 8900, 'usd', 1,
  'alan@example.com', 'Alan Turing', '#1043', '', 'GB',
  datetime('now', '+11 days'), datetime('now', '-1 days'), 'accept',
  'Carrier delivered to a different address than the order (delivered to postal code 94105, order shipped to 94043). This argues for the cardholder; submitting it would hand the issuer the counter-argument.');

insert into carrier_lookups (id, dispute_id, carrier, tracking, channel, outcome,
  delivered_at, delivery_address, address_match, detail)
values ('c-3a', 'd-seed-3', 'ups', '1Z999AA10123456784', 'api', 'delivered_with_pod',
  date('now', '-4 days'), '450 Market St, San Francisco, 94105', 0,
  'UPS POD letter retrieved. Delivered to postal code 94105; the order shipped to 94043.');

-- 4. A closed pair, so the performance page has something honest to show.
insert into disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, order_ref, issuer_country, opened_at, recommendation,
  outcome, outcome_at)
values
 ('d-seed-4', 'stripe', 'du_seed4', 'fraudulent', 'won', 4900, 'usd', 0,
  'k@example.com', 'INV-2044', 'US', datetime('now', '-40 days'), 'fight', 'won', datetime('now', '-12 days')),
 ('d-seed-5', 'shopify', 'gid://seed5', 'product_not_received', 'lost', 15600, 'usd', 1,
  'm@example.com', '#1009', 'MX', datetime('now', '-38 days'), 'fight', 'lost', datetime('now', '-9 days'));

insert into carrier_lookups (id, dispute_id, carrier, tracking, channel, outcome, address_match, detail)
values ('c-5a', 'd-seed-5', 'usps', '9400111899223', 'agent_browser', 'delivered_no_pod', null,
  'USPS shows delivered with no signature on file.');
