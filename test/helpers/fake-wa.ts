/**
 * In-memory fake of the World Anvil API for offline tests.
 * All content is invented; all IDs are obviously fake.
 */
import { WORLD_ANVIL_BASE_URL } from "../../src/constants.js";

type Json = Record<string, unknown>;

export const FAKE_APP_KEY = "fake-app-key-AAAA1111";
export const FAKE_TOKEN = "fake-auth-token-BBBB2222";

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Json | undefined;
  headers: Record<string, string>;
}

const date = (d: string) => ({ date: `${d} 10:00:00.000000`, timezone_type: 3, timezone: "UTC" });

export function seedData() {
  const worlds: Json[] = [
    {
      id: "world-open-0001",
      title: "Testland Alpha",
      entityClass: "World",
      updateDate: date("2026-01-01"),
    },
    {
      id: "world-blocked-0002",
      title: "Testland Hidden",
      entityClass: "World",
      updateDate: date("2026-01-02"),
    },
    {
      id: "world-edit-0003",
      title: "Testland Gamma",
      entityClass: "World",
      updateDate: date("2026-01-03"),
    },
  ];
  const wref = (id: string) => ({
    id,
    title: worlds.find((w) => w.id === id)?.title,
    entityClass: "World",
  });

  const articles: Json[] = [];
  for (let i = 1; i <= 120; i++) {
    articles.push({
      id: `article-open-${String(i).padStart(4, "0")}`,
      title: `Invented Article ${i}`,
      entityClass: i % 3 === 0 ? "Person" : "Article",
      templateType: i % 3 === 0 ? "person" : "article",
      tags: i % 10 === 0 ? "harbor, legend" : "",
      state: "private",
      world: wref("world-open-0001"),
      category:
        i % 2 === 0
          ? { id: "category-open-0001", title: "Invented Category", entityClass: "Category" }
          : null,
      content: `Plain invented text for article ${i}.`,
      excerpt: "",
      updateDate: date("2026-02-01"),
    });
  }
  articles.push({
    id: "article-blocked-0001",
    title: "Hidden Invented Article",
    entityClass: "Article",
    world: wref("world-blocked-0002"),
    content: "Should never be shown.",
    updateDate: date("2026-02-02"),
  });

  const secrets: Json[] = [
    {
      id: "secret-blocked-0001",
      title: "Hidden Secret",
      content: "Should never be shown.",
      world: wref("world-blocked-0002"),
      updateDate: date("2026-03-01"),
    },
    {
      // No world field at all: must resolve through its article.
      id: "secret-open-noworld-0001",
      title: "Secret Without World",
      content: "Invented secret.",
      article: { id: "article-open-0001", title: "Invented Article 1", entityClass: "Article" },
      updateDate: date("2026-03-02"),
    },
    {
      // Neither world nor parent: unresolvable.
      id: "secret-orphan-0001",
      title: "Orphan Secret",
      content: "Invented.",
      updateDate: date("2026-03-03"),
    },
  ];

  const timelines: Json[] = [
    {
      id: "timeline-blocked-0001",
      title: "Hidden Timeline",
      world: wref("world-blocked-0002"),
      updateDate: date("2026-04-01"),
    },
    {
      id: "timeline-open-0001",
      title: "Invented Timeline",
      world: wref("world-open-0001"),
      updateDate: date("2026-04-02"),
    },
  ];

  const histories: Json[] = [
    {
      // History with no world field: resolves via timelines → timeline.world.
      id: "history-blocked-0001",
      title: "Hidden Event",
      content: "Should never be shown.",
      timelines: [
        { id: "timeline-blocked-0001", title: "Hidden Timeline", entityClass: "Timeline" },
      ],
      updateDate: date("2026-05-01"),
    },
    {
      id: "history-open-0001",
      title: "Invented Event",
      content: "Invented event text.",
      timelines: [
        { id: "timeline-open-0001", title: "Invented Timeline", entityClass: "Timeline" },
      ],
      updateDate: date("2026-05-02"),
    },
  ];

  const categories: Json[] = [
    {
      id: "category-open-0001",
      title: "Invented Category",
      world: wref("world-open-0001"),
      updateDate: date("2026-06-01"),
    },
    {
      id: "category-edit-0001",
      title: "Invented Editable Category",
      world: wref("world-edit-0003"),
      updateDate: date("2026-06-02"),
    },
  ];

  // world-edit-0003 is edit_only and world-full-0004 full_edit in the test access file.
  worlds.push({
    id: "world-full-0004",
    title: "Testland Delta",
    entityClass: "World",
    updateDate: date("2026-01-04"),
  });
  categories.push({
    id: "category-full-0001",
    title: "Full Category",
    world: wref("world-full-0004"),
    updateDate: date("2026-06-03"),
  });
  articles.push(
    {
      id: "article-edit-0001",
      title: "Editable Person",
      entityClass: "Person",
      templateType: "person",
      state: "private",
      isDraft: true,
      world: wref("world-edit-0003"),
      content: "Original invented content.",
      nickname: "Original nickname",
      updateDate: date("2026-07-01"),
    },
    {
      id: "article-edit-0002",
      title: "Editable Organization",
      entityClass: "Organization",
      templateType: "organization",
      state: "private",
      world: wref("world-edit-0003"),
      updateDate: date("2026-07-02"),
    },
    {
      id: "article-full-0001",
      title: "Deletable Article",
      entityClass: "Article",
      templateType: "article",
      world: wref("world-full-0004"),
      content: "Invented content to delete.",
      category: { id: "category-full-0001", title: "Full Category", entityClass: "Category" },
      updateDate: date("2026-07-03"),
    },
    {
      id: "article-full-0002",
      title: "Article Linking To Deletable",
      entityClass: "Article",
      templateType: "article",
      world: wref("world-full-0004"),
      content: "See [url:article-full-0001]",
      updateDate: date("2026-07-04"),
    },
  );

  return {
    worlds,
    articles,
    secrets,
    timelines,
    histories,
    categories,
    subscribergroups: [] as Json[],
  };
}

export type FakeData = ReturnType<typeof seedData>;

export interface FakeOptions {
  /** Replace the handler for some calls; return undefined to fall through. */
  override?: (call: RecordedCall) => Response | undefined;
  /** Hide fields below a granularity, to mimic World Anvil (field → min granularity). */
  minGranularity?: Record<string, number>;
  /** Fields World Anvil accepts with 200 but does not store. Default: organization type given as a name. */
  ignore?: (type: string, field: string, value: unknown) => boolean;
  /** Types whose elements come back without updateDate (seen live on subscriber groups). */
  noUpdateDate?: string[];
}

/** Mimics World Anvil ignoring an organization type sent by name instead of {id}. */
const defaultIgnore = (_type: string, field: string, value: unknown) =>
  field === "type" && typeof value === "string";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const htmlNotFound = () =>
  new Response("<!DOCTYPE html><html><body>Page not found</body></html>", {
    status: 404,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });

export function createFakeWorldAnvil(data: FakeData = seedData(), options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];
  const minG = options.minGranularity ?? { world: 1, timelines: 2, article: 2 };

  const collections: Record<string, Json[]> = {
    world: data.worlds,
    article: data.articles,
    secret: data.secrets,
    timeline: data.timelines,
    history: data.histories,
    category: data.categories,
    subscribergroup: (data as { subscribergroups?: Json[] }).subscribergroups ?? [],
  };
  const ignore = options.ignore ?? defaultIgnore;
  let created = 0;
  let clock = 0;
  const stamp = () => date(`2026-09-${String(1 + (clock++ % 28)).padStart(2, "0")}`);
  const noDate = new Set(options.noUpdateDate ?? []);

  const shape = (el: Json, granularity: number): Json => {
    const out: Json = {};
    for (const [k, v] of Object.entries(el)) {
      if ((minG[k] ?? -1) > granularity) continue;
      out[k] = v;
    }
    return out;
  };

  const worldOf = (el: Json) => (el.world as Json | undefined)?.id;

  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(WORLD_ANVIL_BASE_URL + "/")) {
      throw new Error(`fake: unexpected host or base ${url.href}`);
    }
    const path = url.pathname.replace(new URL(WORLD_ANVIL_BASE_URL).pathname + "/", "");
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const call: RecordedCall = {
      method: init.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      headers,
    };
    calls.push(call);

    const o = options.override?.(call);
    if (o) return o;

    if (headers["x-application-key"] !== FAKE_APP_KEY || headers["x-auth-token"] !== FAKE_TOKEN) {
      return json({ success: false, error: "access_denied" }, 401);
    }

    if (call.method === "GET" && path === "identity")
      return json({ id: "user-fake-0001", username: "fake-user" });

    if (call.method === "POST") {
      const body = call.body ?? {};
      if (typeof body.limit !== "string" || typeof body.offset !== "string") {
        return json(
          { success: false, error: { summary: "limit and offset must be strings" } },
          422,
        );
      }
      const limit = Number(body.limit);
      const offset = Number(body.offset);
      let list: Json[] | undefined;
      if (path === "user/worlds") list = data.worlds;
      const m = /^world\/(articles|secrets|timelines|histories|categories|subscribergroups)$/.exec(
        path,
      );
      if (m) {
        const type = {
          articles: "article",
          secrets: "secret",
          timelines: "timeline",
          histories: "history",
          categories: "category",
          subscribergroups: "subscribergroup",
        }[m[1] as string] as string;
        list = (collections[type] ?? []).filter((e) => {
          if (worldOf(e) === call.query.id) return true;
          // history without world: belongs to its timeline's world
          const tl = (e.timelines as Json[] | undefined)?.[0]?.id;
          return tl
            ? data.timelines.find((t) => t.id === tl && worldOf(t) === call.query.id) !== undefined
            : false;
        });
        const cat = (body.category as Json | undefined)?.id;
        if (cat) list = list.filter((a) => (a.category as Json | null)?.id === cat);
      }
      if (!list) return htmlNotFound();
      return json({
        success: true,
        entities: list.slice(offset, offset + limit).map((e) => shape(e, -1)),
      });
    }

    if (call.method === "PUT") {
      const coll = collections[path];
      if (!coll) return htmlNotFound();
      const body = call.body ?? {};
      if (typeof body.title !== "string" || !body.title) {
        return json(
          {
            success: false,
            status: "Unprocessable Data provided",
            error: { summary: "title is required" },
          },
          422,
        );
      }
      const id = `created-${path}-${String(++created).padStart(4, "0")}`;
      const el: Json = {
        id,
        entityClass: path[0]!.toUpperCase() + path.slice(1),
        isWip: path === "article" ? true : undefined,
      };
      for (const [k, v] of Object.entries(body)) if (!ignore(path, k, v)) el[k] = v;
      el.updateDate = stamp();
      el.editURL = `https://fake.invalid/edit/${id}`;
      coll.push(el);
      return json({ id, title: el.title, success: true });
    }

    if (call.method === "PATCH") {
      const coll = collections[path];
      if (!coll) return htmlNotFound();
      const el = coll.find((e) => e.id === call.query.id);
      if (!el) return json({ success: false, error: "resource_not_found" }, 404);
      for (const [k, v] of Object.entries(call.body ?? {})) if (!ignore(path, k, v)) el[k] = v;
      el.updateDate = stamp();
      return json({ id: el.id, success: true });
    }

    if (call.method === "DELETE") {
      const coll = collections[path];
      if (!coll) return htmlNotFound();
      const i = coll.findIndex((e) => e.id === call.query.id);
      if (i < 0) return json({ success: false, error: "resource_not_found" }, 404);
      coll.splice(i, 1);
      return json({ success: true });
    }

    if (call.method === "GET") {
      const coll = collections[path];
      if (!coll) return htmlNotFound();
      const el = coll.find((e) => e.id === call.query.id);
      if (!el) return json({ success: false, error: "resource_not_found" }, 404);
      const out = shape(el, Number(call.query.granularity ?? "0"));
      if (noDate.has(path)) delete out.updateDate;
      return json(out);
    }
    return htmlNotFound();
  }) as typeof fetch;

  return { fetch: fetchImpl, calls, data };
}
