// Generate random printable ASCII text of exactly targetBytes length.
// Uses crypto.getRandomValues on a TypedArray + TextDecoder for fast bulk generation.
// Content is random a-z + space — suitable for any string field in the benchmark.
export function randomText(targetBytes: number): string {
  const buf = new Uint8Array(targetBytes);
  crypto.getRandomValues(buf);
  // Map each byte to one of 32 chars (a-z + 6 spaces) via power-of-two mask.
  const CHARS = 'abcdefghijklmnopqrstuvwxyz      '; // 26 letters + 6 spaces = 32 chars
  const out = new Uint8Array(targetBytes);
  for (let i = 0; i < targetBytes; i++) {
    out[i] = CHARS.charCodeAt(buf[i] & 31);
  }
  return new TextDecoder().decode(out);
}

export function randomJson(targetBytes: number): string {
  const obj: Record<string, unknown> = {};
  let currentSize = 2; // {}

  const keys = [
    'id', 'name', 'value', 'type', 'status', 'message', 'code', 'data',
    'timestamp', 'version', 'source', 'target', 'level', 'category',
    'description', 'metadata', 'config', 'result', 'error', 'info',
    'count', 'total', 'index', 'flags', 'tags', 'labels', 'attrs',
    'params', 'options', 'settings', 'context', 'payload', 'body',
  ];

  let keyIndex = 0;

  while (currentSize < targetBytes - 20) {
    const key = keyIndex < keys.length
      ? keys[keyIndex]
      : `field_${keyIndex}`;
    keyIndex++;

    const remaining = targetBytes - currentSize;
    let value: unknown;
    let valueStr: string;

    if (remaining > 100 && Math.random() < 0.3) {
      // Nested object
      const nested: Record<string, unknown> = {
        value: randomText(8),
        count: Math.floor(Math.random() * 1000),
        enabled: Math.random() > 0.5,
        label: randomText(12),
      };
      valueStr = JSON.stringify(nested);
      value = nested;
    } else if (remaining > 50 && Math.random() < 0.4) {
      // String value
      const strLen = Math.min(remaining - 20, 20 + Math.floor(Math.random() * 60));
      const str = randomText(strLen);
      valueStr = JSON.stringify(str);
      value = str;
    } else if (Math.random() < 0.5) {
      // Number
      value = Math.floor(Math.random() * 100000);
      valueStr = String(value);
    } else {
      // Boolean
      value = Math.random() > 0.5;
      valueStr = String(value);
    }

    obj[key] = value;
    // key + value + quotes + colon + comma + space
    currentSize += key.length + 2 + valueStr.length + 3;
  }

  return JSON.stringify(obj);
}
