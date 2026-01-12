export async function yieldNow(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}
