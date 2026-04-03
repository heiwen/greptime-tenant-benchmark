import { PARTITION_CLAUSE_ON } from './partitions.js';

// PARTITION ON COLUMNS is only supported in GreptimeDB distributed/cluster mode.
// For standalone (local Docker), set PARTITION_ENABLED=1 is NOT set by default.
const PARTITION_ENABLED = process.env.PARTITION_ENABLED === '1';

export function spansTableB(): string {
  const partition = PARTITION_ENABLED ? `\n${PARTITION_CLAUSE_ON('tenant_id')}` : '';
  return `CREATE TABLE IF NOT EXISTS spans (
  tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
  "timestamp" TIMESTAMP(9) NOT NULL TIME INDEX,
  timestamp_end TIMESTAMP(9),
  duration_nano BIGINT,
  trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=1024),
  span_id VARCHAR(16) NOT NULL,
  parent_span_id VARCHAR(16),
  span_name VARCHAR(256) INVERTED INDEX,
  span_kind VARCHAR(64),
  span_status_code VARCHAR(64),
  span_status_message VARCHAR(512),
  trace_state VARCHAR(256),
  service_name VARCHAR(256) INVERTED INDEX,
  scope_name VARCHAR(256),
  scope_version VARCHAR(64),
  gen_ai_operation VARCHAR(64),
  gen_ai_system VARCHAR(64),
  gen_ai_request_model VARCHAR(128),
  gen_ai_response_model VARCHAR(128),
  gen_ai_input_tokens INT,
  gen_ai_output_tokens INT,
  gen_ai_total_tokens INT,
  gen_ai_finish_reasons VARCHAR(128),
  gen_ai_input_messages STRING,
  gen_ai_output_messages STRING,
  span_attributes STRING,
  span_events STRING,
  PRIMARY KEY (tenant_id, span_id)
)${partition}
WITH ('append_mode' = 'true')`;
}

export function spansTableA(tenantId: string): string {
  const suffix = tenantId.replace(/-/g, '');
  const tableName = `spans_${suffix}`;
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  "timestamp" TIMESTAMP(9) NOT NULL TIME INDEX,
  timestamp_end TIMESTAMP(9),
  duration_nano BIGINT,
  trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=1024),
  span_id VARCHAR(16) NOT NULL,
  parent_span_id VARCHAR(16),
  span_name VARCHAR(256) INVERTED INDEX,
  span_kind VARCHAR(64),
  span_status_code VARCHAR(64),
  span_status_message VARCHAR(512),
  trace_state VARCHAR(256),
  service_name VARCHAR(256) INVERTED INDEX,
  scope_name VARCHAR(256),
  scope_version VARCHAR(64),
  gen_ai_operation VARCHAR(64),
  gen_ai_system VARCHAR(64),
  gen_ai_request_model VARCHAR(128),
  gen_ai_response_model VARCHAR(128),
  gen_ai_input_tokens INT,
  gen_ai_output_tokens INT,
  gen_ai_total_tokens INT,
  gen_ai_finish_reasons VARCHAR(128),
  gen_ai_input_messages STRING,
  gen_ai_output_messages STRING,
  span_attributes STRING,
  span_events STRING,
  PRIMARY KEY (span_id)
)
WITH ('append_mode' = 'true')`;
}

export function conversationItemsTableB(): string {
  const partition = PARTITION_ENABLED ? `\n${PARTITION_CLAUSE_ON('tenant_id')}` : '';
  return `CREATE TABLE IF NOT EXISTS conversation_items (
  tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
  "id" VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL INVERTED INDEX,
  created_at TIMESTAMP(3) NOT NULL TIME INDEX,
  "type" VARCHAR(64),
  "data" STRING,
  PRIMARY KEY (tenant_id, conversation_id, "id")
)${partition}`;
}

export function conversationItemsTableA(tenantId: string): string {
  const suffix = tenantId.replace(/-/g, '');
  const tableName = `conversation_items_${suffix}`;
  const partition = PARTITION_ENABLED ? `\n${PARTITION_CLAUSE_ON('conversation_id')}` : '';
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  "id" VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL INVERTED INDEX,
  created_at TIMESTAMP(3) NOT NULL TIME INDEX,
  "type" VARCHAR(64),
  "data" STRING,
  PRIMARY KEY (conversation_id, "id")
)${partition}`;
}
