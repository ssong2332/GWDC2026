import Database from "better-sqlite3";
import { SQLITE_USER_VERSION } from "@/config/constants";
import { AppError } from "@/core/errors";

// Schema v1 (Architecture 6). No automatic migrations during the hackathon: a different user_version
// refuses to start with a recovery hint.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('policy_set','spend_request','approval','rejection','pause','unpause')),
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL, request_id TEXT,
  package_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  anchor_tx_hash TEXT, anchor_block TEXT, anchor_log_index INTEGER, anchor_event TEXT, anchor_args_json TEXT, anchored_at TEXT
);
CREATE TABLE IF NOT EXISTS kiln_calls (
  call_id TEXT PRIMARY KEY,
  flow TEXT NOT NULL CHECK (flow IN ('policy_parse','intent_judge')),
  provider TEXT NOT NULL CHECK (provider IN ('kiln','fake')),
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL, request_id TEXT,
  model TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('tool_call','no_tool_call','http_error')),
  http_status INTEGER, error_code TEXT, finish_reason TEXT, attempts INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, reasoning_tokens INTEGER,
  total_tokens INTEGER NOT NULL, cached_tokens INTEGER, cost_usd TEXT, generation_id TEXT,
  thinking_mode TEXT NOT NULL, raw_arguments TEXT, raw_content TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_requests (
  request_id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL,
  flow TEXT NOT NULL CHECK (flow IN ('rule_block','intent_judge')),
  merchant_id TEXT NOT NULL, amount TEXT NOT NULL, fee TEXT NOT NULL,
  precheck_verdict TEXT NOT NULL, precheck_reason INTEGER, judgment_status TEXT,
  tx_hash TEXT, outcome TEXT CHECK (outcome IN ('executed','blocked','pending','failed')),
  onchain_reason INTEGER, pending_flags INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_events (
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
  block_number TEXT NOT NULL, block_timestamp INTEGER NOT NULL, event_name TEXT NOT NULL,
  request_id TEXT, evidence_hash TEXT, args_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS sync_state (chain_id INTEGER NOT NULL, vault TEXT NOT NULL, last_block TEXT NOT NULL, PRIMARY KEY (chain_id, vault));
`;

/** Opens (or creates) the evidence database. `:memory:` is accepted for tests. */
export function openDatabase(path: string): Database.Database {
    const db = new Database(path);
    try {
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        const version = db.pragma("user_version", { simple: true }) as number;
        const tableCount = db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table'").pluck().get() as number;
        if (version === 0 && tableCount === 0) {
            db.transaction(() => {
                db.exec(SCHEMA_V1);
                db.pragma(`user_version = ${SQLITE_USER_VERSION}`);
            })();
        } else if (version !== SQLITE_USER_VERSION) {
            throw new AppError(
                "DB_VERSION_MISMATCH",
                `database schema version ${version} != ${SQLITE_USER_VERSION}: delete data.local/app.sqlite and rerun E2E`,
            );
        }
        return db;
    } catch (err) {
        db.close();
        throw err;
    }
}
