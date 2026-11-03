import "server-only";
import { AddSource } from "@/components/knowledge/add-source";
import { SourceList } from "@/components/knowledge/source-list";
import { CheckPanel } from "@/components/knowledge/check-panel";
import { latestCheck } from "@/lib/knowledge/check";
import { sourcesFor } from "@/lib/knowledge/queries";
import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES } from "@/lib/knowledge/files";
import { storageBackend } from "@/lib/storage";

/**
 * A bot's knowledge: the check, adding files, text, answers and pages, and
 * the list of what's there. The same on the Knowledge page and in the bot's
 * Knowledge step.
 */
export async function KnowledgeWorkspace({
  kbId,
  canEdit,
  canAdd = canEdit,
}: {
  kbId: string;
  canEdit: boolean;
  /** False for an old shared base no bot uses: nothing new goes in. */
  canAdd?: boolean;
}) {
  const [sources, check] = await Promise.all([sourcesFor(kbId), latestCheck(kbId)]);
  const storage = storageBackend();
  return (
    <>
      {sources.length ? <CheckPanel kbId={kbId} check={check} canEdit={canEdit} /> : null}
      {canAdd ? (
        storage === "none" ? (
          <AddSource
            kbId={kbId}
            accept={ACCEPTED_EXTENSIONS}
            maxBytes={0}
            blobUploads={false}
            filesOff
          />
        ) : (
          <AddSource
            kbId={kbId}
            accept={ACCEPTED_EXTENSIONS}
            maxBytes={MAX_FILE_BYTES}
            blobUploads={storage === "vercel-blob"}
          />
        )
      ) : null}
      <SourceList sources={sources} canEdit={canEdit} />
    </>
  );
}
