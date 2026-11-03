// Observability around the official Paddle worker. Recognition implementation is unmodified.
const earlyMessages = [];
self.onmessage = (event) => earlyMessages.push(event);
const originalFetch = self.fetch.bind(self);
self.fetch = async (input, options) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    self.location.href,
  );
  if (url.origin !== self.location.origin)
    throw new Error("External model/runtime requests are disabled");
  const start = performance.now(),
    response = await originalFetch(input, options);
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          self.postMessage({
            type: "asset",
            path: url.pathname,
            bytes,
            downloadMs: performance.now() - start,
          });
          controller.close();
        } else {
          bytes += chunk.value.byteLength;
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
await import("/scan-lab/vendor/paddle-worker.mjs");
const handleMessage = self.onmessage;
for (const event of earlyMessages) handleMessage?.call(self, event);
earlyMessages.length = 0;
