import { createServer } from "node:http";
import { connect } from "node:net";

/** Synthetic local-only OAuth and OpenAI-compatible streaming endpoint. */
export async function startMockProvider() {
	const counts = { authorize: 0, exchange: 0, refresh: 0, stream: 0, proxy: 0 };
	const callbackPorts = new Set<number>();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.url?.startsWith("http://")) counts.proxy++;
		if (url.pathname === "/authorize") {
			counts.authorize++;
			const callback = new URL(url.searchParams.get("redirect_uri")!);
			if (callback.hostname !== "127.0.0.1") {
				response.writeHead(400).end();
				return;
			}
			callbackPorts.add(Number(callback.port));
			callback.searchParams.set("code", "synthetic-code");
			response.writeHead(302, { location: callback.href }).end();
			return;
		}
		if (url.pathname === "/token") {
			let data = "";
			for await (const chunk of request) data += chunk;
			const body = new URLSearchParams(data);
			const refresh = body.get("grant_type") === "refresh_token";
			if (refresh) counts.refresh++;
			else counts.exchange++;
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					access: refresh ? "synthetic-refreshed" : "synthetic-access",
					refresh: "synthetic-refresh",
					expires: refresh ? Date.now() + 3_600_000 : 0,
				}),
			);
			return;
		}
		if (url.pathname === "/v1/chat/completions") {
			if (request.headers.authorization !== "Bearer synthetic-refreshed") {
				response.writeHead(401).end();
				return;
			}
			counts.stream++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const text of ["local ", "response"])
				response.write(
					`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
				);
			response.end(
				`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
		response.writeHead(404).end();
	});
	server.on("connect", (request, socket, head) => {
		const address = server.address();
		const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(request.url ?? "")?.[1]);
		if (!address || typeof address === "string" || (port !== address.port && !callbackPorts.has(port))) {
			socket.destroy();
			return;
		}
		counts.proxy++;
		const upstream = connect(port, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		socket.on("error", () => upstream.destroy());
		upstream.on("error", () => socket.destroy());
		socket.on("close", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing mock server address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		counts,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
