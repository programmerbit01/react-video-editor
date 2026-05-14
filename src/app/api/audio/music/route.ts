import { NextRequest, NextResponse } from "next/server";

// Fallback route to keep stock-audio UI stable when no provider is configured.
// Returns an empty collection instead of HTML 404, so client JSON parsing never breaks.
export async function POST(_request: NextRequest) {
  return NextResponse.json(
    {
      musics: [],
      pagination: { hasMore: false, page: 1, limit: 30, total: 0 },
      message: "Stock audio provider is not configured",
    },
    { status: 200 }
  );
}

export async function GET(_request: NextRequest) {
  return NextResponse.json(
    {
      musics: [],
      pagination: { hasMore: false, page: 1, limit: 30, total: 0 },
      message: "Stock audio provider is not configured",
    },
    { status: 200 }
  );
}

