import { config } from '../config.js';
import { PARTITION_CLAUSE_ON } from './partitions.js';

export function spansTableB(): string {
  return `CREATE TABLE IF NOT EXISTS spans (
  tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
  "timestamp" TIMESTAMP(9) NOT NULL,
  timestamp_end TIMESTAMP(9),
  duration_nano BIGINT UNSIGNED,
  trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=10240),
  span_id VARCHAR(16) NOT NULL,
  parent_span_id VARCHAR(16),
  span_name VARCHAR(256),
  span_kind VARCHAR(64),
  span_status_code VARCHAR(64),
  span_status_message VARCHAR(512),
  trace_state VARCHAR(256),
  service_name STRING,
  scope_name VARCHAR(256),
  scope_version VARCHAR(64),
  gen_ai_operation VARCHAR(64),
  gen_ai_system VARCHAR(64),
  gen_ai_request_model VARCHAR(128),
  gen_ai_response_model VARCHAR(128),
  gen_ai_input_tokens BIGINT,
  gen_ai_output_tokens BIGINT,
  gen_ai_total_tokens BIGINT,
  gen_ai_finish_reasons VARCHAR(128),
  gen_ai_input_messages STRING,
  gen_ai_output_messages STRING,
  span_attributes STRING,
  span_events STRING,
  span_links STRING,
  TIME INDEX ("timestamp"),
  PRIMARY KEY (tenant_id)
)
${PARTITION_CLAUSE_ON('trace_id')}
WITH ('append_mode' = 'true')`;
}

export function spansTableA(tenantId: string): string {
  const suffix = tenantId.replace(/-/g, '');
  const tableName = `spans_${suffix}`;
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  "timestamp" TIMESTAMP(9) NOT NULL,
  timestamp_end TIMESTAMP(9),
  duration_nano BIGINT UNSIGNED,
  trace_id VARCHAR(32) NOT NULL SKIPPING INDEX WITH(type='BLOOM', granularity=10240),
  span_id VARCHAR(16) NOT NULL,
  parent_span_id VARCHAR(16),
  span_name VARCHAR(256),
  span_kind VARCHAR(64),
  span_status_code VARCHAR(64),
  span_status_message VARCHAR(512),
  trace_state VARCHAR(256),
  service_name STRING,
  scope_name VARCHAR(256),
  scope_version VARCHAR(64),
  gen_ai_operation VARCHAR(64),
  gen_ai_system VARCHAR(64),
  gen_ai_request_model VARCHAR(128),
  gen_ai_response_model VARCHAR(128),
  gen_ai_input_tokens BIGINT,
  gen_ai_output_tokens BIGINT,
  gen_ai_total_tokens BIGINT,
  gen_ai_finish_reasons VARCHAR(128),
  gen_ai_input_messages STRING,
  gen_ai_output_messages STRING,
  span_attributes STRING,
  span_events STRING,
  span_links STRING,
  TIME INDEX ("timestamp")
)
WITH ('append_mode' = 'true')`;
}

export function conversationItemsTableB(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_items (
  tenant_id VARCHAR(36) NOT NULL INVERTED INDEX,
  "id" VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL SKIPPING INDEX WITH(granularity=10240, type='BLOOM'),
  created_at TIMESTAMP(3) NOT NULL,
  "type" VARCHAR(64),
  "data" STRING,
  TIME INDEX ("created_at"),
  PRIMARY KEY (tenant_id)
)
${PARTITION_CLAUSE_ON('conversation_id')}
WITH ('append_mode' = 'true')`;
}

export function conversationItemsTableA(tenantId: string): string {
  const suffix = tenantId.replace(/-/g, '');
  const tableName = `conversation_items_${suffix}`;
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  "id" VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL SKIPPING INDEX WITH(granularity=10240, type='BLOOM'),
  created_at TIMESTAMP(3) NOT NULL ,
  "type" VARCHAR(64),
  "data" STRING,
  TIME INDEX ("created_at")
)
WITH ('append_mode' = 'true')`;
}
