-- OpenDisputes — chargeback evidence, assembled once and rendered per processor.
--
-- The shape to understand before reading the rest: a dispute is NOT stored in
-- the processor's own vocabulary. Stripe and Shopify Payments describe the same
-- event with different field names and different submission rules, and a
-- merchant on both should not keep two mental models. So a dispute is normalized
-- on the way in, evidence accumulates against it as provenance-tagged items, and
-- an adapter maps that dossier to whichever processor has to receive it.
--
-- That indirection is the whole product. Every competitor stores the processor's
-- payload; this stores what is TRUE about the order, which is what survives when
-- the same merchant adds a second processor, or when the same proof has to be
-- rendered for a bank in a different format.

create table if not exists disputes (
  id                text primary key,

  -- Where it came from. (processor, external_id) is the natural key; the
  -- surrogate id exists so evidence can reference a dispute before the
  -- processor's own object has been fetched in full.
  processor         text not null check (processor in ('stripe', 'shopify')),
  external_id       text not null,

  -- Normalized across processors. Stripe's `reason` and Shopify's `type` share
  -- a vocabulary because Shopify Payments is Stripe underneath, so one
  -- taxonomy is honest rather than lossy.
  reason            text not null,
  status            text not null,

  amount_cents      integer not null,
  currency          text not null,

  -- What the dispute is actually about. `is_physical` decides whether carrier
  -- proof of delivery is even a coherent thing to look for, and it is derived
  -- from the order's fulfillments, never guessed from the reason code.
  is_physical       integer not null default 0,

  customer_email    text not null default '',
  customer_name     text not null default '',
  order_ref         text not null default '',
  charge_ref        text not null default '',

  -- Issuer country, when the processor tells us. Win rates vary hard by
  -- country and the outcome ledger is the only place that becomes visible.
  issuer_country    text not null default '',

  -- The clock. `due_by` is the processor's deadline; everything about
  -- scheduling hangs off it, so it is a column and not a JSON field.
  due_by            text,
  opened_at         text not null,

  -- When the customer actually paid. Distinct from `opened_at`, and the only
  -- boundary that supports the sentence an issuer cares about: "they used it
  -- AFTER paying for it". Nullable because not every processor hands it over,
  -- and a summary built without it must say which boundary it could prove
  -- rather than quietly substituting the dispute date. See activity.ts.
  charged_at        text,

  -- Triage verdict — see triage.ts. Written on intake and refreshed whenever
  -- evidence lands, because a dispute that was unwinnable at 09:00 becomes
  -- winnable the moment a signed POD arrives.
  recommendation    text not null default 'pending'
                    check (recommendation in ('pending', 'fight', 'do_not_fight', 'accept')),
  recommendation_reason text not null default '',

  -- Final result, once the bank rules. Null while open.
  outcome           text check (outcome in ('won', 'lost', 'warning_closed')),
  outcome_at        text,

  raw               text not null default '{}',
  created_at        text not null default (datetime('now')),
  updated_at        text not null default (datetime('now')),

  unique (processor, external_id)
);

create index if not exists idx_disputes_status  on disputes (status, due_by);
create index if not exists idx_disputes_outcome on disputes (outcome, reason);

-- The dossier. One row per discrete piece of proof.
--
-- Provenance is not decoration. `source` records HOW the proof was obtained,
-- and that distinction is load-bearing twice over: a POD pulled from the
-- carrier's own API is worth more to an issuer than a screenshot of a public
-- tracking page, and a merchant reviewing an auto-assembled packet needs to see
-- which items a machine asserted versus which it retrieved.
create table if not exists evidence_items (
  id            text primary key,
  dispute_id    text not null references disputes (id) on delete cascade,

  -- Neutral evidence vocabulary. Adapters map these onto processor fields;
  -- nothing here is named after a Stripe column on purpose.
  kind          text not null check (kind in (
                  'activity_log', 'receipt', 'invoice', 'product_description',
                  'proof_of_delivery', 'tracking_history', 'shipping_label',
                  'customer_communication', 'refund_policy', 'cancellation_policy',
                  'terms_acceptance', 'ip_geo_match', 'prior_usage_artifact',
                  'signature', 'delivery_photo', 'rebuttal', 'other'
                )),

  source        text not null check (source in (
                  'processor_api',   -- pulled from Stripe/Shopify itself
                  'carrier_api',     -- official carrier API, strongest for POD
                  'agent_browser',   -- agent logged into a portal and retrieved it
                  'merchant_upload', -- a human attached it
                  'generated'        -- we composed it (rebuttals, activity summaries)
                )),

  title         text not null,
  body          text not null default '',       -- text evidence
  file_key      text not null default '',       -- storage key when this is a file
  file_mime     text not null default '',
  file_bytes    integer not null default 0,

  -- Where it came from, for audit. A carrier POD carries the carrier + tracking
  -- number; an agent retrieval carries the portal URL and the task id.
  provenance    text not null default '{}',

  -- Excluded items stay in the table. Evidence that was gathered and then
  -- deliberately left out of a submission is exactly what you need six months
  -- later when asking why a case was lost.
  included      integer not null default 1,

  collected_at  text not null default (datetime('now'))
);

create index if not exists idx_evidence_dispute on evidence_items (dispute_id, kind);

-- Every attempt to put evidence in front of a bank.
--
-- `verified_submitted` is separate from `submitted` for a specific, documented
-- reason: Shopify's disputeEvidenceUpdate can return success with no user
-- errors while the evidence never actually lands. So the adapter writes what it
-- SENT, then re-reads the processor and writes what the processor CONFIRMS.
-- A row where those disagree is the trigger for browser escalation, and without
-- two columns that state is unrepresentable.
create table if not exists submissions (
  id                  text primary key,
  dispute_id          text not null references disputes (id) on delete cascade,

  mode                text not null check (mode in ('staged', 'submitted')),
  channel             text not null check (channel in ('api', 'agent_browser')),

  payload             text not null default '{}',  -- exactly what was sent
  item_ids            text not null default '[]',  -- evidence_items included

  -- What the processor said at the time, and what it said when re-read.
  response            text not null default '{}',
  verified_submitted  integer not null default 0,
  verified_at         text,

  error               text not null default '',
  created_at          text not null default (datetime('now'))
);

create index if not exists idx_submissions_dispute on submissions (dispute_id, created_at);

-- Carrier proof-of-delivery retrieval attempts.
--
-- Modelled as a log rather than a column on the dispute because retrieval
-- genuinely fails in ways the merchant must see: the API path needs the
-- shipper's own account number and a merchant shipping through a 3PL does not
-- have one. "We could not get POD" and "we did not try" have to look different.
create table if not exists carrier_lookups (
  id            text primary key,
  dispute_id    text not null references disputes (id) on delete cascade,

  carrier       text not null,
  tracking      text not null,

  channel       text not null check (channel in ('api', 'agent_browser')),
  outcome       text not null check (outcome in (
                  'delivered_with_pod',   -- signed/photographed POD retrieved
                  'delivered_no_pod',     -- carrier confirms delivery, no POD doc
                  'not_delivered',        -- carrier does not show delivery
                  'unsupported',          -- no API for this carrier
                  'no_account',           -- API needs a shipper account we lack
                  'error'
                )),

  -- The three things an issuer checks, kept as columns because the triage guard
  -- reads them directly: did it arrive, when, and did it go where it was sold.
  delivered_at        text,
  delivery_address    text not null default '',
  address_match       integer,  -- null = not evaluated, 0 = mismatch, 1 = match

  evidence_item_id    text references evidence_items (id) on delete set null,
  detail              text not null default '',
  agent_task_id       text not null default '',
  created_at          text not null default (datetime('now'))
);

create index if not exists idx_carrier_dispute on carrier_lookups (dispute_id, created_at);

-- What the customer actually did in the product.
--
-- Keyed by CUSTOMER, not by dispute, and that is the whole point. Every other
-- evidence route in this app is dispute-scoped and therefore after-the-fact,
-- but the winning argument for a digital product is a usage history that
-- already existed before anyone disputed anything. A merchant cannot
-- retroactively prove their customer logged in for six months; they can only
-- have been recording it. So this table is written continuously by the
-- merchant's own system and joined in at assembly time.
--
-- Deliberately NOT an analytics store. There are no aggregates, no sessions and
-- no funnel: the only questions asked of it are "did this person use the thing,
-- when, and what did they get out of it", because those are the only questions
-- an issuer weighs.
create table if not exists customer_activity (
  id             text primary key,

  -- The merchant's own id for this event, when they have one. Empty string
  -- means "no id"; the partial unique index below keys off that.
  external_id    text not null default '',

  -- Email is the join that actually works. Stripe gives it on the charge's
  -- billing details, Shopify on the order, so it is the one identifier present
  -- on both sides without the merchant mapping anything. Stored lowercased.
  customer_email text not null,

  -- Stronger keys when the merchant has them. `customer_ref` is their own user
  -- id; `charge_ref` ties an event to one payment when they know which.
  customer_ref   text not null default '',
  charge_ref     text not null default '',

  -- The merchant's own vocabulary, on purpose. Every product has different
  -- verbs ('render', 'export', 'lesson_completed') and an enum here would
  -- force a lie. `signup` is the one conventional value the summary looks for.
  event_type     text not null,

  -- Load-bearing column: every claim this evidence makes is a comparison
  -- between this and `disputes.charged_at`. ISO 8601.
  occurred_at    text not null,

  detail         text not null default '',

  -- Something the customer received or produced. An issuer weighs "here is the
  -- work they took delivery of" far above "our logs say they were active".
  artifact_url   text not null default '',
  artifact_label text not null default '',

  ip             text not null default '',
  metadata       text not null default '{}',
  created_at     text not null default (datetime('now'))
);

create index if not exists idx_activity_customer
  on customer_activity (customer_email, occurred_at);

-- Idempotent re-push, but only for merchants who supply their own event id.
-- Partial so that events without one still append: two renders in the same
-- second are two real events, and a blanket unique key would silently drop the
-- second one.
create unique index if not exists idx_activity_external
  on customer_activity (customer_email, external_id) where external_id != '';

-- Single-row settings. Policy text lives here because it is merchant-specific
-- prose that belongs in every submission and nobody wants to retype it.
create table if not exists settings (
  id                    integer primary key check (id = 1),

  -- Default is stage, not submit. Evidence can be submitted exactly once per
  -- dispute, so an automatic bad submission is unrecoverable in a way an
  -- automatic bad draft is not.
  auto_submit           integer not null default 0,
  -- Reason codes the merchant has explicitly promoted to auto-submit, once
  -- their own outcome ledger justifies it. JSON array.
  auto_submit_reasons   text not null default '[]',

  refund_policy_text        text not null default '',
  cancellation_policy_text  text not null default '',
  product_description_text  text not null default '',
  policy_url                text not null default '',

  -- Which agent handles browser escalation, when the org runs more than one.
  agent_server_id       text not null default '',

  updated_at            text not null default (datetime('now'))
);

insert or ignore into settings (id) values (1);
