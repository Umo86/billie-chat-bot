CREATE TYPE "public"."request_status" AS ENUM('new', 'in_progress', 'done', 'declined');--> statement-breakpoint
CREATE TABLE "chat_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" serial NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid,
	"type_id" text NOT NULL,
	"type_name" text NOT NULL,
	"status" "request_status" DEFAULT 'new' NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assigned_to" uuid,
	"note" text DEFAULT '' NOT NULL,
	"track_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "request_types" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD CONSTRAINT "chat_requests_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD CONSTRAINT "chat_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_requests" ADD CONSTRAINT "chat_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_requests_ref_unique" ON "chat_requests" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_requests_track_unique" ON "chat_requests" USING btree ("track_token");--> statement-breakpoint
CREATE INDEX "chat_requests_status_idx" ON "chat_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "chat_requests_bot_idx" ON "chat_requests" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "chat_requests_conversation_idx" ON "chat_requests" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "chat_requests_assigned_idx" ON "chat_requests" USING btree ("assigned_to");--> statement-breakpoint
ALTER SEQUENCE "chat_requests_ref_seq" RESTART WITH 1001;