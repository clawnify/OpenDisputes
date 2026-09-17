import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { triageWarning, type FulfillmentState } from "./fraud-warnings.js";
import schema from "./schema.sql?raw";
import seed from "../../demo/seed.sql?raw";

function seededDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  db.exec(seed);
  return db;
}

describe("demo seed", () => {
  it("loads on the schema with intact references", () => {
    const db = seededDatabase();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM disputes").get()).toEqual({ n: 5 });
  });

  it("points at no stored files, which a demo does not have", () => {
    const db = seededDatabase();
    expect(db.prepare("SELECT count(*) AS n FROM evidence_items WHERE file_key != ''").get()).toEqual({ n: 0 });
  });

  it("stores the warning verdicts triage would reach", () => {
    const db = seededDatabase();
    const rows = db
      .prepare("SELECT fraud_type, actionable, amount_cents, currency, three_d_secure_result, fulfillment_state, recommendation, recommendation_reason, factors FROM fraud_warnings")
      .all() as {
        fraud_type: string; actionable: number; amount_cents: number; currency: string;
        three_d_secure_result: string; fulfillment_state: string;
        recommendation: string; recommendation_reason: string; factors: string;
      }[];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      const verdict = triageWarning({
        warning: row,
        fulfillment: row.fulfillment_state as FulfillmentState,
        three_d_secure_result: row.three_d_secure_result,
      });
      expect(verdict.recommendation).toBe(row.recommendation);
      expect(verdict.reason).toBe(row.recommendation_reason);
      expect(verdict.factors).toEqual(JSON.parse(row.factors));
    }
  });
});
