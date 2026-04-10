// InfluxDB line-protocol helpers for GreptimeDB seeding.
// Protocol reference: https://docs.influxdata.com/influxdb/v1/write_protocols/line_protocol_tutorial/
//
// Escaping:
//   Tag keys/values : escape comma, space, equals, backslash
//   Field string values: escape backslash, double-quote (content in our generated data
//                        has no backslashes, so in practice only " → \" is needed)
//   Field integers : append 'i' suffix
//   Timestamp     : nanoseconds since epoch (precision=ns)

function escapeTag(s: string): string {
  return s.replace(/[,= \\]/g, '\\$&');
}

function escapeStr(s: string): string {
  // Our vocabulary has no backslashes; only JSON structural quotes need escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Build an LP line for a spans row.
// Schema: PRIMARY KEY (service_name) → service_name is the only TAG.
// All other columns are fields. TIME INDEX = timestamp (ns precision).
export function spanRowToLp(tableName: string, row: Record<string, unknown>): string {
  const tsNs = new Date(row.timestamp as string).getTime() * 1_000_000;

  const parts: string[] = [
    `duration_nano=${row.duration_nano}u`,
    `gen_ai_input_tokens=${row.gen_ai_input_tokens}i`,
    `gen_ai_output_tokens=${row.gen_ai_output_tokens}i`,
    `gen_ai_total_tokens=${row.gen_ai_total_tokens}i`,
    `trace_id="${escapeStr(row.trace_id as string)}"`,
    `span_id="${escapeStr(row.span_id as string)}"`,
    `span_name="${escapeStr(row.span_name as string)}"`,
    `span_kind="${escapeStr(row.span_kind as string)}"`,
    `span_status_code="${escapeStr(row.span_status_code as string)}"`,
    `scope_name="${escapeStr(row.scope_name as string)}"`,
    `scope_version="${escapeStr(row.scope_version as string)}"`,
    `gen_ai_operation="${escapeStr(row.gen_ai_operation as string)}"`,
    `gen_ai_system="${escapeStr(row.gen_ai_system as string)}"`,
    `gen_ai_request_model="${escapeStr(row.gen_ai_request_model as string)}"`,
    `gen_ai_response_model="${escapeStr(row.gen_ai_response_model as string)}"`,
    `gen_ai_finish_reasons="${escapeStr(row.gen_ai_finish_reasons as string)}"`,
    `gen_ai_input_messages="${escapeStr(row.gen_ai_input_messages as string)}"`,
    `gen_ai_output_messages="${escapeStr(row.gen_ai_output_messages as string)}"`,
    `span_attributes="${escapeStr(row.span_attributes as string)}"`,
    `span_events="[]"`,
    `span_links="[]"`,
  ];

  // timestamp_end is a secondary TIMESTAMP column — LP only supports one timestamp position
  // (the TIME INDEX). Skip it; the column is nullable and unused by benchmark queries.
  if (row.parent_span_id != null) {
    parts.push(`parent_span_id="${escapeStr(row.parent_span_id as string)}"`);
  }
  if (row.span_status_message != null) {
    parts.push(`span_status_message="${escapeStr(row.span_status_message as string)}"`);
  }
  // trace_state is always null in generated data — skip
  if (row.tenant_id != null) {
    parts.push(`tenant_id="${escapeStr(row.tenant_id as string)}"`);
  }

  return `${tableName},service_name=${escapeTag(row.service_name as string)} ${parts.join(',')} ${tsNs}`;
}

// Build an LP line for a conversation_items row.
// Schema: no PRIMARY KEY columns → no TAGs. All columns are fields.
// TIME INDEX = created_at (ns precision).
export function itemRowToLp(
  tableName: string,
  row: Record<string, unknown>,
  _convPk: boolean,
  _strategy: 'a' | 'b',
): string {
  const tsNs = new Date(row.created_at as string).getTime() * 1_000_000;

  const fields: string[] = [
    `id="${escapeStr(row.id as string)}"`,
    `conversation_id="${escapeStr(row.conversation_id as string)}"`,
  ];
  if (row.tenant_id != null) fields.push(`tenant_id="${escapeStr(row.tenant_id as string)}"`);
  if (row.type != null) fields.push(`type="${escapeStr(row.type as string)}"`);
  if (row.data != null) fields.push(`data="${escapeStr(row.data as string)}"`);

  return `${tableName} ${fields.join(',')} ${tsNs}`;
}

export async function lpWriteBatch(
  url: string,
  lines: string[],
  retries = 10,
  delayMs = 15_000,
): Promise<void> {
  const body = lines.join('\n');
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body,
      });
      if (resp.ok) return;
      const text = await resp.text();
      throw new Error(`LP write failed ${resp.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      const msg = e instanceof Error ? e.message.slice(0, 100) : String(e);
      console.log(`  [retry] LP error: ${msg}, waiting ${delayMs / 1000}s... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
