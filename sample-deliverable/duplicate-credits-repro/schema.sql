-- Fictional client "NimbusNotes": a note-taking SaaS that sells credit packs. Not real data.
CREATE TABLE accounts (
  id text PRIMARY KEY,
  stripe_customer_id text UNIQUE NOT NULL,
  balance integer NOT NULL DEFAULT 0
);
CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  amount integer NOT NULL,
  stripe_event_id text NOT NULL,
  stripe_invoice_id text NOT NULL
);
