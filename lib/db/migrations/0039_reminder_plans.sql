CREATE TABLE "reminder_plans" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"repeat_days" integer DEFAULT 0 NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"gap_days" integer DEFAULT 2 NOT NULL,
	"weekdays_only" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deadlines" ADD COLUMN "link_id" text;--> statement-breakpoint
ALTER TABLE "reminder_batches" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_plans" ADD CONSTRAINT "reminder_plans_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_plans" ADD CONSTRAINT "reminder_plans_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;