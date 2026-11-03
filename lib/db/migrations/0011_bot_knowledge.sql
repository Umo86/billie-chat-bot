ALTER TABLE "knowledge_bases" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_bot_unique" ON "knowledge_bases" USING btree ("bot_id");--> statement-breakpoint
-- Each bot gets a knowledge base of its own (bots in the bin too, so a restore
-- still answers): the least shared one it answered from, renamed after the
-- bot, or else a new empty one. Anything else it answered from (a base shared
-- with other bots, or a second base) is copied into its own, so no bot loses
-- an answer. A base no bot answered from keeps bot_id null.
DO $$
DECLARE
  b record;
  own uuid;
  link record;
  src record;
  copied uuid;
BEGIN
  FOR b IN SELECT id, name FROM bots ORDER BY created_at, id LOOP
    SELECT kb.id INTO own
      FROM bot_knowledge_bases bk
      JOIN knowledge_bases kb ON kb.id = bk.knowledge_base_id
     WHERE bk.bot_id = b.id AND kb.bot_id IS NULL AND kb.deleted_at IS NULL
     ORDER BY (SELECT count(*) FROM bot_knowledge_bases x WHERE x.knowledge_base_id = kb.id),
              bk.created_at, kb.id
     LIMIT 1;
    IF own IS NULL THEN
      INSERT INTO knowledge_bases (bot_id, name) VALUES (b.id, b.name);
    ELSE
      UPDATE knowledge_bases SET bot_id = b.id, name = b.name WHERE id = own;
    END IF;
  END LOOP;

  FOR link IN
    SELECT bk.knowledge_base_id AS from_kb, mine.id AS to_kb
      FROM bot_knowledge_bases bk
      JOIN knowledge_bases kb ON kb.id = bk.knowledge_base_id
      JOIN knowledge_bases mine ON mine.bot_id = bk.bot_id
     WHERE kb.deleted_at IS NULL AND kb.id <> mine.id
     ORDER BY bk.created_at
  LOOP
    FOR src IN
      SELECT * FROM sources
       WHERE knowledge_base_id = link.from_kb AND deleted_at IS NULL
       ORDER BY created_at, id
    LOOP
      INSERT INTO sources (knowledge_base_id, title, kind, status, error, file_name, file_key,
                           file_size, mime_type, url, refresh_weekly, body, content_hash, chars,
                           passage_count, last_read_at, added_by, created_at, updated_at)
      VALUES (link.to_kb, src.title, src.kind, src.status, src.error, src.file_name, src.file_key,
              src.file_size, src.mime_type, src.url, src.refresh_weekly, src.body,
              src.content_hash, src.chars, src.passage_count, src.last_read_at, src.added_by,
              src.created_at, src.updated_at)
      RETURNING id INTO copied;
      INSERT INTO passages (source_id, knowledge_base_id, ordinal, text, label, embedding, created_at)
      SELECT copied, link.to_kb, p.ordinal, p.text, p.label, p.embedding, p.created_at
        FROM passages p WHERE p.source_id = src.id;
    END LOOP;
  END LOOP;

  -- The old link table now says the same thing, for a rollback.
  DELETE FROM bot_knowledge_bases;
  INSERT INTO bot_knowledge_bases (bot_id, knowledge_base_id)
  SELECT bot_id, id FROM knowledge_bases WHERE bot_id IS NOT NULL;
END $$;
