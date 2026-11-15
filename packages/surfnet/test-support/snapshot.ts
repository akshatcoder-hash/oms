// Test-only: export a running surfnet's accounts as a `--snapshot` file body.
// u64 values such as rentEpoch exceed the safe integer range, so integers are kept as raw JSON text.
export async function exportSnapshot(rpcUrl: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'surfnet_exportSnapshot',
      params: [
        { scope: 'network', filter: { includeProgramAccounts: true, excludeSysvars: true, excludeFeatureGates: true } },
      ],
    }),
  });
  const body = JSON.parse(await response.text(), (_key, value, context?: { source?: string }) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source) throw new Error('JSON integer source unavailable');
      return (JSON as unknown as { rawJSON(source: string): unknown }).rawJSON(context.source);
    }
    return value;
  }) as { result?: { value?: object } };
  if (!body.result || typeof body.result.value !== 'object' || body.result.value === null) {
    throw new Error('surfnet_exportSnapshot returned an unexpected shape (no value map)');
  }
  return JSON.stringify(body.result.value, null, 2);
}
