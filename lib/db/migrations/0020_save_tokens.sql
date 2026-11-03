CREATE TABLE "answer_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"day" date NOT NULL,
	"answer" jsonb NOT NULL,
	"answer_hash" text NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "saved_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "try_fast_first" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "reuse_answers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_cache" ADD CONSTRAINT "answer_cache_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_cache_bot_idx" ON "answer_cache" USING btree ("bot_id","answer_hash");--> statement-breakpoint
CREATE INDEX "answer_cache_day_idx" ON "answer_cache" USING btree ("day");