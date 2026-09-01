import { expect, test } from "bun:test";
import { accumulateNvidiaPoll, type NvidiaPollAccumulator, type NvidiaReading } from "./collector.ts";
import type { NvidiaAdapterSample } from "./model.ts";

function reading(uuid: string, usedVramBytes: number, pollTimestamp: string): NvidiaReading {
  return {
    adapter: { uuid, usedVramBytes } as NvidiaAdapterSample,
    pollTimestamp,
  };
}

test("NVIDIA polls publish complete frames and drop missing adapters", () => {
  const poll: NvidiaPollAccumulator = { pollTimestamp: null, pending: new Map() };

  expect(accumulateNvidiaPoll(poll, reading("gpu-a", 1, "t1"))).toBeNull();
  expect(accumulateNvidiaPoll(poll, reading("gpu-b", 2, "t1"))).toBeNull();

  const first = accumulateNvidiaPoll(poll, reading("gpu-a", 3, "t2"));
  expect([...first!.values()].map((adapter) => [adapter.uuid, adapter.usedVramBytes])).toEqual([
    ["gpu-a", 1],
    ["gpu-b", 2],
  ]);

  const second = accumulateNvidiaPoll(poll, reading("gpu-a", 4, "t3"));
  expect([...second!.keys()]).toEqual(["gpu-a"]);
  expect(second!.get("gpu-a")?.usedVramBytes).toBe(3);
});
