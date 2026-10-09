import { AsyncLocalStorage } from "node:async_hooks";

type TransportRecoveryContext = {
  enabled: true;
  proxyUrl: string;
};

const storage =
  new AsyncLocalStorage<TransportRecoveryContext>();

export function runWithTransportRecovery<T>(
  proxyUrl: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!proxyUrl) {
    throw new Error("Transport recovery proxy URL is missing.");
  }

  return storage.run(
    { enabled: true, proxyUrl },
    operation,
  );
}

export function getTransportRecoveryProxy():
  string | undefined {
  return storage.getStore()?.proxyUrl;
}
