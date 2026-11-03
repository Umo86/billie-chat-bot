CREATE TABLE "email_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"saved_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD COLUMN "history_status" text;--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD COLUMN "history_note" text;--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD COLUMN "history_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_suggestions" ADD CONSTRAINT "email_suggestions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suggestions" ADD CONSTRAINT "email_suggestions_saved_source_id_sources_id_fk" FOREIGN KEY ("saved_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_suggestions_bot_question_unique" ON "email_suggestions" USING btree ("bot_id","question_key");--> statement-breakpoint
CREATE INDEX "email_suggestions_status_idx" ON "email_suggestions" USING btree ("status","bot_id");