import { describe, expect, it } from "vitest";
import { analyzeTemplates, kindOf } from "../live/template-analysis.js";

const generic = {
  id: "a",
  title: "Invented",
  templateType: "article",
  content: "x",
  success: true,
  world: { id: "w" },
};

describe("template probe analysis", () => {
  it("separates template-specific fields using plain articles as the generic basis", () => {
    const r = analyzeTemplates(
      [
        { ...generic, extraGeneric: 1 },
        {
          ...generic,
          templateType: "person",
          extraGeneric: 1,
          nickname: "Invented",
          birthplace: { id: "a-2" },
          honorifics: "",
        },
        { ...generic, templateType: "Person", extraGeneric: 2, nickname: null },
        { ...generic, templateType: "organization", extraGeneric: 1, motto: "Invented motto" },
      ],
      ["id", "title"],
    );
    expect(r.genericBasis).toBe("plain-article-template");
    expect(r.templates.person).toEqual({
      articles: 2,
      specific: {
        birthplace: { kinds: ["ref"], nonEmpty: 1 },
        honorifics: { kinds: ["string"], nonEmpty: 0 },
        nickname: { kinds: ["null", "string"], nonEmpty: 1 },
      },
    });
    expect(r.templates.organization!.specific).toEqual({
      motto: { kinds: ["string"], nonEmpty: 1 },
    });
    expect(r.templates.article).toBeUndefined();
    expect(r.generic).not.toContain("success");
  });

  it("falls back to fields common to every template when no plain article exists", () => {
    const r = analyzeTemplates(
      [
        { id: "1", templateType: "person", shared: "x", nickname: "y" },
        { id: "2", templateType: "rank", shared: "x", insignia: "z" },
      ],
      [],
    );
    expect(r.genericBasis).toBe("common-to-all-templates");
    expect(Object.keys(r.templates.person!.specific)).toEqual(["nickname"]);
    expect(Object.keys(r.templates.rank!.specific)).toEqual(["insignia"]);
  });

  it("records kinds, never values", () => {
    const r = analyzeTemplates(
      [{ id: "1", templateType: "person", secretName: "Invented Real-Looking Name" }],
      [],
    );
    expect(JSON.stringify(r)).not.toContain("Invented Real-Looking Name");
    expect([
      kindOf("s"),
      kindOf(1),
      kindOf(true),
      kindOf(null),
      kindOf([]),
      kindOf({ id: "x" }),
      kindOf({}),
    ]).toEqual(["string", "number", "boolean", "null", "array", "ref", "object"]);
  });
});
