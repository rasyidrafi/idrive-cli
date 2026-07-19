import { describe, expect, it, vi } from "vitest";

import { IdDriveAuthClient } from "../src/auth-client.js";

describe("IdDriveAuthClient", () => {
  it("authenticates against the Cloud Drive endpoints", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        '<root><login message="SUCCESS" username_sync="a1b2" password_sync="c3d4" enctype="DEFAULT" /></root>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        '<root><login acctype="sync" evssrvr="server" evswebsrvr="web" enctype="DEFAULT" dedup="off" /></root>',
        { status: 200 },
      ));
    const client = new IdDriveAuthClient(fetcher);

    const result = await client.authenticate("person@example.test", "p@ss word");

    expect(result.account.syncUsername).toBe("a1b2");
    expect(result.server.serverDns).toBe("server");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "username=person%40example.test&password=p%40ss+word",
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "username=a1b2&password=c3d4",
    );
  });

  it("reports an unactivated Cloud Drive account", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      '<root><login message="SUCCESS" enctype="DEFAULT" /></root>',
      { status: 200 },
    ));

    await expect(
      new IdDriveAuthClient(fetcher).authenticate("person@example.test", "secret"),
    ).rejects.toThrow(/not activated/i);
  });

  it("rejects non-successful HTTP responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("unavailable", {
      status: 503,
    }));

    await expect(
      new IdDriveAuthClient(fetcher).authenticate("person@example.test", "secret"),
    ).rejects.toThrow(/503/);
  });

  it("validates successful machine-link responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: "success" }),
      { status: 200 },
    ));

    await expect(
      new IdDriveAuthClient(fetcher).linkMachine(
        "person@example.test",
        "secret",
        "device-id",
        "server-name",
      ),
    ).resolves.toBeUndefined();

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect((init.body as URLSearchParams).get("device_id")).toBe("device-id");
  });

  it("rejects application-level machine-link failures", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: "failure" }),
      { status: 200 },
    ));

    await expect(
      new IdDriveAuthClient(fetcher).linkMachine("email", "password", "id", "name"),
    ).rejects.toThrow(/rejected/i);
  });

  it("rejects unknown machine-link response shapes", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      new IdDriveAuthClient(fetcher).linkMachine("email", "password", "id", "name"),
    ).rejects.toThrow(/rejected/i);
  });
});
