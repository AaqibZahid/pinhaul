import { describe, expect, it } from "vitest";
import { downloadBoard } from "../src/background/download";

describe("downloadBoard", () => {
  it("does not create a file when cancelled before work starts", async () => {
    const controller = new AbortController();
    controller.abort();
    let saved = false;
    await expect(
      downloadBoard(
        { username: "alice", slug: "ideas" },
        false,
        {
          client: {
            getData: async () => ({}) as never,
            getResource: async () => ({}) as never,
          },
          save: async () => {
            saved = true;
            return 1;
          },
          wait: async () => undefined,
        },
        () => undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(saved).toBe(false);
  });
});
