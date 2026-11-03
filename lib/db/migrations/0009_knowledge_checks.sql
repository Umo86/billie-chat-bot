CREATE TYPE "public"."check_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "knowledge_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"status" "check_status" DEFAULT 'queued' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_sources" integer DEFAULT 0 NOT NULL,
	"total_sources" integer DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_checks" ADD CONSTRAINT "knowledge_checks_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_checks" ADD CONSTRAINT "knowledge_checks_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_checks_kb_idx" ON "knowledge_checks" USING btree ("knowledge_base_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_checks_requested_by_idx" ON "knowledge_checks" USING btree ("requested_by");