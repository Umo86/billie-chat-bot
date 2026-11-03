CREATE TABLE "email_tombstones" (
	"external_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD COLUMN "sync_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD COLUMN "draft_error" text;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "outlook_draft_etag" text;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "outlook_draft_version" text;--> statement-breakpoint
CREATE INDEX "email_tombstones_created_idx" ON "email_tombstones" USING btree ("created_at");