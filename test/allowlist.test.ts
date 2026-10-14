import { describe, expect, it } from "vitest";
import { isAllowlisted } from "../src/allowlist";
import { parseAllowlist } from "../src/config";

describe("allowlist", () => {
  it("parses comma-separated snowflakes and ignores blanks", () => {
    const ids = parseAllowlist(" 100000000000000021, 100000000000000022 ,100000000000000021,");
    expect([...ids]).toEqual(["100000000000000021", "100000000000000022"]);
    expect(isAllowlisted(ids, "100000000000000021")).toBe(true);
    expect(isAllowlisted(ids, "100000000000000099")).toBe(false);
    expect(isAllowlisted(ids, "not-a-snowflake")).toBe(false);
    expect(isAllowlisted(new Set(), "100000000000000021")).toBe(false);
  });

  it("rejects values that are not snowflakes", () => {
    expect(() => parseAllowlist("123,100000000000000021")).toThrow(/ALLOWLIST_USER_IDS/);
  });
});
