CREATE TABLE "ai_usage" (
	"day" date NOT NULL,
	"scope" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_day_scope_model_pk" PRIMARY KEY("day","scope","model")
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "fast_model" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "thorough_model" text;--> statement-breakpoint
-- Use before models were recorded: tokens only (usage_daily's input counted cache reads too).
INSERT INTO "ai_usage" ("day", "scope", "model", "requests", "input_tokens", "cache_read_tokens", "output_tokens")
SELECT "day", "scope", '', "requests", GREATEST("input_tokens" - "cached_tokens", 0), "cached_tokens", "output_tokens"
FROM "usage_daily"
ON CONFLICT DO NOTHING;
