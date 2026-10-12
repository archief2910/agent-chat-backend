import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MagicaClient, executeMagicaRun, readMediaUrl } from "@/server/magica/client";

const server = setupServer();
const base = "https://inference.example.test";

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client() {
  return new MagicaClient({ baseUrl: base, apiKey: "gx_test" });
}

describe("magica client", () => {
  it("reads a completed GPT Image result when the URL is under result", () => {
    expect(readMediaUrl({ result: ["https://cdn.example/cat.png"], provider: "gpt" }, "image_url")).toBe("https://cdn.example/cat.png");
  });

  it("starts a run only when no run id exists, then reads the terminal payload", async () => {
    const posts: unknown[] = [];
    server.use(
      http.post(`${base}/v1/nodes/crop_image/run`, async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ runId: "magica_1" }, { status: 202 });
      }),
      http.get(`${base}/v1/nodes/runs/magica_1`, () =>
        HttpResponse.json({ id: "magica_1", nodeType: "crop_image", status: "COMPLETED", output: { image_url: ["https://cdn.example/out.png"] }, creditUsed: 5000 }),
      ),
    );
    const remembered: string[] = [];
    const run = await executeMagicaRun({
      client: client(),
      nodeType: "crop_image",
      data: { image_url: "https://cdn.example/a.png" },
      rememberRunId: async (id) => {
        remembered.push(id);
      },
      sleep: async () => {},
    });
    expect(posts).toHaveLength(1);
    expect(remembered).toEqual(["magica_1"]);
    expect(run.status).toBe("COMPLETED");

    server.use(
      http.post(`${base}/v1/nodes/crop_image/run`, () => {
        posts.push("again");
        return HttpResponse.json({ runId: "magica_2" }, { status: 202 });
      }),
    );
    await executeMagicaRun({
      client: client(),
      nodeType: "crop_image",
      data: { image_url: "https://cdn.example/a.png" },
      existingRunId: "magica_1",
      rememberRunId: async () => {},
      sleep: async () => {},
    });
    expect(posts).toHaveLength(1);
  });

  it("keeps polling the same run when a status call drops", async () => {
    let reads = 0;
    server.use(
      http.post(`${base}/v1/nodes/crop_image/run`, () => HttpResponse.json({ runId: "magica_retry" }, { status: 202 })),
      http.get(`${base}/v1/nodes/runs/magica_retry`, () => {
        reads += 1;
        if (reads === 1) return HttpResponse.json({ message: "unavailable" }, { status: 503 });
        return HttpResponse.json({
          id: "magica_retry",
          nodeType: "crop_image",
          status: "COMPLETED",
          output: { image_url: "https://cdn.example/out.png" },
          creditUsed: 5000,
        });
      }),
    );
    const run = await executeMagicaRun({
      client: client(),
      nodeType: "crop_image",
      data: { image_url: "https://cdn.example/a.png" },
      rememberRunId: async () => {},
      sleep: async () => {},
    });
    expect(reads).toBe(2);
    expect(run.output).toMatchObject({ image_url: "https://cdn.example/out.png" });
  });

  it("maps 401 and 429 without leaking the response body", async () => {
    server.use(http.get(`${base}/v1/models`, () => HttpResponse.json({ error: "bad key gx_test" }, { status: 401 })));
    await expect(client().listModels()).rejects.toMatchObject({ code: "UPSTREAM_UNAUTHORIZED", status: 502 });

    server.use(http.get(`${base}/v1/models`, () => HttpResponse.json({ message: "slow down" }, { status: 429 })));
    await expect(client().listModels()).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED", retryable: true });
  });

  it("surfaces a failed run message and times out", async () => {
    server.use(
      http.post(`${base}/v1/nodes/crop_image/run`, () => HttpResponse.json({ runId: "magica_fail" }, { status: 202 })),
      http.get(`${base}/v1/nodes/runs/magica_fail`, () =>
        HttpResponse.json({ id: "magica_fail", nodeType: "crop_image", status: "FAILED", userMessage: "The rectangle is outside the image.", creditUsed: 0 }),
      ),
    );
    const failed = await executeMagicaRun({
      client: client(),
      nodeType: "crop_image",
      data: {},
      rememberRunId: async () => {},
      sleep: async () => {},
    });
    expect(failed.userMessage).toBe("The rectangle is outside the image.");

    server.use(
      http.post(`${base}/v1/nodes/crop_image/run`, () => HttpResponse.json({ runId: "magica_slow" }, { status: 202 })),
      http.get(`${base}/v1/nodes/runs/magica_slow`, () => HttpResponse.json({ id: "magica_slow", nodeType: "crop_image", status: "RUNNING" })),
    );
    await expect(
      executeMagicaRun({
        client: client(),
        nodeType: "crop_image",
        data: {},
        rememberRunId: async () => {},
        sleep: async () => {},
        maxPolls: 1,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", details: { externalRunId: "magica_slow" } });
  });
});
