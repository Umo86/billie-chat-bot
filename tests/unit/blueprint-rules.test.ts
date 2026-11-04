import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  keyIdOf,
  newKey,
  readSync,
  readToken,
  sameExhibitor,
  signingKeyOf,
  signToken,
  tokenKeyId,
  TOKEN_MAX_SECONDS,
} from "@/lib/exhibitors/blueprint-rules";
import { hashToken } from "@/lib/chat/token";

const NOW = Date.parse("2027-03-09T10:00:00Z");
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** A token with its own header and claims, signed with the key's signing key. */
function craft(key: string, header: object, claims: object): string {
  const h = b64(header);
  const c = b64(claims);
  const sig = createHmac("sha256", Buffer.from(signingKeyOf(key), "hex"))
    .update(`${h}.${c}`)
    .digest("base64url");
  return `${h}.${c}.${sig}`;
}

describe("BluePrint keys", () => {
  it("makes keys with a public id and a long secret", () => {
    const { key, keyId } = newKey();
    expect(key).toMatch(/^bp_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(keyIdOf(key)).toBe(keyId);
    expect(newKey().key).not.toBe(key);
    expect(keyIdOf("bp_short_x")).toBeNull();
    expect(keyIdOf(`${key}x`)).toBeNull();
  });

  it("signs with a key made from the key, never the hash Billie checks it with", () => {
    const { key } = newKey();
    expect(signingKeyOf(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(signingKeyOf(key)).toBe(signingKeyOf(key));
    expect(signingKeyOf(key)).not.toBe(hashToken(key));
    expect(signingKeyOf(newKey().key)).not.toBe(signingKeyOf(key));
  });
});

describe("sign-in tokens from BluePrint", () => {
  const { key, keyId } = newKey();
  const signing = signingKeyOf(key);

  it("reads a good token: who it's for, in lower case", () => {
    const token = signToken(key, "Sam@Acme-Displays.test", { now: NOW });
    expect(tokenKeyId(token)).toBe(keyId);
    expect(readToken(token, signing, NOW)).toEqual({
      ok: true,
      keyId,
      email: "sam@acme-displays.test",
      exp: NOW / 1000 + 7200,
    });
  });

  it("refuses a token signed with another key, or changed after signing", () => {
    const other = newKey().key;
    expect(readToken(signToken(other, "sam@acme.test", { now: NOW }), signing, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const [h, , s] = signToken(key, "sam@acme.test", { now: NOW }).split(".");
    const swapped = b64({
      iss: "blueprint",
      aud: "billie",
      sub: "jo@bolt.test",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
    });
    expect(readToken(`${h}.${swapped}.${s}`, signing, NOW)).toMatchObject({
      reason: "bad_signature",
    });
  });

  it("only takes HS256 with a key id: never alg none", () => {
    const claims = {
      iss: "blueprint",
      aud: "billie",
      sub: "sam@acme.test",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
    };
    const none = `${b64({ alg: "none", kid: keyId })}.${b64(claims)}.`;
    expect(readToken(none, signing, NOW)).toMatchObject({ reason: "malformed" });
    expect(readToken(craft(key, { alg: "HS512", kid: keyId }, claims), signing, NOW)).toMatchObject(
      { reason: "malformed" },
    );
    expect(readToken(craft(key, { alg: "HS256" }, claims), signing, NOW)).toMatchObject({
      reason: "malformed",
    });
    expect(readToken("not-a-token", signing, NOW)).toMatchObject({ reason: "malformed" });
    expect(readToken(`${"a".repeat(3000)}.b.c`, signing, NOW)).toMatchObject({
      reason: "malformed",
    });
    // A good header and claims, and the right signature, still pass.
    expect(readToken(craft(key, { alg: "HS256", kid: keyId }, claims), signing, NOW)).toMatchObject(
      { ok: true },
    );
  });

  it("checks who it's for, when it was made and when it runs out", () => {
    const at = (claims: Record<string, unknown>) =>
      readToken(signToken(key, "sam@acme.test", { now: NOW, claims }), signing, NOW);
    expect(at({ aud: "someone-else" })).toMatchObject({ reason: "wrong_audience" });
    expect(at({ aud: ["billie", "other"] })).toMatchObject({ ok: true });
    expect(at({ iss: "not-blueprint" })).toMatchObject({ reason: "wrong_audience" });
    expect(at({ iat: undefined })).toMatchObject({ reason: "too_long" });
    expect(at({ exp: NOW / 1000 + TOKEN_MAX_SECONDS + 1 })).toMatchObject({ reason: "too_long" });
    expect(at({ iat: NOW / 1000 + 600, exp: NOW / 1000 + 1200 })).toMatchObject({
      reason: "not_yet",
    });
    expect(at({ nbf: NOW / 1000 + 600 })).toMatchObject({ reason: "not_yet" });
    // A minute's difference in the clocks is fine.
    expect(at({ iat: NOW / 1000 + 30 })).toMatchObject({ ok: true });
    expect(at({ sub: "not an email" })).toMatchObject({ reason: "malformed" });
    expect(at({ sub: "a@x.test, b@y.test" })).toMatchObject({ reason: "malformed" });
    const old = signToken(key, "sam@acme.test", { now: NOW - 3 * 3600_000, seconds: 3600 });
    expect(readToken(old, signing, NOW)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("the guide for BluePrint (docs/blueprint.md)", () => {
  it("has example code that makes a sign-in Billie accepts", () => {
    const guide = readFileSync(path.join(__dirname, "..", "..", "docs", "blueprint.md"), "utf8");
    const code = /```ts\n([\s\S]*?)```/.exec(guide)![1];
    // The example, run as it's written (its import swapped for the modules here).
    const body = code
      .replace(/^import .*$/m, "")
      .replace("export function billieSignIn", "return function billieSignIn")
      .replace(/\(key: string, email: string\): string/, "(key, email)")
      .replace(/ as const/g, "")
      .replace(/: object/g, "");
    const billieSignIn = new Function("createHash", "createHmac", "randomUUID", body)(
      createHash,
      createHmac,
      randomUUID,
    ) as (key: string, email: string) => string;
    const { key, keyId } = newKey();
    const token = billieSignIn(key, " Sam@Acme-Displays.co.uk ");
    expect(readToken(token, signingKeyOf(key))).toMatchObject({
      ok: true,
      keyId,
      email: "sam@acme-displays.co.uk",
    });
  });
});

describe("the exhibitor list BluePrint sends", () => {
  it("tidies it the way a spreadsheet is read", () => {
    const read = readSync({
      exhibitors: [
        {
          id: 101,
          company: "  Acme   Displays Ltd ",
          stand: "B12",
          name: "Sam Patel",
          emails: ["Sam@Acme-Displays.test", "sam@acme-displays.test", "not-an-email"],
          fields: {
            "Stand type": "Shell scheme",
            " Stand plan   approved ": false,
            "Electrics ordered": true,
            Notes: null,
            "Build-up slot": 2,
          },
        },
        { id: "ex-2", company: "Bolt & Co", emails: ["jo@bolt.test; ops@bolt.test"] },
        { id: "ex-3", company: "Nobody Ltd", emails: [] },
      ],
    });
    expect(read).toEqual({
      ok: true,
      list: {
        rows: [
          {
            externalId: "101",
            company: "Acme Displays Ltd",
            stand: "B12",
            name: "Sam Patel",
            emails: ["sam@acme-displays.test"],
            fields: {
              "Stand type": "Shell scheme",
              "Stand plan approved": "No",
              "Electrics ordered": "Yes",
              "Build-up slot": "2",
            },
          },
          {
            externalId: "ex-2",
            company: "Bolt & Co",
            stand: "",
            name: "",
            emails: ["jo@bolt.test", "ops@bolt.test"],
            fields: {},
          },
        ],
        columns: ["Stand type", "Stand plan approved", "Electrics ordered", "Build-up slot"],
        skipped: 1,
      },
    });
  });

  it("keeps the first 40 fields, as with a spreadsheet's columns", () => {
    const fields = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`F${i}`, "x"]));
    const read = readSync({ exhibitors: [{ id: "a", emails: ["a@x.test"], fields }] });
    expect(read.ok && read.list.columns).toHaveLength(40);
    expect(read.ok && Object.keys(read.list.rows[0].fields)).toHaveLength(40);
  });

  it("says what's wrong with a list it can't take", () => {
    expect(readSync([])).toMatchObject({ ok: false, error: /"exhibitors" list/ });
    expect(readSync({ exhibitors: "no" })).toMatchObject({ ok: false });
    expect(readSync({ exhibitors: [{ company: "No id", emails: ["a@x.test"] }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/^Check exhibitors\.0\.id/),
    });
    expect(readSync({ exhibitors: [{ id: "a", emails: "a@x.test" }] })).toMatchObject({
      ok: false,
      error: /exhibitors\.0\.emails/,
    });
    expect(
      readSync({
        exhibitors: [
          { id: "same", emails: ["a@x.test"] },
          { id: "same", emails: ["b@x.test"] },
        ],
      }),
    ).toMatchObject({ ok: false, error: /"same" is in the list twice/ });
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), emails: ["a@x.test"] }));
    expect(readSync({ exhibitors: many })).toMatchObject({ ok: false, error: /up to 5,000/ });
  });

  it("knows when an exhibitor hasn't changed", () => {
    const a = {
      company: "Acme",
      stand: "B12",
      name: "Sam",
      emails: ["sam@acme.test"],
      fields: { "Stand type": "Shell scheme", Electrics: "Yes" },
    };
    expect(
      sameExhibitor(a, { ...a, fields: { Electrics: "Yes", "Stand type": "Shell scheme" } }),
    ).toBe(true);
    expect(sameExhibitor(a, { ...a, stand: "B14" })).toBe(false);
    expect(sameExhibitor(a, { ...a, emails: ["sam@acme.test", "ops@acme.test"] })).toBe(false);
    expect(
      sameExhibitor(a, { ...a, fields: { "Stand type": "Space only", Electrics: "Yes" } }),
    ).toBe(false);
  });
});
