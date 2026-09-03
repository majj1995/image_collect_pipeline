import sharp from "sharp";

export const publicOnlyResolver = async (hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> => {
  if (hostname.endsWith(".example") || hostname.endsWith(".test")) return [{ address: "93.184.216.34", family: 4 }];
  return [{ address: "93.184.216.34", family: 4 }];
};

export function redirectingFetch(target: string): typeof fetch {
  return async () => new Response(null, { status: 302, headers: { location: target } });
}

export async function makePng(options: { width: number; height: number; color?: string; metadata?: boolean; channels?: 3 | 4 } ): Promise<Buffer> {
  const image = sharp({ create: { width: options.width, height: options.height, channels: options.channels ?? 3, background: options.color ?? "#2559d6" } }).png();
  return options.metadata ? image.withMetadata({ comment: "test metadata" }).toBuffer() : image.toBuffer();
}

export function streamResponse(chunks: Uint8Array[], headers: HeadersInit = {}, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(stream, { status, headers });
}
