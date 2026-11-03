CREATE TABLE "bot_members" (
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_members_bot_id_user_id_pk" PRIMARY KEY("bot_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "bot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_members" ADD CONSTRAINT "bot_members_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_members" ADD CONSTRAINT "bot_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_members" ADD CONSTRAINT "bot_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_members_user_idx" ON "bot_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bot_members_added_by_idx" ON "bot_members" USING btree ("added_by");--> statement-breakpoint
-- Everyone already on the team keeps working on every bot that exists now;
-- from here on, admins choose who works on each bot.
INSERT INTO bot_members (bot_id, user_id)
SELECT b.id, u.id FROM bots b CROSS JOIN users u
ON CONFLICT DO NOTHING;
