import { describe, it, expect } from "vitest";
import {
  analyzeNetworkActivityFromXml,
  extractHost,
} from "./analyzeNetworkActivity.js";

// Synthetic Network template XML matching the most common xctrace column
// shape: time, host, method, status-code, duration, bytes-in, bytes-out.
// Real Apple Network traces vary the mnemonic per iOS / Xcode version;
// the analyzer falls back across multiple candidate names per field.
const NETWORK_FIXTURE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="network-connections">
<col><mnemonic>time</mnemonic><name>Time</name><engineering-type>event-time</engineering-type></col>
<col><mnemonic>host</mnemonic><name>Host</name><engineering-type>short-string</engineering-type></col>
<col><mnemonic>method</mnemonic><name>Method</name><engineering-type>short-string</engineering-type></col>
<col><mnemonic>status-code</mnemonic><name>Status</name><engineering-type>integer</engineering-type></col>
<col><mnemonic>duration</mnemonic><name>Duration</name><engineering-type>duration</engineering-type></col>
<col><mnemonic>bytes-in</mnemonic><name>Bytes In</name><engineering-type>byte-count</engineering-type></col>
<col><mnemonic>bytes-out</mnemonic><name>Bytes Out</name><engineering-type>byte-count</engineering-type></col>
</schema>
<row>
<time id="1" fmt="00:00.500">500000000</time>
<host id="2" fmt="https://api.example.com/v1/users">https://api.example.com/v1/users</host>
<method id="3" fmt="GET">GET</method>
<status-code id="4" fmt="200">200</status-code>
<duration id="5" fmt="450 ms">450000000</duration>
<bytes-in id="6" fmt="12 KB">12345</bytes-in>
<bytes-out id="7" fmt="256 bytes">256</bytes-out>
</row>
<row>
<time id="8" fmt="00:01.200">1200000000</time>
<host id="9" fmt="https://api.example.com/v1/items">https://api.example.com/v1/items</host>
<method id="10" fmt="POST">POST</method>
<status-code id="11" fmt="201">201</status-code>
<duration id="12" fmt="3200 ms">3200000000</duration>
<bytes-in id="13" fmt="2 KB">2048</bytes-in>
<bytes-out id="14" fmt="500 KB">500000</bytes-out>
</row>
<row>
<time id="15" fmt="00:02.100">2100000000</time>
<host id="16" fmt="https://cdn.acme.io/assets/icon.png">https://cdn.acme.io/assets/icon.png</host>
<method id="17" fmt="GET">GET</method>
<status-code id="18" fmt="404">404</status-code>
<duration id="19" fmt="80 ms">80000000</duration>
<bytes-in id="20" fmt="512 bytes">512</bytes-in>
<bytes-out id="21" fmt="100 bytes">100</bytes-out>
</row>
<row>
<time id="22" fmt="00:03.000">3000000000</time>
<host id="23" fmt="https://api.example.com/v1/healthcheck">https://api.example.com/v1/healthcheck</host>
<method id="24" fmt="GET">GET</method>
<status-code id="25" fmt="500">500</status-code>
<duration id="26" fmt="120 ms">120000000</duration>
<bytes-in id="27" fmt="64 bytes">64</bytes-in>
<bytes-out id="28" fmt="0 bytes">0</bytes-out>
</row>
</node></trace-query-result>`;

describe("analyzeNetworkActivityFromXml", () => {
  it("parses connection rows and reports row count", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.totals.rows).toBe(4);
    expect(r.status).toBe("available");
  });

  it("aggregates total bytes in + out across all connections", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.totals.totalBytesIn).toBe(12345 + 2048 + 512 + 64);
    expect(r.totals.totalBytesOut).toBe(256 + 500000 + 100 + 0);
  });

  it("computes longest + average response time in milliseconds", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.totals.longestMs).toBe(3200);
    const expectedAvg = (450 + 3200 + 80 + 120) / 4;
    expect(r.totals.averageMs).toBeCloseTo(expectedAvg, 2);
  });

  it("buckets HTTP statuses into 2xx/3xx/4xx/5xx", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.totals.statusBuckets).toEqual({
      "2xx": 2, // 200 + 201
      "4xx": 1, // 404
      "5xx": 1, // 500
    });
  });

  it("ranks topByDuration with the 3200ms POST first", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.topByDuration[0].durationMs).toBe(3200);
    expect(r.topByDuration[0].method).toBe("POST");
    expect(r.topByDuration[1].durationMs).toBe(450);
  });

  it("ranks topByBytes with the 500KB POST upload first", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    const top = r.topByBytes[0];
    expect((top.bytesIn ?? 0) + (top.bytesOut ?? 0)).toBe(2048 + 500000);
    expect(top.method).toBe("POST");
  });

  it("aggregates byHost ranked by request count", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.byHost[0].host).toBe("api.example.com");
    expect(r.byHost[0].count).toBe(3);
    expect(r.byHost[1].host).toBe("cdn.acme.io");
    expect(r.byHost[1].count).toBe(1);
  });

  it("per-host longestMs tracks the slowest request on that host", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    const apiHost = r.byHost.find((h) => h.host === "api.example.com");
    expect(apiHost?.longestMs).toBe(3200);
    const cdnHost = r.byHost.find((h) => h.host === "cdn.acme.io");
    expect(cdnHost?.longestMs).toBe(80);
  });

  it("minBytes filter excludes connections below the threshold", () => {
    // Per row totals: 12345+256=12601, 2048+500000=502048, 512+100=612,
    // 64+0=64. minBytes=1000 keeps the first two only.
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace", 10, 1000);
    expect(r.totals.rows).toBe(2);
    const healthcheck = r.topByDuration.find((e) => e.statusCode === 500);
    expect(healthcheck).toBeUndefined();
    const cdn404 = r.topByDuration.find((e) => e.statusCode === 404);
    expect(cdn404).toBeUndefined();
  });

  it("diagnosis names the slowest request when one is over 3s (user-visible)", () => {
    const r = analyzeNetworkActivityFromXml(NETWORK_FIXTURE, "/fake.trace");
    expect(r.diagnosis).toContain("Slowest: 3200ms");
    expect(r.diagnosis).toContain("Likely the user-visible perf gap");
  });

  it("returns status: not_present when no network table is in the trace", () => {
    const empty = `<?xml version="1.0"?><trace-query-result><node><schema name="tick"/></node></trace-query-result>`;
    const r = analyzeNetworkActivityFromXml(empty, "/fake.trace");
    expect(r.status).toBe("not_present");
    expect(r.totals.rows).toBe(0);
    expect(r.diagnosis).toMatch(/No network/);
  });
});

describe("extractHost helper", () => {
  it("returns the host portion of an https URL", () => {
    expect(extractHost("https://api.example.com/v1/users")).toBe("api.example.com");
  });

  it("strips port when present", () => {
    expect(extractHost("http://localhost:8080/health")).toBe("localhost");
  });

  it("returns the input as-is when there is no scheme or path", () => {
    expect(extractHost("api.example.com")).toBe("api.example.com");
  });

  it("returns undefined for empty / null input", () => {
    expect(extractHost(undefined)).toBeUndefined();
    expect(extractHost("")).toBeUndefined();
  });
});
