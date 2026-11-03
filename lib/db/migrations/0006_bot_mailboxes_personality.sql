CREATE TABLE "bot_mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"address" text NOT NULL,
	"assigned_user_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"delta_link" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "personality" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "emoji" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "email_sign_off" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "teams_webhook_url" text;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "mailbox" text;--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD CONSTRAINT "bot_mailboxes_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mailboxes" ADD CONSTRAINT "bot_mailboxes_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_mailboxes_bot_unique" ON "bot_mailboxes" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_mailboxes_address_unique" ON "bot_mailboxes" USING btree ("address");--> statement-breakpoint
CREATE INDEX "bot_mailboxes_assigned_idx" ON "bot_mailboxes" USING btree ("assigned_user_id");