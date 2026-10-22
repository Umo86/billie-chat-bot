import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getActor } from "@/lib/auth/actor";
import { can } from "@/lib/authz";
import { blobConfigured } from "@/lib/config";
import { MAX_FILE_BYTES } from "@/lib/knowledge/files";
import { CLIENT_UPLOAD_PREFIX } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Hands the browser a short-lived token to upload a large file (an
 * exhibitor manual) straight to private Vercel Blob storage, past the
 * 4.5 MB request limit. Only signed-in people who may edit knowledge get one,
 * and only for the file types Billie reads.
 */
const ALLOWED = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/html",
];

export async function POST(request: Request) {
  if (!blobConfigured())
    return NextResponse.json({ error: "File storage isn't set up" }, { status: 400 });
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const actor = await getActor();
        if (!actor || !can(actor, "knowledge.edit")) throw new Error("Not allowed");
        if (!pathname.startsWith(CLIENT_UPLOAD_PREFIX)) throw new Error("Wrong folder");
        return {
          allowedContentTypes: ALLOWED,
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // The browser registers the file itself (registerUploadAction), so nothing waits on this callback.
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload refused" },
      { status: 400 },
    );
  }
}
