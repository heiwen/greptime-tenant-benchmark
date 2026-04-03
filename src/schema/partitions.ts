export function PARTITION_CLAUSE_ON(col: string): string {
  const hexDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
  const parts: string[] = [];

  parts.push(`  ${col} < '1'`);
  for (let i = 1; i < hexDigits.length - 1; i++) {
    parts.push(`  ${col} >= '${hexDigits[i]}' AND ${col} < '${hexDigits[i + 1]}'`);
  }
  parts.push(`  ${col} >= 'f'`);

  return `PARTITION ON COLUMNS (${col}) (\n${parts.join(',\n')}\n)`;
}

export const PARTITION_CLAUSE: string = PARTITION_CLAUSE_ON('tenant_id');
