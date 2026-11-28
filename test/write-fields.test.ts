import { describe, expect, it } from "vitest";
import { getType } from "../src/registry/index.js";
import { takenAtFromFile } from "../src/write/backups.js";
import { compareReadBack, restoreBody, sameValue, validateFields } from "../src/write/fields.js";

describe("sameValue", () => {
  it.each([
    [{ id: "a" }, { id: "a", title: "T", entityClass: "Person" }],
    [
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "a" }],
    ],
    [true, 1],
    [false, null],
    ["5", 5],
    ["a\r\nb", "a\nb"],
    ["", null],
    [[], null],
    [{ date: "2026-01-01" }, "2026-01-01"],
  ])("%j equals %j", (a, b) => expect(sameValue(a, b)).toBe(true));

  it.each([
    ["a", "b"],
    [{ id: "a" }, { id: "b" }],
    [true, false],
    ["text", null],
  ])("%j differs from %j", (a, b) => expect(sameValue(a, b)).toBe(false));
});

describe("compareReadBack", () => {
  it("classifies stored, ignored and different fields", () => {
    const r = compareReadBack(
      { a: "x", b: "y", c: "z", d: "new" },
      { a: "x", b: null, c: "Z", d: "old" },
      { d: "old" },
    );
    expect(r).toEqual({ stored: ["a"], ignored: ["b", "d"], different: ["c"] });
  });
});

describe("restoreBody", () => {
  it("sends changed writable fields, clears fields empty in the backup, skips computed ones", () => {
    const def = getType("article");
    const backup = {
      id: "x",
      url: "u",
      title: "Old",
      templateType: "person",
      content: "Old text",
      nickname: "",
      organization: { id: "org-1", title: "O" },
      updateDate: { date: "d" },
    };
    const current = {
      ...backup,
      title: "New",
      content: "New text",
      nickname: "Nick",
      organization: null,
    };
    const { body } = restoreBody(def, backup, current);
    expect(body).toEqual({
      title: "Old",
      content: "Old text",
      nickname: "",
      organization: { id: "org-1" },
    });
  });
});

describe("validateFields", () => {
  it("is strict for probed templates and the plain article template only", () => {
    const def = getType("article");
    expect(() =>
      validateFields(def, { nope: 1 }, { template: "person", strictTemplates: true }),
    ).toThrow(/Unknown field/);
    expect(() =>
      validateFields(def, { nope: 1 }, { template: "article", strictTemplates: true }),
    ).toThrow(/Unknown field/);
    expect(
      validateFields(def, { nope: 1 }, { template: "location", strictTemplates: true }).warnings[0],
    ).toMatch(/not probed yet/);
    expect(
      validateFields(def, { nope: 1 }, { template: "person", strictTemplates: false }).warnings[0],
    ).toMatch(/unknown to the registry/);
  });
});

describe("backup file names", () => {
  it("carry the time the backup was taken", () => {
    expect(takenAtFromFile("20260128T101500123Z-abc123-update.json")).toBe(
      Date.UTC(2026, 0, 28, 10, 15, 0, 123),
    );
    expect(takenAtFromFile("nope.json")).toBeUndefined();
  });
});
