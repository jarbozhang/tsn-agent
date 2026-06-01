export const TOPOLOGY_LIMITS = {
  maxNodes: 256,
  maxLinks: 1024,
  maxPortsPerNode: 64,
  maxOperations: 32,
  maxTemplateParams: 16,
  maxArtifactBytes: 1_000_000,
  maxJsonDepth: 32,
  maxIngressPayloadBytes: 1_000_000,
  handlerTimeoutMs: 5_000,
} as const;

export type TopologyLimitName = keyof typeof TOPOLOGY_LIMITS;

export function measureJsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }

  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(measureJsonDepth));
  }

  return 1 + Math.max(0, ...Object.values(value as Record<string, unknown>).map(measureJsonDepth));
}

export function measureJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value) ?? "undefined";

  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(serialized).length;
  }

  return measureUtf8Bytes(serialized);
}

function measureUtf8Bytes(value: string): number {
  let bytes = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}
