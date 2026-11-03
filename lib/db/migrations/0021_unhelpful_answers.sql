CREATE TABLE "unhelpful_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"fixed_source_id" uuid,
	"fixed_at" timestamp with time zone,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unhelpful_answers" ADD CONSTRAINT "unhelpful_answers_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unhelpful_answers" ADD CONSTRAINT "unhelpful_answers_fixed_source_id_sources_id_fk" FOREIGN KEY ("fixed_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unhelpful_bot_question_unique" ON "unhelpful_answers" USING btree ("bot_id","question_key");--> statement-breakpoint
CREATE INDEX "unhelpful_status_idx" ON "unhelpful_answers" USING btree ("status","last_at");