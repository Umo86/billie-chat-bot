CREATE TABLE "slack_threads" (
	"channel" text NOT NULL,
	"ts" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_threads_channel_ts_pk" PRIMARY KEY("channel","ts")
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "slack_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "slack_threads" ADD CONSTRAINT "slack_threads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_threads_conversation_idx" ON "slack_threads" USING btree ("conversation_id","created_at");--> statement-breakpoint
-- Outside working hours, exhibitor bots take a name, email and stand number (bots nobody changed).
UPDATE "bots" SET "rules" = jsonb_set("rules", '{collect}', '["name","email","stand"]'::jsonb)
  WHERE "audience" = 'exhibitors' AND "rules"->'collect' = '["name","company","stand","email","phone"]'::jsonb;--> statement-breakpoint
-- Working hours 9 to 5, for bots still on the old default.
UPDATE "bots" SET "rules" = jsonb_set("rules", '{hours,end}', '"17:00"'::jsonb)
  WHERE "rules"->'hours' = '{"days":[1,2,3,4,5],"start":"09:00","end":"17:30"}'::jsonb;
