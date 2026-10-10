const channel = new BroadcastChannel("pinhaul-blobs");
const urls = new Set<string>();

channel.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as { type?: string; id?: string; blob?: Blob; url?: string };
  if (message.type === "create" && message.id && message.blob instanceof Blob) {
    const url = URL.createObjectURL(message.blob);
    urls.add(url);
    channel.postMessage({ type: "created", id: message.id, url });
  }
  if (message.type === "revoke" && message.url) {
    URL.revokeObjectURL(message.url);
    urls.delete(message.url);
  }
});

addEventListener("pagehide", () => {
  for (const url of urls) URL.revokeObjectURL(url);
});
