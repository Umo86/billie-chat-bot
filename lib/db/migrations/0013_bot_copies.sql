ALTER TABLE "bots" ADD COLUMN "copied_from_id" uuid;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "dates_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_copied_from_id_bots_id_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bots_copied_from_idx" ON "bots" USING btree ("copied_from_id");