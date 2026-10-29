/**
 * Helpers of the tests of the envelope feature. Nothing of the application imports this file.
 */

/** A binary channel message with the given start bucket and pairs. */
export function chunkBytes(startBucket: number, pairs: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(8 + pairs.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, startBucket, true);
  view.setUint32(4, pairs.length / 2, true);
  bytes.set(pairs, 8);
  return bytes;
}
