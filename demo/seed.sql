-- Demo data for an isolated workspace. Fictional customers, orders and addresses.
--
-- The three cases this app is built around (a winnable digital dispute, a
-- physical one with signed proof of delivery, and one it tells you to concede),
-- a closed won/lost pair for the performance page, three open fraud warnings
-- and the customer activity behind the digital case. No stored files: every
-- evidence item is text, so nothing points at a file the demo does not have.
-- Warning verdicts were produced by triageWarning with the inputs shown.

INSERT INTO settings (id, refund_policy_text, cancellation_policy_text, product_description_text, policy_url, counter_fee_cents) VALUES
  (1,
   'Refunds are available within 14 days of purchase for unused subscriptions. Physical orders can be returned unopened within 30 days.',
   'Subscriptions can be cancelled at any time from the account page and stop at the end of the paid period.',
   'Northlight Studio sells design templates by subscription and printed notebooks shipped from our warehouse.',
   'https://northlight.example.test/legal',
   1500);

-- 1. Digital subscription, "not received", with heavy use before and after the charge.
INSERT INTO disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, charge_ref, issuer_country,
  due_by, opened_at, charged_at, recommendation, recommendation_reason)
VALUES ('d-seed-1', 'stripe', 'du_demo_1001', 'product_not_received', 'needs_response',
  11900, 'usd', 0, 'noa.brandt@example.test', 'Noa Brandt', 'INV-2091', 'ch_demo_1001', 'US',
  datetime('now', '+6 days'), datetime('now', '-2 days'), datetime('now', '-20 days'), 'fight',
  'Worth contesting. The packet is submittable but incomplete — the gaps below are what issuers ask for on this reason code.
Missing: Any conversation with the customer');

INSERT INTO evidence_items (id, dispute_id, kind, source, title, body) VALUES
 ('e-1a', 'd-seed-1', 'receipt', 'processor_api', 'Receipt INV-2091',
  'Pro plan, monthly. 119.00 USD charged to a card ending 4242. Billing email noa.brandt@example.test.'),
 ('e-1b', 'd-seed-1', 'prior_usage_artifact', 'merchant_upload', 'Work product delivered to the customer',
  'Template pack "Autumn launch kit" exported twice after the charge, as a 38-file archive.'),
 ('e-1c', 'd-seed-1', 'rebuttal', 'generated', 'Why this charge stands',
  'The account shows use after the charge. The activity record is included in full rather than summarized. The cardholder did not contact us to request a refund or raise a problem before filing this dispute.');

INSERT INTO customer_activity (id, external_id, customer_email, customer_ref, charge_ref, event_type, occurred_at, detail, artifact_label, ip) VALUES
 ('a-1', 'evt-1', 'noa.brandt@example.test', 'user_318', '', 'signup', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-120 days'), 'Created an account', '', '203.0.113.24'),
 ('a-2', 'evt-2', 'noa.brandt@example.test', 'user_318', '', 'login', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days'), 'Signed in', '', '203.0.113.24'),
 ('a-3', 'evt-3', 'noa.brandt@example.test', 'user_318', 'ch_demo_1001', 'export', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-15 days'), 'Exported a template pack', 'Autumn launch kit', '203.0.113.24'),
 ('a-4', 'evt-4', 'noa.brandt@example.test', 'user_318', 'ch_demo_1001', 'export', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 days'), 'Exported a template pack again', 'Autumn launch kit', '203.0.113.24');

-- 2. Physical order, "not received". The carrier API needed an account the
--    merchant lacks; the agent then retrieved signed proof from the portal.
INSERT INTO disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, charge_ref, issuer_country,
  due_by, opened_at, recommendation, recommendation_reason)
VALUES ('d-seed-2', 'shopify', 'gid://shopify/ShopifyPaymentsDispute/demo2',
  'product_not_received', 'needs_response', 24500, 'usd', 1,
  'leo.marsh@example.test', 'Leo Marsh', '#1042', '', 'US',
  datetime('now', '+2 days'), datetime('now', '-5 days'), 'fight',
  'Worth contesting, and the packet covers what issuers ask for on this reason code.');

INSERT INTO evidence_items (id, dispute_id, kind, source, title, body, provenance) VALUES
 ('e-2a', 'd-seed-2', 'proof_of_delivery', 'agent_browser',
  'Carrier proof of delivery — 771200000001',
  'Delivered to 12 Birch Lane, Springfield, 40123. Signed by L MARSH.',
  '{"carrier":"fedex","tracking":"771200000001","signedBy":"L MARSH"}'),
 ('e-2b', 'd-seed-2', 'tracking_history', 'agent_browser', 'Scan history',
  'Day 1 09:14 picked up at the warehouse. Day 3 04:02 arrived at the local facility. Day 5 11:38 delivered, signed by L MARSH.',
  '{"carrier":"fedex","tracking":"771200000001"}');

INSERT INTO carrier_lookups (id, dispute_id, carrier, tracking, channel, outcome,
  delivered_at, delivery_address, address_match, evidence_item_id, detail)
VALUES
 ('c-2a', 'd-seed-2', 'fedex', '771200000001', 'api', 'no_account',
  NULL, '', NULL, NULL, 'Signature proof of delivery needs the shipper''s own carrier account number.'),
 ('c-2b', 'd-seed-2', 'fedex', '771200000001', 'agent_browser', 'delivered_with_pod',
  date('now', '-9 days'), '12 Birch Lane, Springfield, 40123', 1, 'e-2a',
  'Signed proof of delivery retrieved from the carrier portal. Received by L MARSH.');

-- 3. Physical order delivered to a different address than the order. The case
--    the app tells you to concede.
INSERT INTO disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, charge_ref, issuer_country,
  due_by, opened_at, recommendation, recommendation_reason)
VALUES ('d-seed-3', 'shopify', 'gid://shopify/ShopifyPaymentsDispute/demo3',
  'product_not_received', 'needs_response', 8900, 'usd', 1,
  'iris.vale@example.test', 'Iris Vale', '#1043', '', 'GB',
  datetime('now', '+11 days'), datetime('now', '-1 days'), 'accept',
  'Carrier delivered to a different address than the order (delivered to postal code 40999, order shipped to 40123). This argues for the cardholder; submitting it would hand the issuer the counter-argument.');

INSERT INTO carrier_lookups (id, dispute_id, carrier, tracking, channel, outcome,
  delivered_at, delivery_address, address_match, detail)
VALUES ('c-3a', 'd-seed-3', 'ups', '1Z0000000000000003', 'api', 'delivered_with_pod',
  date('now', '-4 days'), '88 Harbor Road, Bayport, 40999', 0,
  'Proof of delivery retrieved. Delivered to postal code 40999; the order shipped to 40123.');

-- 4. A closed won/lost pair, so the performance page has something to show.
INSERT INTO disputes (id, processor, external_id, reason, status, amount_cents, currency,
  is_physical, customer_email, customer_name, order_ref, issuer_country, opened_at, recommendation,
  outcome, outcome_at)
VALUES
 ('d-seed-4', 'stripe', 'du_demo_1004', 'fraudulent', 'won', 4900, 'usd', 0,
  'kai.north@example.test', 'Kai North', 'INV-2044', 'US', datetime('now', '-40 days'), 'fight', 'won', datetime('now', '-12 days')),
 ('d-seed-5', 'shopify', 'gid://shopify/ShopifyPaymentsDispute/demo5', 'product_not_received', 'lost', 15600, 'usd', 1,
  'mara.quinn@example.test', 'Mara Quinn', '#1009', 'MX', datetime('now', '-38 days'), 'fight', 'lost', datetime('now', '-9 days'));

INSERT INTO carrier_lookups (id, dispute_id, carrier, tracking, channel, outcome, address_match, detail)
VALUES ('c-5a', 'd-seed-5', 'usps', '9400100000000005', 'agent_browser', 'delivered_no_pod', NULL,
  'The carrier shows the parcel delivered with no signature on file.');

-- 5. Open early fraud warnings, one per verdict the merchant can act on.
INSERT INTO fraud_warnings (id, processor, external_id, charge_ref, fraud_type, actionable,
  amount_cents, currency, customer_email, customer_name, is_physical, three_d_secure_result,
  fulfillment_state, recommendation, recommendation_reason, factors, warned_at)
VALUES
 ('w-seed-1', 'stripe', 'issfr_demo_1', 'ch_demo_2001', 'made_with_stolen_card', 1,
  6400, 'usd', 'buyer.one@example.test', 'Sam Ortega', 1, '',
  'not_shipped', 'refund',
  'The order has not shipped, so a refund costs you the sale and nothing else. This is the case Stripe singles out for refunding: the product is still recoverable, and refunding in full now removes the dispute and its fee. Cancel the fulfillment as well as refunding, or you pay twice.',
  '["The issuer labelled this made with stolen card, which describes a compromised card rather than a disagreement with you.","No fulfillment or tracking is on record for this order."]',
  datetime('now', '-1 days')),
 ('w-seed-2', 'stripe', 'issfr_demo_2', 'ch_demo_2002', 'unauthorized_use_of_card', 1,
  11900, 'usd', 'jo.fenwick@example.test', 'Jo Fenwick', 0, '',
  'service_used', 'do_not_refund',
  'The service was already used, so the value has been delivered and cannot be recovered by refunding. Usage after payment is also the strongest evidence there is against a fraud claim, so this is a charge worth keeping and defending rather than conceding early.',
  '["This customer used the product after paying for it."]',
  datetime('now', '-2 days')),
 ('w-seed-3', 'stripe', 'issfr_demo_3', 'ch_demo_2003', 'misc', 1,
  3200, 'usd', 'ren.alder@example.test', 'Ren Alder', 1, '',
  'in_transit', 'review',
  'The parcel is in transit, which is the one genuinely ambiguous case. If the carrier will recall or reroute it you can refund and still keep the goods; if not, refunding loses both. Check whether a recall is possible before deciding.',
  '["The parcel has shipped but the carrier does not yet show it delivered."]',
  datetime('now', '-3 hours'));
