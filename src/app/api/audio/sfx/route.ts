import { NextRequest, NextResponse } from "next/server";
import { AUDIOS } from "@/features/editor/data/audio";

const toSoundEffect = (a: any) => ({
  id: `sfx_${a.id}`,
  name: a.name || "Untitled SFX",
  src: a.details?.src || "",
  type: "audio",
  description: a.metadata?.author || "",
});

const filterByQuery = (items: any[], query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) =>
    [i.name, i.description]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q))
  );
};

const paginate = (items: any[], page: number, limit: number) => {
  const start = (page - 1) * limit;
  const end = start + limit;
  const sliced = items.slice(start, end);
  return {
    soundEffects: sliced,
    pagination: {
      hasMore: end < items.length,
      page,
      limit,
      total: items.length,
    },
  };
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({} as any));
  const page = Number(body?.page || 1);
  const limit = Number(body?.limit || 30);
  const query = Array.isArray(body?.query?.keys) ? String(body.query.keys[0] || "") : "";

  const mapped = AUDIOS.map(toSoundEffect).filter((m) => !!m.src);
  const filtered = filterByQuery(mapped, query);
  return NextResponse.json(paginate(filtered, page, limit), { status: 200 });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const page = Number(searchParams.get("page") || "1");
  const limit = Number(searchParams.get("limit") || "30");
  const query = searchParams.get("query") || "";

  const mapped = AUDIOS.map(toSoundEffect).filter((m) => !!m.src);
  const filtered = filterByQuery(mapped, query);
  return NextResponse.json(paginate(filtered, page, limit), { status: 200 });
}

