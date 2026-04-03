/**
 * Generate a deterministic conversation ID for a given tenant + index.
 * Uses a simple hash of the tenant ID and index to produce a valid UUID v4.
 * The seeder and workloads call this with the same arguments to get the same UUIDs.
 */
export function tenantConversationId(tenantId: string, index: number): string {
  // Create a deterministic but well-distributed hash using FNV-1a-like mixing
  const input = `${tenantId}:${index}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9dc5811c;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x00000193) >>> 0;
  }

  // Mix h1 and h2 to produce 4 x 32-bit words
  const a = (h1 ^ (h2 >>> 16)) >>> 0;
  const b = (h2 ^ (h1 >>> 16)) >>> 0;
  const c2 = Math.imul(a ^ b, 0x45d9f3b) >>> 0;
  const d = Math.imul(b ^ (c2 >>> 8), 0xb7e15163) >>> 0;

  function hex(n: number, len: number): string {
    return (n >>> 0).toString(16).padStart(len, '0').slice(-len);
  }

  // Format as UUID v4 (set version bits)
  const p1 = hex(a, 8);
  const p2 = hex(b >>> 16, 4);
  // Version 4: high nibble of time_hi = 4
  const p3 = '4' + hex(c2 >>> 20, 3);
  // Variant: high bits = 10xx
  const p4 = hex(((d >>> 16) & 0x3fff) | 0x8000, 4);
  const p5 = hex(d & 0xffff, 4) + hex(a ^ d, 8);

  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}
